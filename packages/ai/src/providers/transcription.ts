import { COMPATIBLE_PRESETS, compatibleFetch } from './openai';
import { AiProviderError } from './types';

/**
 * Speech to text for voice notes. Meta's Muse Voice Transcribe is the main
 * provider; Gemini's audio understanding is the backup; an offline stand-in keeps
 * development and tests working without a key.
 *
 * Muse Voice Transcribe accepts only WAV: mono, 16-bit PCM, 16 or 24 kHz.
 * Convert other formats (WhatsApp sends OGG/Opus) before calling.
 */

export interface TranscriptionInput {
  /** WAV audio: mono, 16-bit PCM, 16 or 24 kHz */
  wav: Buffer;
  /** Words to bias recognition toward, such as the business and product names */
  keywords?: string[];
  /** Languages to expect, e.g. ["English"]; a hint, not forced */
  languageBias?: string[];
}
export interface TranscriptionResult {
  text: string;
  /** The provider heard no speech: a final answer, not a failure to retry elsewhere. */
  noSpeech?: boolean;
  durationMs?: number;
  model: string;
  provider: string;
}
export interface TranscriptionProvider {
  readonly name: string;
  transcribe(input: TranscriptionInput): Promise<TranscriptionResult>;
}

export const MUSE_TRANSCRIBE_MODEL = 'muse-voice-transcribe-1.0';
const NO_SPEECH = '[NO_SPEECH]';

/** Reads a WAV header; null when the buffer isn't a PCM WAV file. */
export function wavInfo(buf: Buffer): { channels: number; sampleRate: number; bitsPerSample: number; durationMs: number } | null {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  let fmt: { channels: number; sampleRate: number; bitsPerSample: number; format: number } | null = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(offset + 8), channels: buf.readUInt16LE(offset + 10), sampleRate: buf.readUInt32LE(offset + 12), bitsPerSample: buf.readUInt16LE(offset + 22) };
    if (id === 'data' && fmt) {
      if (fmt.format !== 1) return null;
      const dataBytes = Math.min(size, buf.length - offset - 8);
      return { channels: fmt.channels, sampleRate: fmt.sampleRate, bitsPerSample: fmt.bitsPerSample, durationMs: Math.round((dataBytes / (fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8))) * 1000) };
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

/** True when Muse Voice Transcribe accepts the file as is. */
export function isTranscribableWav(buf: Buffer): boolean {
  const info = wavInfo(buf);
  return Boolean(info && info.channels === 1 && info.bitsPerSample === 16 && (info.sampleRate === 16000 || info.sampleRate === 24000));
}

export class MetaTranscriber implements TranscriptionProvider {
  readonly name = 'meta';
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: { apiKey: string; fetchImpl?: typeof fetch }) {
    this.fetchImpl = config.fetchImpl ?? ((...args) => fetch(...args));
  }

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    const form = new FormData();
    const request = {
      model: MUSE_TRANSCRIBE_MODEL,
      audioEncoding: 'WAV',
      mode: 'PUSH_TO_TALK',
      ...(input.languageBias?.length ? { languageBias: input.languageBias } : {}),
      ...(input.keywords?.length ? { keywords: input.keywords.slice(0, 50) } : {}),
    };
    form.append('request', new Blob([JSON.stringify(request)], { type: 'application/json' }));
    form.append('audio', new Blob([new Uint8Array(input.wav)], { type: 'audio/wav' }), 'voice-note.wav');
    let res: Response;
    try {
      res = await this.fetchImpl(`${COMPATIBLE_PRESETS.meta.baseUrl}/asr/transcribe`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.config.apiKey}`, accept: 'application/json' },
        body: form,
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new AiProviderError('Could not reach the Meta Model API', true, 'network');
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } | string; message?: string };
      const detail = typeof body.error === 'string' ? body.error : (body.error?.message ?? body.message ?? '');
      const kind = res.status === 429 ? 'rate_limit' : res.status === 401 || res.status === 402 || res.status === 403 ? 'auth' : res.status >= 500 ? 'server' : 'invalid_request';
      throw new AiProviderError(`Meta Voice Transcribe returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`, res.status === 429 || res.status >= 500, kind);
    }
    const json = (await res.json()) as { transcript?: string; audioDurationMs?: number };
    const text = (json.transcript ?? '').trim();
    // A speech recognizer's empty transcript means it heard no speech.
    return { text, noSpeech: !text, durationMs: json.audioDurationMs, model: MUSE_TRANSCRIBE_MODEL, provider: this.name };
  }
}

/** Backup: Gemini's audio understanding through its OpenAI-compatible chat endpoint. */
export class GeminiTranscriber implements TranscriptionProvider {
  readonly name = 'google';
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: { apiKey: string; model?: string; fetchImpl?: typeof fetch }) {
    this.fetchImpl = config.fetchImpl ?? ((...args) => fetch(...args));
  }

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    const model = this.config.model ?? COMPATIBLE_PRESETS.google.fastModel;
    // Spelling hints only: without the "never output" rule, silence came back as the hint list.
    const hint = input.keywords?.length ? ` If any of these names are spoken, spell them this way: ${input.keywords.slice(0, 30).join(', ')}. Never output a name that isn't spoken.` : '';
    const res = await compatibleFetch<{ model?: string; choices: { message: { content: string | null } }[] }>(this.fetchImpl, 'Google Gemini', COMPATIBLE_PRESETS.google.baseUrl, this.config.apiKey, '/chat/completions', {
      model,
      max_tokens: 2000,
      messages: [
        { role: 'system', content: `Transcribe the audio exactly as spoken, in the language spoken. Output only the transcript, with no notes, quotes or labels. If there is no clear speech (silence, music or noise), output exactly ${NO_SPEECH}.${hint}` },
        { role: 'user', content: [{ type: 'input_audio', input_audio: { data: input.wav.toString('base64'), format: 'wav' } }] },
      ],
    });
    const text = (res.choices[0]?.message.content ?? '').trim();
    const noSpeech = text.toUpperCase().includes(NO_SPEECH);
    return { text: noSpeech ? '' : text, noSpeech, durationMs: wavInfo(input.wav)?.durationMs, model: res.model ?? model, provider: this.name };
  }
}

/** Offline stand-in: can't understand speech, so it says what it received. */
export class MockTranscriber implements TranscriptionProvider {
  readonly name = 'mock';
  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    const ms = wavInfo(input.wav)?.durationMs ?? 0;
    return { text: `[Voice note, ${Math.max(1, Math.round(ms / 1000))} seconds. Add a Meta Model API key to transcribe it.]`, durationMs: ms, model: 'mock-transcribe-1', provider: this.name };
  }
}

/** Tries providers in order; a provider's failure moves on to the next one. */
export class FailoverTranscriber implements TranscriptionProvider {
  readonly name: string;
  constructor(private readonly chain: TranscriptionProvider[], private readonly onFailover?: (from: string, reason: string) => void) {
    if (!chain.length) throw new Error('FailoverTranscriber needs at least one provider');
    this.name = chain[0]!.name;
  }
  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    let last: unknown;
    for (const p of this.chain) {
      try {
        const r = await p.transcribe(input);
        if (r.text || r.noSpeech || p === this.chain[this.chain.length - 1]) return r;
        last = new AiProviderError(`${p.name} returned an empty transcript`, true, 'server');
      } catch (error) {
        last = error;
        this.onFailover?.(p.name, error instanceof Error ? error.message : String(error));
      }
    }
    throw last;
  }
}
