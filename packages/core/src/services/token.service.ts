import { ciphertextKeyVersion, decryptSecret, encryptSecret } from '@socialpilot/auth';
import type { Db, SocialToken } from '@socialpilot/database';
import { isSocialApiError, type SocialPlatformAdapter, type TokenResult } from '@socialpilot/social';
import { getInfra } from '../infra';

/**
 * TokenService — the only code that sees plaintext OAuth tokens.
 * Tokens are AES-256-GCM encrypted with the social account id as associated
 * data, so a ciphertext copied onto another account row will not decrypt.
 */
/** Refresh proactively when a token expires within this window. */
const REFRESH_SKEW_MS = 10 * 60 * 1000;

export const TokenService = {
  REFRESH_SKEW_MS,

  encrypt(socialAccountId: string, value: string): string {
    return encryptSecret(getInfra().keyRing, value, socialAccountId);
  },

  decrypt(socialAccountId: string, ciphertext: string): string {
    return decryptSecret(getInfra().keyRing, ciphertext, socialAccountId);
  },

  async store(db: Db, socialAccountId: string, tokens: TokenResult): Promise<void> {
    const { keyRing } = getInfra();
    const data = {
      accessTokenEnc: this.encrypt(socialAccountId, tokens.accessToken),
      refreshTokenEnc: tokens.refreshToken ? this.encrypt(socialAccountId, tokens.refreshToken) : null,
      tokenType: tokens.tokenType ?? 'bearer',
      expiresAt: tokens.expiresAt ?? null,
      refreshExpiresAt: tokens.refreshExpiresAt ?? null,
      scopes: tokens.scopes ?? [],
      keyVersion: keyRing.currentVersion,
      revokedAt: null,
    };
    await db.socialToken.upsert({
      where: { socialAccountId },
      create: { socialAccountId, ...data },
      update: { ...data, rotatedAt: new Date() },
    });
  },

  decode(token: SocialToken): TokenResult {
    return {
      accessToken: this.decrypt(token.socialAccountId, token.accessTokenEnc),
      refreshToken: token.refreshTokenEnc ? this.decrypt(token.socialAccountId, token.refreshTokenEnc) : undefined,
      expiresAt: token.expiresAt ?? undefined,
      refreshExpiresAt: token.refreshExpiresAt ?? undefined,
      scopes: token.scopes,
      tokenType: token.tokenType,
    };
  },

  isExpiring(token: Pick<SocialToken, 'expiresAt'>, skewMs = REFRESH_SKEW_MS): boolean {
    return Boolean(token.expiresAt && token.expiresAt.getTime() - Date.now() < skewMs);
  },

  isExpired(token: Pick<SocialToken, 'expiresAt'>): boolean {
    return Boolean(token.expiresAt && token.expiresAt.getTime() <= Date.now());
  },

  /**
   * Returns fresh credentials, refreshing when close to expiry. When refresh is
   * impossible the account is flagged for re-authentication.
   */
  async ensureFresh(
    account: { id: string; platform: string; platformAccountId: string; platformUserId: string | null; metadata: unknown },
    adapter: SocialPlatformAdapter,
  ): Promise<TokenResult> {
    const { db } = getInfra();
    const token = await db.socialToken.findUnique({ where: { socialAccountId: account.id } });
    if (!token || token.revokedAt) throw new Error('Social account has no active credentials');
    const current = this.decode(token);
    if (!this.isExpiring(token)) return current;
    if (!adapter.getCapabilities().tokenRefresh) {
      if (this.isExpired(token)) {
        await db.socialAccount.update({ where: { id: account.id }, data: { status: 'TOKEN_EXPIRED', lastError: 'Access token expired; reconnect the account' } });
        throw new Error('Access token expired and this platform does not support refresh');
      }
      return current;
    }
    try {
      const refreshed = await adapter.refreshAccessToken({
        id: account.id,
        platform: account.platform as never,
        platformAccountId: account.platformAccountId,
        platformUserId: account.platformUserId,
        metadata: (account.metadata ?? {}) as Record<string, unknown>,
        credentials: current,
      });
      const merged: TokenResult = { ...refreshed, refreshToken: refreshed.refreshToken ?? current.refreshToken, scopes: refreshed.scopes ?? current.scopes };
      await this.store(db, account.id, merged);
      await db.socialAccount.update({ where: { id: account.id }, data: { status: 'ACTIVE', lastError: null } });
      return merged;
    } catch (error) {
      if (isSocialApiError(error) && error.requiresReauth) {
        await db.socialAccount.update({ where: { id: account.id }, data: { status: 'REAUTH_REQUIRED', lastError: error.message } });
      }
      throw error;
    }
  },

  async revoke(socialAccountId: string, adapter?: SocialPlatformAdapter, account?: Parameters<NonNullable<SocialPlatformAdapter['revokeToken']>>[0]): Promise<void> {
    const { db, logger } = getInfra();
    if (adapter?.revokeToken && account) {
      try {
        await adapter.revokeToken(account);
      } catch (error) {
        logger.warn({ socialAccountId, error: error instanceof Error ? error.message : String(error) }, 'platform token revocation failed; deleting local credentials anyway');
      }
    }
    // Destroy the ciphertext rather than only flagging it.
    await db.socialToken.updateMany({ where: { socialAccountId }, data: { accessTokenEnc: '', refreshTokenEnc: null, revokedAt: new Date() } });
  },

  /** Re-encrypts every token still using an old key version. Run after rotating ENCRYPTION_KEY. */
  async rotateKeys(batchSize = 200): Promise<{ rotated: number }> {
    const { db, keyRing } = getInfra();
    let rotated = 0;
    for (;;) {
      const tokens = await db.socialToken.findMany({ where: { keyVersion: { not: keyRing.currentVersion }, revokedAt: null }, take: batchSize });
      if (!tokens.length) break;
      for (const t of tokens) {
        await this.store(db, t.socialAccountId, this.decode(t));
        rotated++;
      }
    }
    return { rotated };
  },

  keyVersionOf: ciphertextKeyVersion,
};
