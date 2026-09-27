import { AnthropicProvider } from './providers/anthropic';
import { HashingEmbeddingProvider, MockAIProvider } from './providers/mock';
import { OpenAIEmbeddingProvider, OpenAIProvider } from './providers/openai';
import type { AIProvider, EmbeddingProvider } from './providers/types';

export interface AiFactoryConfig {
  provider: 'anthropic' | 'openai' | 'google' | 'nvidia' | 'meta' | 'mock';
  apiKey?: string;
  model?: string;
  fastModel?: string;
  openaiBaseUrl?: string;
  embeddingProvider: 'openai' | 'google' | 'nvidia' | 'mock';
  embeddingApiKey?: string;
  embeddingModel?: string;
}

export function createAIProvider(config: AiFactoryConfig): AIProvider {
  switch (config.provider) {
    case 'anthropic':
      if (!config.apiKey) throw new Error('AI_API_KEY is required for the anthropic provider');
      return new AnthropicProvider({ apiKey: config.apiKey, model: config.model, fastModel: config.fastModel });
    case 'openai':
    case 'google':
    case 'nvidia':
    case 'meta':
      if (!config.apiKey) throw new Error(`AI_API_KEY is required for the ${config.provider} provider`);
      return new OpenAIProvider({
        apiKey: config.apiKey,
        kind: config.provider,
        baseUrl: config.provider === 'openai' ? config.openaiBaseUrl : undefined,
        model: config.model,
        fastModel: config.fastModel,
      });
    case 'mock':
      return new MockAIProvider();
  }
}

export function createEmbeddingProvider(config: AiFactoryConfig): EmbeddingProvider {
  if (config.embeddingProvider !== 'mock') {
    const apiKey = config.embeddingApiKey ?? (config.provider === config.embeddingProvider ? config.apiKey : undefined);
    if (!apiKey) throw new Error(`EMBEDDING_API_KEY is required for ${config.embeddingProvider} embeddings`);
    return new OpenAIEmbeddingProvider({
      apiKey,
      kind: config.embeddingProvider,
      baseUrl: config.embeddingProvider === 'openai' ? config.openaiBaseUrl : undefined,
      model: config.embeddingModel,
    });
  }
  return new HashingEmbeddingProvider();
}
