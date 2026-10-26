import { describe, expect, it } from 'vitest';
import { FailoverTranscriber, GeminiTranscriber, isTranscribableWav, MetaTranscriber, MockTranscriber, wavInfo } from './providers/transcription';

/** Silent mono 16-bit PCM WAV. */
export function makeWav(seconds: number, sampleRate = 16000, channels = 1): Buffer {
  const data = Buffer.alloc(Math.round(seconds * sampleRate) * channels * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

describe('WAV checks', () => {
  it('reads the header and accepts only what Muse Voice Transcribe takes', () => {
    expect(wavInfo(makeWav(2.5))).toEqual({ channels: 1, sampleRate: 16000, bitsPerSample: 16, durationMs: 2500 });
    expect(isTranscribableWav(makeWav(1))).toBe(true);
    expect(isTranscribableWav(makeWav(1, 24000))).toBe(true);
    expect(isTranscribableWav(makeWav(1, 44100))).toBe(false);
    expect(isTranscribableWav(makeWav(1, 16000, 2))).toBe(false);
    expect(wavInfo(Buffer.from('OggS not a wav file at all, just some bytes here....'))).toBeNull();
  });
});

describe('Muse Voice Transcribe', () => {
  it('posts multipart request + audio with keyword hints and reads the transcript', async () => {
    let seen: { url: string; auth: string | null; request: Record<string, unknown>; audioType: string; audioBytes: number } | null = null;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const form = init!.body as FormData;
      const audio = form.get('audio') as Blob;
      seen = { url: String(url), auth: new Headers(init!.headers).get('authorization'), request: JSON.parse(await (form.get('request') as Blob).text()), audioType: audio.type, audioBytes: audio.size };
      return new Response(JSON.stringify({ sessionId: 's', transcript: ' Do you have sourdough today? ', audioDurationMs: 2100, turns: [] }), { status: 200 });
    }) as typeof fetch;
    const wav = makeWav(2.1);
    const r = await new MetaTranscriber({ apiKey: 'k', fetchImpl }).transcribe({ wav, keywords: ["Bella's Bakery", 'sourdough'], languageBias: ['English'] });
    expect(r).toEqual({ text: 'Do you have sourdough today?', durationMs: 2100, model: 'muse-voice-transcribe-1.0', provider: 'meta' });
    expect(seen).toMatchObject({ url: 'https://api.meta.ai/v1/asr/transcribe', auth: 'Bearer k', audioType: 'audio/wav', audioBytes: wav.length });
    expect(seen!.request).toEqual({ model: 'muse-voice-transcribe-1.0', audioEncoding: 'WAV', mode: 'PUSH_TO_TALK', languageBias: ['English'], keywords: ["Bella's Bakery", 'sourdough'] });
  });

  it('turns billing and auth errors into account errors', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { message: 'Billing verification failed.' } }), { status: 402 })) as typeof fetch;
    await expect(new MetaTranscriber({ apiKey: 'k', fetchImpl }).transcribe({ wav: makeWav(1) })).rejects.toMatchObject({ kind: 'auth', message: expect.stringContaining('HTTP 402: Billing verification failed') });
  });
});

describe('backup and failover', () => {
  it('Gemini sends the WAV as input_audio and returns the text', async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ model: 'gemini-3.1-flash-lite', choices: [{ message: { content: 'Can I order a cake for Saturday?' } }] }), { status: 200 });
    }) as typeof fetch;
    const r = await new GeminiTranscriber({ apiKey: 'k', fetchImpl }).transcribe({ wav: makeWav(1), keywords: ['Bella'] });
    expect(r).toMatchObject({ text: 'Can I order a cake for Saturday?', provider: 'google' });
    const user = (body.messages as { role: string; content: unknown }[])[1]!;
    expect(user.content).toEqual([{ type: 'input_audio', input_audio: { data: makeWav(1).toString('base64'), format: 'wav' } }]);
  });

  it('falls over from a failing Meta to the next provider', async () => {
    const failing = new MetaTranscriber({ apiKey: 'k', fetchImpl: (async () => new Response('{}', { status: 402 })) as typeof fetch });
    const events: string[] = [];
    const r = await new FailoverTranscriber([failing, new MockTranscriber()], (from) => events.push(from)).transcribe({ wav: makeWav(3) });
    expect(r.provider).toBe('mock');
    expect(r.text).toContain('3 seconds');
    expect(events).toEqual(['meta']);
  });
});
