import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import { toStrictJsonSchema } from './json-schema';
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

export interface AnthropicProviderConfig {
  apiKey: string;
  model?: string;
  fastModel?: string;
}

export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5';

/**
 * Claude via the official Anthropic SDK. Uses structured outputs
 * (output_config.format json_schema) for machine-read results and enables
 * server-side refusal fallbacks so a policy decline is re-run on a fallback model.
 */
export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;

  constructor(private readonly config: AnthropicProviderConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey, maxRetries: 2, timeout: 120_000 });
  }

  modelFor(tier: ModelTier): string {
    return tier === 'fast' ? (this.config.fastModel ?? this.config.model ?? ANTHROPIC_DEFAULT_MODEL) : (this.config.model ?? ANTHROPIC_DEFAULT_MODEL);
  }

  private async call(input: GenerateTextInput, format?: Record<string, unknown>) {
    const model = this.modelFor(input.tier ?? 'default');
    try {
      const response = await this.client.beta.messages.create({
        model,
        max_tokens: input.maxTokens ?? 4096,
        system: input.system,
        messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
        output_config: {
          effort: input.effort ?? 'medium',
          ...(format ? { format: { type: 'json_schema' as const, schema: format } } : {}),
        },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
      if (response.stop_reason === 'refusal') {
        throw new AiProviderError('The model declined this request', false, 'refusal');
      }
      if (response.stop_reason === 'max_tokens') {
        throw new AiProviderError('Model output was truncated (max_tokens)', true, 'truncated');
      }
      const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      return {
        text,
        model: response.model,
        usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
      };
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      if (error instanceof Anthropic.RateLimitError) throw new AiProviderError('Anthropic rate limit', true, 'rate_limit');
      if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
        throw new AiProviderError('Anthropic authentication failed — check AI_API_KEY', false, 'auth');
      }
      if (error instanceof Anthropic.BadRequestError) throw new AiProviderError(`Anthropic rejected the request: ${error.message}`, false, 'invalid_request');
      if (error instanceof Anthropic.APIConnectionError) throw new AiProviderError('Could not reach Anthropic', true, 'network');
      if (error instanceof Anthropic.APIError) throw new AiProviderError(`Anthropic API error ${error.status}`, (error.status ?? 500) >= 500, 'server');
      throw error;
    }
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    return this.call(input);
  }

  async generateStructured<S extends z.ZodType>(input: GenerateStructuredInput<S>): Promise<GenerateStructuredResult<z.infer<S>>> {
    const result = await this.call(input, toStrictJsonSchema(input.schema));
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      throw new AiOutputValidationError(`${input.schemaName}: model output was not valid JSON`, result.text);
    }
    const validated = input.schema.safeParse(parsed);
    if (!validated.success) {
      throw new AiOutputValidationError(`${input.schemaName}: ${validated.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, result.text);
    }
    return { data: validated.data, model: result.model, usage: result.usage };
  }
}
