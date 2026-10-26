import { decodeMaskToRaster, formats, recordsOfKind } from '@meta-sam/parser';
import { COMPATIBLE_PRESETS } from './openai';
import { AiProviderError } from './types';

/**
 * Object segmentation: Meta SAM 3.1 finds every match for a short noun phrase
 * ("chocolate cake") and returns a pixel mask for each, used to cut products out
 * of client photos. An offline stand-in keeps development working without a key.
 */

export interface SegmentedObject {
  /** Half-open box in source pixels that the mask covers */
  bounds: { left: number; top: number; right: number; bottom: number };
  /** Row-major 0/1 raster; its own size, stretched over `bounds` */
  mask: { width: number; height: number; data: Uint8Array };
  confidence?: number;
}
export interface SegmentationInput {
  image: Buffer;
  mimeType: string;
  /** What to find, as a short noun phrase */
  prompt: string;
  width: number;
  height: number;
}
export interface SegmentationResult {
  objects: SegmentedObject[];
  model: string;
}
export interface SegmentationProvider {
  readonly name: string;
  segment(input: SegmentationInput): Promise<SegmentationResult>;
}

export const SAM_MODEL = 'sam-3.1';

/** Reads a Responses API event stream (server-sent events) and yields each event. */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ type: string; [key: string]: unknown }> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, '');
      const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      try {
        yield JSON.parse(data);
      } catch {
        // ignore keep-alives and malformed lines
      }
    }
  }
}

export class MetaSegmenter implements SegmentationProvider {
  readonly name = 'meta';
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: { apiKey: string; fetchImpl?: typeof fetch }) {
    this.fetchImpl = config.fetchImpl ?? ((...args) => fetch(...args));
  }

  async segment(input: SegmentationInput): Promise<SegmentationResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${COMPATIBLE_PRESETS.meta.baseUrl}/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.config.apiKey}`, 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({
          model: SAM_MODEL,
          stream: true,
          input: [
            {
              type: 'message',
              role: 'user',
              content: [
                { type: 'input_text', text: input.prompt.slice(0, 200) },
                { type: 'input_image', image_url: `data:${input.mimeType};base64,${input.image.toString('base64')}` },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new AiProviderError('Could not reach the Meta Model API', true, 'network');
    }
    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } | string };
      const detail = typeof body.error === 'string' ? body.error : (body.error?.message ?? '');
      const kind = res.status === 429 ? 'rate_limit' : res.status === 401 || res.status === 402 || res.status === 403 ? 'auth' : res.status >= 500 ? 'server' : 'invalid_request';
      throw new AiProviderError(`SAM 3.1 returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`, res.status === 429 || res.status >= 500, kind);
    }

    const parser = formats.segmentation.image().createParser();
    let completed = false;
    for await (const event of sseEvents(res.body)) {
      if (event.type === 'response.output_text.delta') parser.push(String(event.delta ?? ''), { emit: false });
      else if (event.type === 'response.completed') completed = true;
      else if (event.type === 'response.failed' || event.type === 'error') {
        const msg = (event.response as { error?: { message?: string } } | undefined)?.error?.message ?? (event.message as string | undefined) ?? 'segmentation failed';
        throw new AiProviderError(`SAM 3.1: ${msg}`, true, 'server');
      }
    }
    const { result } = parser.finish(completed ? { status: 'completed' } : { status: 'incomplete', reason: 'eof' });
    const objects = recordsOfKind(result.records, 'mask').map((r) => ({
      bounds: { ...r.bounds },
      mask: { width: r.mask.width, height: r.mask.height, data: decodeMaskToRaster(r.mask) },
      confidence: r.confidence,
    }));
    return { objects, model: SAM_MODEL };
  }
}

/** Offline stand-in: an ellipse over the middle of the photo, so the studio flow works without a key. */
export class MockSegmenter implements SegmentationProvider {
  readonly name = 'mock';
  async segment(input: SegmentationInput): Promise<SegmentationResult> {
    const size = 64;
    const data = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) data[y * size + x] = ((x - 31.5) / 32) ** 2 + ((y - 31.5) / 32) ** 2 <= 1 ? 1 : 0;
    const bounds = { left: Math.round(input.width * 0.2), top: Math.round(input.height * 0.15), right: Math.round(input.width * 0.8), bottom: Math.round(input.height * 0.85) };
    return { objects: [{ bounds, mask: { width: size, height: size, data } }], model: 'mock-sam-1' };
  }
}
