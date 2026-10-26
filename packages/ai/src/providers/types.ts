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
  /** Which provider answered (set when a failover chain is used) */
  provider?: string;
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
  /** Which provider answered (set when a failover chain is used) */
  provider?: string;
}

// ── Tool calling (agents) ─────────────────────────────────────────────

/** A function the model may call; `parameters` is a JSON schema object. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** JSON-encoded arguments, exactly as the model produced them */
  arguments: string;
}

export type AgentMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface ChatWithToolsInput {
  messages: AgentMessage[];
  tools: ToolSpec[];
  tier?: ModelTier;
  maxTokens?: number;
  effort?: Effort;
}

export interface ChatWithToolsResult {
  /** The model's text, when it answered instead of (or alongside) calling tools */
  text: string | null;
  toolCalls: ToolCall[];
  model: string;
  usage: TokenUsage;
  provider?: string;
}

/** Vendor-neutral LLM interface. The application never imports a vendor SDK directly. */
export interface AIProvider {
  readonly name: string;
  modelFor(tier: ModelTier): string;
  generateText(input: GenerateTextInput): Promise<GenerateTextResult>;
  /** Output is validated against `schema`; throws AiOutputValidationError when it does not conform. */
  generateStructured<S extends z.ZodType>(input: GenerateStructuredInput<S>): Promise<GenerateStructuredResult<z.infer<S>>>;
  /** Model IDs available to this key, where the provider can list them. */
  listModels?(): Promise<string[]>;
  /** One turn of a tool-calling conversation (agents). */
  chatWithTools?(input: ChatWithToolsInput): Promise<ChatWithToolsResult>;
}

/** Some embedding models encode questions and documents differently. */
export type EmbeddingPurpose = 'query' | 'document';

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  generateEmbeddings(texts: string[], purpose?: EmbeddingPurpose): Promise<number[][]>;
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
