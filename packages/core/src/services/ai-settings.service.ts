import {
  createAIProvider,
  CUSTOM_URL_PROVIDERS,
  createEmbeddingProvider,
  FailoverAIProvider,
  FailoverTranscriber,
  GeminiTranscriber,
  MetaImageProvider,
  MetaSegmenter,
  MetaTranscriber,
  MockImageProvider,
  MockSegmenter,
  MockTranscriber,
  type AIProvider,
  type EmbeddingProvider,
  type ImageProvider,
  type SegmentationProvider,
  type TranscriptionProvider,
} from '@socialpilot/ai';
import { decryptSecret, encryptSecret } from '@socialpilot/auth';
import { isProduction } from '@socialpilot/config';
import type { OrganizationAiSettings, Prisma } from '@socialpilot/database';
import type { AiSettingsInput } from '@socialpilot/validation';
import { requirePermission, type AuthContext } from '../context';
import { badRequest } from '../errors';
import { getInfra } from '../infra';
import { audit } from './audit.service';

/** Suggested model IDs shown in the UI. Any valid model ID can be entered. */
export const MODEL_SUGGESTIONS = {
  anthropic: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-fable-5-1'],
  openai: ['gpt-4.1', 'gpt-4.1-mini'],
  // Providers rename models often: these are starting points, any model ID can be typed.
  google: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.1-pro-preview'],
  // NVIDIA retires models often (the Llama 3.x NIMs ended 2026-08-26) and access varies by key: use "Load models" for the live list.
  nvidia: ['nvidia/nemotron-3.5-lightning-30b-a3b'],
  // Meta Model API (Muse Spark). The -contributor versions are discounted.
  meta: ['muse-spark-1.3', 'muse-spark-1.2', 'muse-spark-1.1', 'muse-spark-1.3-contributor', 'muse-spark-1.2-contributor'],
  // Meta's open weights: Muse Spark Open hosted on Baseten, Muse Glimmer on your own Modal deployment.
  baseten: ['meta-models/muse-spark-open'],
  modal: ['muse-glimmer'],
  embeddings: {
    openai: ['text-embedding-3-small'],
    google: ['gemini-embedding-001', 'gemini-embedding-2-preview'],
    nvidia: ['nvidia/nemotron-3-embed-1b', 'nvidia/nemotron-3.5-embed-1b'],
  },
} as const;

type Provider = 'anthropic' | 'openai' | 'google' | 'nvidia' | 'meta' | 'baseten' | 'modal' | 'mock';
type EmbeddingProviderKey = 'openai' | 'google' | 'nvidia' | 'mock';

interface Resolved {
  provider: Provider;
  model?: string;
  fastModel?: string;
  apiKey?: string;
  baseUrl?: string;
  embeddingProvider: EmbeddingProviderKey;
  embeddingModel?: string;
  embeddingApiKey?: string;
  /** Backup text providers, tried in order after the primary */
  fallbacks: ResolvedFallback[];
}

interface ResolvedFallback {
  provider: Provider;
  model?: string;
  fastModel?: string;
  apiKey?: string;
  /** true when the key was saved in the dashboard (vs. the server .env) */
  orgKey: boolean;
}

/** Stored shape of one backup provider (keys encrypted). */
interface StoredFallback {
  provider: Provider;
  model?: string | null;
  fastModel?: string | null;
  apiKeyEnc?: string | null;
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
  // One key can serve both text and embeddings when they use the same service.
  const fallbacks = resolveFallbacks(organizationId, row, override);
  const embeddingApiKey =
    orgEmbKey ??
    (embeddingProvider === env.EMBEDDING_PROVIDER ? env.EMBEDDING_API_KEY : undefined) ??
    (provider === embeddingProvider ? orgKey : undefined) ??
    fallbacks.find((f) => f.provider === embeddingProvider && f.orgKey)?.apiKey ??
    (env.AI_PROVIDER === embeddingProvider ? env.AI_API_KEY : undefined);

  // Models only fall back to env defaults when the provider is the server's provider.
  const sameProvider = provider === env.AI_PROVIDER;
  return {
    provider,
    model: pick(override?.model, row?.model, sameProvider ? env.AI_MODEL : undefined),
    fastModel: pick(override?.fastModel, row?.fastModel, sameProvider ? env.AI_FAST_MODEL : undefined),
    apiKey,
    // The base URL is for an endpoint you choose: OpenAI-compatible, or your Modal deployment.
    baseUrl: [provider, embeddingProvider, ...fallbacks.map((f) => f.provider)].some((p) => customUrl(p))
      ? ((override?.baseUrl !== undefined ? override.baseUrl || undefined : row?.baseUrl) ?? (provider === 'modal' || fallbacks.some((f) => f.provider === 'modal') ? undefined : env.OPENAI_BASE_URL))
      : undefined,
    embeddingProvider,
    embeddingModel: pick(override?.embeddingModel, row?.embeddingModel, embeddingProvider === env.EMBEDDING_PROVIDER ? env.EMBEDDING_MODEL : undefined),
    embeddingApiKey,
    fallbacks,
  };
}

const customUrl = (provider: string) => (CUSTOM_URL_PROVIDERS as readonly string[]).includes(provider);

function storedFallbacks(row: Partial<OrganizationAiSettings> | null): StoredFallback[] {
  return Array.isArray(row?.fallbacks) ? (row.fallbacks as unknown as StoredFallback[]) : [];
}

const fallbackField = (provider: string) => `fallback:${provider}:apiKey`;

/** Backup providers: from the pending input when given (keys kept per provider), else from storage. */
function resolveFallbacks(organizationId: string, row: Partial<OrganizationAiSettings> | null, override?: AiSettingsInput): ResolvedFallback[] {
  const { env } = getInfra();
  const stored = storedFallbacks(row);
  const storedKey = (provider: string) => decrypt(organizationId, fallbackField(provider), stored.find((s) => s.provider === provider)?.apiKeyEnc ?? null);
  const source =
    override?.fallbacks !== undefined
      ? override.fallbacks.map((f) => ({ provider: f.provider as Provider, model: f.model ?? undefined, fastModel: f.fastModel ?? undefined, key: f.apiKey === undefined ? storedKey(f.provider) : (f.apiKey ?? undefined) }))
      : stored.map((f) => ({ provider: f.provider, model: f.model ?? undefined, fastModel: f.fastModel ?? undefined, key: decrypt(organizationId, fallbackField(f.provider), f.apiKeyEnc ?? null) }));
  return source.map((f) => ({
    provider: f.provider,
    model: f.model,
    fastModel: f.fastModel,
    apiKey: f.key ?? (env.AI_PROVIDER === f.provider ? env.AI_API_KEY : undefined),
    orgKey: Boolean(f.key),
  }));
}

function assertUsable(r: Resolved) {
  const providers = [r.provider, ...r.fallbacks.map((f) => f.provider)];
  if (new Set(providers).size !== providers.length) throw badRequest('Each provider can appear only once (primary or backup)');
  if (isProduction(getInfra().env) && (providers.includes('mock') || r.embeddingProvider === 'mock')) throw badRequest('The mock AI provider is not allowed in production');
  for (const f of r.fallbacks) {
    if (f.provider !== 'mock' && !f.apiKey) throw badRequest(`Add an API key for the ${f.provider} backup`);
  }
  if (providers.includes('modal') && (providers.includes('openai') || r.embeddingProvider === 'openai')) throw badRequest('OpenAI and Modal share the base URL setting, so use one of them');
  if (providers.includes('modal') && !r.baseUrl) throw badRequest('Enter the URL of your Modal deployment as the base URL, ending in /v1');
  if (r.provider !== 'mock' && !r.apiKey) throw badRequest(`Add an API key for ${r.provider}`);
  if (r.embeddingProvider !== 'mock' && !r.embeddingApiKey) throw badRequest(`Add an API key for ${r.embeddingProvider} embeddings`);
}

/** One provider per entry in the chain (primary first), for per-provider testing. */
function buildChain(r: Resolved): AIProvider[] {
  const primary = createAIProvider({ provider: r.provider, apiKey: r.apiKey, model: r.model, fastModel: r.fastModel, openaiBaseUrl: r.baseUrl, embeddingProvider: 'mock' });
  const backups = r.fallbacks.map((f) =>
    createAIProvider({ provider: f.provider, apiKey: f.apiKey, model: f.model, fastModel: f.fastModel, openaiBaseUrl: customUrl(f.provider) ? r.baseUrl : undefined, embeddingProvider: 'mock' }),
  );
  return [primary, ...backups];
}

function build(r: Resolved): { ai: AIProvider; embeddings: EmbeddingProvider } {
  const chain = buildChain(r);
  const ai =
    chain.length > 1
      ? new FailoverAIProvider(chain, (e) => getInfra().logger.warn({ from: e.from, to: e.to, reason: e.reason }, e.to ? 'AI provider failed; trying backup' : 'AI provider failed; no backups left'))
      : chain[0]!;
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
  return { ai, embeddings: createEmbeddingProvider(config) };
}

const cache = new Map<string, { expires: number; version: number | null; value: { ai: AIProvider; embeddings: EmbeddingProvider } }>();
const TTL_MS = 30_000;

/**
 * The AI and embedding providers for an organization: its own settings from
 * Settings → AI models, falling back to the server defaults. Rechecked every 30
 * seconds and rebuilt only when the settings changed; saving settings clears the
 * cache in this process, other processes pick the change up within 30 seconds.
 */
export async function aiFor(organizationId: string): Promise<{ ai: AIProvider; embeddings: EmbeddingProvider }> {
  const hit = cache.get(organizationId);
  if (hit && hit.expires > Date.now()) return hit.value;
  const { db, ai, embeddings, logger } = getInfra();
  const row = await db.organizationAiSettings.findUnique({ where: { organizationId } });
  const version = row?.updatedAt.getTime() ?? null;
  // Unchanged settings keep the same providers, so failover cooldowns (a provider
  // skipped after a billing or rate-limit error) survive the refresh.
  if (hit && hit.version === version) {
    hit.expires = Date.now() + TTL_MS;
    return hit.value;
  }
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
  cache.set(organizationId, { expires: Date.now() + TTL_MS, version, value });
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
  const chain = buildChain(effective);
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
      fallbacks: storedFallbacks(row).map((f) => {
        const key = decrypt(ctx.organizationId, fallbackField(f.provider), f.apiKeyEnc ?? null);
        return { provider: f.provider, model: f.model ?? null, fastModel: f.fastModel ?? null, apiKey: key ? { set: true, hint: hint(key) } : { set: false, hint: null } };
      }),
    },
    effective: {
      provider: effective.provider,
      model: probe.ai.modelFor('default'),
      fastModel: probe.ai.modelFor('fast'),
      embeddingProvider: effective.embeddingProvider,
      embeddingModel: probe.embeddings.model,
      apiKeySource: storedKey ? 'organization' : effective.apiKey ? 'server' : 'none',
      /** Order in which providers are tried */
      chain: chain.map((p) => ({ provider: p.name, model: p.modelFor('default'), fastModel: p.modelFor('fast') })),
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

  const data: Prisma.OrganizationAiSettingsUncheckedUpdateInput = {};
  if (input.provider !== undefined) data.provider = input.provider;
  if (input.model !== undefined) data.model = input.model;
  if (input.fastModel !== undefined) data.fastModel = input.fastModel;
  if (input.baseUrl !== undefined) data.baseUrl = input.baseUrl || null;
  if (input.embeddingProvider !== undefined) data.embeddingProvider = input.embeddingProvider;
  if (input.embeddingModel !== undefined) data.embeddingModel = input.embeddingModel;
  if (input.apiKey !== undefined) data.apiKeyEnc = input.apiKey ? encrypt(ctx.organizationId, 'apiKey', input.apiKey) : null;
  if (input.embeddingApiKey !== undefined) data.embeddingApiKeyEnc = input.embeddingApiKey ? encrypt(ctx.organizationId, 'embeddingApiKey', input.embeddingApiKey) : null;
  if (input.fallbacks !== undefined) {
    const stored = storedFallbacks(row);
    data.fallbacks = input.fallbacks.map((f): StoredFallback => {
      const existing = stored.find((s) => s.provider === f.provider)?.apiKeyEnc ?? null;
      return {
        provider: f.provider as Provider,
        model: f.model ?? null,
        fastModel: f.fastModel ?? null,
        apiKeyEnc: f.apiKey === undefined ? existing : f.apiKey ? encrypt(ctx.organizationId, fallbackField(f.provider), f.apiKey) : null,
      };
    }) as unknown as Prisma.InputJsonValue;
  }

  await db.organizationAiSettings.upsert({
    where: { organizationId: ctx.organizationId },
    create: { ...(data as Prisma.OrganizationAiSettingsUncheckedCreateInput), organizationId: ctx.organizationId, updatedById: ctx.userId },
    update: { ...data, updatedById: ctx.userId },
  });
  clearAiCache(ctx.organizationId);
  const summary = (r: Resolved) => ({ provider: r.provider, model: r.model, fastModel: r.fastModel, embeddingProvider: r.embeddingProvider, embeddingModel: r.embeddingModel, backups: r.fallbacks.map((f) => `${f.provider}${f.model ? `:${f.model}` : ''}`) });
  await audit(ctx, {
    action: 'ai.settings_changed',
    resourceType: 'OrganizationAiSettings',
    before: summary(before),
    after: { ...summary(next), apiKeyChanged: input.apiKey !== undefined, embeddingApiKeyChanged: input.embeddingApiKey !== undefined, backupKeysChanged: (input.fallbacks ?? []).filter((f) => f.apiKey !== undefined).map((f) => f.provider) },
  });
  const embeddingChanged = build(before).embeddings.model !== build(next).embeddings.model;
  // Knowledge is searched only with vectors from the current embedding model, so a change makes
  // it unsearchable until re-indexed. Re-index automatically, after the 30-second settings cache
  // in other processes (the worker) has expired, so the new model is the one used.
  let reindexQueued: number | null = null;
  if (embeddingChanged) {
    const { reindexAllKnowledge } = await import('./knowledge.service');
    reindexQueued = await reindexAllKnowledge(ctx, undefined, { delayMs: 35_000 })
      .then((r) => r.queued)
      .catch(() => null);
  }
  return { ...(await getAiSettings(ctx)), reindexRequired: embeddingChanged && reindexQueued === null, reindexQueued };
}

const NON_TEXT_MODEL = /embed|tts|imagen|veo|image-generation|rerank|guard|aqa|audio|parse|clip|vila|muse-image|transcribe|^sam-/i;

/** Which key to use for a provider when listing models: typed > saved (primary, backup, embeddings) > .env. */
function keyForProvider(organizationId: string, row: Partial<OrganizationAiSettings> | null, provider: string, typed?: string): string | undefined {
  const { env } = getInfra();
  if (typed) return typed;
  if (row?.provider === provider) {
    const k = decrypt(organizationId, 'apiKey', row.apiKeyEnc ?? null);
    if (k) return k;
  }
  const backup = storedFallbacks(row).find((f) => f.provider === provider);
  const backupKey = backup ? decrypt(organizationId, fallbackField(provider), backup.apiKeyEnc ?? null) : undefined;
  if (backupKey) return backupKey;
  if (row?.embeddingProvider === provider) {
    const k = decrypt(organizationId, 'embeddingApiKey', row.embeddingApiKeyEnc ?? null);
    if (k) return k;
  }
  if (env.AI_PROVIDER === provider && env.AI_API_KEY) return env.AI_API_KEY;
  if (env.EMBEDDING_PROVIDER === provider) return env.EMBEDDING_API_KEY ?? undefined;
  return undefined;
}

/** Lists the models a provider offers to this key, filtered to text or embedding models. */
export async function listAvailableModels(ctx: AuthContext, input: { provider: string; apiKey?: string; purpose: 'text' | 'embedding' }) {
  requirePermission(ctx, 'settings:manage');
  if (input.provider === 'mock') return { models: input.purpose === 'embedding' ? ['hashing-1536-v1'] : ['mock-v1', 'mock-fast-v1'] };
  const row = await getInfra().db.organizationAiSettings.findUnique({ where: { organizationId: ctx.organizationId } });
  const apiKey = keyForProvider(ctx.organizationId, row, input.provider, input.apiKey);
  if (!apiKey) throw badRequest(`Enter the ${input.provider} API key first`);
  const provider = createAIProvider({ provider: input.provider as Provider, apiKey, embeddingProvider: 'mock', openaiBaseUrl: input.provider === 'openai' ? (row?.baseUrl ?? getInfra().env.OPENAI_BASE_URL) : input.provider === 'modal' ? (row?.baseUrl ?? undefined) : undefined });
  if (!provider.listModels) throw badRequest(`${input.provider} doesn’t offer a model list`);
  try {
    const all = await provider.listModels();
    const models = input.purpose === 'embedding' ? all.filter((m) => /embed/i.test(m)) : all.filter((m) => !NON_TEXT_MODEL.test(m));
    return { models };
  } catch (error) {
    throw badRequest(`Could not load models: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** After a "model not found" error, name a few models the key can use. */
async function modelHint(provider: AIProvider): Promise<string> {
  try {
    const models = (await provider.listModels?.())?.filter((m) => !NON_TEXT_MODEL.test(m)) ?? [];
    return models.length ? ` Models available to your key include: ${models.slice(0, 8).join(', ')}.` : '';
  } catch {
    return '';
  }
}

type ChainTestResult = { provider: string; role: 'primary' | 'backup'; ok: boolean; model?: string; latencyMs?: number; error?: string };

/**
 * Makes a tiny real call to every provider in the chain (primary and each backup,
 * independently) plus the embeddings provider, using unsaved values merged over saved ones.
 */
export async function testAiSettings(ctx: AuthContext, input: AiSettingsInput) {
  requirePermission(ctx, 'settings:manage');
  const row = await getInfra().db.organizationAiSettings.findUnique({ where: { organizationId: ctx.organizationId } });
  const resolved = resolve(ctx.organizationId, row, input);
  const providers = [resolved.provider, ...resolved.fallbacks.map((f) => f.provider)];
  if (new Set(providers).size !== providers.length) {
    const error = 'Each provider can appear only once (primary or backup)';
    return { text: { ok: false, error }, chain: [] as ChainTestResult[], embeddings: { ok: false, error } };
  }

  const entries: { provider: string; role: 'primary' | 'backup'; build: () => AIProvider; missingKey: boolean }[] = [
    { provider: resolved.provider, role: 'primary', missingKey: resolved.provider !== 'mock' && !resolved.apiKey, build: () => buildChain({ ...resolved, fallbacks: [] })[0]! },
    ...resolved.fallbacks.map((f) => ({
      provider: f.provider,
      role: 'backup' as const,
      missingKey: f.provider !== 'mock' && !f.apiKey,
      build: () => createAIProvider({ provider: f.provider, apiKey: f.apiKey, model: f.model, fastModel: f.fastModel, openaiBaseUrl: customUrl(f.provider) ? resolved.baseUrl : undefined, embeddingProvider: 'mock' }),
    })),
  ];
  const chain: ChainTestResult[] = [];
  for (const entry of entries) {
    if (entry.missingKey) {
      chain.push({ provider: entry.provider, role: entry.role, ok: false, error: `Add an API key for ${entry.provider}` });
      continue;
    }
    const started = Date.now();
    let provider: AIProvider | undefined;
    try {
      provider = entry.build();
      const res = await provider.generateText({ system: 'You are a connection test. Reply with the single word OK.', messages: [{ role: 'user', content: 'Connection test' }], maxTokens: 256, effort: 'low' });
      chain.push({ provider: entry.provider, role: entry.role, ok: true, model: res.model, latencyMs: Date.now() - started });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const notFound = /HTTP 404|not found|does not exist|unknown model/i.test(message);
      chain.push({ provider: entry.provider, role: entry.role, ok: false, model: provider?.modelFor('default'), error: notFound && provider ? `${message}.${await modelHint(provider)}`.replace('..', '.') : message });
    }
  }

  let embeddings: { ok: boolean; model?: string; dimensions?: number; latencyMs?: number; error?: string };
  if (resolved.embeddingProvider !== 'mock' && !resolved.embeddingApiKey) {
    embeddings = { ok: false, error: `Add an API key for ${resolved.embeddingProvider} embeddings` };
  } else {
    const started = Date.now();
    let model: string | undefined;
    try {
      const emb = build({ ...resolved, fallbacks: [] }).embeddings;
      model = emb.model;
      const [vector] = await emb.generateEmbeddings(['connection test'], 'query');
      embeddings = { ok: Boolean(vector?.length), model, dimensions: vector?.length, latencyMs: Date.now() - started };
    } catch (error) {
      embeddings = { ok: false, model, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const primary = chain[0]!;
  return { text: { ok: primary.ok, model: primary.model, latencyMs: primary.latencyMs, error: primary.error }, chain, embeddings };
}

/**
 * Image generation uses Meta's Muse Image with the organization's Meta Model API
 * key (main or backup provider in Settings → AI models, or the server's key when
 * the server default is Meta). Outside production, without a key, an offline
 * placeholder image is produced so the flow can be tried.
 */
export async function imageProviderFor(organizationId: string): Promise<ImageProvider> {
  const { db, env } = getInfra();
  const row = await db.organizationAiSettings.findUnique({ where: { organizationId } });
  const key = keyForProvider(organizationId, row, 'meta');
  if (key) return new MetaImageProvider({ apiKey: key });
  if (!isProduction(env)) return new MockImageProvider();
  throw badRequest('Image generation uses Meta Muse Image. Add a Meta Model API key in Settings → AI models (as the main or a backup provider).');
}

/**
 * Voice notes: Meta Muse Voice Transcribe first, Gemini as the backup, and the
 * offline stand-in outside production. Uses whichever keys are saved.
 */
export async function transcriptionProviderFor(organizationId: string): Promise<TranscriptionProvider> {
  const { db, env, logger } = getInfra();
  const row = await db.organizationAiSettings.findUnique({ where: { organizationId } });
  const chain: TranscriptionProvider[] = [];
  const meta = keyForProvider(organizationId, row, 'meta');
  if (meta) chain.push(new MetaTranscriber({ apiKey: meta }));
  const google = keyForProvider(organizationId, row, 'google');
  if (google) chain.push(new GeminiTranscriber({ apiKey: google }));
  if (!isProduction(env)) chain.push(new MockTranscriber());
  if (!chain.length) throw badRequest('Voice notes are transcribed with Meta Muse Voice Transcribe (or Google Gemini). Add one of these keys in Settings → AI models.');
  return new FailoverTranscriber(chain, (from, reason) => logger.warn({ organizationId, from, reason }, 'Transcription provider failed, trying the next one'));
}

/** Product cutouts use Meta SAM 3.1; the offline stand-in outside production. */
export async function segmentationProviderFor(organizationId: string): Promise<SegmentationProvider> {
  const { db, env } = getInfra();
  const row = await db.organizationAiSettings.findUnique({ where: { organizationId } });
  const key = keyForProvider(organizationId, row, 'meta');
  if (key) return new MetaSegmenter({ apiKey: key });
  if (!isProduction(env)) return new MockSegmenter();
  throw badRequest('Product cutouts use Meta SAM 3.1. Add a Meta Model API key in Settings → AI models (as the main or a backup provider).');
}
