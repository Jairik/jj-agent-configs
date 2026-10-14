import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ChatLine, Phase, VoiceSettings } from '../types'

const phase = atom({ plugin: 'voice-grill', key: 'phase' } as const, 'off' as Phase)
const live = atom({ plugin: 'voice-grill', key: 'live' } as const, '')
const detail = atom({ plugin: 'voice-grill', key: 'detail' } as const, '')
const chat = atom({ plugin: 'voice-grill', key: 'chat' } as const, [] as ChatLine[])
const settings = atom({ plugin: 'voice-grill', key: 'settings' } as const, null as VoiceSettings | null)
// The index of the word being read aloud in Claude's last line; -1 when not reading.
const word = atom({ plugin: 'voice-grill', key: 'word' } as const, -1)
// Reading frozen mid-word, or the mic muted, until Space (or Resume) again.
const paused = atom({ plugin: 'voice-grill', key: 'paused' } as const, false)

const PANE = 'voice-grill'
// Only the voice-grill skill turns voice mode on; the grill skills it runs are left as they are.
const START_SKILLS = ['voice-grill']
const RULED_SKILLS = [...START_SKILLS, 'grilling', 'grill-me', 'grill-with-docs']
const COMMAND = 'voice-mode'
const DONE = '[voice-grill:done]'
const FIRST_LOAD_MS = 20 * 60_000 // the first start downloads the models
const CHAT_LINES = 30
const CHAT_SHOWN = 8
const PHASE_LABEL: Record<Phase, [string, string]> = {
  off: ['Voice off', 'inactive'],
  waiting: ['Waiting for Claude', 'subtle'],
  speaking: ['Speaking', 'claude'],
  listening: ['Listening', 'success'],
  sending: ['Sending', 'suggestion'],
}
const SPEED_STEP = 0.05
const VOLUME_STEP = 0.1
// Kokoro's English voices by prefix: American/British, woman/man.
const ACCENTS: Record<string, string> = { af: 'American woman', am: 'American man', bf: 'British woman', bm: 'British man' }

function voiceLabel(voice: string) {
  const [prefix = '', name = voice] = voice.split('_')
  const accent = ACCENTS[prefix]
  return accent ? `${name[0]?.toUpperCase()}${name.slice(1)} (${accent})` : voice
}

const RULES = `VOICE GRILLING MODE is on. It overrides the grilling skill's round format.
The user hears each of your messages through text-to-speech and answers by voice; their replies are speech-to-text transcripts.
- Ask exactly ONE question per message: the most important question on the current frontier. Never a numbered round.
- Keep it speakable: plain sentences, no markdown, headings, tables, code blocks or emoji, roughly 80 words at most.
- Give your recommended answer in one sentence starting with "My recommendation:".
- Track the rest of the design tree yourself and move to the next frontier question after each answer.
- Transcripts may contain filler words or misheard terms: read past them, and ask to confirm if one looks garbled.
- Look facts up yourself as the skill says, but still end every message with exactly one question.
- When a picture would help (a diagram, chart, layout or comparison), add one SVG in a \`\`\`svg block (with a viewBox and no script). It is drawn in the user's side panel and never read aloud; say in a few words what it shows.
- When the frontier is empty and the user has confirmed shared understanding, end that message with the line ${DONE}`

// Markdown and emoji read badly aloud.
const speakable = (md: string): string =>
  md
    .replaceAll(DONE, '')
    .replace(/```svg[\s\S]*?```/g, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/g, ' ')
    .replace(/```[\s\S]*?```/g, ' (code omitted) ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/➡️/g, 'My recommendation:')
    .replace(/\bQ\d+\s*-\s*/g, '')
    .replace(/^\s*(#+|>|-{3,}|[-*]\s)/gm, '')
    .replace(/(\*\*|__|\*|_)/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/\n{2,}/g, '\n')
    .trim()

type Mood = 'talking' | 'listening' | 'thinking' | 'idle' | 'paused'

// Clawd for the terminal, in quarter blocks: at rest, and arms up (talking alternates the two).
const CLAWD_REST = [' ▐▛███▜▌ ', '▝▜█████▛▘', '  ▘▘ ▝▝  ']
const CLAWD_WAVE = ['▗▐▛███▜▌▖', ' ▜█████▛ ', '  ▘▘ ▝▝  ']

// Clawd for the desktop: an 11 by 6 pixel sprite, animated by mood (SMIL, no script).
function clawdSvg(mood: Mood) {
  const anim = (attr: string, values: string, dur: string) =>
    `<animate attributeName="${attr}" values="${values}" dur="${dur}" repeatCount="indefinite"/>`
  const bob =
    mood === 'paused'
      ? '0 0;0 0'
      : mood === 'talking' ? '0 0;0 -0.5;0 0' : mood === 'thinking' ? '0 0;0 -0.3;0 0' : '0 0;0 0'
  const bobDur = mood === 'talking' ? '0.35s' : '1.6s'
  const arm = (x: number) =>
    `<rect x="${x}" y="2" width="2" height="1">${mood === 'talking' ? anim('y', '2;1;2', '0.35s') : ''}</rect>`
  // Listening: he blinks now and then; thinking: his eyes look up.
  const eye = (x: number) =>
    `<rect x="${x}" y="${mood === 'thinking' ? 0.6 : mood === 'paused' ? 1.6 : 1}" width="1" height="${mood === 'paused' ? 0.4 : 1}" fill="#1f1e1d">${
      mood === 'listening' ? anim('height', '1;1;1;0.15;1', '2.4s') : ''
    }</rect>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -1.5 11 7" width="66" height="42" shape-rendering="crispEdges">
<g fill="#D97757" opacity="${mood === 'idle' ? 0.6 : 1}">
<animateTransform attributeName="transform" type="translate" values="${bob}" dur="${bobDur}" repeatCount="indefinite"/>
<rect x="2" y="0" width="7" height="4"/>${arm(0)}${arm(9)}
<rect x="2" y="4" width="1" height="1"/><rect x="4" y="4" width="1" height="1"/>
<rect x="6" y="4" width="1" height="1"/><rect x="8" y="4" width="1" height="1"/>
${eye(3)}${eye(7)}
</g></svg>`
}

// The volume as a small bar and a percentage.
function volumeBar(volume: number) {
  const filled = Math.round(Math.min(1.5, Math.max(0, volume)) * 6)
  return `${'▮'.repeat(filled)}${'▯'.repeat(9 - filled)} ${Math.round(volume * 100)}%`
}

// Splits text around its index-th word (words as the helper counts them: split on whitespace).
function splitAtWord(text: string, index: number) {
  const pieces = text.split(/(\s+)/)
  let seen = -1
  for (let i = 0; i < pieces.length; i += 1) {
    if (/^\s*$/.test(pieces[i] ?? '')) continue
    seen += 1
    if (seen === index) {
      return { before: pieces.slice(0, i).join(''), current: pieces[i] ?? '', after: pieces.slice(i + 1).join('') }
    }
  }
  return { before: text, current: '', after: '' }
}

type VoiceEvent = { seq: number; type: string; text?: string; reason?: string; index?: number; id?: string | null }
// A question for the driver: one already streaming to the helper as Claude writes it, or a whole answer.
type Job = { kind: 'stream'; id: string } | { kind: 'answer'; answer: string }
// Claude's reply as it streams: sentences go to the helper as soon as they are complete.
type Outgoing = { stream: Stream; piece: string } | { stream: Stream; end: string }
type Stream = { id: string; raw: string; sent: number; pieces: string[]; block: number; opened: boolean; off: boolean; done: boolean }
type Health = { ready: boolean; loading: string; error: string; stt: string; tts: string; config: string }

const run = {
  // Bumped whenever a running cycle should stop caring about its own results.
  generation: 0,
  uvPath: 'uv',
  socket: '',
  daemon: 'off' as 'off' | 'starting' | 'up',
  seq: 0,
  // What the mod last put in the prompt box; anything else there is the person's.
  lastFilled: '',
  // Set while an Enter waits for the final transcript.
  enterWaiter: undefined as ((text: string | undefined) => void) | undefined,
  // Claude's answers waiting for the driver, and the driver's wake-up.
  queue: [] as Job[],
  stream: undefined as Stream | undefined,
  // Pieces of streaming replies (and their ends) for the sender loop, in order.
  outbox: [] as Outgoing[],
  wakeSender: undefined as (() => void) | undefined,
  speechCount: 0,
  wake: undefined as (() => void) | undefined,
  traceLines: [] as string[],
}

// A trace of what the voice loop did, in <mod>/.trace.log, for debugging.
function trace($: EngineInterface, message: string) {
  const stamp = new Date().toISOString().slice(11, 23)
  run.traceLines = [...run.traceLines, `${stamp} ${message}`].slice(-300)
  void $.fs.write(`${$.plugin.root}/.trace.log`, `${run.traceLines.join('\n')}\n`).catch(() => undefined)
}

function helper($: EngineInterface) {
  return `${$.plugin.root}/bin/voice.py`
}

function delay($: EngineInterface, ms: number) {
  return new Promise<void>(resolve => {
    $.clock.after(ms, () => resolve())
  })
}

async function api($: EngineInterface, path: string, body?: unknown): Promise<any> {
  const response = await $.http.fetch(`http://voice-grill${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    socketPath: run.socket,
  })
  return JSON.parse(response.text)
}

function control($: EngineInterface, cmd: string) {
  trace($, `control ${cmd}`)
  return api($, '/control', { cmd }).catch(() => undefined)
}

async function setPhase($: EngineInterface, next: Phase) {
  trace($, `phase ${next}`)
  await update($, paused, () => false) // the helper starts each new step unpaused
  return update($, phase, () => next)
}

// Pauses or resumes what the helper is doing: reading (frozen mid-word) or listening (mic muted).
async function togglePause($: EngineInterface) {
  const now = await read($, phase)
  if ((now !== 'speaking' && now !== 'listening') || run.daemon !== 'up') return
  const answer = await api($, '/control', { cmd: 'toggle-pause' }).catch(() => undefined)
  if (answer?.ok) await update($, paused, () => Boolean(answer.paused))
  trace($, `pause ${answer?.paused}`)
}

// Changes the voice or speed in the running helper (and the config file): no restart.
async function changeSettings($: EngineInterface, change: { voice?: string; speed?: number; volume?: number; autoSend?: boolean }) {
  if (run.daemon !== 'up') {
    $.ui.toast('The speech helper is still starting; try again in a moment')
    return
  }
  const next = await api($, '/settings', change).catch(err => ({ error: String(err) }))
  if (next.error) {
    $.ui.toast(`Could not change it: ${next.error}`)
    return
  }
  trace($, `settings ${JSON.stringify(change)}`)
  await update($, settings, () => next as VoiceSettings)
}

function say($: EngineInterface, who: ChatLine['who'], text: string, visuals?: string[]) {
  return update($, chat, lines => [...lines, { who, text, visuals }].slice(-CHAT_LINES))
}

// Starts the speech daemon once and waits until its models are loaded.
async function ensureDaemon($: EngineInterface): Promise<Health> {
  if (run.daemon === 'off') {
    run.daemon = 'starting'
    trace($, 'daemon starting')
    void (async () => {
      const child = $.process.spawn({
        argv: [run.uvPath, 'run', '--quiet', '--script', helper($), 'serve', '--socket', run.socket],
      })
      for await (const { text } of child) trace($, `daemon: ${text.trimEnd()}`)
      run.daemon = 'off'
      trace($, 'daemon exited')
    })().catch(err => {
      run.daemon = 'off'
      trace($, `daemon failed: ${String(err)}`)
    })
  }
  const startedAt = await $.clock.now()
  for (;;) {
    const health: Health | undefined = await api($, '/health').catch(() => undefined)
    if (health?.error) throw new Error(health.error)
    if (health?.ready) {
      run.daemon = 'up'
      await update($, detail, () => `${health.stt} · ${health.tts}`)
      const current = await api($, '/settings').catch(() => null)
      await update($, settings, () => current as VoiceSettings | null)
      return health
    }
    if (health) await update($, detail, () => `${health.loading}…`)
    // The spawn loop above sets it back to off when the helper exits.
    if ((run.daemon as string) === 'off') throw new Error('the speech helper exited; run voice.py doctor')
    if ((await $.clock.now()) - startedAt > FIRST_LOAD_MS) throw new Error('the speech helper did not start')
    await delay($, 700)
  }
}

// Long-polls the daemon until an event of one of `types` arrives; undefined once stale.
async function waitFor(
  $: EngineInterface,
  mine: number,
  types: readonly string[],
  on: { partial?: (text: string) => Promise<void>; word?: (index: number) => Promise<void>; id?: string } = {},
): Promise<VoiceEvent | undefined> {
  for (;;) {
    if (mine !== run.generation) return undefined
    const got: { events: VoiceEvent[] } = await api($, `/events?after=${run.seq}&wait=1000`)
    for (const event of got.events) {
      run.seq = Math.max(run.seq, event.seq)
      if (mine !== run.generation) return undefined
      // A speech's events carry its id; another speech's (one that was cut off) are not ours.
      if (on.id !== undefined && (event.type === 'word' || event.type === 'spoken') && event.id !== on.id) continue
      if (event.type === 'partial' && on.partial) await on.partial(event.text ?? '')
      if (event.type === 'word' && on.word) await on.word(event.index ?? 0)
      if (event.type === 'error' || types.includes(event.type)) {
        trace($, `event ${event.type} ${event.reason ?? ''} ${(event.text ?? '').slice(0, 80)}`)
        return event
      }
    }
  }
}

async function activate($: EngineInterface) {
  if ((await read($, phase)) !== 'off') return
  trace($, 'activate')
  await update($, chat, () => [])
  await setPhase($, 'waiting')
  await $.ui.open({ id: PANE, title: 'Voice grilling', closeOnEscape: true })
  $.ui.toast('Voice grilling on: talk, then press Enter (or say "send it"). Esc leaves.')
  // Warm the models while Claude writes the first question.
  void ensureDaemon($).catch(err => fail($, 'the speech helper failed', String(err)))
}

async function deactivate($: EngineInterface, why?: string, isPaneClosed?: boolean) {
  trace($, `deactivate ${why ?? ''}`)
  run.generation += 1
  run.queue = []
  if (run.daemon === 'up') await control($, 'off')
  run.enterWaiter?.(undefined)
  const box = await $.prompt.read()
  if (run.lastFilled && box.text === run.lastFilled) await $.prompt.fill({ text: '' })
  run.lastFilled = ''
  await setPhase($, 'off')
  await update($, live, () => '')
  await update($, word, () => -1)
  if (!isPaneClosed) await $.ui.close({ id: PANE })
  if (why) $.ui.toast(why)
}

async function fail($: EngineInterface, what: string, err: string) {
  trace($, `FAIL ${what}: ${err}`)
  $.ui.log(`voice-grill: ${what}: ${err}`)
  await deactivate($, `Voice grilling stopped: ${what}. ${err}`.slice(0, 300))
}

// The live transcript goes in the prompt box until the person edits it.
async function fillLive($: EngineInterface, text: string) {
  await update($, live, () => text)
  const box = await $.prompt.read()
  if (box.text !== run.lastFilled) {
    trace($, `box edited by the person (${JSON.stringify(box.text.slice(0, 40))})`)
    await control($, 'cancel') // they took over: what is in the box is theirs
    return
  }
  await $.prompt.fill({ text })
  run.lastFilled = text
}

// Waits until the helper has read speech `id`, marking each word as it is said.
async function heard($: EngineInterface, id: string, mine: number): Promise<string | undefined> {
  await setPhase($, 'speaking')
  const event = await waitFor($, mine, ['spoken'], {
    id,
    word: async at => {
      await update($, word, () => at)
    },
  })
  await update($, word, () => -1)
  if (event?.type === 'error') throw new Error(event.text)
  return event?.reason
}

async function speak($: EngineInterface, text: string, mine: number): Promise<string | undefined> {
  run.speechCount += 1
  const id = `say-${run.speechCount}`
  const started = await api($, '/speak', { text, id })
  run.seq = Math.max(run.seq, started.seq)
  return heard($, id, mine)
}

// The SVG pictures in a message, drawn in the side panel instead of read.
function visualsOf(text: string) {
  const fenced = [...text.matchAll(/```svg\s*([\s\S]*?)```/g)].map(found => found[1]?.trim() ?? '')
  const bare = [...text.replace(/```[\s\S]*?```/g, '').matchAll(/<svg[\s\S]*?<\/svg>/g)].map(found => found[0])
  return [...fenced, ...bare].filter(svg => svg.startsWith('<svg') && svg.length <= 131_072)
}

// Where the last complete sentence of `raw` ends, at or after `from`; never inside a code
// block or SVG still being written, which is held back until it closes.
function sentenceEnd(raw: string, from: number) {
  const boundary = /[.!?:;](?=\s)|\n/g
  boundary.lastIndex = from
  let cut = from
  for (let found = boundary.exec(raw); found; found = boundary.exec(raw)) cut = found.index + found[0].length
  const open = /```|<svg/g
  open.lastIndex = from
  for (let found = open.exec(raw); found; found = open.exec(raw)) {
    const close = found[0] === '```' ? raw.indexOf('```', found.index + 3) : raw.indexOf('</svg>', found.index)
    if (close === -1) return Math.min(cut, found.index)
    open.lastIndex = close + (found[0] === '```' ? 3 : 6)
  }
  return cut
}

// Queues the next complete sentences of a streaming reply for the helper; `isEnd` queues the rest.
function feedStream(stream: Stream, isEnd: boolean) {
  if (stream.off) return
  const cut = isEnd ? stream.raw.length : sentenceEnd(stream.raw, stream.sent)
  if (cut <= stream.sent) return
  const piece = speakable(stream.raw.slice(stream.sent, cut))
  stream.sent = cut
  if (piece === '') return
  stream.pieces.push(piece)
  run.outbox.push({ stream, piece })
  run.wakeSender?.()
}

// The other long-lived loop (session.start's $ outlives any one event): sends what
// feedStream queued, so a hook never waits on the helper.
async function sender($: EngineInterface) {
  for (;;) {
    const next = run.outbox.shift()
    if (next === undefined) {
      await new Promise<void>(resolve => {
        run.wakeSender = resolve
      })
      run.wakeSender = undefined
      continue
    }
    try {
      if ('piece' in next) await sendPiece($, next.stream, next.piece)
      else await endStream($, next.stream, next.end)
    } catch (err) {
      next.stream.off = true
      trace($, `stream failed: ${String(err)}`)
    }
  }
}

async function sendPiece($: EngineInterface, stream: Stream, piece: string) {
  if (stream.off) return
  const text = stream.pieces.join(' ')
  const visuals = visualsOf(stream.raw)
  if (stream.opened) {
    await api($, '/speak', { text: piece, id: stream.id, more: true })
    await update($, chat, lines => lines.map(line => (line.id === stream.id ? { ...line, text, visuals } : line)))
    return
  }
  // The first question can arrive while the models still load: wait for them.
  if (run.daemon !== 'up') await ensureDaemon($)
  // The first sentence: a new question starts, and anything still running for the last one stops.
  stream.opened = true
  run.generation += 1
  const started = await api($, '/speak', { text: piece, id: stream.id, more: true })
  run.seq = Math.max(run.seq, started.seq)
  trace($, `streaming ${stream.id}`)
  await update($, chat, lines => [...lines, { who: 'claude' as const, text, id: stream.id, visuals }].slice(-CHAT_LINES))
  run.queue = [{ kind: 'stream', id: stream.id }]
  run.wake?.()
}

// The reply is all in: the helper reads what is left and then says it is done. A reply
// that never reached the helper is read whole instead.
async function endStream($: EngineInterface, stream: Stream, answer: string) {
  stream.done = answer.includes(DONE) || stream.raw.includes(DONE)
  if (!stream.opened || stream.off) {
    if (stream.opened || !answer.trim()) return
    await say($, 'claude', speakable(answer), visualsOf(answer))
    run.generation += 1
    run.queue = [{ kind: 'answer', answer }]
    run.wake?.()
    return
  }
  const visuals = visualsOf(stream.raw)
  await update($, chat, lines => lines.map(line => (line.id === stream.id ? { ...line, visuals } : line)))
  await api($, '/speak', { id: stream.id, more: false })
}

// One question: read it aloud, then listen until the answer is sent.
async function cycle($: EngineInterface, job: Job) {
  const mine = run.generation
  trace($, `cycle ${mine}: ${job.kind === 'stream' ? `stream ${job.id}` : job.answer.slice(0, 60)}`)
  await ensureDaemon($)
  if (mine !== run.generation) return

  const stream = job.kind === 'stream' && run.stream?.id === job.id ? run.stream : undefined
  const spoken = stream ? stream.pieces.join(' ') : job.kind === 'answer' ? speakable(job.answer) : ''
  let reason: string | undefined
  if (job.kind === 'stream') reason = await heard($, job.id, mine)
  else if (spoken) reason = await speak($, spoken, mine)
  if (reason === 'off') return deactivate($, 'Voice grilling off')
  if (mine !== run.generation) return
  if (stream ? stream.done : job.kind === 'answer' && job.answer.includes(DONE)) {
    return deactivate($, 'Grilling finished: voice off')
  }

  for (;;) {
    await setPhase($, 'listening')
    await update($, live, () => '')
    const box = await $.prompt.read()
    run.lastFilled = box.text // an empty box, or what the person left there
    const started = await api($, '/listen', {})
    run.seq = Math.max(run.seq, started.seq)
    const final = await waitFor($, mine, ['final'], { partial: text => fillLive($, text) })
    if (!final) return
    if (final.type === 'error') throw new Error(final.text)
    const text = (final.text ?? '').trim()

    if (final.reason === 'enter') {
      run.enterWaiter?.(text)
      await setPhase($, 'waiting')
      return
    }
    if (final.reason === 'cancel') {
      await setPhase($, 'waiting')
      return
    }
    if (final.reason === 'repeat') {
      if ((await speak($, spoken, mine)) === 'off') return deactivate($, 'Voice grilling off')
      continue
    }
    if (final.reason === 'off') {
      // Keep what was said so far in the box to send by hand.
      run.lastFilled = ''
      return deactivate($, 'Voice grilling off')
    }
    if (!text) {
      $.ui.toast("Didn't catch anything; still listening")
      continue
    }
    // Sent by the 1 key or the send phrase.
    await setPhase($, 'sending')
    const now = await $.prompt.read()
    if (now.text === run.lastFilled) await $.prompt.fill({ text: '' })
    run.lastFilled = ''
    await update($, live, () => '')
    await say($, 'you', text)
    await $.prompt.submit({ text, asUser: true })
    if (mine === run.generation) await setPhase($, 'waiting')
    return
  }
}

// The one long-lived loop: started by session.start, whose $ outlives its dispatch,
// it takes each of Claude's answers in turn and runs its question cycle.
async function driver($: EngineInterface) {
  trace($, 'driver started')
  for (;;) {
    const job = run.queue.shift()
    if (job === undefined) {
      await new Promise<void>(resolve => {
        run.wake = resolve
      })
      run.wake = undefined
      continue
    }
    try {
      await cycle($, job)
    } catch (err) {
      await fail($, 'voice loop failed', String(err))
    }
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Voice grilling controls (/voice-grill starts it)',
      argumentHint: '[on|off|status|config|restart]',
    })
    const found = await $.process
      .run(['sh', '-c', 'command -v uv || echo "$HOME/.local/bin/uv"; echo "${XDG_RUNTIME_DIR:-/tmp}"'])
      .catch(() => undefined)
    const [uv, runtime] = found?.stdout.trim().split('\n') ?? []
    run.uvPath = uv || 'uv'
    const id = Math.random().toString(36).slice(2, 10)
    run.socket = `${runtime || '/tmp'}/voice-grill-${id}.sock`
    // A reload drops any cycle that was running; wait for the next answer.
    const now = await read($, phase)
    if (now !== 'off' && now !== 'waiting') await setPhase($, 'waiting')
    const started = await next(e)
    void driver($)
    void sender($)

    return started
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const want = e.args.trim().toLowerCase()
    const isOn = (await read($, phase)) !== 'off'
    if (want === 'status' || want === 'config') {
      const health: Health | undefined =
        run.daemon === 'up' ? await api($, '/health').catch(() => undefined) : undefined
      const where = await $.process.run([run.uvPath, 'run', '--quiet', '--script', helper($), 'config'], {
        timeoutMs: 120_000,
      })
      return {
        text: [
          `Voice grilling is ${isOn ? 'on' : 'off'}; speech helper ${run.daemon}.`,
          health ? `Engines: ${health.stt} · ${health.tts}` : '',
          `Config: ${where.stdout.trim()} (changes apply after /voice-mode restart)`,
          `Check it with: ${helper($)} doctor`,
          `Trace: ${$.plugin.root}/.trace.log`,
        ]
          .filter(Boolean)
          .join('\n'),
      }
    }
    if (want === 'restart') {
      if (run.daemon !== 'off') await api($, '/shutdown', {}).catch(() => undefined)
      run.daemon = 'off'
      if (isOn) void ensureDaemon($).catch(err => fail($, 'the speech helper failed', String(err)))
      return { text: 'Speech helper restarting with the current config.' }
    }
    if (want === 'off' || (want === '' && isOn)) {
      await deactivate($)
      return { text: 'Voice grilling off.' }
    }
    await activate($)
    return { text: 'Voice grilling on. It starts reading after the next question.' }
  })

  on('skill.prompt', async ($, e, next) => {
    if (START_SKILLS.includes(e.skill)) await activate($)
    const result = await next(e)
    if (!RULED_SKILLS.includes(e.skill) || (await read($, phase)) === 'off') return result

    return { text: `${result.text}\n\n${RULES}` }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if ((await read($, phase)) === 'off') return composed

    return {
      sections: [...composed.sections, { id: 'voice-grill:rules', text: RULES, scope: 'session' }],
    }
  })

  // Enter on the live transcript sends the final transcript; typing your own takes over.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin') return next(e)
    try {
      const now = await read($, phase)
      if (now === 'listening' && e.text.trim() && e.text === run.lastFilled) {
        trace($, 'enter on the live transcript')
        const final = await new Promise<string | undefined>(resolve => {
          run.enterWaiter = resolve
          $.clock.after(8000, () => resolve(undefined))
          void control($, 'enter')
        })
        run.enterWaiter = undefined
        run.lastFilled = ''
        await update($, live, () => '')
        await say($, 'you', final || e.text)
        return next({ ...e, text: final || e.text })
      }
      if (now !== 'off') await say($, 'you', e.text)
      if (now === 'speaking' || now === 'listening') {
        trace($, 'typed prompt takes over')
        run.generation += 1
        run.lastFilled = ''
        await control($, 'cancel')
        await update($, live, () => '')
        await setPhase($, 'waiting')
      }
    } catch (err) {
      trace($, `prompt.submit: ${String(err)}`)
    }

    return next(e)
  })

  // Claude's reply streams to the helper sentence by sentence, so reading starts while it writes.
  on('turn.step', async function* ($, e, next) {
    const steps = next(e)
    if (e.agentId || (await read($, phase)) === 'off') return yield* steps
    if (run.stream?.id !== e.turnId) {
      run.stream = { id: e.turnId, raw: '', sent: 0, pieces: [], block: -1, opened: false, off: false, done: false }
    }
    const stream = run.stream
    for (;;) {
      const step = await steps.next()
      if (step.done) {
        feedStream(stream, true) // a step's text is complete when it ends
        return step.value
      }
      const chunk = step.value
      if (chunk.kind === 'text') {
        if (chunk.index !== stream.block && stream.raw !== '') stream.raw += '\n'
        stream.block = chunk.index
        stream.raw += chunk.text
        feedStream(stream, false)
      }
      yield chunk
    }
  })

  // Space in the composer while it holds only what the mod put there pauses or resumes.
  on('prompt.edit', async ($, e, next) => {
    if (e.key?.key !== ' ' || e.inputText !== ' ' || e.key.ctrl || e.key.meta) return next(e)
    const now = await read($, phase)
    if ((now !== 'speaking' && now !== 'listening') || e.text !== run.lastFilled) return next(e)
    await togglePause($)
    return next({ ...e, inputText: '' })
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId || (await read($, phase)) === 'off') return result
    if (e.isAborted) {
      // Esc during a turn leaves voice mode too.
      await deactivate($, 'Voice grilling off')
      return result
    }
    const stream = run.stream?.id === e.turnId ? run.stream : undefined
    if (stream && !stream.off && stream.pieces.length > 0) {
      // Being read already (or about to be, once the models load): the sender finishes it.
      feedStream(stream, true)
      run.outbox.push({ stream, end: e.answer })
      run.wakeSender?.()
      return result
    }
    if (e.reason !== 'answer' || !e.answer.trim()) return result
    await say($, 'claude', speakable(e.answer), visualsOf(e.answer))
    // Hand the answer to the driver; a cycle still running for an older one stops.
    run.generation += 1
    run.queue = [{ kind: 'answer', answer: e.answer }]
    trace($, `queued answer (driver ${run.wake ? 'idle' : 'busy'})`)
    run.wake?.()

    return result
  })

  // Esc at an empty, idle prompt closes the pane, and that ends voice mode.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person' && (await read($, phase)) !== 'off') {
      await deactivate($, 'Voice grilling off', true)
    }
    return next(e)
  })

  // Ctrl+D in the pane's key catcher: leave voice mode and type instead.
  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE || e.element !== 'keys') return next(e)
    const data = e.data as { type?: string } | null
    if (data?.type === 'stop') await deactivate($, 'Voice grilling off: type away')
    if (data?.type === 'pause') await togglePause($)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    // The key catcher needs a Client, which the terminal and desktop draw; Svg draws Clawd where it can.
    const Client = 'Client' in elements ? elements.Client : undefined
    const Select = 'Select' in elements ? elements.Select : undefined
    // The terminal's table has an Svg that draws nothing there, so it gets the block-character Clawd.
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : undefined
    const now = await read($, phase)
    const heardText = await read($, live)
    const engines = await read($, detail)
    const lines = await read($, chat)
    const tts = await read($, settings)
    const saying = await read($, word)
    const english = (tts?.voices ?? []).filter(voice => (voice.split('_')[0] ?? '') in ACCENTS)
    const at = english.indexOf(tts?.voice ?? '')
    const step = (by: number) => english[(at + by + english.length) % english.length] ?? english[0]
    const shown = lines.slice(-CHAT_SHOWN)
    const lastClaude = shown.map(line => line.who).lastIndexOf('claude')
    const isPaused = await read($, paused)
    const [label, tone] = isPaused ? ['Paused', 'warning'] : PHASE_LABEL[now]
    const thinking = (now === 'waiting' || now === 'sending') && shown[shown.length - 1]?.who === 'you'

    // Claude's line being read aloud: said words plain, the current one marked, the rest dim.
    const reading = (text: string) => {
      const { before, current, after } = splitAtWord(text, saying)
      return (
        <Text>
          {before}
          <Text bold color="inverseText" backgroundColor="claude">
            {current}
          </Text>
          <Text dimColor>{after}</Text>
        </Text>
      )
    }
    // Clawd: animated SVG on the desktop; on the terminal his arms wave word by word.
    const mood: Mood = isPaused
      ? 'paused'
      : now === 'speaking' ? 'talking' : now === 'listening' ? 'listening' : thinking ? 'thinking' : 'idle'
    const clawd = Svg ? (
      <Svg key="clawd" source={clawdSvg(mood)} alt={`Clawd, ${mood}`} width={66} height={48} isInteractive />
    ) : (
      <Text color="claude" dimColor={mood === 'idle'}>
        {(mood === 'talking' && saying % 2 === 1 ? CLAWD_WAVE : CLAWD_REST).join('\n')}
      </Text>
    )

    return (
      <Box flexDirection="column" gap={1}>
        <Box borderStyle="round" borderColor="claude" paddingX={1} gap={2} alignItems="center">
          {clawd}
          <Box flexDirection="column">
            <Text bold>Voice grilling</Text>
            <Box alignItems="center" gap={1}>
              <Text>
                <Text color={tone}>● </Text>
                {label}
              </Text>
              {(now === 'speaking' || now === 'listening') && (
                <Button key="pause" label={isPaused ? '▶ Resume' : '❚❚ Pause'} onPress={() => togglePause($)} />
              )}
            </Box>
            {engines !== '' && <Text dimColor>{engines}</Text>}
            {now !== 'off' && Client && <Client key="keys" module="./keys.tsx" props={{}} />}
          </Box>
        </Box>

        {now !== 'off' && tts && (
          <Box flexDirection="column" paddingX={1}>
            {english.length > 0 && !tts.voiceNeedsRestart && Select && (
              <Select
                key="voice"
                label="Voice"
                value={tts.voice}
                options={english.map(voice => ({ key: voice, value: voice, label: voiceLabel(voice) }))}
                onSelect={(voice: string) => changeSettings($, { voice })}
              />
            )}
            {english.length > 0 && !tts.voiceNeedsRestart && !Select && (
              <Box alignItems="center" gap={1}>
                <Text dimColor>Voice </Text>
                <Button key="voice-prev" label="◀" onPress={() => changeSettings($, { voice: step(-1) })} />
                <Text>{voiceLabel(tts.voice)}</Text>
                <Button key="voice-next" label="▶" onPress={() => changeSettings($, { voice: step(1) })} />
              </Box>
            )}
            {tts.voiceNeedsRestart && <Text dimColor>Voice {tts.voice} (change it in the config, then /voice-mode restart)</Text>}
            <Box alignItems="center" gap={1} flexWrap="wrap">
              <Text dimColor>Speed </Text>
              <Button key="slower" label="−" onPress={() => changeSettings($, { speed: tts.speed - SPEED_STEP })} />
              <Text bold>{tts.speed.toFixed(2)}×</Text>
              <Button key="faster" label="+" onPress={() => changeSettings($, { speed: tts.speed + SPEED_STEP })} />
              <Text dimColor>   Volume </Text>
              <Button
                key="quieter"
                label="−"
                onPress={() => changeSettings($, { volume: (tts.volume ?? 1) - VOLUME_STEP })}
              />
              <Text bold>{volumeBar(tts.volume ?? 1)}</Text>
              <Button
                key="louder"
                label="+"
                onPress={() => changeSettings($, { volume: (tts.volume ?? 1) + VOLUME_STEP })}
              />
            </Box>
            <Box>
              <Button
                key="auto-send"
                label={`${tts.autoSend ? '☑' : '☐'} Auto-send after a ${tts.autoSendSeconds ?? 2.5}s pause`}
                onPress={() => changeSettings($, { autoSend: !tts.autoSend })}
              />
            </Box>
          </Box>
        )}

        <Box flexDirection="column" gap={1} paddingX={1}>
          {shown.map((line, index) =>
            line.who === 'claude' ? (
              <Box key={`line-${index}`} flexDirection="column" gap={1}>
                <Box>
                  <Text color={now === 'speaking' && index === lastClaude ? 'claude' : 'text'}>⏺ </Text>
                  <Box flexShrink={1}>
                    {now === 'speaking' && index === lastClaude && saying >= 0 ? reading(line.text) : <Text>{line.text}</Text>}
                  </Box>
                </Box>
                {Svg &&
                  (line.visuals ?? []).map((svg, at) => (
                    <Svg key={`visual-${index}-${at}`} source={svg} alt="A picture from Claude" isInteractive />
                  ))}
              </Box>
            ) : (
              <Box key={`line-${index}`}>
                <Text dimColor>&gt; </Text>
                <Box flexShrink={1}>
                  <Text dimColor>{line.text}</Text>
                </Box>
              </Box>
            ),
          )}
        </Box>

        {now !== 'off' && (
          <Box borderStyle="round" borderColor={now === 'listening' ? 'success' : 'promptBorder'} paddingX={1}>
            <Text>
              <Text color={now === 'listening' ? 'success' : 'subtle'}>&gt; </Text>
              {now === 'listening' && <Text>{heardText === '' ? '▍' : `${heardText} ▍`}</Text>}
            </Text>
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, phase)
    if (now === 'off' || e.props.hasSurvey) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const engines = await read($, detail)
    const heard = await read($, live)
    const isPaused = await read($, paused)
    const status: Record<Phase, string> = {
      off: '',
      waiting: 'waiting for the next question…',
      speaking: 'reading the question…',
      listening: 'listening: press Enter or 1, or say "send it"',
      sending: 'sending your answer…',
    }

    return (
      <Box flexDirection="column">
        <Text>
          <Text color="red">● </Text>
          Voice grilling: {isPaused ? 'paused (Space resumes)' : status[now]}
          {now === 'waiting' && engines.endsWith('…') ? ` (${engines})` : ''}
        </Text>
        {now === 'listening' && heard !== '' && <Text dimColor>“{heard}”</Text>}
        <Box>
          {now === 'speaking' && (
            <Button key="skip" hotkey="1" label="Skip to answering" onPress={() => control($, 'skip')} />
          )}
          {now === 'listening' && (
            <Button key="send" hotkey="1" label="Send answer" onPress={() => control($, 'send')} />
          )}
          {now === 'listening' && (
            <Button key="repeat" hotkey="2" label="Repeat question" onPress={() => control($, 'repeat')} />
          )}
          {(now === 'speaking' || now === 'listening') && (
            <Button key="pause" hotkey="4" label={isPaused ? 'Resume' : 'Pause'} onPress={() => togglePause($)} />
          )}
          <Button key="off" hotkey="3" label="Voice off" onPress={() => deactivate($, 'Voice grilling off')} />
        </Box>
      </Box>
    )
  })
}
