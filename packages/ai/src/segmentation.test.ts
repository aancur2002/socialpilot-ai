import { describe, expect, it } from 'vitest';
// Not part of the package's public exports; used only to build a realistic mask token.
import { encodeSegmentationMask } from '../../../node_modules/@meta-sam/parser/dist/mask-codec.js';
import { MetaSegmenter, MockSegmenter } from './providers/segmentation';

function sse(events: object[], chunkSize = 37): Response {
  const text = events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  // Split mid-event to check the stream reader stitches chunks back together.
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += chunkSize) c.enqueue(bytes.slice(i, i + chunkSize));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('SAM 3.1 segmentation', () => {
  const raster = Uint8Array.from([0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0]);
  const mask = encodeSegmentationMask(raster, 4, 4);
  const line = `<0f>0<|box;x1=10;y1=20;x2=50;y2=60;w=100;h=80|><|mask;x=0;y=0;data=4,4,${mask.payload}|>\n`;

  it('sends the image and prompt to /responses and decodes the streamed masks', async () => {
    let sent: { url: string; body: Record<string, unknown> } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent = { url, body: JSON.parse(String(init.body)) };
      const half = Math.floor(line.length / 2);
      return sse([
        { type: 'response.created' },
        { type: 'response.output_text.delta', delta: line.slice(0, half), item_id: 'i', output_index: 0, content_index: 0 },
        { type: 'response.output_text.delta', delta: line.slice(half), item_id: 'i', output_index: 0, content_index: 0 },
        { type: 'response.completed' },
      ]);
    }) as unknown as typeof fetch;
    const result = await new MetaSegmenter({ apiKey: 'k', fetchImpl }).segment({ image: Buffer.from('jpg'), mimeType: 'image/jpeg', prompt: 'cake', width: 100, height: 80 });

    expect(sent!.url).toBe('https://api.meta.ai/v1/responses');
    expect(sent!.body).toMatchObject({ model: 'sam-3.1', stream: true });
    const content = (sent!.body.input as { content: { type: string; text?: string; image_url?: string }[] }[])[0]!.content;
    expect(content[0]).toEqual({ type: 'input_text', text: 'cake' });
    expect(content[1]!.image_url).toBe(`data:image/jpeg;base64,${Buffer.from('jpg').toString('base64')}`);

    expect(result.model).toBe('sam-3.1');
    expect(result.objects).toHaveLength(1);
    expect(result.objects[0]!.bounds).toEqual({ left: 10, top: 20, right: 51, bottom: 61 }); // half-open: the box's x2/y2 are inclusive
    expect([...result.objects[0]!.mask.data]).toEqual([...raster]);
  });

  it('returns no objects when nothing matches, and maps HTTP errors', async () => {
    const empty = (async () => sse([{ type: 'response.completed' }])) as unknown as typeof fetch;
    expect((await new MetaSegmenter({ apiKey: 'k', fetchImpl: empty }).segment({ image: Buffer.from('x'), mimeType: 'image/png', prompt: 'unicorn', width: 10, height: 10 })).objects).toEqual([]);

    const denied = (async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 })) as unknown as typeof fetch;
    await expect(new MetaSegmenter({ apiKey: 'k', fetchImpl: denied }).segment({ image: Buffer.from('x'), mimeType: 'image/png', prompt: 'cake', width: 10, height: 10 })).rejects.toMatchObject({ kind: 'auth' });
  });

  it('offline stand-in masks the middle of the photo', async () => {
    const { objects } = await new MockSegmenter().segment({ image: Buffer.alloc(0), mimeType: 'image/png', prompt: 'cake', width: 200, height: 100 });
    expect(objects[0]!.bounds).toEqual({ left: 40, top: 15, right: 160, bottom: 85 });
  });
});
