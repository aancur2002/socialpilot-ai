import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

/**
 * Loads `.env` (or the file named by ENV_FILE) from the current directory or
 * the nearest parent. Variables already present in the process environment win.
 */
function loadEnvFile(): void {
  const name = process.env.ENV_FILE ?? '.env';
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = resolve(dir, name);
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined));

const base64Key32 = z.string().refine(
  (v) => {
    try {
      return Buffer.from(v, 'base64').length === 32;
    } catch {
      return false;
    }
  },
  { message: 'must be 32 bytes, base64-encoded' },
);

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_ENV: z.string().default('local'),

    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),

    APP_URL: z.string().url().default('http://localhost:3000'),
    API_URL: z.string().url().default('http://localhost:4000'),
    WEBHOOK_BASE_URL: z.string().url().default('http://localhost:4000'),
    API_PORT: z.coerce.number().int().positive().default(4000),
    CORS_ORIGINS: z.string().default('http://localhost:3000'),

    ENCRYPTION_KEY: base64Key32,
    ENCRYPTION_KEY_VERSION: z.coerce.number().int().positive().default(1),
    ENCRYPTION_KEY_PREVIOUS: optionalString,
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    SESSION_TTL_HOURS: z.coerce.number().int().positive().default(168),

    AI_PROVIDER: z.enum(['anthropic', 'openai', 'google', 'nvidia', 'meta', 'baseten', 'modal', 'mock']).default('mock'),
    AI_API_KEY: optionalString,
    AI_MODEL: optionalString,
    AI_FAST_MODEL: optionalString,
    EMBEDDING_PROVIDER: z.enum(['openai', 'google', 'nvidia', 'mock']).default('mock'),
    EMBEDDING_API_KEY: optionalString,
    EMBEDDING_MODEL: optionalString,
    OPENAI_BASE_URL: optionalString,

    STORAGE_DRIVER: z.enum(['s3', 'local']).default('local'),
    ALLOW_LOCAL_STORAGE: bool,
    /** Directory for STORAGE_DRIVER=local; defaults to <repo>/.data/storage */
    LOCAL_STORAGE_DIR: optionalString,
    S3_ENDPOINT: optionalString,
    S3_REGION: z.string().default('us-east-1'),
    S3_ACCESS_KEY: optionalString,
    S3_SECRET_KEY: optionalString,
    S3_BUCKET: optionalString,
    S3_PUBLIC_URL: optionalString,
    S3_FORCE_PATH_STYLE: bool,

    SOCIAL_MOCK_MODE: bool,

    FACEBOOK_CLIENT_ID: optionalString,
    FACEBOOK_CLIENT_SECRET: optionalString,
    FACEBOOK_WEBHOOK_VERIFY_TOKEN: optionalString,
    META_GRAPH_API_VERSION: z.string().default('v23.0'),
    INSTAGRAM_CLIENT_ID: optionalString,
    INSTAGRAM_CLIENT_SECRET: optionalString,
    INSTAGRAM_WEBHOOK_VERIFY_TOKEN: optionalString,
    WHATSAPP_CLIENT_ID: optionalString,
    WHATSAPP_CLIENT_SECRET: optionalString,
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: optionalString,
    WHATSAPP_CONFIG_ID: optionalString,
    LINKEDIN_CLIENT_ID: optionalString,
    LINKEDIN_CLIENT_SECRET: optionalString,
    LINKEDIN_API_VERSION: z.string().default('202509'),
    LINKEDIN_ORGANIZATION_SCOPES: bool,
    TIKTOK_CLIENT_KEY: optionalString,
    TIKTOK_CLIENT_SECRET: optionalString,

    EMAIL_DRIVER: z.enum(['log', 'smtp']).default('log'),
    SMTP_URL: optionalString,
    EMAIL_FROM: z.string().default('SocialPilot AI <no-reply@example.com>'),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    PUBLISH_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
    API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),
  })
  .superRefine((env, ctx) => {
    const isProd = env.NODE_ENV === 'production' || env.APP_ENV === 'production';
    if (isProd && env.SOCIAL_MOCK_MODE) {
      ctx.addIssue({
        code: 'custom',
        path: ['SOCIAL_MOCK_MODE'],
        message: 'Mock social providers must never be enabled in production',
      });
    }
    if (isProd && env.AI_PROVIDER === 'mock') {
      ctx.addIssue({ code: 'custom', path: ['AI_PROVIDER'], message: 'Mock AI provider is not allowed in production' });
    }
    // Local disk storage suits a single server with a persistent volume; it must be chosen
    // explicitly in production because it doesn't work with several API servers.
    if (isProd && env.STORAGE_DRIVER === 'local' && !env.ALLOW_LOCAL_STORAGE) {
      ctx.addIssue({ code: 'custom', path: ['STORAGE_DRIVER'], message: 'Local storage in production needs ALLOW_LOCAL_STORAGE=true (single server with a persistent volume), or use STORAGE_DRIVER=s3' });
    }
    if (env.AI_PROVIDER !== 'mock' && !env.AI_API_KEY) {
      ctx.addIssue({ code: 'custom', path: ['AI_API_KEY'], message: `AI_API_KEY is required for ${env.AI_PROVIDER}` });
    }
    if (env.EMBEDDING_PROVIDER !== 'mock' && !(env.EMBEDDING_API_KEY ?? (env.AI_PROVIDER === env.EMBEDDING_PROVIDER ? env.AI_API_KEY : undefined))) {
      ctx.addIssue({ code: 'custom', path: ['EMBEDDING_API_KEY'], message: `EMBEDDING_API_KEY is required for ${env.EMBEDDING_PROVIDER} embeddings` });
    }
    if (env.STORAGE_DRIVER === 's3') {
      for (const key of ['S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'] as const) {
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required when STORAGE_DRIVER=s3` });
      }
    }
    if (env.EMAIL_DRIVER === 'smtp' && !env.SMTP_URL) {
      ctx.addIssue({ code: 'custom', path: ['SMTP_URL'], message: 'SMTP_URL is required when EMAIL_DRIVER=smtp' });
    }
  });

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/** Parses and caches the environment. Throws a readable error listing every problem. */
export function getEnv(): Env {
  if (cached) return cached;
  loadEnvFile();
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}\nSee env.example for documentation.`);
  }
  cached = parsed.data;
  return cached;
}

/** Test helper: clears the cached env so a test can change process.env. */
export function resetEnvCache(): void {
  cached = undefined;
}

export function isProduction(env: Env = getEnv()): boolean {
  return env.NODE_ENV === 'production' || env.APP_ENV === 'production';
}

/** Mock social adapters are available only outside production and when explicitly enabled. */
export function mockSocialEnabled(env: Env = getEnv()): boolean {
  return env.SOCIAL_MOCK_MODE && !isProduction(env);
}

export const repoRoot = (): string => {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'turbo.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
};
