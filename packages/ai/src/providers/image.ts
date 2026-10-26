import { deflateSync } from 'node:zlib';
import { COMPATIBLE_PRESETS, compatibleFetch } from './openai';
import { AiProviderError } from './types';

/**
 * Image generation. Meta's Muse Image (`muse-image-1.0`) through the Meta Model
 * API's OpenAI-compatible images endpoint, plus an offline stand-in for
 * development and demos without a key.
 */

export type ImageShape = 'square' | 'landscape' | 'portrait';
export interface GeneratedImage {
  data: Buffer;
  mimeType: 'image/png';
  model: string;
}
export interface EditedImage {
  data: Buffer;
  /** Usually WebP or PNG; convert before publishing */
  mimeType: string;
  model: string;
}
export interface ImageEditInput {
  /** 1 to 10 source images */
  images: { data: Buffer; mimeType: string }[];
  prompt: string;
  user?: string;
}
export interface ImageProvider {
  readonly name: string;
  readonly model: string;
  generate(input: { prompt: string; shape?: ImageShape; user?: string }): Promise<GeneratedImage>;
  /** Changes or combines existing images following the prompt. */
  edit(input: ImageEditInput): Promise<EditedImage>;
}

export const MUSE_IMAGE_MODEL = 'muse-image-1.0';
const SIZES: Record<ImageShape, string> = { square: '1024x1024', landscape: '1792x1024', portrait: '1024x1792' };

export class MetaImageProvider implements ImageProvider {
  readonly name = 'meta';
  readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: { apiKey: string; model?: string; fetchImpl?: typeof fetch }) {
    this.model = config.model ?? MUSE_IMAGE_MODEL;
    this.fetchImpl = config.fetchImpl ?? ((...args) => fetch(...args));
  }

  async generate(input: { prompt: string; shape?: ImageShape; user?: string }): Promise<GeneratedImage> {
    const res = await compatibleFetch<{ data?: { b64_json?: string }[] }>(this.fetchImpl, 'Meta Model', COMPATIBLE_PRESETS.meta.baseUrl, this.config.apiKey, '/images/generations', {
      model: this.model,
      prompt: input.prompt.slice(0, 4000),
      n: 1,
      size: SIZES[input.shape ?? 'square'],
      // PNG, not the default WebP: Instagram and some other platforms reject WebP.
      output_format: 'png',
      response_format: 'b64_json',
      ...(input.user ? { user: input.user } : {}),
    });
    const b64 = res.data?.[0]?.b64_json;
    if (!b64) throw new AiProviderError('Muse Image returned no image', true, 'server');
    return { data: Buffer.from(b64, 'base64'), mimeType: 'image/png', model: this.model };
  }

  /** JSON form of /images/edits: images go in as data URLs. Edits take no mask or size. */
  async edit(input: ImageEditInput): Promise<EditedImage> {
    const res = await compatibleFetch<{ data?: { b64_json?: string }[]; output_format?: string }>(this.fetchImpl, 'Meta Model', COMPATIBLE_PRESETS.meta.baseUrl, this.config.apiKey, '/images/edits', {
      model: this.model,
      prompt: input.prompt.slice(0, 4000),
      images: input.images.slice(0, 10).map((img) => ({ image_url: `data:${img.mimeType};base64,${img.data.toString('base64')}` })),
      n: 1,
      ...(input.user ? { user: input.user } : {}),
    });
    const b64 = res.data?.[0]?.b64_json;
    if (!b64) throw new AiProviderError('Muse Image returned no image', true, 'server');
    return { data: Buffer.from(b64, 'base64'), mimeType: `image/${res.output_format ?? 'webp'}`, model: this.model };
  }
}

// ── Offline stand-in: a small branded PNG, so the flow works without a key ──

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encodes an RGB image as PNG. */
export function encodePng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Deterministic gradient derived from the prompt: clearly a placeholder, never mistaken for a real image. */
export class MockImageProvider implements ImageProvider {
  readonly name = 'mock';
  readonly model = 'mock-image-1';

  async generate(input: { prompt: string; shape?: ImageShape }): Promise<GeneratedImage> {
    const [w, h] = { square: [512, 512], landscape: [768, 432], portrait: [432, 768] }[input.shape ?? 'square'] as [number, number];
    let seed = 0;
    for (const ch of input.prompt) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const a: [number, number, number] = [40 + (seed % 120), 90 + ((seed >> 8) % 120), 110 + ((seed >> 16) % 120)];
    const b: [number, number, number] = [20, 33, 61];
    const data = encodePng(w, h, (x, y) => {
      const t = (x / w + y / h) / 2;
      const stripe = Math.floor((x + y) / 24) % 2 === 0 ? 0 : 10;
      return [0, 1, 2].map((i) => Math.round(a[i]! * (1 - t) + b[i]! * t + stripe)) as [number, number, number];
    });
    return { data, mimeType: 'image/png', model: this.model };
  }

  /** Returns the first source image unchanged: the offline stand-in can't edit. */
  async edit(input: ImageEditInput): Promise<EditedImage> {
    const first = input.images[0];
    if (!first) throw new AiProviderError('No image to edit', false, 'invalid_request');
    return { data: first.data, mimeType: first.mimeType, model: this.model };
  }
}
