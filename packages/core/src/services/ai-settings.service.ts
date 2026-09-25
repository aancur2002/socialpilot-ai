import { createAIProvider, createEmbeddingProvider, type AIProvider, type EmbeddingProvider } from '@socialpilot/ai';
import { decryptSecret, encryptSecret } from '@socialpilot/auth';
import { isProduction } from '@socialpilot/config';
import type { OrganizationAiSettings } from '@socialpilot/database';
import type { AiSettingsInput } from '@socialpilot/validation';
import { requirePermission, type AuthContext } from '../context';
import { badRequest } from '../errors';
import { getInfra } from '../infra';
import { audit } from './audit.service';

/** Suggested model IDs shown in the UI. Any valid model ID can be entered. */
export const MODEL_SUGGESTIONS = {
  anthropic: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-fable-5-1'],
  openai: ['gpt-4.1', 'gpt-4.1-mini'],
  embeddings: { openai: ['text-embedding-3-small'] },
} as const;

type Provider = 'anthropic' | 'openai' | 'mock';
type EmbeddingProviderKey = 'openai' | 'mock';

interface Resolved {
  provider: Provider;
  model?: string;
  fastModel?: string;
  apiKey?: string;
  baseUrl?: string;
  embeddingProvider: EmbeddingProviderKey;
  embeddingModel?: string;
  embeddingApiKey?: string;
}

const aad = (organizationId: string, field: string) => `ai-settings:${organizationId}:${field}`;
const encrypt = (organizationId: string, field: string, value: string) => encryptSecret(getInfra().keyRing, value, aad(organizationId, field));
const decrypt = (organizationId: string, field: string, value: string | null) => (value ? decryptSecret(getInfra().keyRing, value, aad(organizationId, field)) : undefined);

/** Merges organization settings over the server environment defaults. */
function resolve(organizationId: string, row: Partial<OrganizationAiSettings> | null, override?: AiSettingsInput): Resolved {
  const { env } = getInfra();
  const pick = <T>(o: T | null | undefined, r: T | null | undefined, e: T | undefined): T | undefined => (o !== undefined ? (o ?? e) : (r ?? e));
  const provider = (pick(override?.provider, row?.provider as Provider | null, env.AI_PROVIDER) ?? 'mock') as Provider;
  const storedKey = decrypt(organizationId, 'apiKey', row?.apiKeyEnc ?? null);
  const orgKey = override?.apiKey !== undefined ? (override.apiKey ?? undefined) : storedKey;
  const apiKey = orgKey ?? (env.AI_PROVIDER === provider ? env.AI_API_KEY : undefined);

  const embeddingProvider = (pick(override?.embeddingProvider, row?.embeddingProvider as EmbeddingProviderKey | null, env.EMBEDDING_PROVIDER) ?? 'mock') as EmbeddingProviderKey;
  const storedEmbKey = decrypt(organizationId, 'embeddingApiKey', row?.embeddingApiKeyEnc ?? null);
  const orgEmbKey = override?.embeddingApiKey !== undefined ? (override.embeddingApiKey ?? undefined) : storedEmbKey;
  const embeddingApiKey = orgEmbKey ?? env.EMBEDDING_API_KEY ?? (env.AI_PROVIDER === 'openai' ? env.AI_API_KEY : undefined) ?? (provider === 'openai' ? orgKey : undefined);

  // Models only fall back to env defaults when the provider is the server's provider.
  const sameProvider = provider === env.AI_PROVIDER;
  return {
    provider,
    model: pick(override?.model, row?.model, sameProvider ? env.AI_MODEL : undefined),
    fastModel: pick(override?.fastModel, row?.fastModel, sameProvider ? env.AI_FAST_MODEL : undefined),
    apiKey,
    baseUrl: (override?.baseUrl !== undefined ? override.baseUrl || undefined : row?.baseUrl) ?? env.OPENAI_BASE_URL,
    embeddingProvider,
    embeddingModel: pick(override?.embeddingModel, row?.embeddingModel, embeddingProvider === env.EMBEDDING_PROVIDER ? env.EMBEDDING_MODEL : undefined),
    embeddingApiKey,
  };
}

function assertUsable(r: Resolved) {
  if (isProduction(getInfra().env) && (r.provider === 'mock' || r.embeddingProvider === 'mock')) throw badRequest('The mock AI provider is not allowed in production');
  if (r.provider !== 'mock' && !r.apiKey) throw badRequest(`Add an API key for ${r.provider}`);
  if (r.embeddingProvider === 'openai' && !r.embeddingApiKey) throw badRequest('Add an API key for OpenAI embeddings');
}

function build(r: Resolved): { ai: AIProvider; embeddings: EmbeddingProvider } {
  const config = {
    provider: r.provider,
    apiKey: r.apiKey,
    model: r.model,
    fastModel: r.fastModel,
    openaiBaseUrl: r.baseUrl,
    embeddingProvider: r.embeddingProvider,
    embeddingApiKey: r.embeddingApiKey,
    embeddingModel: r.embeddingModel,
  };
  return { ai: createAIProvider(config), embeddings: createEmbeddingProvider(config) };
}

const cache = new Map<string, { expires: number; value: { ai: AIProvider; embeddings: EmbeddingProvider } }>();
const TTL_MS = 30_000;

/**
 * The AI and embedding providers for an organization: its own settings from
 * Settings → AI models, falling back to the server defaults. Cached briefly;
 * saving settings clears the cache in this process, other processes pick the
 * change up within 30 seconds.
 */
export async function aiFor(organizationId: string): Promise<{ ai: AIProvider; embeddings: EmbeddingProvider }> {
  const hit = cache.get(organizationId);
  if (hit && hit.expires > Date.now()) return hit.value;
  const { db, ai, embeddings, logger } = getInfra();
  const row = await db.organizationAiSettings.findUnique({ where: { organizationId } });
  let value = { ai, embeddings };
  if (row) {
    try {
      const resolved = resolve(organizationId, row);
      assertUsable(resolved);
      value = build(resolved);
    } catch (error) {
      logger.warn({ organizationId, error: error instanceof Error ? error.message : String(error) }, 'organization AI settings unusable; using server defaults');
    }
  }
  cache.set(organizationId, { expires: Date.now() + TTL_MS, value });
  return value;
}

export function clearAiCache(organizationId?: string) {
  if (organizationId) cache.delete(organizationId);
  else cache.clear();
}

const hint = (key: string | undefined) => (key ? `…${key.slice(-4)}` : null);

export async function getAiSettings(ctx: AuthContext) {
  requirePermission(ctx, 'settings:manage');
  const { db, env } = getInfra();
  const row = await db.organizationAiSettings.findUnique({ where: { organizationId: ctx.organizationId } });
  const effective = resolve(ctx.organizationId, row);
  const storedKey = decrypt(ctx.organizationId, 'apiKey', row?.apiKeyEnc ?? null);
  const storedEmbKey = decrypt(ctx.organizationId, 'embeddingApiKey', row?.embeddingApiKeyEnc ?? null);
  const probe = build(effective);
  return {
    saved: {
      provider: row?.provider ?? null,
      model: row?.model ?? null,
      fastModel: row?.fastModel ?? null,
      baseUrl: row?.baseUrl ?? null,
      embeddingProvider: row?.embeddingProvider ?? null,
      embeddingModel: row?.embeddingModel ?? null,
      apiKey: storedKey ? { set: true, hint: hint(storedKey) } : { set: false, hint: null },
      embeddingApiKey: storedEmbKey ? { set: true, hint: hint(storedEmbKey) } : { set: false, hint: null },
    },
    effective: {
      provider: effective.provider,
      model: probe.ai.modelFor('default'),
      fastModel: probe.ai.modelFor('fast'),
      embeddingProvider: effective.embeddingProvider,
      embeddingModel: probe.embeddings.model,
      apiKeySource: storedKey ? 'organization' : effective.apiKey ? 'server' : 'none',
    },
    serverDefaults: { provider: env.AI_PROVIDER, model: env.AI_MODEL ?? null, fastModel: env.AI_FAST_MODEL ?? null, embeddingProvider: env.EMBEDDING_PROVIDER },
    mockAllowed: !isProduction(env),
    suggestions: MODEL_SUGGESTIONS,
    updatedAt: row?.updatedAt ?? null,
  };
}

export async function updateAiSettings(ctx: AuthContext, input: AiSettingsInput) {
  requirePermission(ctx, 'settings:manage');
  const { db } = getInfra();
  const row = await db.organizationAiSettings.findUnique({ where: { organizationId: ctx.organizationId } });
  const before = resolve(ctx.organizationId, row);
  const next = resolve(ctx.organizationId, row, input);
  assertUsable(next);

  const data: Partial<OrganizationAiSettings> = {};
  if (input.provider !== undefined) data.provider = input.provider;
  if (input.model !== undefined) data.model = input.model;
  if (input.fastModel !== undefined) data.fastModel = input.fastModel;
  if (input.baseUrl !== undefined) data.baseUrl = input.baseUrl || null;
  if (input.embeddingProvider !== undefined) data.embeddingProvider = input.embeddingProvider;
  if (input.embeddingModel !== undefined) data.embeddingModel = input.embeddingModel;
  if (input.apiKey !== undefined) data.apiKeyEnc = input.apiKey ? encrypt(ctx.organizationId, 'apiKey', input.apiKey) : null;
  if (input.embeddingApiKey !== undefined) data.embeddingApiKeyEnc = input.embeddingApiKey ? encrypt(ctx.organizationId, 'embeddingApiKey', input.embeddingApiKey) : null;

  await db.organizationAiSettings.upsert({
    where: { organizationId: ctx.organizationId },
    create: { organizationId: ctx.organizationId, ...data, updatedById: ctx.userId },
    update: { ...data, updatedById: ctx.userId },
  });
  clearAiCache(ctx.organizationId);
  await audit(ctx, {
    action: 'ai.settings_changed',
    resourceType: 'OrganizationAiSettings',
    before: { provider: before.provider, model: before.model, fastModel: before.fastModel, embeddingProvider: before.embeddingProvider, embeddingModel: before.embeddingModel },
    after: { provider: next.provider, model: next.model, fastModel: next.fastModel, embeddingProvider: next.embeddingProvider, embeddingModel: next.embeddingModel, apiKeyChanged: input.apiKey !== undefined, embeddingApiKeyChanged: input.embeddingApiKey !== undefined },
  });
  const embeddingChanged = build(before).embeddings.model !== build(next).embeddings.model;
  return { ...(await getAiSettings(ctx)), reindexRequired: embeddingChanged };
}

/** Makes a tiny real call with the given (unsaved) settings merged over the saved ones. */
export async function testAiSettings(ctx: AuthContext, input: AiSettingsInput) {
  requirePermission(ctx, 'settings:manage');
  const row = await getInfra().db.organizationAiSettings.findUnique({ where: { organizationId: ctx.organizationId } });
  const resolved = resolve(ctx.organizationId, row, input);
  const result: { text: { ok: boolean; model?: string; latencyMs?: number; error?: string }; embeddings: { ok: boolean; model?: string; dimensions?: number; latencyMs?: number; error?: string } } = {
    text: { ok: false },
    embeddings: { ok: false },
  };
  try {
    assertUsable(resolved);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { text: { ok: false, error: message }, embeddings: { ok: false, error: message } };
  }
  const { ai, embeddings } = build(resolved);
  let started = Date.now();
  try {
    const res = await ai.generateText({ system: 'You are a connection test. Reply with the single word OK.', messages: [{ role: 'user', content: 'Connection test' }], maxTokens: 256, effort: 'low' });
    result.text = { ok: true, model: res.model, latencyMs: Date.now() - started };
  } catch (error) {
    result.text = { ok: false, model: ai.modelFor('default'), error: error instanceof Error ? error.message : String(error) };
  }
  started = Date.now();
  try {
    const [vector] = await embeddings.generateEmbeddings(['connection test']);
    result.embeddings = { ok: Boolean(vector?.length), model: embeddings.model, dimensions: vector?.length, latencyMs: Date.now() - started };
  } catch (error) {
    result.embeddings = { ok: false, model: embeddings.model, error: error instanceof Error ? error.message : String(error) };
  }
  return result;
}
