/**
 * Server-side media inspection: the declared MIME type is never trusted —
 * the file's magic bytes decide what it is.
 */
export interface MediaInfo {
  mimeType: string;
  kind: 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'AUDIO';
  width?: number;
  height?: number;
}

const startsWith = (buf: Buffer, bytes: number[], offset = 0) => bytes.every((b, i) => buf[offset + i] === b);

export function sniffMime(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
  if (buf.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (buf.toString('ascii', 0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12);
    return brand === 'qt  ' ? 'video/quicktime' : brand === 'M4A ' ? 'audio/mp4' : 'video/mp4';
  }
  if (startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  if (buf.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

function pngSize(buf: Buffer) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function gifSize(buf: Buffer) {
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function jpegSize(buf: Buffer) {
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) return undefined;
    const marker = buf[offset + 1]!;
    const length = buf.readUInt16BE(offset + 2);
    // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return undefined;
}

function webpSize(buf: Buffer) {
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
  }
  return undefined;
}

export const TEXT_MIME_TYPES = ['text/plain', 'text/markdown', 'text/csv'];

export function inspectMedia(buf: Buffer, declaredMime: string, fileName: string): MediaInfo | null {
  const sniffed = sniffMime(buf);
  if (!sniffed) {
    // Plain-text documents have no magic bytes; accept only valid UTF-8 without NULs.
    const isText = TEXT_MIME_TYPES.includes(declaredMime) || /\.(txt|md|csv)$/i.test(fileName);
    if (isText && !buf.includes(0) && Buffer.from(buf.toString('utf8'), 'utf8').equals(buf)) {
      return { mimeType: TEXT_MIME_TYPES.includes(declaredMime) ? declaredMime : 'text/plain', kind: 'DOCUMENT' };
    }
    return null;
  }
  if (sniffed.startsWith('image/')) {
    let size: { width: number; height: number } | undefined;
    try {
      size = sniffed === 'image/png' ? pngSize(buf) : sniffed === 'image/gif' ? gifSize(buf) : sniffed === 'image/jpeg' ? jpegSize(buf) : webpSize(buf);
    } catch {
      size = undefined;
    }
    return { mimeType: sniffed, kind: 'IMAGE', ...size };
  }
  if (sniffed.startsWith('audio/')) return { mimeType: sniffed, kind: 'AUDIO' };
  // WebM is the same container for audio and video; browsers record voice as audio/webm.
  if (sniffed === 'video/webm' && declaredMime.startsWith('audio/')) return { mimeType: 'audio/webm', kind: 'AUDIO' };
  if (sniffed.startsWith('video/')) return { mimeType: sniffed, kind: 'VIDEO' };
  return { mimeType: sniffed, kind: 'DOCUMENT' };
}
