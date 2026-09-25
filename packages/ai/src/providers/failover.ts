import type { z } from 'zod';
import {
  AiOutputValidationError,
  AiProviderError,
  type AIProvider,
  type GenerateStructuredInput,
  type GenerateStructuredResult,
  type GenerateTextInput,
  type GenerateTextResult,
  type ModelTier,
} from './types';

/** How long a provider is skipped after it fails, by failure kind. */
const COOLDOWN_MS: Partial<Record<AiProviderError['kind'], number>> = {
  rate_limit: 60_000,
  auth: 5 * 60_000,
  server: 30_000,
  network: 30_000,
  invalid_request: 5 * 60_000,
};

export interface FailoverEvent {
  from: string;
  to: string | null;
  reason: string;
}

/**
 * Tries a chain of providers in order (primary first, then backups). A provider that
 * fails with a rate limit, quota, bad key, outage, unknown model or unusable output is
 * skipped and the same request goes to the next one. Recently failed providers are
 * skipped for a short cooldown. Refusals are not retried elsewhere.
 */
export class FailoverAIProvider implements AIProvider {
  readonly name: string;
  private readonly cooldownUntil = new Map<number, number>();

  constructor(
    private readonly chain: AIProvider[],
    private readonly onFailover?: (event: FailoverEvent) => void,
  ) {
    if (!chain.length) throw new Error('FailoverAIProvider needs at least one provider');
    this.name = chain[0]!.name;
  }

  get providers(): readonly AIProvider[] {
    return this.chain;
  }

  modelFor(tier: ModelTier): string {
    return this.chain[0]!.modelFor(tier);
  }

  private shouldFailOver(error: unknown): error is AiProviderError | AiOutputValidationError {
    if (error instanceof AiOutputValidationError) return true;
    return error instanceof AiProviderError && error.kind !== 'refusal';
  }

  /** Providers to try now: those not cooling down, or all of them if every one is. */
  private order(): number[] {
    const now = Date.now();
    const ready = this.chain.map((_, i) => i).filter((i) => (this.cooldownUntil.get(i) ?? 0) <= now);
    return ready.length ? ready : this.chain.map((_, i) => i);
  }

  private async run<T>(fn: (p: AIProvider) => Promise<T>): Promise<T & { provider: string }> {
    const order = this.order();
    let lastError: unknown;
    for (let n = 0; n < order.length; n++) {
      const i = order[n]!;
      const provider = this.chain[i]!;
      try {
        const result = await fn(provider);
        this.cooldownUntil.delete(i);
        return { ...result, provider: provider.name };
      } catch (error) {
        lastError = error;
        if (!this.shouldFailOver(error)) throw error;
        const kind = error instanceof AiProviderError ? error.kind : 'invalid_output';
        const cooldown = error instanceof AiProviderError ? COOLDOWN_MS[error.kind] : undefined;
        if (cooldown) this.cooldownUntil.set(i, Date.now() + cooldown);
        const next = order[n + 1] !== undefined ? this.chain[order[n + 1]!]!.name : null;
        this.onFailover?.({ from: provider.name, to: next, reason: `${kind}: ${error.message.slice(0, 200)}` });
      }
    }
    throw lastError;
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    return this.run((p) => p.generateText(input));
  }

  async generateStructured<S extends z.ZodType>(input: GenerateStructuredInput<S>): Promise<GenerateStructuredResult<z.infer<S>>> {
    return this.run((p) => p.generateStructured(input));
  }
}
