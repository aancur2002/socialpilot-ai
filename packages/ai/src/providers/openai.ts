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
 * (its OpenAI compatibility endpoint), NVIDIA NIM (build.nvidia.com) and the Meta
 * Model API (Muse Spark) all speak this API, with small differences captured in the
 * presets below.
 */
export type CompatibleProvider = 'openai' | 'google' | 'nvidia' | 'meta';

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
  /** Sends reasoning_effort: minimal for the fast tier, the caller's effort (or low) otherwise. */
  reasoningEffort?: boolean;
  /** Returned by listModels when the service has no /models endpoint. */
  knownModels?: string[];
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
    model: 'gemini-3.8-flash',
    fastModel: 'gemini-3.1-flash-lite',
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
  meta: {
    label: 'Meta Model',
    baseUrl: 'https://api.meta.ai/v1',
    model: 'muse-spark-1.3',
    fastModel: 'muse-spark-1.3',
    // No embedding model: knowledge search pairs Meta text with Google or NVIDIA embeddings.
    embeddingModel: '',
    maxTokensParam: 'max_completion_tokens',
    structured: 'strict',
    embeddingDimensionsParam: false,
    embeddingInputType: false,
    reasoningEffort: true,
    knownModels: ['muse-spark-1.3', 'muse-spark-1.2', 'muse-spark-1.1', 'muse-spark-1.3-contributor', 'muse-spark-1.2-contributor'],
  },
};

type FetchImpl = typeof fetch;

const SHORT_JSON_REMINDER = 'Respond with only a JSON object that follows the response schema. No prose, no code fences.';
const addUsage = (a: { inputTokens?: number; outputTokens?: number }, b: { inputTokens?: number; outputTokens?: number }) => ({
  inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0) || undefined,
  outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0) || undefined,
});

/** Brief pause before retrying a temporary overload; honors Retry-After up to 5 seconds. */
function retryDelayMs(res: Response): number {
  const header = Number(res.headers.get('retry-after'));
  return Number.isFinite(header) && header > 0 ? Math.min(header * 1000, 5000) : 1500;
}

/**
 * Calls the service, retrying once after a short pause on 503 (overloaded) or 429
 * (rate limited), since those often clear within seconds. Persistent failures are
 * left to the caller, where a failover chain moves on to the next provider.
 */
export async function compatibleFetch<T>(fetchImpl: FetchImpl, label: string, baseUrl: string, apiKey: string, path: string, body?: unknown): Promise<T> {
  try {
    return await compatibleFetchOnce<T>(fetchImpl, label, baseUrl, apiKey, path, body);
  } catch (error) {
    if (error instanceof TemporaryOverload) {
      await new Promise((r) => setTimeout(r, error.delayMs));
      return compatibleFetchOnce<T>(fetchImpl, label, baseUrl, apiKey, path, body, true);
    }
    throw error;
  }
}

class TemporaryOverload extends Error {
  constructor(readonly delayMs: number) {
    super('temporary overload');
  }
}

async function compatibleFetchOnce<T>(fetchImpl: FetchImpl, label: string, baseUrl: string, apiKey: string, path: string, body?: unknown, isRetry = false): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new AiProviderError(`Could not reach the ${label} API`, true, 'network');
  }
  if (!res.ok && !isRetry && (res.status === 503 || res.status === 429)) {
    throw new TemporaryOverload(retryDelayMs(res));
  }
  if (!res.ok) {
    // Include the provider's own error text (never the key) so the settings test is actionable.
    let detail = '';
    try {
      // Some services (e.g. Gemini) wrap the error object in an array.
      const json = (await res.json()) as unknown;
      const data = (Array.isArray(json) ? json[0] : json) as { error?: { message?: string } | string; detail?: string; message?: string } | undefined;
      const raw = typeof data?.error === 'string' ? data.error : (data?.error?.message ?? data?.detail ?? data?.message ?? '');
      detail = raw ? `: ${String(raw).slice(0, 300)}` : '';
    } catch {
      detail = '';
    }
    const kind = res.status === 429 ? 'rate_limit' : res.status === 401 || res.status === 402 || res.status === 403 ? 'auth' : res.status >= 500 ? 'server' : 'invalid_request';
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
  /** Set once json_schema output failed validation with only the short reminder. */
  private schemaTextNeeded = false;

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
    const tier = input.tier ?? 'default';
    const model = this.modelFor(tier);
    const res = await compatibleFetch<ChatCompletion>(this.fetchImpl, this.preset.label, this.baseUrl, this.config.apiKey, '/chat/completions', {
      model,
      [this.preset.maxTokensParam]: input.maxTokens ?? 4096,
      ...(this.preset.reasoningEffort ? { reasoning_effort: tier === 'fast' ? 'minimal' : (input.effort ?? 'low') } : {}),
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

  /** Model IDs this key can use, straight from the service's /models endpoint. */
  async listModels(): Promise<string[]> {
    try {
      return await listCompatibleModels(this.fetchImpl, this.preset.label, this.baseUrl, this.config.apiKey);
    } catch (error) {
      // Only a missing endpoint falls back; a bad key must still surface.
      if (this.preset.knownModels && error instanceof AiProviderError && error.kind === 'invalid_request') return this.preset.knownModels;
      throw error;
    }
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

    // When the endpoint enforces the schema (json_schema), repeating it as text only costs
    // tokens (100-250 per call), so a one-line reminder is sent instead. If an endpoint's
    // output still doesn't validate, the full schema text is used from then on.
    const jsonSchemaExtra = () => (this.preset.structured === 'strict' ? undefined : this.schemaTextNeeded ? schemaInstruction : SHORT_JSON_REMINDER);
    const run = (mode: StructuredMode) =>
      mode === 'json_schema'
        ? this.complete(input, { type: 'json_schema', json_schema: { name: input.schemaName, strict: true, schema } }, jsonSchemaExtra())
        : mode === 'json_object'
          ? this.complete(input, { type: 'json_object' }, schemaInstruction)
          : this.complete(input, undefined, schemaInstruction);

    let result: Awaited<ReturnType<OpenAIProvider['complete']>> | undefined;
    let lastError: unknown;
    for (const mode of modes) {
      try {
        result = await run(mode);
        this.structuredMode = mode;
        break;
      } catch (error) {
        lastError = error;
        const rejectedMode = error instanceof AiProviderError && error.kind === 'invalid_request';
        if (!rejectedMode || mode === modes[modes.length - 1]) throw error;
      }
    }
    if (!result) throw lastError;

    try {
      return { data: this.parseStructured(input, result.text), model: result.model, usage: result.usage };
    } catch (error) {
      const shortened = this.structuredMode === 'json_schema' && this.preset.structured !== 'strict' && !this.schemaTextNeeded;
      if (!(error instanceof AiOutputValidationError) || !shortened) throw error;
      this.schemaTextNeeded = true;
      const retry = await run('json_schema');
      return { data: this.parseStructured(input, retry.text), model: retry.model, usage: addUsage(result.usage, retry.usage) };
    }
  }

  private parseStructured<S extends z.ZodType>(input: GenerateStructuredInput<S>, text: string): z.infer<S> {
    let parsed: unknown;
    try {
      parsed = this.structuredMode === 'json_schema' || this.structuredMode === 'json_object' ? JSON.parse(text) : extractJson(text);
    } catch {
      try {
        parsed = extractJson(text);
      } catch {
        throw new AiOutputValidationError(`${input.schemaName}: output was not valid JSON`, text);
      }
    }
    const validated = input.schema.safeParse(parsed);
    if (!validated.success) throw new AiOutputValidationError(`${input.schemaName}: ${validated.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, text);
    return validated.data;
  }

}

/** Lists model IDs from an OpenAI-compatible /models endpoint (Gemini prefixes IDs with "models/"). */
export async function listCompatibleModels(fetchImpl: FetchImpl, label: string, baseUrl: string, apiKey: string): Promise<string[]> {
  const res = await compatibleFetch<{ data?: { id: string }[] }>(fetchImpl, label, baseUrl, apiKey, '/models');
  return [...new Set((res.data ?? []).map((m) => m.id.replace(/^models\//, '')))].sort();
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

  async listModels(): Promise<string[]> {
    return listCompatibleModels(this.fetchImpl, this.preset.label, this.baseUrl, this.config.apiKey);
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
