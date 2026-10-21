import type { z } from 'zod';
import { AiOutputValidationError, AiProviderError, type AIProvider, type ChatMessage, type Effort, type ModelTier } from '../providers/types';

/** One row for the AiGeneration table — prompt text and raw inputs are deliberately NOT stored. */
export interface AiGenerationLog {
  provider: string;
  model: string;
  agent: string;
  promptVersion: string;
  inputType: string;
  output: unknown;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  status: 'SUCCESS' | 'VALIDATION_FAILED' | 'ERROR';
  error?: string;
}

/** Persists a generation log and returns its id (or undefined when logging is disabled). */
export type GenerationLogger = (log: AiGenerationLog) => Promise<string | undefined>;

export interface StructuredCall<S extends z.ZodType> {
  agent: string;
  promptVersion: string;
  inputType: string;
  schemaName: string;
  schema: S;
  system: string;
  user: string;
  tier?: ModelTier;
  effort?: Effort;
  maxTokens?: number;
  mockContext?: unknown;
}

export interface StructuredOutcome<T> {
  data: T;
  generationId?: string;
  model: string;
  promptVersion: string;
}

/**
 * Runs a structured generation with schema validation. A validation failure is
 * retried once with the validation error fed back; if it fails again the error
 * propagates so the caller can escalate. Every attempt is logged.
 */
export async function runStructured<S extends z.ZodType>(
  provider: AIProvider,
  call: StructuredCall<S>,
  log: GenerationLogger,
): Promise<StructuredOutcome<z.infer<S>>> {
  const messages: ChatMessage[] = [{ role: 'user', content: call.user }];
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const started = Date.now();
    try {
      const res = await provider.generateStructured({
        system: call.system,
        messages,
        schemaName: call.schemaName,
        schema: call.schema,
        tier: call.tier,
        effort: call.effort,
        maxTokens: call.maxTokens,
        mockContext: call.mockContext,
      });
      const generationId = await log({
        provider: res.provider ?? provider.name,
        model: res.model,
        agent: call.agent,
        promptVersion: call.promptVersion,
        inputType: call.inputType,
        output: res.data,
        latencyMs: Date.now() - started,
        inputTokens: res.usage.inputTokens,
        outputTokens: res.usage.outputTokens,
        status: 'SUCCESS',
      });
      return { data: res.data, generationId, model: res.model, promptVersion: call.promptVersion };
    } catch (error) {
      lastError = error;
      const isValidation = error instanceof AiOutputValidationError;
      // After failover, record the provider whose error ended the attempt, not the chain's first name.
      const failed = (error as { provider?: string }).provider;
      await log({
        provider: failed ?? provider.name,
        model: failed ? `${failed} (after failover)` : provider.modelFor(call.tier ?? 'default'),
        agent: call.agent,
        promptVersion: call.promptVersion,
        inputType: call.inputType,
        output: null,
        latencyMs: Date.now() - started,
        status: isValidation ? 'VALIDATION_FAILED' : 'ERROR',
        error: error instanceof Error ? error.message.slice(0, 1000) : String(error),
      });
      if (isValidation && attempt === 1) {
        messages.push(
          { role: 'assistant', content: error.rawOutput.slice(0, 4000) },
          { role: 'user', content: `That output did not match the required JSON schema (${error.message.slice(0, 500)}). Return only a corrected JSON object.` },
        );
        continue;
      }
      if (error instanceof AiProviderError && error.retryable && attempt === 1) continue;
      throw error;
    }
  }
  throw lastError;
}
