import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { encodePng, MetaImageProvider, MockImageProvider } from './providers/image';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('Muse Image provider', () => {
  it('calls the images endpoint for a PNG and decodes the result', async () => {
    const png = encodePng(2, 2, () => [1, 2, 3]);
    const calls: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get('authorization') });
      return new Response(JSON.stringify({ created: 1, data: [{ b64_json: png.toString('base64') }], output_format: 'png' }), { status: 200 });
    }) as typeof fetch;
    const img = await new MetaImageProvider({ apiKey: 'k', fetchImpl }).generate({ prompt: 'Sourdough on a wooden board', shape: 'landscape', user: 'org_1' });
    expect(calls[0]!.url).toBe('https://api.meta.ai/v1/images/generations');
    expect(calls[0]!.auth).toBe('Bearer k');
    expect(calls[0]!.body).toEqual({ model: 'muse-image-1.0', prompt: 'Sourdough on a wooden board', n: 1, size: '1792x1024', output_format: 'png', response_format: 'b64_json', user: 'org_1' });
    expect(img.data.equals(png)).toBe(true);
    expect(img.mimeType).toBe('image/png');
  });

  it('surfaces API errors with the provider message', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { message: 'Billing verification failed.' } }), { status: 402 })) as typeof fetch;
    await expect(new MetaImageProvider({ apiKey: 'k', fetchImpl }).generate({ prompt: 'x' })).rejects.toMatchObject({ kind: 'auth', message: expect.stringContaining('HTTP 402: Billing verification failed') });
  });

  it('fails clearly when no image comes back', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch;
    await expect(new MetaImageProvider({ apiKey: 'k', fetchImpl }).generate({ prompt: 'x' })).rejects.toThrow(/no image/);
  });
});

describe('offline image stand-in', () => {
  it('produces a valid PNG of the requested shape, the same for the same prompt', async () => {
    const mock = new MockImageProvider();
    const a = await mock.generate({ prompt: 'Autumn menu', shape: 'portrait' });
    const b = await mock.generate({ prompt: 'Autumn menu', shape: 'portrait' });
    expect(a.data.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(a.data.readUInt32BE(16)).toBe(432); // IHDR width
    expect(a.data.readUInt32BE(20)).toBe(768); // IHDR height
    expect(a.data.equals(b.data)).toBe(true);
    const idatLen = a.data.readUInt32BE(33);
    expect(inflateSync(a.data.subarray(41, 41 + idatLen)).length).toBe((432 * 3 + 1) * 768);
  });
});

describe('Muse Image edits', () => {
  it('sends source images as data URLs to /images/edits and returns the edited image', async () => {
    let sent: { url: string; body: Record<string, unknown> } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent = { url, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('webp-bytes').toString('base64') }], output_format: 'webp' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const out = await new MetaImageProvider({ apiKey: 'k', fetchImpl }).edit({ images: [{ data: Buffer.from('png'), mimeType: 'image/png' }], prompt: 'on a marble counter' });
    expect(sent!.url).toBe('https://api.meta.ai/v1/images/edits');
    expect(sent!.body).toEqual({ model: 'muse-image-1.0', prompt: 'on a marble counter', images: [{ image_url: `data:image/png;base64,${Buffer.from('png').toString('base64')}` }], n: 1 });
    expect(out).toEqual({ data: Buffer.from('webp-bytes'), mimeType: 'image/webp', model: 'muse-image-1.0' });
  });
});
