import { join } from 'node:path';
import { createAIProvider, createEmbeddingProvider, type AIProvider, type EmbeddingProvider } from '@socialpilot/ai';
import { buildKeyRing, hmacSha256, type KeyRing } from '@socialpilot/auth';
import { getEnv, mockSocialEnabled, repoRoot, type Env } from '@socialpilot/config';
import { prisma, type PrismaClient } from '@socialpilot/database';
import { SocialAdapterRegistry } from '@socialpilot/social';
import { LocalStorage, S3Storage, type StorageProvider } from '@socialpilot/storage';
import type { Redis } from 'ioredis';
import { getLogger, type Logger } from './logger';
import { createRedis, Queues } from './queue/queues';
import { RateLimitService } from './queue/rate-limit';

/** Process-wide dependencies. Built lazily from validated env; tests may override parts. */
export interface Infra {
  env: Env;
  db: PrismaClient;
  redis: Redis;
  keyRing: KeyRing;
  ai: AIProvider;
  embeddings: EmbeddingProvider;
  storage: StorageProvider;
  social: SocialAdapterRegistry;
  queues: Queues;
  rateLimits: RateLimitService;
  logger: Logger;
}

let infra: Infra | undefined;

export function mockWebhookSecret(env: Env): string {
  return hmacSha256(env.JWT_SECRET, 'socialpilot-mock-webhook-v1');
}

export function buildInfra(env: Env = getEnv()): Infra {
  const redis = createRedis(env.REDIS_URL);
  const aiConfig = {
    provider: env.AI_PROVIDER,
    apiKey: env.AI_API_KEY,
    model: env.AI_MODEL,
    fastModel: env.AI_FAST_MODEL,
    openaiBaseUrl: env.OPENAI_BASE_URL,
    embeddingProvider: env.EMBEDDING_PROVIDER,
    embeddingApiKey: env.EMBEDDING_API_KEY,
    embeddingModel: env.EMBEDDING_MODEL,
  };
  const storage: StorageProvider =
    env.STORAGE_DRIVER === 's3'
      ? new S3Storage({
          endpoint: env.S3_ENDPOINT,
          region: env.S3_REGION,
          accessKeyId: env.S3_ACCESS_KEY!,
          secretAccessKey: env.S3_SECRET_KEY!,
          bucket: env.S3_BUCKET!,
          publicUrl: env.S3_PUBLIC_URL,
          forcePathStyle: env.S3_FORCE_PATH_STYLE,
        })
      : new LocalStorage(env.LOCAL_STORAGE_DIR ?? join(repoRoot(), '.data', 'storage'), env.API_URL);

  return {
    env,
    db: prisma,
    redis,
    keyRing: buildKeyRing(env.ENCRYPTION_KEY, env.ENCRYPTION_KEY_VERSION, env.ENCRYPTION_KEY_PREVIOUS),
    ai: createAIProvider(aiConfig),
    embeddings: createEmbeddingProvider(aiConfig),
    storage,
    social: new SocialAdapterRegistry({
      mockEnabled: mockSocialEnabled(env),
      apiUrl: env.API_URL,
      mockWebhookSecret: mockWebhookSecret(env),
      metaGraphVersion: env.META_GRAPH_API_VERSION,
      facebook: { clientId: env.FACEBOOK_CLIENT_ID, clientSecret: env.FACEBOOK_CLIENT_SECRET, webhookVerifyToken: env.FACEBOOK_WEBHOOK_VERIFY_TOKEN },
      instagram: { clientId: env.INSTAGRAM_CLIENT_ID, clientSecret: env.INSTAGRAM_CLIENT_SECRET, webhookVerifyToken: env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN },
      whatsapp: { clientId: env.WHATSAPP_CLIENT_ID, clientSecret: env.WHATSAPP_CLIENT_SECRET, webhookVerifyToken: env.WHATSAPP_WEBHOOK_VERIFY_TOKEN, configId: env.WHATSAPP_CONFIG_ID },
      linkedin: { clientId: env.LINKEDIN_CLIENT_ID, clientSecret: env.LINKEDIN_CLIENT_SECRET, apiVersion: env.LINKEDIN_API_VERSION, organizationScopes: env.LINKEDIN_ORGANIZATION_SCOPES },
      tiktok: { clientId: env.TIKTOK_CLIENT_KEY, clientSecret: env.TIKTOK_CLIENT_SECRET },
    }),
    queues: new Queues(redis),
    rateLimits: new RateLimitService(redis),
    logger: getLogger(),
  };
}

export function getInfra(): Infra {
  if (!infra) infra = buildInfra();
  return infra;
}

/** Test hook: replace parts of the infrastructure (e.g. a fake AI provider). */
export function overrideInfra(partial: Partial<Infra>): Infra {
  infra = { ...getInfra(), ...partial };
  return infra;
}

export async function closeInfra(): Promise<void> {
  if (!infra) return;
  await infra.queues.close();
  infra.redis.disconnect();
  await infra.db.$disconnect();
  infra = undefined;
}
