import type { z } from 'zod';

export type ModelTier = 'default' | 'fast';
export type Effort = 'low' | 'medium' | 'high';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface GenerateTextInput {
  system: string;
  messages: ChatMessage[];
  tier?: ModelTier;
  maxTokens?: number;
  effort?: Effort;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface GenerateTextResult {
  text: string;
  model: string;
  usage: TokenUsage;
}

export interface GenerateStructuredInput<S extends z.ZodType> extends GenerateTextInput {
  /** Short identifier of the output contract, e.g. "intent_classification". */
  schemaName: string;
  schema: S;
  /**
   * Structured, already-parsed view of the request used ONLY by the offline mock
   * provider to produce deterministic output. Real providers ignore it.
   */
  mockContext?: unknown;
}

export interface GenerateStructuredResult<T> {
  data: T;
  model: string;
  usage: TokenUsage;
}

/** Vendor-neutral LLM interface. The application never imports a vendor SDK directly. */
export interface AIProvider {
  readonly name: string;
  modelFor(tier: ModelTier): string;
  generateText(input: GenerateTextInput): Promise<GenerateTextResult>;
  /** Output is validated against `schema`; throws AiOutputValidationError when it does not conform. */
  generateStructured<S extends z.ZodType>(input: GenerateStructuredInput<S>): Promise<GenerateStructuredResult<z.infer<S>>>;
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  generateEmbeddings(texts: string[]): Promise<number[][]>;
}

export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly kind: 'refusal' | 'rate_limit' | 'auth' | 'invalid_request' | 'server' | 'network' | 'truncated' | 'unknown' = 'unknown',
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

export class AiOutputValidationError extends Error {
  constructor(
    message: string,
    readonly rawOutput: string,
  ) {
    super(message);
    this.name = 'AiOutputValidationError';
  }
}
