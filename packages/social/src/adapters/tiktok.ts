import { SocialApiError } from '../errors';
import { HttpClient, sleep, type PlatformErrorInfo } from '../http';
import { composeCaption } from '../validation';
import type {
  AnalyticsResult,
  ConnectedAccount,
  DateRange,
  OAuthCallbackInput,
  OAuthInput,
  PublishResult,
  SocialAccount,
  SocialPost,
  SocialProfile,
  TokenResult,
} from '../types';
import { BaseAdapter, expiresInToDate, type OAuthAppCredentials } from './base';

export type TikTokConfig = OAuthAppCredentials;

const API = 'https://open.tiktokapis.com/v2';

function parseTikTokError(status: number, body: unknown): PlatformErrorInfo {
  const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
  const message = err?.message ? `TikTok API error ${err.code}: ${err.message}` : undefined;
  switch (err?.code) {
    case 'access_token_invalid':
      return { code: 'UNAUTHORIZED', message, platformCode: err.code, requiresReauth: true };
    case 'scope_not_authorized':
    case 'scope_permission_missed':
      return { code: 'INVALID_PERMISSIONS', message, platformCode: err.code, requiresReauth: true };
    case 'rate_limit_exceeded':
    case 'spam_risk_too_many_posts':
      return { code: 'RATE_LIMITED', message, platformCode: err.code, retryable: true };
    case 'url_ownership_unverified':
    case 'invalid_params':
    case 'privacy_level_option_mismatch':
      return { code: 'VALIDATION', message, platformCode: err.code };
    default:
      return { message, platformCode: err?.code, retryable: status >= 500 };
  }
}

interface TikTokEnvelope<T> {
  data: T;
  error: { code: string; message: string };
}

/**
 * TikTok — Login Kit + Content Posting API (direct post).
 * Unaudited apps may only post with privacy SELF_ONLY; media URLs must be on a
 * domain verified in the TikTok developer portal.
 * Docs: https://developers.tiktok.com/doc/content-posting-api-get-started
 */
export class TikTokAdapter extends BaseAdapter {
  readonly platform = 'TIKTOK' as const;
  private readonly http = new HttpClient('TIKTOK', parseTikTokError);

  constructor(config: TikTokConfig) {
    super(config);
  }

  getScopes(): string[] {
    return ['user.info.basic', 'user.info.profile', 'user.info.stats', 'video.publish', 'video.upload', 'video.list'];
  }

  async getAuthorizationUrl(input: OAuthInput): Promise<string> {
    const { clientId } = this.requireConfigured();
    const url = new URL('https://www.tiktok.com/v2/auth/authorize/');
    url.searchParams.set('client_key', clientId);
    url.searchParams.set('scope', this.getScopes().join(','));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('state', input.state);
    return url.toString();
  }

  private toTokens(res: { access_token: string; expires_in: number; refresh_token: string; refresh_expires_in: number; scope: string }): TokenResult {
    return {
      accessToken: res.access_token,
      refreshToken: res.refresh_token,
      expiresAt: expiresInToDate(res.expires_in),
      refreshExpiresAt: expiresInToDate(res.refresh_expires_in),
      scopes: res.scope.split(','),
    };
  }

  async handleOAuthCallback(input: OAuthCallbackInput): Promise<ConnectedAccount[]> {
    const { clientId, clientSecret } = this.requireConfigured();
    const res = await this.http.post<{ access_token: string; expires_in: number; open_id: string; refresh_token: string; refresh_expires_in: number; scope: string }>(
      `${API}/oauth/token/`,
      { form: { client_key: clientId, client_secret: clientSecret, code: input.code, grant_type: 'authorization_code', redirect_uri: input.redirectUri } },
    );
    const tokens = this.toTokens(res);
    const profile = await this.fetchUser(res.access_token);
    return [
      {
        platformAccountId: res.open_id,
        platformUserId: res.open_id,
        displayName: profile.display_name ?? 'TikTok user',
        username: profile.username,
        avatarUrl: profile.avatar_url,
        scopes: tokens.scopes ?? [],
        tokens,
      },
    ];
  }

  override async refreshAccessToken(account: SocialAccount): Promise<TokenResult> {
    const { clientId, clientSecret } = this.requireConfigured();
    if (!account.credentials.refreshToken) {
      throw new SocialApiError({ platform: 'TIKTOK', code: 'TOKEN_EXPIRED', message: 'No TikTok refresh token; reconnect required', requiresReauth: true });
    }
    const res = await this.http.post<{ access_token: string; expires_in: number; refresh_token: string; refresh_expires_in: number; scope: string }>(
      `${API}/oauth/token/`,
      { form: { client_key: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: account.credentials.refreshToken } },
    );
    return this.toTokens(res);
  }

  async revokeToken(account: SocialAccount): Promise<void> {
    const { clientId, clientSecret } = this.requireConfigured();
    await this.http.post(`${API}/oauth/revoke/`, { form: { client_key: clientId, client_secret: clientSecret, token: account.credentials.accessToken } });
  }

  private async fetchUser(token: string) {
    const res = await this.http.get<TikTokEnvelope<{ user: { open_id: string; display_name?: string; username?: string; avatar_url?: string; bio_description?: string; follower_count?: number; following_count?: number; video_count?: number; profile_deep_link?: string } }>>(
      `${API}/user/info/`,
      {
        headers: { authorization: `Bearer ${token}` },
        query: { fields: 'open_id,display_name,username,avatar_url,bio_description,follower_count,following_count,video_count,profile_deep_link' },
      },
    );
    return res.data.user;
  }

  async getProfile(account: SocialAccount): Promise<SocialProfile> {
    const u = await this.fetchUser(account.credentials.accessToken);
    return {
      displayName: u.display_name ?? 'TikTok user',
      username: u.username,
      avatarUrl: u.avatar_url,
      bio: u.bio_description,
      followers: u.follower_count,
      following: u.following_count,
      postsCount: u.video_count,
      profileUrl: u.profile_deep_link,
    };
  }

  override async publishPost(account: SocialAccount, post: SocialPost): Promise<PublishResult> {
    const headers = { authorization: `Bearer ${account.credentials.accessToken}` };
    if (!post.media.length) throw new SocialApiError({ platform: 'TIKTOK', code: 'VALIDATION', message: 'TikTok posts require a video or photos' });

    // Creator info decides which privacy levels are allowed (SELF_ONLY for unaudited apps).
    const creator = await this.http.post<TikTokEnvelope<{ privacy_level_options: string[]; max_video_post_duration_sec?: number }>>(
      `${API}/post/publish/creator_info/query/`,
      { headers, json: {} },
    );
    const options = creator.data.privacy_level_options;
    const privacy = options.includes('PUBLIC_TO_EVERYONE') ? 'PUBLIC_TO_EVERYONE' : (options[0] ?? 'SELF_ONLY');
    const caption = composeCaption(post.text, post.hashtags);
    const video = post.media.find((m) => m.kind === 'VIDEO');

    let publishId: string;
    if (video) {
      const res = await this.http.post<TikTokEnvelope<{ publish_id: string }>>(`${API}/post/publish/video/init/`, {
        headers,
        json: {
          post_info: { title: caption.slice(0, 2200), privacy_level: privacy, disable_comment: false, disable_duet: false, disable_stitch: false },
          source_info: { source: 'PULL_FROM_URL', video_url: video.url },
        },
      });
      publishId = res.data.publish_id;
    } else {
      const res = await this.http.post<TikTokEnvelope<{ publish_id: string }>>(`${API}/post/publish/content/init/`, {
        headers,
        json: {
          media_type: 'PHOTO',
          post_mode: 'DIRECT_POST',
          post_info: { title: (post.title ?? caption).slice(0, 90), description: caption.slice(0, 4000), privacy_level: privacy, disable_comment: false },
          source_info: { source: 'PULL_FROM_URL', photo_images: post.media.map((m) => m.url), photo_cover_index: 0 },
        },
      });
      publishId = res.data.publish_id;
    }

    // Publishing is asynchronous; poll the status endpoint (max ~5 minutes).
    for (let i = 0; i < 60; i++) {
      const status = await this.http.post<TikTokEnvelope<{ status: string; fail_reason?: string; publicaly_available_post_id?: (string | number)[] }>>(
        `${API}/post/publish/status/fetch/`,
        { headers, json: { publish_id: publishId } },
      );
      const s = status.data.status;
      if (s === 'PUBLISH_COMPLETE') {
        const postId = status.data.publicaly_available_post_id?.[0];
        return { platformPostId: postId ? String(postId) : publishId, publishedAt: new Date() };
      }
      if (s === 'FAILED') {
        throw new SocialApiError({ platform: 'TIKTOK', code: 'VALIDATION', message: `TikTok publishing failed: ${status.data.fail_reason ?? 'unknown reason'}` });
      }
      await sleep(5000);
    }
    throw new SocialApiError({ platform: 'TIKTOK', code: 'TIMEOUT', message: 'TikTok publishing is still processing; status unknown', retryable: false });
  }

  override async getAnalytics(account: SocialAccount, _range: DateRange, postIds: string[] = []): Promise<AnalyticsResult> {
    const headers = { authorization: `Bearer ${account.credentials.accessToken}` };
    const result: AnalyticsResult = { account: {}, posts: [], unsupportedMetrics: ['reach', 'impressions', 'saves', 'clicks'] };
    const user = await this.fetchUser(account.credentials.accessToken);
    if (typeof user.follower_count === 'number') result.account.followers = user.follower_count;
    if (postIds.length) {
      const res = await this.http.post<TikTokEnvelope<{ videos: { id: string; view_count?: number; like_count?: number; comment_count?: number; share_count?: number }[] }>>(
        `${API}/video/query/`,
        { headers, query: { fields: 'id,view_count,like_count,comment_count,share_count' }, json: { filters: { video_ids: postIds.slice(0, 20) } } },
      );
      for (const v of res.data.videos) {
        result.posts.push({
          platformPostId: v.id,
          metrics: { views: v.view_count ?? 0, likes: v.like_count ?? 0, comments: v.comment_count ?? 0, shares: v.share_count ?? 0 },
        });
      }
    }
    return result;
  }
}
