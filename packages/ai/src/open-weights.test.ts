import { describe, expect, it } from 'vitest';
import { createAIProvider } from './factory';
import { OpenAIProvider } from './providers/openai';

function capture() {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ model: 'x', choices: [{ message: { content: 'Hello from open weights' } }], usage: { prompt_tokens: 5, completion_tokens: 4 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("Meta's open-weight models", () => {
  it('calls Muse Spark Open on Baseten with room for reasoning', async () => {
    const { calls, fetchImpl } = capture();
    const ai = new OpenAIProvider({ apiKey: 'k', kind: 'baseten', fetchImpl });
    const out = await ai.generateText({ system: 'Be brief.', messages: [{ role: 'user', content: 'Hi' }], maxTokens: 300 });
    expect(out.text).toBe('Hello from open weights');
    expect(calls[0]!.url).toBe('https://inference.baseten.co/v1/chat/completions');
    expect(calls[0]!.body).toMatchObject({ model: 'meta-models/muse-spark-open', max_tokens: 4096 });
  });

  it('calls Muse Glimmer on your own Modal deployment', async () => {
    const { calls, fetchImpl } = capture();
    const ai = new OpenAIProvider({ apiKey: 'k', kind: 'modal', baseUrl: 'https://me--socialpilot-glimmer-serve.modal.run/v1', fetchImpl });
    await ai.generateText({ system: 'Be brief.', messages: [{ role: 'user', content: 'Hi' }] });
    expect(calls[0]!.url).toBe('https://me--socialpilot-glimmer-serve.modal.run/v1/chat/completions');
    expect(calls[0]!.body).toMatchObject({ model: 'muse-glimmer' });
  });

  it('needs the Modal URL, and passes it through the factory', () => {
    expect(() => createAIProvider({ provider: 'modal', apiKey: 'k', embeddingProvider: 'mock' })).toThrow(/Modal deployment/);
    expect(createAIProvider({ provider: 'modal', apiKey: 'k', openaiBaseUrl: 'https://m.modal.run/v1', embeddingProvider: 'mock' })).toBeInstanceOf(OpenAIProvider);
    // A fixed-address provider ignores a base URL meant for another endpoint.
    expect(createAIProvider({ provider: 'baseten', apiKey: 'k', openaiBaseUrl: 'https://elsewhere/v1', embeddingProvider: 'mock' })).toBeInstanceOf(OpenAIProvider);
  });
});
