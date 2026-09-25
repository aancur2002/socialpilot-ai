import { decryptSecret, encryptSecret } from '@socialpilot/auth';
import type { Platform, Prisma } from '@socialpilot/database';
import { IMPLEMENTED_PLATFORMS, isSocialApiError, type PlatformCredentialOverride, type PlatformKey, type SocialAdapterRegistry } from '@socialpilot/social';
import type { AuthContext } from '../context';
import { badRequest, forbidden, notFound } from '../errors';
import { getInfra } from '../infra';
import { audit, auditGlobal } from './audit.service';
import { TokenService } from './token.service';

/**
 * Platform app credentials (Meta app, LinkedIn app, TikTok app) belong to whoever
 * operates this deployment, so they are managed by platform super admins. Values
 * saved here override the matching environment variables.
 */

const aad = (platform: string, field: string) => `platform-credential:${platform}:${field}`;
const enc = (platform: string, field: string, v: string) => encryptSecret(getInfra().keyRing, v, aad(platform, field));
const dec = (platform: string, field: string, v: string | null) => (v ? decryptSecret(getInfra().keyRing, v, aad(platform, field)) : undefined);

let loadedAt = 0;
let loading: Promise<void> | null = null;
const TTL_MS = 30_000;

async function loadOverrides(): Promise<void> {
  const { db, social, logger } = getInfra();
  const rows = await db.platformCredential.findMany();
  const overrides: Partial<Record<PlatformKey, PlatformCredentialOverride>> = {};
  for (const r of rows) {
    try {
      overrides[r.platform] = {
        clientId: r.clientId ?? undefined,
        clientSecret: dec(r.platform, 'clientSecret', r.clientSecretEnc),
        webhookVerifyToken: dec(r.platform, 'webhookVerifyToken', r.webhookVerifyTokenEnc),
        configId: r.configId ?? undefined,
        organizationScopes: (r.options as { organizationScopes?: boolean }).organizationScopes,
      };
    } catch (error) {
      logger.error({ platform: r.platform, error: error instanceof Error ? error.message : String(error) }, 'could not decrypt platform credentials (was ENCRYPTION_KEY changed?)');
    }
  }
  social.configure(overrides);
  loadedAt = Date.now();
}

/** The adapter registry with dashboard-managed credentials applied (refreshed every 30s). */
export async function getSocial(): Promise<SocialAdapterRegistry> {
  if (Date.now() - loadedAt > TTL_MS) {
    loading ??= loadOverrides().finally(() => {
      loading = null;
    });
    await loading;
  }
  return getInfra().social;
}

function assertSuperAdmin(user: { isSuperAdmin: boolean }) {
  if (!user.isSuperAdmin) throw forbidden('Only platform admins can manage platform app credentials');
}

const FIELDS: Record<string, { clientIdLabel: string; secretLabel: string; verifyToken: boolean; configId: boolean; organizationScopes: boolean; envPrefix: string }> = {
  FACEBOOK: { clientIdLabel: 'App ID', secretLabel: 'App secret', verifyToken: true, configId: false, organizationScopes: false, envPrefix: 'FACEBOOK' },
  INSTAGRAM: { clientIdLabel: 'Instagram app ID', secretLabel: 'Instagram app secret', verifyToken: true, configId: false, organizationScopes: false, envPrefix: 'INSTAGRAM' },
  WHATSAPP: { clientIdLabel: 'App ID', secretLabel: 'App secret', verifyToken: true, configId: true, organizationScopes: false, envPrefix: 'WHATSAPP' },
  LINKEDIN: { clientIdLabel: 'Client ID', secretLabel: 'Client secret', verifyToken: false, configId: false, organizationScopes: true, envPrefix: 'LINKEDIN' },
  TIKTOK: { clientIdLabel: 'Client key', secretLabel: 'Client secret', verifyToken: false, configId: false, organizationScopes: false, envPrefix: 'TIKTOK' },
};

const hint = (v?: string) => (v ? `…${v.slice(-4)}` : null);

export async function listPlatformSetup(user: { isSuperAdmin: boolean }) {
  assertSuperAdmin(user);
  const { db, env } = getInfra();
  const social = await getSocial();
  const base = social.baseConfig;
  const rows = await db.platformCredential.findMany();
  const { oauthRedirectUri } = await import('./social.service');
  return {
    mockEnabled: social.mockEnabled,
    platforms: IMPLEMENTED_PLATFORMS.map((platform) => {
      const row = rows.find((r) => r.platform === platform);
      const envCfg = base[platform.toLowerCase() as 'facebook'] as { clientId?: string; clientSecret?: string; webhookVerifyToken?: string; configId?: string; organizationScopes?: boolean };
      const secret = dec(platform, 'clientSecret', row?.clientSecretEnc ?? null);
      const verify = dec(platform, 'webhookVerifyToken', row?.webhookVerifyTokenEnc ?? null);
      const src = (db: unknown, e: unknown) => (db ? 'dashboard' : e ? 'env' : 'none');
      const adapter = social.realAdapter(platform);
      const f = FIELDS[platform]!;
      return {
        platform,
        labels: { clientId: f.clientIdLabel, clientSecret: f.secretLabel },
        fields: { verifyToken: f.verifyToken, configId: f.configId, organizationScopes: f.organizationScopes },
        envPrefix: f.envPrefix,
        clientId: { value: row?.clientId ?? envCfg.clientId ?? null, source: src(row?.clientId, envCfg.clientId) },
        clientSecret: { set: Boolean(secret ?? envCfg.clientSecret), hint: hint(secret ?? envCfg.clientSecret), source: src(secret, envCfg.clientSecret) },
        webhookVerifyToken: { set: Boolean(verify ?? envCfg.webhookVerifyToken), source: src(verify, envCfg.webhookVerifyToken) },
        configId: { value: row?.configId ?? envCfg.configId ?? null, source: src(row?.configId, envCfg.configId) },
        organizationScopes: Boolean((row?.options as { organizationScopes?: boolean } | undefined)?.organizationScopes ?? envCfg.organizationScopes),
        configured: adapter.isConfigured(),
        lastCheck: row?.checkedAt ? { at: row.checkedAt, ok: row.checkOk, message: row.checkMessage } : null,
        redirectUri: oauthRedirectUri(platform),
        webhookUrl: f.verifyToken ? `${env.WEBHOOK_BASE_URL}/webhooks/${platform.toLowerCase()}` : null,
        scopes: adapter.getScopes(),
        docsPath: `docs/integrations/${platform.toLowerCase()}.md`,
      };
    }),
  };
}

export interface PlatformSetupInput {
  clientId?: string | null;
  clientSecret?: string | null;
  webhookVerifyToken?: string | null;
  configId?: string | null;
  organizationScopes?: boolean;
}

export async function savePlatformSetup(user: { id: string; isSuperAdmin: boolean }, platform: PlatformKey, input: PlatformSetupInput) {
  assertSuperAdmin(user);
  if (!IMPLEMENTED_PLATFORMS.includes(platform)) throw notFound('Platform');
  const { db } = getInfra();
  const existing = await db.platformCredential.findUnique({ where: { platform: platform as Platform } });
  const data: Prisma.PlatformCredentialUncheckedUpdateInput = { updatedById: user.id, checkedAt: null, checkOk: null, checkMessage: null };
  if (input.clientId !== undefined) data.clientId = input.clientId || null;
  if (input.clientSecret !== undefined) data.clientSecretEnc = input.clientSecret ? enc(platform, 'clientSecret', input.clientSecret) : null;
  if (input.webhookVerifyToken !== undefined) data.webhookVerifyTokenEnc = input.webhookVerifyToken ? enc(platform, 'webhookVerifyToken', input.webhookVerifyToken) : null;
  if (input.configId !== undefined) data.configId = input.configId || null;
  if (input.organizationScopes !== undefined) data.options = { ...((existing?.options as object) ?? {}), organizationScopes: input.organizationScopes };
  await db.platformCredential.upsert({
    where: { platform: platform as Platform },
    create: { ...(data as Prisma.PlatformCredentialUncheckedCreateInput), platform: platform as Platform },
    update: data,
  });
  loadedAt = 0; // re-apply immediately in this process
  await getSocial();
  await auditGlobal({
    action: 'platform.credentials_changed',
    resourceType: 'PlatformCredential',
    resourceId: platform,
    userId: user.id,
    after: { clientIdChanged: input.clientId !== undefined, clientSecretChanged: input.clientSecret !== undefined, verifyTokenChanged: input.webhookVerifyToken !== undefined, configIdChanged: input.configId !== undefined, organizationScopes: input.organizationScopes },
  });
  return listPlatformSetup(user);
}

/** Asks the platform to validate the app credentials where it supports that, and stores the result. */
export async function checkPlatformSetup(user: { isSuperAdmin: boolean }, platform: PlatformKey) {
  assertSuperAdmin(user);
  const { db } = getInfra();
  const adapter = (await getSocial()).realAdapter(platform);
  let result: { ok: boolean | null; message: string };
  if (!adapter.isConfigured()) {
    result = { ok: false, message: 'Required credentials are missing.' };
  } else {
    try {
      result = adapter.checkAppCredentials ? await adapter.checkAppCredentials() : { ok: null, message: 'This platform has no credential check.' };
    } catch (error) {
      result = { ok: false, message: isSocialApiError(error) ? error.message : error instanceof Error ? error.message : String(error) };
    }
  }
  await db.platformCredential.upsert({
    where: { platform: platform as Platform },
    create: { platform: platform as Platform, checkedAt: new Date(), checkOk: result.ok, checkMessage: result.message.slice(0, 500) },
    update: { checkedAt: new Date(), checkOk: result.ok, checkMessage: result.message.slice(0, 500) },
  });
  return result;
}

/**
 * Moves everything pending from a mock account to the real account that replaced it,
 * then disconnects the mock. Conversation history stays on the mock account.
 */
export async function replaceMockAccount(ctx: AuthContext, mockAccountId: string, realAccountId: string) {
  const { db } = getInfra();
  const [mock, real] = await Promise.all([
    db.socialAccount.findFirst({ where: { id: mockAccountId, organizationId: ctx.organizationId } }),
    db.socialAccount.findFirst({ where: { id: realAccountId, organizationId: ctx.organizationId } }),
  ]);
  if (!mock || !real) throw notFound('Social account');
  if (!mock.isMock) throw badRequest('Only mock accounts can be replaced');
  if (real.isMock) throw badRequest('The replacement must be a real connected account');
  if (mock.clientId !== real.clientId || mock.platform !== real.platform) throw badRequest('The replacement must be the same platform and client');

  const moved = await db.$transaction(async (tx) => {
    const variants = await tx.contentVariant.updateMany({ where: { socialAccountId: mock.id }, data: { socialAccountId: real.id } });
    const pending = await tx.scheduledPost.findMany({ where: { socialAccountId: mock.id, status: { in: ['SCHEDULED', 'QUEUED'] } } });
    for (const p of pending) {
      await tx.scheduledPost.update({ where: { id: p.id }, data: { socialAccountId: real.id, idempotencyKey: `${p.variantId}:${real.id}:${p.scheduledAt.toISOString()}` } });
    }
    await tx.socialAccount.update({ where: { id: mock.id }, data: { status: 'DISCONNECTED' } });
    await audit(ctx, { action: 'social_account.mock_replaced', resourceType: 'SocialAccount', resourceId: real.id, clientId: real.clientId, before: { mockAccountId: mock.id }, after: { variantsMoved: variants.count, scheduledPostsMoved: pending.length } }, tx);
    return { variants: variants.count, scheduledPosts: pending.length };
  });
  await TokenService.revoke(mock.id);
  return moved;
}

