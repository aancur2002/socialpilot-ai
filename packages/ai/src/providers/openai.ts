import type { z } from 'zod';
import { extractJson, toStrictJsonSchema } from './json-schema';
import {
  AiOutputValidationError,
  AiProviderError,
  type AIProvider,
  type EmbeddingProvider,
  type EmbeddingPurpose,
  type GenerateStructuredInput,
  type GenerateStructuredResult,
  type GenerateTextInput,
  type GenerateTextResult,
  type ModelTier,
} from './types';

/**
 * OpenAI-compatible chat and embedding providers. OpenAI itself, Google Gemini
 * (its OpenAI compatibility endpoint) and NVIDIA NIM (build.nvidia.com) all speak
 * this API, with small differences captured in the presets below.
 */
export type CompatibleProvider = 'openai' | 'google' | 'nvidia';

interface Preset {
  label: string;
  baseUrl: string;
  model: string;
  fastModel: string;
  embeddingModel: string;
  /** OpenAI uses max_completion_tokens; the others accept max_tokens. */
  maxTokensParam: 'max_completion_tokens' | 'max_tokens';
  /** Strict json_schema support is guaranteed only on OpenAI; others fall back when rejected. */
  structured: 'strict' | 'negotiate';
  /** Send `dimensions` to request 1536-d embeddings. */
  embeddingDimensionsParam: boolean;
  /** Asymmetric embedding models need input_type=query|passage (NVIDIA retrieval models). */
  embeddingInputType: boolean;
}

export const COMPATIBLE_PRESETS: Record<CompatibleProvider, Preset> = {
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1',
    fastModel: 'gpt-4.1-mini',
    embeddingModel: 'text-embedding-3-small',
    maxTokensParam: 'max_completion_tokens',
    structured: 'strict',
    embeddingDimensionsParam: true,
    embeddingInputType: false,
  },
  google: {
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
    fastModel: 'gemini-2.5-flash-lite',
    embeddingModel: 'gemini-embedding-001',
    maxTokensParam: 'max_tokens',
    structured: 'negotiate',
    embeddingDimensionsParam: true,
    embeddingInputType: false,
  },
  nvidia: {
    label: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    model: 'meta/llama-3.3-70b-instruct',
    fastModel: 'meta/llama-3.1-8b-instruct',
    embeddingModel: 'nvidia/nv-embedqa-e5-v5',
    maxTokensParam: 'max_tokens',
    structured: 'negotiate',
    embeddingDimensionsParam: false,
    embeddingInputType: true,
  },
};

type FetchImpl = typeof fetch;

async function compatibleFetch<T>(fetchImpl: FetchImpl, label: string, baseUrl: string, apiKey: string, path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new AiProviderError(`Could not reach the ${label} API`, true, 'network');
  }
  if (!res.ok) {
    // Include the provider's own error text (never the key) so the settings test is actionable.
    let detail = '';
    try {
      const data = (await res.json()) as { error?: { message?: string } | string; detail?: string; message?: string };
      const raw = typeof data.error === 'string' ? data.error : (data.error?.message ?? data.detail ?? data.message ?? '');
      detail = raw ? `: ${String(raw).slice(0, 300)}` : '';
    } catch {
      detail = '';
    }
    const kind = res.status === 429 ? 'rate_limit' : res.status === 401 || res.status === 403 ? 'auth' : res.status >= 500 ? 'server' : 'invalid_request';
    throw new AiProviderError(`${label} API returned HTTP ${res.status}${detail}`, res.status === 429 || res.status >= 500, kind);
  }
  return (await res.json()) as T;
}

interface ChatCompletion {
  model: string;
  choices: { message: { content: string | null; refusal?: string | null }; finish_reason: string }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export interface OpenAIProviderConfig {
  apiKey: string;
  /** Which OpenAI-compatible service; defaults to OpenAI. */
  kind?: CompatibleProvider;
  baseUrl?: string;
  model?: string;
  fastModel?: string;
  fetchImpl?: FetchImpl;
}

type StructuredMode = 'json_schema' | 'json_object' | 'prompt';

export class OpenAIProvider implements AIProvider {
  readonly name: string;
  private readonly preset: Preset;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchImpl;
  /** The structured-output mode this endpoint accepted last, so later calls skip failed modes. */
  private structuredMode: StructuredMode;

  constructor(private readonly config: OpenAIProviderConfig) {
    const kind = config.kind ?? 'openai';
    this.name = kind;
    this.preset = COMPATIBLE_PRESETS[kind];
    this.baseUrl = config.baseUrl ?? this.preset.baseUrl;
    this.fetchImpl = config.fetchImpl ?? ((...args) => fetch(...args));
    this.structuredMode = 'json_schema';
  }

  modelFor(tier: ModelTier): string {
    const model = this.config.model ?? this.preset.model;
    return tier === 'fast' ? (this.config.fastModel ?? (this.config.model ? model : this.preset.fastModel)) : model;
  }

  private async complete(input: GenerateTextInput, responseFormat?: unknown, extraSystem?: string) {
    const model = this.modelFor(input.tier ?? 'default');
    const res = await compatibleFetch<ChatCompletion>(this.fetchImpl, this.preset.label, this.baseUrl, this.config.apiKey, '/chat/completions', {
      model,
      [this.preset.maxTokensParam]: input.maxTokens ?? 4096,
      messages: [{ role: 'system', content: extraSystem ? `${input.system}\n\n${extraSystem}` : input.system }, ...input.messages],
      ...(responseFormat ? { response_format: responseFormat } : {}),
    });
    const choice = res.choices[0];
    if (!choice) throw new AiProviderError('Empty completion', true, 'server');
    if (choice.message.refusal) throw new AiProviderError('The model declined this request', false, 'refusal');
    if (choice.finish_reason === 'length') throw new AiProviderError('Model output was truncated', true, 'truncated');
    return { text: choice.message.content ?? '', model: res.model ?? model, usage: { inputTokens: res.usage?.prompt_tokens, outputTokens: res.usage?.completion_tokens } };
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    return this.complete(input);
  }

  /**
   * Structured output. OpenAI gets strict json_schema. Other services are negotiated:
   * json_schema → json_object → plain instructions, falling back only when the
   * endpoint rejects a mode (HTTP 400). The result is always validated with zod.
   */
  async generateStructured<S extends z.ZodType>(input: GenerateStructuredInput<S>): Promise<GenerateStructuredResult<z.infer<S>>> {
    const schema = toStrictJsonSchema(input.schema);
    const schemaInstruction = `Respond with only a JSON object (no prose, no code fences) that matches this JSON schema:\n${JSON.stringify(schema)}`;
    const modes: StructuredMode[] =
      this.preset.structured === 'strict' ? ['json_schema'] : (['json_schema', 'json_object', 'prompt'] as StructuredMode[]).slice((['json_schema', 'json_object', 'prompt'] as StructuredMode[]).indexOf(this.structuredMode));

    let result: Awaited<ReturnType<OpenAIProvider['complete']>> | undefined;
    let lastError: unknown;
    for (const mode of modes) {
      try {
        if (mode === 'json_schema') {
          result = await this.complete(input, { type: 'json_schema', json_schema: { name: input.schemaName, strict: true, schema } }, this.preset.structured === 'strict' ? undefined : schemaInstruction);
        } else if (mode === 'json_object') {
          result = await this.complete(input, { type: 'json_object' }, schemaInstruction);
        } else {
          result = await this.complete(input, undefined, schemaInstruction);
        }
        this.structuredMode = mode;
        break;
      } catch (error) {
        lastError = error;
        const rejectedMode = error instanceof AiProviderError && error.kind === 'invalid_request';
        if (!rejectedMode || mode === modes[modes.length - 1]) throw error;
      }
    }
    if (!result) throw lastError;

    let parsed: unknown;
    try {
      parsed = this.structuredMode === 'json_schema' || this.structuredMode === 'json_object' ? JSON.parse(result.text) : extractJson(result.text);
    } catch {
      try {
        parsed = extractJson(result.text);
      } catch {
        throw new AiOutputValidationError(`${input.schemaName}: output was not valid JSON`, result.text);
      }
    }
    const validated = input.schema.safeParse(parsed);
    if (!validated.success) throw new AiOutputValidationError(`${input.schemaName}: ${validated.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, result.text);
    return { data: validated.data, model: result.model, usage: result.usage };
  }
}

export const EMBEDDING_DIMENSIONS = 1536;

/**
 * Fits a vector to the fixed 1536-d storage column without changing similarity:
 * shorter vectors are zero-padded (dot products and norms are unchanged); longer
 * vectors are truncated and re-normalized, which is valid for Matryoshka-trained
 * models such as gemini-embedding-001 and OpenAI text-embedding-3.
 */
export function fitEmbedding(vector: number[], dimensions = EMBEDDING_DIMENSIONS): number[] {
  if (vector.length === dimensions) return vector;
  if (vector.length < dimensions) return [...vector, ...new Array<number>(dimensions - vector.length).fill(0)];
  const cut = vector.slice(0, dimensions);
  const norm = Math.sqrt(cut.reduce((s, v) => s + v * v, 0)) || 1;
  return cut.map((v) => v / norm);
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly dimensions = EMBEDDING_DIMENSIONS;
  readonly model: string;
  private readonly preset: Preset;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchImpl;

  constructor(private readonly config: { apiKey: string; kind?: CompatibleProvider; baseUrl?: string; model?: string; fetchImpl?: FetchImpl }) {
    const kind = config.kind ?? 'openai';
    this.name = kind;
    this.preset = COMPATIBLE_PRESETS[kind];
    this.model = config.model ?? this.preset.embeddingModel;
    this.baseUrl = config.baseUrl ?? this.preset.baseUrl;
    this.fetchImpl = config.fetchImpl ?? ((...args) => fetch(...args));
  }

  async generateEmbeddings(texts: string[], purpose: EmbeddingPurpose = 'document'): Promise<number[][]> {
    if (!texts.length) return [];
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 64) {
      const res = await compatibleFetch<{ data: { index: number; embedding: number[] }[] }>(this.fetchImpl, this.preset.label, this.baseUrl, this.config.apiKey, '/embeddings', {
        model: this.model,
        input: texts.slice(i, i + 64),
        encoding_format: 'float',
        ...(this.preset.embeddingDimensionsParam ? { dimensions: this.dimensions } : {}),
        ...(this.preset.embeddingInputType ? { input_type: purpose === 'query' ? 'query' : 'passage', truncate: 'END' } : {}),
      });
      out.push(...res.data.sort((a, b) => a.index - b.index).map((d) => fitEmbedding(d.embedding, this.dimensions)));
    }
    return out;
  }
}
