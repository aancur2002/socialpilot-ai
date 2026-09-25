import { createPkcePair, generateToken } from '@socialpilot/auth';
import type { Platform, Prisma, SocialAccount as SocialAccountRow } from '@socialpilot/database';
import { isSocialApiError, SocialApiError, type ConnectedAccount, type PlatformKey, type SocialAccount, type SocialPlatformAdapter } from '@socialpilot/social';
import { assertClientAccess, requirePermission, tenantWhere, type AuthContext, type ServiceContext } from '../context';
import { AppError, badRequest, notFound } from '../errors';
import { getInfra } from '../infra';
import { audit } from './audit.service';
import { getClient } from './client.service';
import { notifyClientMembers } from './notification.service';
import { assertWithinLimit } from './organization.service';
import { TokenService } from './token.service';

/** Public shape of a social account — never includes credentials. */
const publicSelect = {
  id: true,
  organizationId: true,
  clientId: true,
  platform: true,
  isMock: true,
  platformAccountId: true,
  displayName: true,
  username: true,
  avatarUrl: true,
  status: true,
  capabilities: true,
  scopes: true,
  lastSyncedAt: true,
  lastError: true,
  createdAt: true,
  profile: { select: { followers: true, following: true, postsCount: true, profileUrl: true, fetchedAt: true } },
  token: { select: { expiresAt: true, revokedAt: true } },
} satisfies Prisma.SocialAccountSelect;

export function platformStatuses() {
  const { social } = getInfra();
  return { mockEnabled: social.mockEnabled, platforms: social.statuses() };
}

export function oauthRedirectUri(platform: PlatformKey): string {
  return `${getInfra().env.API_URL}/api/v1/social/oauth/callback/${platform.toLowerCase()}`;
}

export async function startOAuth(ctx: AuthContext, input: { clientId: string; platform: PlatformKey; redirectPath?: string; mock?: boolean }) {
  requirePermission(ctx, 'social_accounts:connect');
  await getClient(ctx, input.clientId);
  const { db, social } = getInfra();
  const adapter = input.mock ? social.mock(input.platform) : social.realAdapter(input.platform);
  if (!adapter.isConfigured()) {
    throw new AppError('NOT_CONFIGURED', `${input.platform} is not configured on this server. See docs/integrations/${input.platform.toLowerCase()}.md`);
  }
  const state = generateToken(24);
  const pkce = createPkcePair();
  await db.oAuthState.create({
    data: {
      id: state,
      organizationId: ctx.organizationId,
      clientId: input.clientId,
      userId: ctx.userId,
      platform: input.platform,
      isMock: Boolean(input.mock),
      codeVerifier: pkce.verifier,
      redirectPath: input.redirectPath,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    },
  });
  const url = await adapter.getAuthorizationUrl({ state, redirectUri: oauthRedirectUri(input.platform), codeChallenge: pkce.challenge });
  return { authorizationUrl: url };
}

/**
 * Handles the OAuth redirect. Returns the web URL to send the browser to.
 * The state is single-use and bound to the organization, client and user that started the flow.
 */
export async function completeOAuth(platform: PlatformKey, query: { state?: string; code?: string; error?: string; error_description?: string }): Promise<string> {
  const { db, env, social, logger } = getInfra();
  const fail = (path: string, message: string) => `${env.APP_URL}${path}${path.includes('?') ? '&' : '?'}oauth_error=${encodeURIComponent(message)}`;
  if (!query.state) return fail('/social-accounts', 'Missing OAuth state');

  // Atomically consume the state so a replayed callback cannot be used twice.
  const consumed = await db.oAuthState.updateMany({ where: { id: query.state, usedAt: null, expiresAt: { gt: new Date() }, platform: platform as Platform }, data: { usedAt: new Date() } });
  const state = await db.oAuthState.findUnique({ where: { id: query.state } });
  if (!consumed.count || !state) return fail('/social-accounts', 'This connection link has expired. Please try again.');
  const back = state.redirectPath ?? `/clients/${state.clientId}/social-accounts`;
  if (query.error || !query.code) return fail(back, query.error_description ?? query.error ?? 'Authorization was cancelled');

  const { resolveAuthContext } = await import('./organization.service');
  const user = await db.user.findUniqueOrThrow({ where: { id: state.userId } });
  const ctx = await resolveAuthContext(user, state.organizationId);

  try {
    requirePermission(ctx, 'social_accounts:connect');
    assertClientAccess(ctx, state.clientId);
    const adapter = state.isMock ? social.mock(platform) : social.realAdapter(platform);
    const accounts = await adapter.handleOAuthCallback({ code: query.code, redirectUri: oauthRedirectUri(platform), codeVerifier: state.codeVerifier ?? undefined });
    const saved = await saveConnectedAccounts(ctx, state.clientId, platform, adapter, accounts);
    return `${env.APP_URL}${back}${back.includes('?') ? '&' : '?'}connected=${saved.length}`;
  } catch (error) {
    logger.warn({ platform, organizationId: state.organizationId, clientId: state.clientId, error: error instanceof Error ? error.message : String(error) }, 'OAuth callback failed');
    const message = error instanceof AppError || isSocialApiError(error) ? error.message : 'Could not complete the connection';
    return fail(back, message);
  }
}

export async function saveConnectedAccounts(ctx: AuthContext, clientId: string, platform: PlatformKey, adapter: SocialPlatformAdapter, accounts: ConnectedAccount[]) {
  const { db } = getInfra();
  const existingCount = await db.socialAccount.count({ where: { organizationId: ctx.organizationId, status: { not: 'DISCONNECTED' } } });
  const newOnes = [];
  for (const a of accounts) {
    const exists = await db.socialAccount.findUnique({ where: { clientId_platform_platformAccountId: { clientId, platform, platformAccountId: a.platformAccountId } } });
    if (!exists || exists.status === 'DISCONNECTED') newOnes.push(a);
  }
  await assertWithinLimit(ctx.organizationId, 'socialAccounts', existingCount, newOnes.length);

  const saved: SocialAccountRow[] = [];
  for (const a of accounts) {
    const account = await db.$transaction(async (tx) => {
      const data = {
        platformUserId: a.platformUserId ?? null,
        displayName: a.displayName,
        username: a.username ?? null,
        avatarUrl: a.avatarUrl ?? null,
        status: 'ACTIVE' as const,
        isMock: adapter.isMock,
        capabilities: adapter.getCapabilities() as unknown as Prisma.InputJsonValue,
        scopes: a.scopes,
        metadata: (a.metadata ?? {}) as Prisma.InputJsonValue,
        lastError: null,
        connectedById: ctx.userId,
      };
      const row = await tx.socialAccount.upsert({
        where: { clientId_platform_platformAccountId: { clientId, platform, platformAccountId: a.platformAccountId } },
        create: { organizationId: ctx.organizationId, clientId, platform, platformAccountId: a.platformAccountId, ...data },
        update: data,
      });
      await TokenService.store(tx, row.id, a.tokens);
      await audit(ctx, { action: 'social_account.connected', resourceType: 'SocialAccount', resourceId: row.id, clientId, after: { platform, displayName: a.displayName, isMock: adapter.isMock, scopes: a.scopes } }, tx);
      return row;
    });
    saved.push(account);
    // Best effort: profile stats are informational.
    refreshProfileInternal(account.id).catch(() => undefined);
  }
  return saved;
}

/** Development-only: connect a Mock* account directly without the consent redirect. */
export async function connectMockAccount(ctx: AuthContext, input: { clientId: string; platform: PlatformKey; displayName?: string }) {
  requirePermission(ctx, 'social_accounts:connect');
  await getClient(ctx, input.clientId);
  const adapter = getInfra().social.mock(input.platform);
  const accounts = await adapter.handleOAuthCallback({ code: `mock_code_${input.platform}_${generateToken(6)}`, redirectUri: oauthRedirectUri(input.platform) });
  if (input.displayName) {
    accounts[0]!.displayName = input.displayName;
    accounts[0]!.metadata = { ...accounts[0]!.metadata, displayName: input.displayName };
  }
  const [account] = await saveConnectedAccounts(ctx, input.clientId, input.platform, adapter, accounts);
  return getSocialAccount(ctx, account!.id);
}

export async function listSocialAccounts(ctx: ServiceContext, clientId?: string) {
  requirePermission(ctx, 'social_accounts:view');
  return getInfra().db.socialAccount.findMany({
    where: { ...tenantWhere(ctx, clientId), status: { not: 'DISCONNECTED' } },
    select: publicSelect,
    orderBy: [{ platform: 'asc' }, { displayName: 'asc' }],
  });
}

export async function getSocialAccount(ctx: ServiceContext, id: string) {
  requirePermission(ctx, 'social_accounts:view');
  const account = await getInfra().db.socialAccount.findFirst({ where: { id, ...tenantWhere(ctx) }, select: publicSelect });
  if (!account) throw notFound('Social account');
  return account;
}

export async function disconnectSocialAccount(ctx: AuthContext, id: string) {
  requirePermission(ctx, 'social_accounts:disconnect');
  const { db, logger } = getInfra();
  const account = await db.socialAccount.findFirst({ where: { id, ...tenantWhere(ctx) } });
  if (!account) throw notFound('Social account');
  try {
    const loaded = await loadAdapterAccount(account.organizationId, account.id, { skipRefresh: true });
    await TokenService.revoke(account.id, loaded.adapter, loaded.account);
  } catch (error) {
    logger.warn({ socialAccountId: id, error: error instanceof Error ? error.message : String(error) }, 'could not load adapter while disconnecting; deleting credentials');
    await TokenService.revoke(account.id);
  }
  await db.socialAccount.update({ where: { id }, data: { status: 'DISCONNECTED' } });
  // Pending scheduled posts for this account can no longer publish.
  await db.scheduledPost.updateMany({ where: { socialAccountId: id, status: { in: ['SCHEDULED', 'QUEUED'] } }, data: { status: 'CANCELLED', lastError: 'Social account disconnected' } });
  await audit(ctx, { action: 'social_account.disconnected', resourceType: 'SocialAccount', resourceId: id, clientId: account.clientId, before: { platform: account.platform, displayName: account.displayName } });
}

export interface LoadedAccount {
  record: SocialAccountRow;
  adapter: SocialPlatformAdapter;
  account: SocialAccount;
}

/**
 * Loads an account with decrypted, fresh credentials for adapter calls.
 * Internal use only (workers/services) — the result must never be returned to a client.
 */
export async function loadAdapterAccount(organizationId: string, socialAccountId: string, opts: { skipRefresh?: boolean } = {}): Promise<LoadedAccount> {
  const { db, social } = getInfra();
  const record = await db.socialAccount.findFirst({ where: { id: socialAccountId, organizationId } });
  if (!record) throw notFound('Social account');
  if (record.status === 'DISCONNECTED') throw badRequest('This social account is disconnected');
  const adapter = social.forAccount({ platform: record.platform, isMock: record.isMock });
  let credentials;
  if (opts.skipRefresh) {
    const token = await db.socialToken.findUnique({ where: { socialAccountId } });
    if (!token || token.revokedAt) throw new SocialApiError({ platform: record.platform, code: 'UNAUTHORIZED', message: 'No active credentials', requiresReauth: true });
    credentials = TokenService.decode(token);
  } else {
    credentials = await TokenService.ensureFresh(record, adapter);
  }
  return {
    record,
    adapter,
    account: {
      id: record.id,
      platform: record.platform,
      platformAccountId: record.platformAccountId,
      platformUserId: record.platformUserId,
      metadata: (record.metadata ?? {}) as Record<string, unknown>,
      credentials,
    },
  };
}

async function refreshProfileInternal(socialAccountId: string) {
  const { db } = getInfra();
  const row = await db.socialAccount.findUniqueOrThrow({ where: { id: socialAccountId } });
  const { adapter, account } = await loadAdapterAccount(row.organizationId, socialAccountId);
  const profile = await adapter.getProfile(account);
  await db.socialProfile.upsert({
    where: { socialAccountId },
    create: { socialAccountId, followers: profile.followers, following: profile.following, postsCount: profile.postsCount, bio: profile.bio, profileUrl: profile.profileUrl },
    update: { followers: profile.followers, following: profile.following, postsCount: profile.postsCount, bio: profile.bio, profileUrl: profile.profileUrl, fetchedAt: new Date() },
  });
  await db.socialAccount.update({ where: { id: socialAccountId }, data: { displayName: profile.displayName, avatarUrl: profile.avatarUrl ?? row.avatarUrl, lastSyncedAt: new Date() } });
}

export async function refreshSocialProfile(ctx: ServiceContext, id: string) {
  await getSocialAccount(ctx, id);
  await refreshProfileInternal(id);
  return getSocialAccount(ctx, id);
}

/** Marks an account as needing reconnection and notifies the client's team. */
export async function flagReauthRequired(socialAccountId: string, reason: string) {
  const { db } = getInfra();
  const account = await db.socialAccount.update({ where: { id: socialAccountId }, data: { status: 'REAUTH_REQUIRED', lastError: reason } });
  await notifyClientMembers(account.organizationId, account.clientId, 'social_accounts:connect', {
    type: 'TOKEN_EXPIRED',
    title: `${account.platform} account needs to be reconnected`,
    body: `${account.displayName}: ${reason}`,
    link: `/clients/${account.clientId}/social-accounts`,
  });
}
