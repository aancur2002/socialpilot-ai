import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAIProvider, createEmbeddingProvider } from './factory';
import { fitEmbedding, OpenAIEmbeddingProvider, OpenAIProvider } from './providers/openai';

type Call = { url: string; body: Record<string, unknown> };

/** Fake fetch: returns queued responses in order and records every request. */
function fakeFetch(responses: { status: number; body: unknown }[]) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    const r = responses.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { impl, calls };
}

const completion = (content: string) => ({ status: 200, body: { model: 'm', choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4 } } });
const schema = z.object({ answer: z.string(), score: z.number() });
const call = (p: OpenAIProvider) => p.generateStructured({ system: 'sys', messages: [{ role: 'user', content: 'hi' }], schemaName: 'test', schema });

describe('OpenAI-compatible providers', () => {
  it('Google: falls back from json_schema to json_object and remembers the working mode', async () => {
    const { impl, calls } = fakeFetch([
      { status: 400, body: { error: { message: 'response_format json_schema not supported' } } },
      completion('{"answer":"yes","score":0.9}'),
      completion('{"answer":"again","score":0.5}'),
    ]);
    const p = new OpenAIProvider({ apiKey: 'k', kind: 'google', fetchImpl: impl });
    expect((await call(p)).data).toEqual({ answer: 'yes', score: 0.9 });
    expect(calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect((calls[0]!.body.response_format as { type: string }).type).toBe('json_schema');
    expect((calls[1]!.body.response_format as { type: string }).type).toBe('json_object');
    expect(calls[1]!.body.max_tokens).toBeDefined(); // not max_completion_tokens
    expect(calls[1]!.body.model).toBe('gemini-3.8-flash');
    // Second request skips the rejected mode.
    await call(p);
    expect((calls[2]!.body.response_format as { type: string }).type).toBe('json_object');
  });

  it('NVIDIA: falls back to plain instructions and extracts JSON from prose', async () => {
    const { impl, calls } = fakeFetch([
      { status: 400, body: { detail: 'unsupported' } },
      { status: 400, body: { detail: 'unsupported' } },
      completion('Sure! Here it is:\n```json\n{"answer":"ok","score":1}\n```'),
    ]);
    const p = new OpenAIProvider({ apiKey: 'k', kind: 'nvidia', fetchImpl: impl });
    expect((await call(p)).data).toEqual({ answer: 'ok', score: 1 });
    expect(calls[2]!.url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    expect(calls[2]!.body.response_format).toBeUndefined();
    expect(String((calls[2]!.body.messages as { content: string }[])[0]!.content)).toContain('JSON schema');
  });

  it('OpenAI: uses strict json_schema only and max_completion_tokens', async () => {
    const { impl, calls } = fakeFetch([{ status: 400, body: { error: { message: 'bad' } } }]);
    const p = new OpenAIProvider({ apiKey: 'k', kind: 'openai', fetchImpl: impl });
    await expect(call(p)).rejects.toThrow(/HTTP 400: bad/);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.max_completion_tokens).toBeDefined();
  });

  it('still rejects output that fails schema validation (after one retry with the full schema)', async () => {
    const { impl, calls } = fakeFetch([completion('{"answer":"x"}'), completion('{"answer":"x"}')]);
    await expect(call(new OpenAIProvider({ apiKey: 'k', kind: 'google', fetchImpl: impl }))).rejects.toThrow(/score/);
    expect(calls).toHaveLength(2);
  });

  it('sends the schema once when the endpoint enforces it, and the full text only if output fails', async () => {
    const system = (c: Call) => String((c.body.messages as { content: string }[])[0]!.content);
    const { impl, calls } = fakeFetch([completion('{"answer":"ok","score":1}'), completion('{"answer":"x"}'), completion('{"answer":"fixed","score":0.5}'), completion('{"answer":"next","score":0.2}')]);
    const p = new OpenAIProvider({ apiKey: 'k', kind: 'google', fetchImpl: impl });
    expect((await call(p)).data.answer).toBe('ok');
    expect(system(calls[0]!)).toContain('follows the response schema');
    expect(system(calls[0]!)).not.toContain('"properties"');
    // Invalid output: retried once with the full schema text, which then sticks.
    expect((await call(p)).data.answer).toBe('fixed');
    expect(system(calls[2]!)).toContain('"properties"');
    await call(p);
    expect(system(calls[3]!)).toContain('"properties"');
  });

  it('surfaces auth errors with the provider message and never retries modes on them', async () => {
    const { impl, calls } = fakeFetch([{ status: 401, body: { error: { message: 'API key not valid' } } }]);
    await expect(call(new OpenAIProvider({ apiKey: 'k', kind: 'google', fetchImpl: impl }))).rejects.toThrow(/Google Gemini API returned HTTP 401: API key not valid/);
    expect(calls).toHaveLength(1);
  });

  it('retries once after a short pause when the service is temporarily overloaded', async () => {
    const { impl, calls } = fakeFetch([
      { status: 503, body: [{ error: { message: 'This model is currently experiencing high demand.' } }] },
      completion('OK'),
    ]);
    const res = await new OpenAIProvider({ apiKey: 'k', kind: 'google', fetchImpl: impl }).generateText({ system: 's', messages: [{ role: 'user', content: 'x' }] });
    expect(res.text).toBe('OK');
    expect(calls).toHaveLength(2);
  });

  it('reports a persistent overload with the provider message after one retry', async () => {
    const overloaded = { status: 503, body: [{ error: { message: 'This model is currently experiencing high demand.' } }] };
    const { impl, calls } = fakeFetch([overloaded, overloaded]);
    await expect(new OpenAIProvider({ apiKey: 'k', kind: 'google', fetchImpl: impl }).generateText({ system: 's', messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({
      kind: 'server',
      message: expect.stringMatching(/HTTP 503: This model is currently experiencing high demand/),
    });
    expect(calls).toHaveLength(2);
  });

  it('reads Gemini errors wrapped in an array (so a 404 names the missing model)', async () => {
    const { impl } = fakeFetch([{ status: 404, body: [{ error: { code: 404, message: 'models/gemini-2.5-flash is not found for API version v1main' } }] }]);
    await expect(new OpenAIProvider({ apiKey: 'k', kind: 'google', fetchImpl: impl }).generateText({ system: 's', messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/HTTP 404: models\/gemini-2.5-flash is not found/);
  });

  it('lists models from /models, stripping the Gemini "models/" prefix', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { data: [{ id: 'models/gemini-3.8-flash' }, { id: 'models/gemini-embedding-001' }, { id: 'models/gemini-3.8-flash' }] } }]);
    expect(await new OpenAIProvider({ apiKey: 'k', kind: 'google', fetchImpl: impl }).listModels()).toEqual(['gemini-3.8-flash', 'gemini-embedding-001']);
    expect(calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/models');
  });

  it('uses preset models, custom models, and the main model as fast model when only main is set', () => {
    expect(new OpenAIProvider({ apiKey: 'k', kind: 'nvidia' }).modelFor('fast')).toBe('meta/llama-3.1-8b-instruct');
    const custom = new OpenAIProvider({ apiKey: 'k', kind: 'nvidia', model: 'deepseek-ai/deepseek-r1' });
    expect(custom.modelFor('default')).toBe('deepseek-ai/deepseek-r1');
    expect(custom.modelFor('fast')).toBe('deepseek-ai/deepseek-r1');
  });

  it('Meta: strict json_schema, max_completion_tokens, and reasoning effort by tier', async () => {
    const { impl, calls } = fakeFetch([completion('{"answer":"hi","score":1}'), completion('ok')]);
    const p = new OpenAIProvider({ apiKey: 'k', kind: 'meta', fetchImpl: impl });
    expect((await call(p)).data).toEqual({ answer: 'hi', score: 1 });
    expect(calls[0]!.url).toBe('https://api.meta.ai/v1/chat/completions');
    expect(calls[0]!.body).toMatchObject({ model: 'muse-spark-1.3', reasoning_effort: 'low' });
    expect(calls[0]!.body.max_completion_tokens).toBeDefined();
    expect((calls[0]!.body.response_format as { type: string }).type).toBe('json_schema');
    await p.generateText({ system: 's', messages: [{ role: 'user', content: 'x' }], tier: 'fast' });
    expect(calls[1]!.body.reasoning_effort).toBe('minimal');
    expect(calls[1]!.body.stop).toBeUndefined();
  });

  it('Meta: falls back to known models when there is no /models endpoint, but surfaces a bad key', async () => {
    const missing = fakeFetch([{ status: 404, body: { error: { message: 'Not found' } } }]);
    expect(await new OpenAIProvider({ apiKey: 'k', kind: 'meta', fetchImpl: missing.impl }).listModels()).toContain('muse-spark-1.3');
    const badKey = fakeFetch([{ status: 401, body: { error: { message: 'Invalid key' } } }]);
    await expect(new OpenAIProvider({ apiKey: 'k', kind: 'meta', fetchImpl: badKey.impl }).listModels()).rejects.toThrow(/401/);
  });

  it('treats a billing error (HTTP 402) as an account problem, so failover rests that provider', async () => {
    const { impl } = fakeFetch([{ status: 402, body: { error: { message: 'Billing verification failed.' } } }]);
    await expect(new OpenAIProvider({ apiKey: 'k', kind: 'meta', fetchImpl: impl }).generateText({ system: 's', messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({
      kind: 'auth',
      message: 'Meta Model API returned HTTP 402: Billing verification failed.',
    });
  });

  it('does not send reasoning_effort to providers that do not take it', async () => {
    const { impl, calls } = fakeFetch([completion('ok')]);
    await new OpenAIProvider({ apiKey: 'k', kind: 'google', fetchImpl: impl }).generateText({ system: 's', messages: [{ role: 'user', content: 'x' }] });
    expect(calls[0]!.body.reasoning_effort).toBeUndefined();
  });

  it('factory builds Google and NVIDIA providers', () => {
    expect(createAIProvider({ provider: 'google', apiKey: 'k', embeddingProvider: 'mock' }).name).toBe('google');
    expect(createEmbeddingProvider({ provider: 'nvidia', apiKey: 'k', embeddingProvider: 'nvidia' }).model).toBe('nvidia/nv-embedqa-e5-v5');
    expect(() => createEmbeddingProvider({ provider: 'anthropic', apiKey: 'k', embeddingProvider: 'google' })).toThrow(/EMBEDDING_API_KEY/);
  });
});

describe('embedding dimensions', () => {
  const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i]!, 0);

  it('zero-pads short vectors without changing similarity', () => {
    const a = Array.from({ length: 1024 }, (_, i) => Math.sin(i));
    const b = Array.from({ length: 1024 }, (_, i) => Math.cos(i));
    const pa = fitEmbedding(a);
    const pb = fitEmbedding(b);
    expect(pa).toHaveLength(1536);
    expect(dot(pa, pb)).toBeCloseTo(dot(a, b), 10);
  });

  it('truncates long vectors and re-normalizes them', () => {
    const v = fitEmbedding(Array.from({ length: 3072 }, () => 1));
    expect(v).toHaveLength(1536);
    expect(dot(v, v)).toBeCloseTo(1, 10);
  });

  it('NVIDIA sends input_type for queries vs passages and pads results', async () => {
    const vec = Array.from({ length: 1024 }, () => 0.01);
    const { impl, calls } = fakeFetch([
      { status: 200, body: { data: [{ index: 0, embedding: vec }] } },
      { status: 200, body: { data: [{ index: 0, embedding: vec }] } },
    ]);
    const e = new OpenAIEmbeddingProvider({ apiKey: 'k', kind: 'nvidia', fetchImpl: impl });
    const [doc] = await e.generateEmbeddings(['passage text'], 'document');
    await e.generateEmbeddings(['question?'], 'query');
    expect(doc).toHaveLength(1536);
    expect(calls[0]!.body).toMatchObject({ input_type: 'passage', model: 'nvidia/nv-embedqa-e5-v5' });
    expect(calls[1]!.body).toMatchObject({ input_type: 'query' });
    expect(calls[0]!.body.dimensions).toBeUndefined();
  });

  it('Google requests 1536 dimensions', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { data: [{ index: 0, embedding: Array.from({ length: 1536 }, () => 0.02) }] } }]);
    await new OpenAIEmbeddingProvider({ apiKey: 'k', kind: 'google', fetchImpl: impl }).generateEmbeddings(['x']);
    expect(calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/embeddings');
    expect(calls[0]!.body).toMatchObject({ dimensions: 1536, model: 'gemini-embedding-001' });
  });
});
