import { AnthropicProvider } from './providers/anthropic';
import { HashingEmbeddingProvider, MockAIProvider } from './providers/mock';
import { OpenAIEmbeddingProvider, OpenAIProvider } from './providers/openai';
import type { AIProvider, EmbeddingProvider } from './providers/types';

export interface AiFactoryConfig {
  provider: 'anthropic' | 'openai' | 'mock';
  apiKey?: string;
  model?: string;
  fastModel?: string;
  openaiBaseUrl?: string;
  embeddingProvider: 'openai' | 'mock';
  embeddingApiKey?: string;
  embeddingModel?: string;
}

export function createAIProvider(config: AiFactoryConfig): AIProvider {
  switch (config.provider) {
    case 'anthropic':
      if (!config.apiKey) throw new Error('AI_API_KEY is required for the anthropic provider');
      return new AnthropicProvider({ apiKey: config.apiKey, model: config.model, fastModel: config.fastModel });
    case 'openai':
      if (!config.apiKey) throw new Error('AI_API_KEY is required for the openai provider');
      return new OpenAIProvider({ apiKey: config.apiKey, baseUrl: config.openaiBaseUrl, model: config.model, fastModel: config.fastModel });
    case 'mock':
      return new MockAIProvider();
  }
}

export function createEmbeddingProvider(config: AiFactoryConfig): EmbeddingProvider {
  if (config.embeddingProvider === 'openai') {
    const apiKey = config.embeddingApiKey ?? config.apiKey;
    if (!apiKey) throw new Error('EMBEDDING_API_KEY is required for openai embeddings');
    return new OpenAIEmbeddingProvider({ apiKey, baseUrl: config.openaiBaseUrl, model: config.embeddingModel });
  }
  return new HashingEmbeddingProvider();
}
