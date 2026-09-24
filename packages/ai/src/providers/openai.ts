import type { z } from 'zod';
import { toStrictJsonSchema } from './json-schema';
import {
  AiOutputValidationError,
  AiProviderError,
  type AIProvider,
  type EmbeddingProvider,
  type GenerateStructuredInput,
  type GenerateStructuredResult,
  type GenerateTextInput,
  type GenerateTextResult,
  type ModelTier,
} from './types';

export interface OpenAIProviderConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fastModel?: string;
}

async function openaiFetch<T>(baseUrl: string, apiKey: string, path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new AiProviderError('Could not reach the OpenAI-compatible API', true, 'network');
  }
  if (!res.ok) {
    const kind = res.status === 429 ? 'rate_limit' : res.status === 401 || res.status === 403 ? 'auth' : res.status >= 500 ? 'server' : 'invalid_request';
    throw new AiProviderError(`OpenAI-compatible API returned HTTP ${res.status}`, res.status === 429 || res.status >= 500, kind);
  }
  return (await res.json()) as T;
}

interface ChatCompletion {
  model: string;
  choices: { message: { content: string | null; refusal?: string | null }; finish_reason: string }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

/** OpenAI (or any OpenAI-compatible endpoint) — alternative text provider. */
export class OpenAIProvider implements AIProvider {
  readonly name = 'openai';
  private readonly baseUrl: string;

  constructor(private readonly config: OpenAIProviderConfig) {
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
  }

  modelFor(tier: ModelTier): string {
    const model = this.config.model ?? 'gpt-4.1';
    return tier === 'fast' ? (this.config.fastModel ?? model) : model;
  }

  private async complete(input: GenerateTextInput, responseFormat?: unknown) {
    const model = this.modelFor(input.tier ?? 'default');
    const res = await openaiFetch<ChatCompletion>(this.baseUrl, this.config.apiKey, '/chat/completions', {
      model,
      max_completion_tokens: input.maxTokens ?? 4096,
      messages: [{ role: 'system', content: input.system }, ...input.messages],
      ...(responseFormat ? { response_format: responseFormat } : {}),
    });
    const choice = res.choices[0];
    if (!choice) throw new AiProviderError('Empty completion', true, 'server');
    if (choice.message.refusal) throw new AiProviderError('The model declined this request', false, 'refusal');
    if (choice.finish_reason === 'length') throw new AiProviderError('Model output was truncated', true, 'truncated');
    return { text: choice.message.content ?? '', model: res.model, usage: { inputTokens: res.usage?.prompt_tokens, outputTokens: res.usage?.completion_tokens } };
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    return this.complete(input);
  }

  async generateStructured<S extends z.ZodType>(input: GenerateStructuredInput<S>): Promise<GenerateStructuredResult<z.infer<S>>> {
    const result = await this.complete(input, {
      type: 'json_schema',
      json_schema: { name: input.schemaName, strict: true, schema: toStrictJsonSchema(input.schema) },
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      throw new AiOutputValidationError(`${input.schemaName}: output was not valid JSON`, result.text);
    }
    const validated = input.schema.safeParse(parsed);
    if (!validated.success) throw new AiOutputValidationError(`${input.schemaName}: ${validated.error.message}`, result.text);
    return { data: validated.data, model: result.model, usage: result.usage };
  }
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';
  readonly dimensions = 1536;
  readonly model: string;
  private readonly baseUrl: string;

  constructor(private readonly config: { apiKey: string; baseUrl?: string; model?: string }) {
    this.model = config.model ?? 'text-embedding-3-small';
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
  }

  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 96) {
      const res = await openaiFetch<{ data: { index: number; embedding: number[] }[] }>(this.baseUrl, this.config.apiKey, '/embeddings', {
        model: this.model,
        input: texts.slice(i, i + 96),
        dimensions: this.dimensions,
      });
      out.push(...res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding));
    }
    return out;
  }
}
