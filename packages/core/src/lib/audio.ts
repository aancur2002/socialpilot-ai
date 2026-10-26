import { spawn } from 'node:child_process';
import { isTranscribableWav } from '@socialpilot/ai';

/** Voice notes longer than this are not transcribed (Muse Voice Transcribe's limit). */
export const MAX_VOICE_NOTE_BYTES = 32 * 1024 * 1024;

/**
 * Returns audio as mono 16-bit 16 kHz WAV, the format Muse Voice Transcribe accepts.
 * WAV recorded in the browser passes through; anything else (WhatsApp's OGG/Opus,
 * MP3, M4A) is converted with ffmpeg.
 */
export async function toTranscribableWav(audio: Buffer): Promise<Buffer> {
  if (isTranscribableWav(audio)) return audio;
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-t', '600', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      reject(new Error('Converting this audio needs ffmpeg, which is not installed on the server'));
      return;
    }
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), 60_000);
    proc.stdout.on('data', (c: Buffer) => out.push(c));
    proc.stderr.on('data', (c: Buffer) => (err += c.toString()).slice(-500));
    proc.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new Error(e.code === 'ENOENT' ? 'Converting this audio needs ffmpeg, which is not installed on the server' : `ffmpeg failed: ${e.message}`));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.length) resolve(Buffer.concat(out));
      else reject(new Error(`Could not convert the audio${err ? `: ${err.trim().slice(-200)}` : ''}`));
    });
    proc.stdin.on('error', () => undefined);
    proc.stdin.end(audio);
  });
}
