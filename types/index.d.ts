export type Phase = 'off' | 'waiting' | 'speaking' | 'listening' | 'sending'
export type ChatLine = { who: 'claude' | 'you'; text: string; id?: string; visuals?: string[] }
export type VoiceSettings = { voice: string; speed: number; volume: number; autoSend: boolean; autoSendSeconds: number; voices: string[]; voiceNeedsRestart: boolean }

declare module 'claude-code' {
  interface PluginState {
    'voice-grill': { phase: Phase; live: string; detail: string; chat: ChatLine[]; settings: VoiceSettings | null; word: number; paused: boolean }
  }
}
