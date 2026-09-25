import { SocialApiError } from '../errors';
import { HttpClient, type PlatformErrorInfo } from '../http';
import { composeCaption } from '../validation';
import type {
  AnalyticsResult,
  CommentOptions,
  CommentReplyInput,
  ConnectedAccount,
  DateRange,
  MessageResult,
  NormalizedComment,
  OAuthCallbackInput,
  OAuthInput,
  PublishResult,
  SocialAccount,
  SocialPost,
  SocialProfile,
  TokenResult,
} from '../types';
import { BaseAdapter, expiresInToDate, type OAuthAppCredentials } from './base';

export interface LinkedInConfig extends OAuthAppCredentials {
  apiVersion: string;
  /** Request Community Management scopes (organization pages). Requires LinkedIn approval. */
  organizationScopes?: boolean;
}

function parseLinkedInError(status: number, body: unknown): PlatformErrorInfo {
  const b = body as { message?: string; serviceErrorCode?: number; code?: string } | null;
  const message = b?.message ? `LinkedIn API error: ${b.message}` : undefined;
  if (status === 401) return { code: 'UNAUTHORIZED', message, requiresReauth: true };
  if (status === 403) return { code: 'INVALID_PERMISSIONS', message, platformCode: b?.serviceErrorCode ? String(b.serviceErrorCode) : undefined };
  if (status === 429) return { code: 'RATE_LIMITED', message, retryable: true };
  return { message, platformCode: b?.serviceErrorCode ? String(b.serviceErrorCode) : b?.code };
}

/**
 * LinkedIn — Posts API (member via w_member_social; organizations via
 * Community Management API, which requires application review).
 * Docs: https://learn.microsoft.com/linkedin/marketing/community-management/shares/posts-api
 */
export class LinkedInAdapter extends BaseAdapter {
  readonly platform = 'LINKEDIN' as const;
  private readonly http = new HttpClient('LINKEDIN', parseLinkedInError);

  constructor(private readonly config: LinkedInConfig) {
    super(config);
  }

  private headers(token: string): Record<string, string> {
    return { authorization: `Bearer ${token}`, 'LinkedIn-Version': this.config.apiVersion, 'X-Restli-Protocol-Version': '2.0.0' };
  }

  getScopes(): string[] {
    const member = ['openid', 'profile', 'email', 'w_member_social'];
    return this.config.organizationScopes ? [...member, 'r_organization_social', 'w_organization_social', 'rw_organization_admin'] : member;
  }

  async checkAppCredentials(): Promise<{ ok: boolean | null; message: string }> {
    this.requireConfigured();
    return { ok: null, message: 'LinkedIn can’t verify app credentials without a user sign-in. Connect a test account to confirm they work.' };
  }

  async getAuthorizationUrl(input: OAuthInput): Promise<string> {
    const { clientId } = this.requireConfigured();
    const url = new URL('https://www.linkedin.com/oauth/v2/authorization');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('state', input.state);
    url.searchParams.set('scope', this.getScopes().join(' '));
    return url.toString();
  }

  private toTokens(res: { access_token: string; expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number; scope?: string }): TokenResult {
    return {
      accessToken: res.access_token,
      refreshToken: res.refresh_token,
      expiresAt: expiresInToDate(res.expires_in),
      refreshExpiresAt: expiresInToDate(res.refresh_token_expires_in),
      scopes: res.scope?.split(/[ ,]/).filter(Boolean),
    };
  }

  async handleOAuthCallback(input: OAuthCallbackInput): Promise<ConnectedAccount[]> {
    const { clientId, clientSecret } = this.requireConfigured();
    const res = await this.http.post<{ access_token: string; expires_in: number; refresh_token?: string; refresh_token_expires_in?: number; scope?: string }>(
      'https://www.linkedin.com/oauth/v2/accessToken',
      { form: { grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri, client_id: clientId, client_secret: clientSecret } },
    );
    const tokens = this.toTokens(res);
    const me = await this.http.get<{ sub: string; name?: string; picture?: string; email?: string }>('https://api.linkedin.com/v2/userinfo', {
      headers: { authorization: `Bearer ${res.access_token}` },
    });
    const scopes = tokens.scopes ?? this.getScopes();
    const accounts: ConnectedAccount[] = [
      {
        platformAccountId: `urn:li:person:${me.sub}`,
        platformUserId: me.sub,
        displayName: me.name ?? 'LinkedIn member',
        avatarUrl: me.picture,
        scopes,
        tokens,
        metadata: { authorType: 'person' },
      },
    ];
    if (scopes.includes('rw_organization_admin')) {
      const acls = await this.http.get<{ elements: { organization: string; role: string; state: string }[] }>(
        'https://api.linkedin.com/rest/organizationAcls',
        { query: { q: 'roleAssignee', role: 'ADMINISTRATOR', state: 'APPROVED' }, headers: this.headers(res.access_token) },
      );
      for (const acl of acls.elements) {
        const orgId = acl.organization.split(':').pop()!;
        const org = await this.http.get<{ localizedName?: string; vanityName?: string }>(`https://api.linkedin.com/rest/organizations/${orgId}`, {
          headers: this.headers(res.access_token),
        });
        accounts.push({
          platformAccountId: acl.organization,
          platformUserId: me.sub,
          displayName: org.localizedName ?? `Organization ${orgId}`,
          username: org.vanityName,
          scopes,
          tokens,
          metadata: { authorType: 'organization' },
        });
      }
    }
    return accounts;
  }

  /** Refresh tokens are only issued to apps LinkedIn has enabled for programmatic refresh. */
  override async refreshAccessToken(account: SocialAccount): Promise<TokenResult> {
    const { clientId, clientSecret } = this.requireConfigured();
    if (!account.credentials.refreshToken) {
      throw new SocialApiError({ platform: 'LINKEDIN', code: 'TOKEN_EXPIRED', message: 'No LinkedIn refresh token; the user must reconnect', requiresReauth: true });
    }
    const res = await this.http.post<{ access_token: string; expires_in: number; refresh_token?: string; refresh_token_expires_in?: number; scope?: string }>(
      'https://www.linkedin.com/oauth/v2/accessToken',
      { form: { grant_type: 'refresh_token', refresh_token: account.credentials.refreshToken, client_id: clientId, client_secret: clientSecret } },
    );
    return this.toTokens(res);
  }

  async getProfile(account: SocialAccount): Promise<SocialProfile> {
    if (account.platformAccountId.startsWith('urn:li:organization:')) {
      const id = account.platformAccountId.split(':').pop()!;
      const org = await this.http.get<{ localizedName?: string; vanityName?: string }>(`https://api.linkedin.com/rest/organizations/${id}`, {
        headers: this.headers(account.credentials.accessToken),
      });
      return { displayName: org.localizedName ?? id, username: org.vanityName, profileUrl: org.vanityName ? `https://www.linkedin.com/company/${org.vanityName}` : undefined };
    }
    const me = await this.http.get<{ name?: string; picture?: string }>('https://api.linkedin.com/v2/userinfo', {
      headers: { authorization: `Bearer ${account.credentials.accessToken}` },
    });
    return { displayName: me.name ?? 'LinkedIn member', avatarUrl: me.picture };
  }

  private async uploadImage(account: SocialAccount, url: string): Promise<string> {
    const init = await this.http.post<{ value: { uploadUrl: string; image: string } }>('https://api.linkedin.com/rest/images?action=initializeUpload', {
      headers: this.headers(account.credentials.accessToken),
      json: { initializeUploadRequest: { owner: account.platformAccountId } },
    });
    const source = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!source.ok) throw new SocialApiError({ platform: 'LINKEDIN', code: 'VALIDATION', message: `Could not download media for upload (HTTP ${source.status})` });
    const bytes = new Uint8Array(await source.arrayBuffer());
    const put = await fetch(init.value.uploadUrl, {
      method: 'PUT',
      headers: { authorization: `Bearer ${account.credentials.accessToken}` },
      body: bytes,
      signal: AbortSignal.timeout(120_000),
    });
    if (!put.ok) throw new SocialApiError({ platform: 'LINKEDIN', code: put.status >= 500 ? 'SERVER_ERROR' : 'VALIDATION', status: put.status, message: `LinkedIn image upload failed (HTTP ${put.status})` });
    return init.value.image;
  }

  override async publishPost(account: SocialAccount, post: SocialPost): Promise<PublishResult> {
    const body: Record<string, unknown> = {
      author: account.platformAccountId,
      commentary: composeCaption(post.text, post.hashtags),
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    };
    const image = post.media.find((m) => m.kind === 'IMAGE');
    if (post.media.some((m) => m.kind === 'VIDEO')) throw new SocialApiError({ platform: 'LINKEDIN', code: 'UNSUPPORTED', message: 'LinkedIn video upload is not implemented yet' });
    if (image) body.content = { media: { id: await this.uploadImage(account, image.url), ...(post.title ? { title: post.title } : {}) } };
    else if (post.link) body.content = { article: { source: post.link, title: post.title ?? post.link } };

    const res = await this.http.request('https://api.linkedin.com/rest/posts', { method: 'POST', headers: this.headers(account.credentials.accessToken), json: body });
    const id = res.headers.get('x-restli-id') ?? res.headers.get('x-linkedin-id');
    if (!id) throw new SocialApiError({ platform: 'LINKEDIN', code: 'UNKNOWN', message: 'LinkedIn did not return a post id' });
    return { platformPostId: id, url: `https://www.linkedin.com/feed/update/${id}`, publishedAt: new Date() };
  }

  override async getComments(account: SocialAccount, options: CommentOptions = {}): Promise<NormalizedComment[]> {
    if (!options.platformPostId) throw new SocialApiError({ platform: 'LINKEDIN', code: 'VALIDATION', message: 'platformPostId is required' });
    const res = await this.http.get<{ elements: { id?: string; $URN?: string; actor: string; message: { text: string }; created: { time: number }; parentComment?: string }[] }>(
      `https://api.linkedin.com/rest/socialActions/${encodeURIComponent(options.platformPostId)}/comments`,
      { headers: this.headers(account.credentials.accessToken), query: { count: options.limit ?? 50 } },
    );
    return res.elements.map((c) => ({
      platformCommentId: c.$URN ?? c.id ?? '',
      platformPostId: options.platformPostId!,
      parentPlatformCommentId: c.parentComment,
      authorPlatformId: c.actor,
      text: c.message.text,
      createdAt: new Date(c.created.time),
    }));
  }

  override async replyToComment(account: SocialAccount, input: CommentReplyInput): Promise<MessageResult> {
    // Comment URN format: urn:li:comment:(urn:li:activity:123,456)
    const match = /^urn:li:comment:\((.+),(\d+)\)$/.exec(input.platformCommentId);
    if (!match) throw new SocialApiError({ platform: 'LINKEDIN', code: 'VALIDATION', message: 'Unrecognized LinkedIn comment URN' });
    const res = await this.http.request(`https://api.linkedin.com/rest/socialActions/${encodeURIComponent(input.platformCommentId)}/comments`, {
      method: 'POST',
      headers: this.headers(account.credentials.accessToken),
      json: { actor: account.platformAccountId, object: match[1], message: { text: input.text }, parentComment: input.platformCommentId },
    });
    return { platformMessageId: res.headers.get('x-restli-id') ?? `${input.platformCommentId}:reply`, sentAt: new Date() };
  }

  override async getAnalytics(account: SocialAccount, range: DateRange): Promise<AnalyticsResult> {
    const result: AnalyticsResult = { account: {}, posts: [], unsupportedMetrics: [] };
    if (!account.platformAccountId.startsWith('urn:li:organization:')) {
      result.unsupportedMetrics.push('impressions', 'clicks', 'likes', 'comments', 'shares', 'engagement');
      return result; // member post analytics are not available to general apps
    }
    const res = await this.http.get<{ elements: { totalShareStatistics: Record<string, number> }[] }>(
      'https://api.linkedin.com/rest/organizationalEntityShareStatistics',
      {
        headers: this.headers(account.credentials.accessToken),
        query: {
          q: 'organizationalEntity',
          organizationalEntity: account.platformAccountId,
          timeIntervals: `(timeRange:(start:${range.from.getTime()},end:${range.to.getTime()}),timeGranularityType:DAY)`,
        },
      },
    );
    const totals: Record<string, number> = {};
    for (const el of res.elements) for (const [k, v] of Object.entries(el.totalShareStatistics)) totals[k] = (totals[k] ?? 0) + v;
    const map: Record<string, string> = { impressionCount: 'impressions', uniqueImpressionsCount: 'reach', clickCount: 'clicks', likeCount: 'likes', commentCount: 'comments', shareCount: 'shares', engagement: 'engagement' };
    for (const [src, dst] of Object.entries(map)) {
      if (typeof totals[src] === 'number') result.account[dst] = totals[src];
      else result.unsupportedMetrics.push(dst);
    }
    return result;
  }
}
