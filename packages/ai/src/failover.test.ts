import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { runStructured } from './agents/runner';
import { FailoverAIProvider, type FailoverEvent } from './providers/failover';
import { AiOutputValidationError, AiProviderError, type AIProvider } from './providers/types';

/** A fake provider that fails with the queued errors, then succeeds. */
function fake(name: string, failures: Error[] = []): AIProvider & { calls: number } {
  const p = {
    name,
    calls: 0,
    modelFor: () => `${name}-model`,
    generateText: vi.fn(async () => {
      p.calls++;
      const err = failures.shift();
      if (err) throw err;
      return { text: `from ${name}`, model: `${name}-model`, usage: {} };
    }),
    generateStructured: vi.fn(async (input: { schema: z.ZodType }) => {
      p.calls++;
      const err = failures.shift();
      if (err) throw err;
      return { data: input.schema.parse({ ok: true }), model: `${name}-model`, usage: {} };
    }),
  };
  return p as unknown as AIProvider & { calls: number };
}

const ask = (p: AIProvider) => p.generateText({ system: 's', messages: [{ role: 'user', content: 'hi' }] });

describe('AI provider failover', () => {
  it('uses the backup when the primary hits a rate limit, and reports who answered', async () => {
    const events: FailoverEvent[] = [];
    const primary = fake('google', [new AiProviderError('HTTP 429 quota', true, 'rate_limit')]);
    const backup = fake('nvidia');
    const chain = new FailoverAIProvider([primary, backup], (e) => events.push(e));
    const res = await ask(chain);
    expect(res).toMatchObject({ text: 'from nvidia', provider: 'nvidia' });
    expect(events[0]).toMatchObject({ from: 'google', to: 'nvidia' });
    expect(events[0]!.reason).toMatch(/rate_limit/);
  });

  it('skips a provider that just failed until its cooldown ends', async () => {
    const primary = fake('google', [new AiProviderError('bad key', false, 'auth')]);
    const backup = fake('nvidia');
    const chain = new FailoverAIProvider([primary, backup]);
    await ask(chain);
    await ask(chain);
    expect(primary.calls).toBe(1); // second request went straight to the backup
    expect(backup.calls).toBe(2);
  });

  it('fails over on server errors, network errors, unknown models and unusable output', async () => {
    for (const err of [
      new AiProviderError('HTTP 503', true, 'server'),
      new AiProviderError('offline', true, 'network'),
      new AiProviderError('HTTP 404 model not found', false, 'invalid_request'),
      new AiOutputValidationError('bad json', '{'),
    ]) {
      const res = await ask(new FailoverAIProvider([fake('a', [err]), fake('b')]));
      expect(res.provider).toBe('b');
    }
  });

  it('does not route a refused request to another provider', async () => {
    const backup = fake('b');
    await expect(ask(new FailoverAIProvider([fake('a', [new AiProviderError('declined', false, 'refusal')]), backup]))).rejects.toThrow('declined');
    expect(backup.calls).toBe(0);
  });

  it('throws the last error when every provider fails', async () => {
    const chain = new FailoverAIProvider([fake('a', [new AiProviderError('a down', true, 'server')]), fake('b', [new AiProviderError('b down', true, 'server')])]);
    await expect(ask(chain)).rejects.toThrow('b down');
  });

  it('tries every provider again when all of them are cooling down', async () => {
    const a = fake('a', [new AiProviderError('limit', true, 'rate_limit')]);
    const b = fake('b', [new AiProviderError('limit', true, 'rate_limit')]);
    const chain = new FailoverAIProvider([a, b]);
    await expect(ask(chain)).rejects.toThrow();
    expect((await ask(chain)).provider).toBe('a');
  });

  it('logs the provider that actually produced a structured result', async () => {
    const logs: string[] = [];
    const chain = new FailoverAIProvider([fake('google', [new AiProviderError('429', true, 'rate_limit')]), fake('nvidia')]);
    await runStructured(chain, { agent: 'T', promptVersion: 'V1', inputType: 't', schemaName: 's', schema: z.object({ ok: z.boolean() }), system: 's', user: 'u' }, async (l) => {
      logs.push(`${l.provider}:${l.status}`);
      return undefined;
    });
    expect(logs).toEqual(['nvidia:SUCCESS']);
  });
});
