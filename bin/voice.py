#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11,<3.13"
# dependencies = [
#   "numpy",
#   "faster-whisper>=1.1",
#   "nvidia-cublas-cu12",
#   "nvidia-cudnn-cu12>=9,<10",
#   "kokoro-onnx>=0.4",
#   "piper-tts>=1.2",
# ]
# ///
"""Speech helper for the voice-grill mod: one long-lived process that keeps the
speech-to-text and text-to-speech models loaded and answers the mod over a Unix socket.

  voice.py serve --socket PATH   the daemon the mod starts
  voice.py setup                 download and warm every configured model
  voice.py doctor                show the config, engines, devices and audio tools
  voice.py say TEXT [--voice V]  speak TEXT with the configured (or given) voice
  voice.py voices [--play V ...] list the voices, or play a sample of each
  voice.py hear [--seconds N]    record N seconds (default 5) and print the transcript
  voice.py config                print the config file's path (created on first run)

Engines are adapters: register more by dropping a .py file in ~/.config/voice-grill/engines/
that calls register_stt(name)(cls) or register_tts(name)(cls); see the bottom of this file.
"""

import argparse
import collections
import copy
import ctypes
import importlib.util
import io
import json
import os
import queue
import re
import shutil
import signal
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import tomllib
import urllib.parse
import urllib.request
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np

CONFIG_DIR = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "voice-grill"
CONFIG_PATH = CONFIG_DIR / "config.toml"
DATA = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "voice-grill"
RATE = 16000

DEFAULT_CONFIG = """\
# voice-grill configuration. Changes apply the next time voice mode starts
# (or run /voice-mode restart). Check a change with: voice.py doctor

[stt]                       # speech to text
engine = "faster-whisper"   # faster-whisper | openai-compatible | any adapter in engines/
model = "large-v3-turbo"    # e.g. large-v3-turbo, distil-large-v3.5, small.en, or a local path
device = "auto"             # auto (GPU if it works, else CPU) | cuda | cpu
compute_type = "auto"       # auto | float16 | int8_float16 | int8
language = "en"
beam_size = 5
live_interval_ms = 300      # how often the live transcript refreshes while you talk; 0 = only at pauses
# url = "http://localhost:8000/v1"   # openai-compatible: a local server such as Speaches

[tts]                       # text to speech
engine = "kokoro"           # kokoro | piper | openai-compatible | any adapter in engines/
voice = "af_heart"          # kokoro: af_heart, af_bella, am_michael, bf_emma, ... ; piper: en_US-lessac-medium
speed = 1.0
volume = 1.0                # 1.0 = as the engine makes it; 0.5 = half as loud
# url = "http://localhost:8000/v1"   # openai-compatible
# model = "kokoro"                   # openai-compatible

[listen]
send_phrase = "send it"     # say this at the end of an answer to send it
off_phrase = "stop voice"   # say this to leave voice mode
pause_ms = 700              # silence that ends a phrase
min_level = 300             # loudness that counts as speech (raise it in a noisy room)
barge_in = true             # start talking while a question is read to stop it and answer
auto_send = false           # send the answer by itself after a pause (the side panel toggles it)
auto_send_ms = 2500         # how long a pause sends it

[audio]
recorder = "auto"           # auto | parec | pw-record | arecord
player = "auto"             # auto | pw-play | paplay | aplay

[daemon]
idle_minutes = 15           # unload the models (and free the GPU) after this long unused; 0 = never
"""


# ---------- config ----------

def deep_merge(base, extra):
    out = copy.deepcopy(base)
    for key, value in extra.items():
        out[key] = deep_merge(out[key], value) if isinstance(value, dict) and isinstance(out.get(key), dict) else value
    return out


def load_config():
    if not CONFIG_PATH.exists():
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        CONFIG_PATH.write_text(DEFAULT_CONFIG)
    defaults = tomllib.loads(DEFAULT_CONFIG)
    return deep_merge(defaults, tomllib.loads(CONFIG_PATH.read_text()))


def save_setting(section, key, value):
    """Rewrite one `key = value` line inside [section] of the config, keeping its comment."""
    lines = CONFIG_PATH.read_text().splitlines(keepends=True)
    current, rendered, section_end = None, json.dumps(value), None
    for i, line in enumerate(lines):
        head = re.match(r"\s*\[([^\]]+)\]", line)
        if head:
            current = head.group(1).strip()
            continue
        if current == section and line.strip() and not line.lstrip().startswith("#"):
            section_end = i + 1
        found = re.match(rf"(\s*{re.escape(key)}\s*=\s*)(\"[^\"]*\"|[^#\s]+)(.*)", line, re.S)
        if current == section and found:
            lines[i] = found.group(1) + rendered + found.group(3)
            break
    else:
        if section_end is None:
            raise KeyError(f"no [{section}] section")
        lines.insert(section_end, f"{key} = {rendered}\n")
    CONFIG_PATH.write_text("".join(lines))


# ---------- engine registry ----------

STT, TTS = {}, {}


def register_stt(name):
    def add(cls):
        STT[name] = cls
        return cls
    return add


def register_tts(name):
    def add(cls):
        TTS[name] = cls
        return cls
    return add


def load_engine_plugins():
    folder = CONFIG_DIR / "engines"
    for path in sorted(folder.glob("*.py")) if folder.is_dir() else []:
        spec = importlib.util.spec_from_file_location(f"voice_grill_engine_{path.stem}", path)
        module = importlib.util.module_from_spec(spec)
        module.register_stt, module.register_tts, module.np, module.RATE = register_stt, register_tts, np, RATE
        spec.loader.exec_module(module)


def download(url, dest):
    dest = Path(dest)
    if dest.exists():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    log(f"downloading {url}")
    tmp = dest.with_name(dest.name + ".part")
    urllib.request.urlretrieve(url, tmp)
    tmp.rename(dest)
    return dest


def log(text):
    print(f"[voice-grill] {text}", file=sys.stderr, flush=True)


def wav_bytes(samples, rate):
    pcm = (np.clip(samples, -1, 1) * 32767).astype(np.int16) if samples.dtype != np.int16 else samples
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def read_wav(data):
    with wave.open(io.BytesIO(data)) as w:
        raw = w.readframes(w.getnframes())
        samples = np.frombuffer(raw, np.int16).astype(np.float32) / 32768.0
        if w.getnchannels() > 1:
            samples = samples.reshape(-1, w.getnchannels()).mean(axis=1)
        return samples, w.getframerate()


# ---------- speech to text adapters: transcribe(float32 16 kHz mono) -> str ----------

def preload_cuda_libs():
    """faster-whisper's GPU build wants cuBLAS 12 and cuDNN 9; load the pip copies so
    the system CUDA version does not matter."""
    spec = importlib.util.find_spec("nvidia")
    for root in spec.submodule_search_locations if spec else []:
        for pattern in ("cublas/lib/libcublasLt.so.12", "cublas/lib/libcublas.so.12", "cudnn/lib/libcudnn*.so.9"):
            for lib in sorted(Path(root).glob(pattern)):
                try:
                    ctypes.CDLL(str(lib), mode=ctypes.RTLD_GLOBAL)
                except OSError as err:
                    log(f"could not preload {lib.name}: {err}")


@register_stt("faster-whisper")
class FasterWhisper:
    def __init__(self, cfg):
        from faster_whisper import WhisperModel

        self.cfg = cfg
        devices = ["cuda", "cpu"] if cfg["device"] == "auto" else [cfg["device"]]
        last = None
        for device in devices:
            compute = cfg["compute_type"]
            if compute == "auto":
                compute = "float16" if device == "cuda" else "int8"
            try:
                if device == "cuda":
                    preload_cuda_libs()
                self.model = WhisperModel(cfg["model"], device=device, compute_type=compute,
                                          download_root=str(DATA / "whisper"))
                self._run(np.zeros(RATE // 2, np.float32))  # fails here if a GPU library is missing
                self.device = f"{device}/{compute}"
                return
            except Exception as err:  # noqa: BLE001 - try the next device
                last = err
                log(f"faster-whisper on {device} failed: {err}")
        raise RuntimeError(f"faster-whisper could not start: {last}")

    def _run(self, audio):
        segments, _ = self.model.transcribe(audio, language=self.cfg["language"] or None,
                                            beam_size=int(self.cfg["beam_size"]), vad_filter=True,
                                            condition_on_previous_text=False)
        return " ".join(s.text.strip() for s in segments).strip()

    def transcribe(self, audio):
        return self._run(audio)

    def describe(self):
        return f"faster-whisper {self.cfg['model']} on {self.device}"


@register_stt("openai-compatible")
class OpenAICompatibleSTT:
    """Any server with POST {url}/audio/transcriptions, e.g. a local Speaches container."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.url = cfg.get("url") or "http://localhost:8000/v1"

    def transcribe(self, audio):
        boundary = "voicegrill" + os.urandom(8).hex()
        fields = {"model": self.cfg["model"], "language": self.cfg["language"], "response_format": "json"}
        body = b"".join(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode() for k, v in fields.items() if v
        ) + (
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\n'
            "Content-Type: audio/wav\r\n\r\n"
        ).encode() + wav_bytes(audio, RATE) + f"\r\n--{boundary}--\r\n".encode()
        req = urllib.request.Request(f"{self.url}/audio/transcriptions", data=body,
                                     headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read()).get("text", "").strip()

    def describe(self):
        return f"openai-compatible STT {self.cfg['model']} at {self.url}"


# ---------- text to speech adapters: synth(text) -> (float32 samples, rate) ----------

KOKORO_FILES = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"


@register_tts("kokoro")
class Kokoro:
    def __init__(self, cfg):
        from kokoro_onnx import Kokoro as KokoroOnnx

        self.cfg = cfg
        model = download(KOKORO_FILES + "kokoro-v1.0.onnx", DATA / "kokoro" / "kokoro-v1.0.onnx")
        voices = download(KOKORO_FILES + "voices-v1.0.bin", DATA / "kokoro" / "voices-v1.0.bin")
        self.kokoro = KokoroOnnx(str(model), str(voices))

    def synth(self, text):
        voice = self.cfg["voice"]
        lang = "en-gb" if voice[:1] == "b" else "en-us"
        samples, rate = self.kokoro.create(text, voice=voice, speed=float(self.cfg["speed"]), lang=lang)
        return np.asarray(samples, np.float32), rate

    def voices(self):
        return sorted(self.kokoro.get_voices())

    def describe(self):
        return f"kokoro voice {self.cfg['voice']} (CPU)"


@register_tts("piper")
class Piper:
    def __init__(self, cfg):
        from piper import PiperVoice

        self.cfg = cfg
        name = cfg["voice"] if "-" in cfg["voice"] else "en_US-lessac-medium"
        region, speaker, quality = (name.split("-") + ["", ""])[:3]
        base = (f"https://huggingface.co/rhasspy/piper-voices/resolve/main/"
                f"{region.split('_')[0]}/{region}/{speaker}/{quality}/{name}.onnx")
        model = download(base, DATA / "piper" / f"{name}.onnx")
        download(base + ".json", DATA / "piper" / f"{name}.onnx.json")
        self.voice = PiperVoice.load(str(model))
        self.name = name

    def synth(self, text):
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            if hasattr(self.voice, "synthesize_wav"):
                self.voice.synthesize_wav(text, w)
            else:
                self.voice.synthesize(text, w)
        return read_wav(buf.getvalue())

    def describe(self):
        return f"piper voice {self.name}"


@register_tts("openai-compatible")
class OpenAICompatibleTTS:
    """Any server with POST {url}/audio/speech returning WAV, e.g. a local Speaches or Kokoro-FastAPI."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.url = cfg.get("url") or "http://localhost:8000/v1"

    def synth(self, text):
        body = json.dumps({"model": self.cfg.get("model", "kokoro"), "voice": self.cfg["voice"], "input": text,
                           "speed": float(self.cfg["speed"]), "response_format": "wav"}).encode()
        req = urllib.request.Request(f"{self.url}/audio/speech", data=body,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            return read_wav(resp.read())

    def describe(self):
        return f"openai-compatible TTS {self.cfg['voice']} at {self.url}"


# ---------- audio tools ----------

def on(value):
    return str(value).lower() in ("true", "1", "yes", "on")


def pick(choice, options):
    for cmd in options if choice == "auto" else [o for o in options if o[0] == choice]:
        if shutil.which(cmd[0]):
            return cmd
    raise RuntimeError(f"none of {[o[0] for o in options]} is installed")


def recorder_cmd(cfg):
    return pick(cfg["audio"]["recorder"], [
        ["parec", "--format=s16le", f"--rate={RATE}", "--channels=1", "--raw"],
        ["pw-record", "--rate", str(RATE), "--channels", "1", "--format", "s16", "-"],
        ["arecord", "-q", "-f", "S16_LE", "-r", str(RATE), "-c", "1", "-t", "raw"],
    ])


def player_cmd(cfg):
    return pick(cfg["audio"]["player"], [["pw-play"], ["paplay"], ["aplay", "-q"]])


SENTENCE = re.compile(r"(?<=[.!?:;])\s+|\n+")


def sentences(text):
    out, chunk = [], ""
    for piece in (p.strip() for p in SENTENCE.split(text)):
        if not piece:
            continue
        chunk = f"{chunk} {piece}".strip()
        if len(chunk) > 40:  # very short pieces sound choppy on their own
            out.append(chunk)
            chunk = ""
    return out + ([chunk] if chunk else [])


def norm(text):
    return re.sub(r"[^a-z0-9 ]+", "", text.lower()).split()


def ends_with(text, phrase):
    words, tail = norm(text), norm(phrase)
    return bool(tail) and words[-len(tail):] == tail


def strip_tail(text, phrase):
    n = len(norm(phrase))
    words = text.rstrip().split()
    return " ".join(words[:-n]) if len(words) >= n else ""


PLAYER_LAG = 0.08  # seconds from starting the player to hearing sound


def word_times(words, seconds):
    """When each word starts, in seconds into its clip: a share of the clip by
    length, with extra weight for the pause after punctuation."""
    weights = [len(w) + 2 + (4 if w[-1] in ",;:" else 7 if w[-1] in ".!?" else 0) for w in words]
    total, at, times = sum(weights) or 1, 0.0, []
    for weight in weights:
        times.append(at / total * seconds)
        at += weight
    return times


# ---------- the voice engine ----------

class Speech:
    """One message being read aloud; `feed` takes its text as it streams in."""

    def __init__(self, sid, open_):
        self.sid, self.open = sid, open_
        self.feed = queue.Queue()
        self.heard = ""  # what has gone to the synthesizer so far


class BargeIn:
    """Listens while a message is read. Sustained sound that transcribes to words the
    speaker is not saying (so not its own echo) stops the reading; the recorder and
    the audio so far go on to the listen that follows."""

    CHECK_EVERY = 0.4  # seconds between transcription checks while it is loud
    WINDOW = RATE * 2 * 2  # bytes of audio a check transcribes: the last 2 s

    def __init__(self, voice, speech):
        self.voice, self.speech = voice, speech
        self.rec = subprocess.Popen(recorder_cmd(voice.cfg), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.audio, self.floor, self.done = bytearray(), None, False
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def run(self):
        lc = self.voice.cfg["listen"]
        frame_bytes, last_check, started = int(RATE * 0.03) * 2, 0.0, time.time()
        recent = collections.deque(maxlen=17)  # the last half second of frames: loud or not
        while not self.done:
            chunk = self.rec.stdout.read(frame_bytes)
            if not chunk:
                return
            self.audio += chunk
            del self.audio[: max(0, len(self.audio) - self.WINDOW)]
            level = float(np.sqrt(np.mean(np.frombuffer(chunk, np.int16).astype(np.float32) ** 2)))
            if self.floor is None or time.time() - started < 0.5:
                self.floor = level if self.floor is None else min(self.floor * 0.9 + level * 0.1, level * 2)
            recent.append(level > max(float(lc["min_level"]), self.floor * 2.5))
            # speech dips between syllables, so "mostly loud" over the window, not unbroken
            if not self.voice.paused and sum(recent) >= 9 and time.time() - last_check >= self.CHECK_EVERY:
                last_check = time.time()
                if self.is_person(bytes(self.audio)) and not self.done:
                    log("barge-in")
                    self.voice.stop("barge")
                    return

    def is_person(self, pcm):
        heard = norm(self.voice.stt.transcribe(np.frombuffer(pcm, np.int16).astype(np.float32) / 32768.0))
        said = set(norm(self.speech.heard))
        new = [w for w in heard if w not in said]
        log(f"barge-in check: heard {' '.join(heard)!r}, new {new}")
        # a person's words are the newest in the window, so two new among the last four count too
        fresh_tail = sum(w not in said for w in heard[-4:])
        return len(heard) >= 2 and (len(new) >= max(2, len(heard) / 2) or fresh_tail >= 2)

    def finish(self, handoff):
        self.done = True
        if handoff:
            self.thread.join(timeout=1)
            # the last 1.5 s: the person's start, with little of the voice's echo before it
            lead_in = bytes(self.audio[-int(RATE * 2 * 1.5):])
            self.voice.handoff = {"rec": self.rec, "audio": lead_in, "floor": self.floor, "at": time.time()}
        else:
            self.rec.terminate()

class Voice:
    def __init__(self, cfg):
        self.cfg = cfg
        self.stt = None
        self.tts = None
        self.loading = "starting"
        self.error = ""
        self.ready = threading.Event()
        self.events, self.seq = [], 0
        self.cond = threading.Condition()
        self.command = ""
        self.busy = threading.Lock()
        self.last_used = time.time()
        self.session = None  # the speech being read, which may still be streaming in
        self.handoff = None  # a barge-in's recorder and audio, for the listen that follows
        self.ended = set()  # ids of speeches that are over: more text for them is dropped
        self.paused = False  # reading frozen mid-word, or the mic muted; each new op starts unpaused

    # ends the current speech: its feed stops waiting for more text
    def stop(self, command):
        self.command = command
        if self.session:
            self.session.feed.put(None)

    # text to read: a new speech, or more of the one with this id while it is open
    def say_text(self, text, sid=None, more=False):
        current = self.session
        if sid and current and current.sid == sid:
            if current.open:
                if text:
                    current.feed.put(text)
                if not more:
                    current.open = False
                    current.feed.put(None)
            return False
        if sid and (not text or sid in self.ended):
            return False  # more of, or the end of, a speech that is already over
        self.stop("skip")  # end whatever runs, then start
        if current and current.sid:
            self.ended.add(current.sid)
        self.session = Speech(sid, more)
        if text:
            self.session.feed.put(text)
        if not more:
            self.session.feed.put(None)
        self.start(self.speak, self.session)
        return True

    # events the mod long-polls
    def emit(self, kind, **fields):
        with self.cond:
            self.seq += 1
            self.events.append({"seq": self.seq, "type": kind, **fields})
            self.events = self.events[-200:]
            self.cond.notify_all()

    def events_after(self, after, wait_ms):
        deadline = time.time() + wait_ms / 1000
        with self.cond:
            while True:
                fresh = [e for e in self.events if e["seq"] > after]
                left = deadline - time.time()
                if fresh or left <= 0:
                    return fresh, self.seq
                self.cond.wait(left)

    def load(self):
        try:
            load_engine_plugins()
            tts_cfg, stt_cfg = self.cfg["tts"], self.cfg["stt"]
            self.loading = f"loading {tts_cfg['engine']}"
            self.tts = TTS[tts_cfg["engine"]](tts_cfg)
            self.loading = f"loading {stt_cfg['engine']} {stt_cfg.get('model', '')}"
            self.stt = STT[stt_cfg["engine"]](stt_cfg)
            self.loading = ""
            log(f"ready: {self.stt.describe()}; {self.tts.describe()}")
        except KeyError as err:
            self.error = f"no engine named {err}; known: stt {sorted(STT)}, tts {sorted(TTS)}"
        except Exception as err:  # noqa: BLE001 - reported to the mod
            self.error = f"{type(err).__name__}: {err}"
        finally:
            self.ready.set()
            if self.error:
                log(self.error)
                self.emit("error", text=self.error)

    # Voice and speed change live for an engine that reads them per utterance (kokoro,
    # openai-compatible); piper's voice is a model file, so it needs a restart.
    def settings(self, change=None):
        tts = self.cfg["tts"]
        live_voice = tts["engine"] != "piper"
        for key, value in (change or {}).items():
            if key == "speed":
                value = round(min(2.0, max(0.5, float(value))), 2)
            elif key == "volume":
                value = round(min(1.5, max(0.0, float(value))), 2)
            elif key == "autoSend":
                self.cfg["listen"]["auto_send"] = bool(value)
                save_setting("listen", "auto_send", bool(value))
                continue
            elif key == "voice":
                value = str(value)
                if self.tts and hasattr(self.tts, "voices") and value not in self.tts.voices():
                    raise ValueError(f"unknown voice {value}")
            else:
                continue
            tts[key] = value
            save_setting("tts", key, value)
        voices = self.tts.voices() if self.tts and hasattr(self.tts, "voices") else []
        return {"voice": tts["voice"], "speed": float(tts["speed"]), "volume": float(tts.get("volume", 1.0)),
                "autoSend": on(self.cfg["listen"].get("auto_send")),
                "autoSendSeconds": int(self.cfg["listen"].get("auto_send_ms", 2500)) / 1000,
                "voices": voices, "voiceNeedsRestart": not live_voice}

    def health(self):
        return {"ready": self.ready.is_set() and not self.error, "loading": self.loading, "error": self.error,
                "stt": self.stt.describe() if self.stt else "", "tts": self.tts.describe() if self.tts else "",
                "config": str(CONFIG_PATH)}

    def start(self, target, *args):
        # The caller has set self.command to stop whatever runs; the new op clears it
        # only once it holds the lock, so the old one sees the stop first.
        self.last_used = time.time()

        def run():
            with self.busy:
                self.command = ""
                self.paused = False
                self.ready.wait()
                if self.error:
                    self.emit("error", text=self.error)
                    return
                try:
                    target(*args)
                except Exception as err:  # noqa: BLE001
                    log(f"{target.__name__} failed: {err}")
                    self.emit("error", text=f"{target.__name__}: {err}")

        threading.Thread(target=run, daemon=True).start()

    # speaking: synthesize the next sentence while the current one plays; text may keep
    # streaming in until the speech is closed
    def speak(self, speech):
        clips = queue.Queue(maxsize=2)
        tts = self.cfg["tts"]

        def synth():
            while not self.command:
                piece = speech.feed.get()
                if piece is None:
                    break
                for part in sentences(piece):
                    if self.command:
                        break
                    speech.heard += " " + part
                    samples, rate = self.tts.synth(part)
                    clips.put((samples, rate, part))
            clips.put(None)

        threading.Thread(target=synth, daemon=True).start()
        monitor = BargeIn(self, speech) if on(self.cfg["listen"].get("barge_in", True)) else None
        reason, player, drained, first_word = "done", player_cmd(self.cfg), False, 0
        while True:
            clip = clips.get()
            if clip is None:
                drained = True
                break
            if self.command:
                break
            samples, rate, part = clip
            volume = float(tts.get("volume", 1.0))  # read per sentence, so a change applies at once
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                f.write(wav_bytes(np.asarray(samples, np.float32) * volume, rate))
            try:
                schedule = word_times(part.split(), len(samples) / rate)
                while self.paused and not self.command:  # paused between sentences
                    time.sleep(0.03)
                proc = subprocess.Popen(player + [f.name], stderr=subprocess.DEVNULL)
                began, next_word, frozen_at = time.time() + PLAYER_LAG, 0, None
                while proc.poll() is None:
                    if self.command:
                        if frozen_at:
                            proc.send_signal(signal.SIGCONT)
                        proc.terminate()
                        break
                    # pause: freeze the player where it is; resume: carry on from there
                    if self.paused and not frozen_at:
                        proc.send_signal(signal.SIGSTOP)
                        frozen_at = time.time()
                    elif not self.paused and frozen_at:
                        proc.send_signal(signal.SIGCONT)
                        began += time.time() - frozen_at
                        frozen_at = None
                    if frozen_at:
                        time.sleep(0.03)
                        continue
                    # the word being said, estimated from its share of the clip
                    while next_word < len(schedule) and time.time() - began >= schedule[next_word]:
                        self.emit("word", index=first_word + next_word, id=speech.sid)
                        next_word += 1
                    time.sleep(0.03)
                first_word += len(schedule)
            finally:
                os.unlink(f.name)
        if self.command:
            reason = self.command
        speech.open = False
        speech.feed.put(None)  # unblock the synth thread
        while not drained and clips.get() is not None:  # let the synth thread finish
            pass
        if monitor:
            monitor.finish(handoff=reason == "barge")
        self.emit("spoken", reason=reason, id=speech.sid)

    # listening: energy VAD cuts phrases at pauses; each phrase is transcribed as it ends,
    # and the phrase still being spoken is re-transcribed every live_interval_ms
    def listen(self):
        lc = self.cfg["listen"]
        handoff, self.handoff = self.handoff, None
        if handoff and time.time() - handoff["at"] < 5:
            rec, lead_in, floor = handoff["rec"], handoff["audio"], handoff["floor"]
        else:
            if handoff:
                handoff["rec"].terminate()
            lead_in, floor = b"", None
            rec = subprocess.Popen(recorder_cmd(self.cfg), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.emit("status", text="listening")
        frame_bytes = int(RATE * 0.03) * 2
        live_every = float(self.cfg["stt"].get("live_interval_ms", 0)) / 1000
        lock = threading.Lock()
        shared = {"current": bytearray(lead_in), "speech": bool(lead_in), "done": False}
        segments = queue.Queue()
        parts, flags = [], {"phrase": False, "off": False}

        def to_audio(pcm):
            return np.frombuffer(bytes(pcm), np.int16).astype(np.float32) / 32768.0

        def publish(interim=""):
            text = " ".join(parts + ([interim] if interim else [])).strip()
            self.emit("partial", text=text)

        def worker():
            last_live = 0.0
            while True:
                try:
                    pcm = segments.get(timeout=0.1)
                except queue.Empty:
                    pcm = False
                if pcm is None:
                    return
                if pcm:
                    text = self.stt.transcribe(to_audio(pcm))
                    if text:
                        parts.append(text)
                        flags["off"] = flags["off"] or ends_with(text, lc["off_phrase"])
                        flags["phrase"] = flags["phrase"] or ends_with(text, lc["send_phrase"])
                    publish()
                    continue
                if live_every and time.time() - last_live >= live_every:
                    with lock:
                        snapshot = bytes(shared["current"]) if shared["speech"] else b""
                    if len(snapshot) > RATE:  # at least half a second
                        last_live = time.time()
                        publish(self.stt.transcribe(to_audio(snapshot)))

        w = threading.Thread(target=worker, daemon=True)
        w.start()

        silent_ms, quiet_ms, started, reason = 0, 0, time.time() - (1 if floor else 0), None
        while reason is None:
            chunk = rec.stdout.read(frame_bytes)
            if not chunk:
                reason = "error"
                break
            if self.paused:  # muted: the audio is dropped and the pause clocks stand still
                if self.command in ("send", "enter", "repeat", "off", "cancel"):
                    reason = self.command
                continue
            level = float(np.sqrt(np.mean(np.frombuffer(chunk, np.int16).astype(np.float32) ** 2)))
            if floor is None or time.time() - started < 0.5:
                floor = level if floor is None else min(floor * 0.9 + level * 0.1, level * 2)
            loud = level > max(float(lc["min_level"]), floor * 3)
            with lock:
                shared["current"] += chunk
                if loud:
                    shared["speech"], silent_ms, quiet_ms = True, 0, 0
                else:
                    silent_ms, quiet_ms = silent_ms + 30, quiet_ms + 30
                if shared["speech"] and silent_ms >= int(lc["pause_ms"]):
                    segments.put(shared["current"])
                    shared["current"], shared["speech"], silent_ms = bytearray(), False, 0
                elif not shared["speech"] and len(shared["current"]) > RATE * 2:
                    del shared["current"][: len(shared["current"]) - RATE * 2]  # keep 1 s of lead-in
            if self.command in ("send", "enter", "repeat", "off", "cancel"):
                reason = self.command
            elif flags["off"]:
                reason = "off"
            elif flags["phrase"]:
                reason = "phrase"
            elif (on(lc.get("auto_send")) and parts and not shared["speech"] and segments.empty()
                  and quiet_ms >= int(lc.get("auto_send_ms", 2500))):
                reason = "send"  # said something, then a long enough pause

        rec.terminate()
        with lock:
            if reason in ("send", "enter", "off") and shared["speech"]:
                segments.put(shared["current"])
        segments.put(None)
        w.join()

        text = " ".join(parts).strip()
        if flags["off"]:
            text, reason = strip_tail(text, lc["off_phrase"]), "off"
        elif flags["phrase"]:
            text, reason = strip_tail(text, lc["send_phrase"]), "send"
        if reason == "error":
            self.emit("error", text="the recorder stopped")
        self.emit("final", text=text, reason=reason)


# ---------- the daemon ----------

class UnixHTTPServer(ThreadingHTTPServer):
    address_family = socket.AF_UNIX

    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = "voice-grill", 0


def serve(args):
    voice = Voice(load_config())

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def address_string(self):
            return "unix"

        def reply(self, data, status=200):
            body = json.dumps(data).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def body(self):
            n = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(n) or b"{}")

        def do_GET(self):
            url = urllib.parse.urlparse(self.path)
            q = urllib.parse.parse_qs(url.query)
            if url.path == "/health":
                return self.reply(voice.health())
            if url.path == "/settings":
                return self.reply(voice.settings())
            if url.path == "/events":
                after = int(q.get("after", ["0"])[0])
                wait = min(int(q.get("wait", ["1000"])[0]), 5000)
                events, seq = voice.events_after(after, wait)
                return self.reply({"events": events, "seq": seq})
            self.reply({"error": "not found"}, 404)

        def do_POST(self):
            path, data = self.path, self.body()
            if path == "/speak":
                # {text}: read it; {text, id, more: true}: start or add to a streaming speech,
                # closed by a last {id, more: false}
                seq = voice.seq
                fresh = voice.say_text(str(data.get("text", "")), data.get("id"), bool(data.get("more")))
                return self.reply({"ok": True, "seq": seq, "fresh": fresh})
            if path == "/listen":
                voice.stop("cancel")
                voice.start(voice.listen)
                return self.reply({"ok": True, "seq": voice.seq})
            if path == "/control" and data.get("cmd") in ("pause", "resume", "toggle-pause"):
                cmd = data["cmd"]
                voice.paused = (not voice.paused) if cmd == "toggle-pause" else cmd == "pause"
                return self.reply({"ok": True, "paused": voice.paused})
            if path == "/control":
                voice.stop(str(data.get("cmd", "")))
                return self.reply({"ok": True})
            if path == "/settings":
                try:
                    return self.reply(voice.settings(data))
                except (ValueError, KeyError) as err:
                    return self.reply({"error": str(err)}, 400)
            if path == "/shutdown":
                self.reply({"ok": True})
                threading.Thread(target=server.shutdown, daemon=True).start()
                return
            self.reply({"error": "not found"}, 404)

    path = Path(args.socket)
    path.unlink(missing_ok=True)
    server = UnixHTTPServer(str(path), Handler)
    threading.Thread(target=voice.load, daemon=True).start()

    parent = os.getppid()

    idle = float(voice.cfg["daemon"]["idle_minutes"]) * 60

    def watch():  # leave when the mod (or uv) that started us is gone, or after idling
        while os.getppid() == parent:
            time.sleep(1)
            if idle and not voice.busy.locked() and time.time() - voice.last_used > idle:
                log("idle: unloading")
                break
        server.shutdown()

    threading.Thread(target=watch, daemon=True).start()
    log(f"listening on {path}")
    try:
        server.serve_forever()
    finally:
        path.unlink(missing_ok=True)


# ---------- command line ----------

def build(cfg):
    load_engine_plugins()
    return TTS[cfg["tts"]["engine"]](cfg["tts"]), STT[cfg["stt"]["engine"]](cfg["stt"])


def setup(args):
    cfg = load_config()
    tts, stt = build(cfg)
    tts.synth("Ready.")
    print(f"text to speech: {tts.describe()}")
    print(f"speech to text: {stt.describe()}")
    print(f"config: {CONFIG_PATH}")


def doctor(args):
    cfg = load_config()
    print(f"config: {CONFIG_PATH}")
    print(json.dumps(cfg, indent=2))
    load_engine_plugins()
    print(f"engines: stt {sorted(STT)}, tts {sorted(TTS)}")
    for kind, choose in (("recorder", recorder_cmd), ("player", player_cmd)):
        try:
            print(f"{kind}: {choose(cfg)[0]}")
        except RuntimeError as err:
            print(f"{kind}: MISSING ({err})")
    gpu = shutil.which("nvidia-smi")
    print(f"nvidia-smi: {'yes' if gpu else 'no'}")


def say(args):
    cfg = load_config()
    if args.voice:
        cfg["tts"]["voice"] = args.voice
    load_engine_plugins()
    voice = Voice(cfg)
    voice.tts = TTS[cfg["tts"]["engine"]](cfg["tts"])
    cfg["listen"]["barge_in"] = False
    speech = Speech(None, False)
    speech.feed.put(" ".join(args.text))
    speech.feed.put(None)
    voice.speak(speech)


def hear(args):
    cfg = load_config()
    load_engine_plugins()
    voice = Voice(cfg)
    voice.stt = STT[cfg["stt"]["engine"]](cfg["stt"])
    print(f"recording {args.seconds}s with {voice.stt.describe()}... speak now", flush=True)
    threading.Timer(args.seconds, lambda: setattr(voice, "command", "send")).start()
    voice.listen()
    final = [e for e in voice.events if e["type"] == "final"][-1]
    print(final["text"])


def voices(args):
    """List the configured engine's voices, or play a sample of each named one."""
    cfg = load_config()
    load_engine_plugins()
    tts = TTS[cfg["tts"]["engine"]](cfg["tts"])
    listing = getattr(getattr(tts, "kokoro", None), "get_voices", None)
    if not args.play:
        print("\n".join(sorted(listing())) if listing else f"{tts.describe()} lists no voices")
        return
    voice = Voice(cfg)
    voice.tts = tts
    for name in args.play:
        cfg["tts"]["voice"] = name
        print(name, flush=True)
        voice.speak(f"Hi, I'm {name.split('_')[-1]}. What should the README cover first?")


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve")
    s.add_argument("--socket", required=True)
    sub.add_parser("setup")
    sub.add_parser("doctor")
    sub.add_parser("config")
    s = sub.add_parser("say")
    s.add_argument("text", nargs="+")
    s.add_argument("--voice")
    s = sub.add_parser("voices")
    s.add_argument("--play", nargs="*", help="voices to sample, e.g. af_heart am_michael")
    s = sub.add_parser("hear")
    s.add_argument("--seconds", type=float, default=5)
    args = p.parse_args()
    if args.cmd == "config":
        load_config()
        print(CONFIG_PATH)
        return
    {"serve": serve, "setup": setup, "doctor": doctor, "say": say, "hear": hear, "voices": voices}[args.cmd](args)


if __name__ == "__main__":
    main()

# An engine adapter in ~/.config/voice-grill/engines/my_engine.py looks like:
#
#   @register_stt("my-stt")
#   class MySTT:
#       def __init__(self, cfg): ...            # cfg is the [stt] table
#       def transcribe(self, audio): ...        # float32 numpy, 16 kHz mono -> str
#       def describe(self): return "my-stt"
#
#   @register_tts("my-tts")
#   class MyTTS:
#       def __init__(self, cfg): ...            # cfg is the [tts] table
#       def synth(self, text): ...              # -> (float32 numpy samples, sample rate)
#       def describe(self): return "my-tts"
