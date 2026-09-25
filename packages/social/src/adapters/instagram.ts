import { SocialApiError } from '../errors';
import { HttpClient, sleep } from '../http';
import { composeCaption } from '../validation';
import type {
  AnalyticsResult,
  CommentOptions,
  CommentReplyInput,
  ConnectedAccount,
  DateRange,
  MediaRef,
  MessageResult,
  NormalizedComment,
  NormalizedConversation,
  NormalizedMessage,
  NormalizedWebhookEvent,
  OAuthCallbackInput,
  OAuthInput,
  PublishResult,
  SendMessageInput,
  SocialAccount,
  SocialPost,
  SocialProfile,
  TokenResult,
  WebhookRequest,
} from '../types';
import { BaseAdapter, expiresInToDate, toUnixSeconds, type OAuthAppCredentials } from './base';
import { graphUrl, metaChallenge, parseMetaError, verifyMetaSignature } from './meta-common';

export interface InstagramConfig extends OAuthAppCredentials {
  graphVersion: string;
  webhookVerifyToken?: string;
}

export const INSTAGRAM_ACCOUNT_METRICS = ['reach', 'views', 'accounts_engaged', 'total_interactions', 'follows_and_unfollows'];

/**
 * Instagram API with Instagram Login (Business/Creator accounts).
 * Docs: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login
 */
export class InstagramAdapter extends BaseAdapter {
  readonly platform = 'INSTAGRAM' as const;
  private readonly http = new HttpClient('INSTAGRAM', parseMetaError);

  constructor(private readonly config: InstagramConfig) {
    super(config);
  }

  private url(path: string) {
    return graphUrl(this.config.graphVersion, path, 'graph.instagram.com');
  }

  getScopes(): string[] {
    return [
      'instagram_business_basic',
      'instagram_business_content_publish',
      'instagram_business_manage_comments',
      'instagram_business_manage_messages',
      'instagram_business_manage_insights',
    ];
  }

  async checkAppCredentials(): Promise<{ ok: boolean | null; message: string }> {
    this.requireConfigured();
    return { ok: null, message: 'Instagram can’t verify app credentials without a user sign-in. Connect a test account to confirm they work.' };
  }

  async getAuthorizationUrl(input: OAuthInput): Promise<string> {
    const { clientId } = this.requireConfigured();
    const url = new URL('https://www.instagram.com/oauth/authorize');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', this.getScopes().join(','));
    url.searchParams.set('state', input.state);
    return url.toString();
  }

  async handleOAuthCallback(input: OAuthCallbackInput): Promise<ConnectedAccount[]> {
    const { clientId, clientSecret } = this.requireConfigured();
    const short = await this.http.post<{ access_token: string; user_id: string | number; permissions?: string[] | string }>(
      'https://api.instagram.com/oauth/access_token',
      { form: { client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', redirect_uri: input.redirectUri, code: input.code } },
    );
    const long = await this.http.get<{ access_token: string; expires_in: number }>('https://graph.instagram.com/access_token', {
      query: { grant_type: 'ig_exchange_token', client_secret: clientSecret, access_token: short.access_token },
    });
    const me = await this.http.get<{ user_id: string; username: string; name?: string; profile_picture_url?: string; account_type?: string }>(this.url('me'), {
      query: { fields: 'user_id,username,name,profile_picture_url,account_type', access_token: long.access_token },
    });
    const scopes = Array.isArray(short.permissions) ? short.permissions : (short.permissions?.split(',') ?? this.getScopes());
    return [
      {
        platformAccountId: me.user_id,
        platformUserId: String(short.user_id),
        displayName: me.name || me.username,
        username: me.username,
        avatarUrl: me.profile_picture_url,
        scopes,
        tokens: { accessToken: long.access_token, expiresAt: expiresInToDate(long.expires_in), scopes },
        metadata: { accountType: me.account_type },
      },
    ];
  }

  /** Long-lived tokens (60 days) can be refreshed once they are at least 24 hours old. */
  override async refreshAccessToken(account: SocialAccount): Promise<TokenResult> {
    const res = await this.http.get<{ access_token: string; expires_in: number }>('https://graph.instagram.com/refresh_access_token', {
      query: { grant_type: 'ig_refresh_token', access_token: account.credentials.accessToken },
    });
    return { accessToken: res.access_token, expiresAt: expiresInToDate(res.expires_in) };
  }

  async getProfile(account: SocialAccount): Promise<SocialProfile> {
    const me = await this.http.get<{ username: string; name?: string; biography?: string; profile_picture_url?: string; followers_count?: number; follows_count?: number; media_count?: number }>(
      this.url('me'),
      { query: { fields: 'username,name,biography,profile_picture_url,followers_count,follows_count,media_count', access_token: account.credentials.accessToken } },
    );
    return {
      displayName: me.name || me.username,
      username: me.username,
      bio: me.biography,
      avatarUrl: me.profile_picture_url,
      followers: me.followers_count,
      following: me.follows_count,
      postsCount: me.media_count,
      profileUrl: `https://www.instagram.com/${me.username}`,
    };
  }

  private async createContainer(account: SocialAccount, media: MediaRef, extra: Record<string, string>): Promise<string> {
    const form: Record<string, string> = { access_token: account.credentials.accessToken, ...extra };
    if (media.kind === 'VIDEO') {
      form.media_type = extra.is_carousel_item ? 'VIDEO' : 'REELS';
      form.video_url = media.url;
    } else {
      form.image_url = media.url;
    }
    const res = await this.http.post<{ id: string }>(this.url(`${account.platformAccountId}/media`), { form, timeoutMs: 60_000 });
    return res.id;
  }

  /** Video containers are processed asynchronously; poll until FINISHED (max ~5 min). */
  private async waitForContainer(account: SocialAccount, containerId: string): Promise<void> {
    for (let i = 0; i < 60; i++) {
      const res = await this.http.get<{ status_code: string; status?: string }>(this.url(containerId), {
        query: { fields: 'status_code,status', access_token: account.credentials.accessToken },
      });
      if (res.status_code === 'FINISHED' || res.status_code === 'PUBLISHED') return;
      if (res.status_code === 'ERROR' || res.status_code === 'EXPIRED') {
        throw new SocialApiError({ platform: 'INSTAGRAM', code: 'VALIDATION', message: `Instagram rejected the media: ${res.status ?? res.status_code}` });
      }
      await sleep(5000);
    }
    throw new SocialApiError({ platform: 'INSTAGRAM', code: 'TIMEOUT', message: 'Instagram media processing timed out', retryable: true });
  }

  override async publishPost(account: SocialAccount, post: SocialPost): Promise<PublishResult> {
    if (!post.media.length) {
      throw new SocialApiError({ platform: 'INSTAGRAM', code: 'VALIDATION', message: 'Instagram posts require at least one image or video' });
    }
    const caption = composeCaption(post.text, post.hashtags);
    let creationId: string;
    if (post.media.length === 1) {
      creationId = await this.createContainer(account, post.media[0]!, { caption });
      if (post.media[0]!.kind === 'VIDEO') await this.waitForContainer(account, creationId);
    } else {
      const children: string[] = [];
      for (const m of post.media) {
        const id = await this.createContainer(account, m, { is_carousel_item: 'true' });
        if (m.kind === 'VIDEO') await this.waitForContainer(account, id);
        children.push(id);
      }
      const res = await this.http.post<{ id: string }>(this.url(`${account.platformAccountId}/media`), {
        form: { media_type: 'CAROUSEL', children: children.join(','), caption, access_token: account.credentials.accessToken },
      });
      creationId = res.id;
      await this.waitForContainer(account, creationId);
    }
    const published = await this.http.post<{ id: string }>(this.url(`${account.platformAccountId}/media_publish`), {
      form: { creation_id: creationId, access_token: account.credentials.accessToken },
    });
    let permalink: string | undefined;
    try {
      permalink = (await this.http.get<{ permalink?: string }>(this.url(published.id), { query: { fields: 'permalink', access_token: account.credentials.accessToken } })).permalink;
    } catch {
      permalink = undefined; // post is live; permalink lookup is best-effort
    }
    return { platformPostId: published.id, url: permalink, publishedAt: new Date() };
  }

  override async getComments(account: SocialAccount, options: CommentOptions = {}): Promise<NormalizedComment[]> {
    if (!options.platformPostId) throw new SocialApiError({ platform: 'INSTAGRAM', code: 'VALIDATION', message: 'platformPostId is required' });
    const res = await this.http.get<{ data: { id: string; text: string; timestamp: string; username?: string; from?: { id: string; username?: string }; parent_id?: string }[] }>(
      this.url(`${options.platformPostId}/comments`),
      { query: { fields: 'id,text,timestamp,username,from,parent_id', limit: options.limit ?? 50, access_token: account.credentials.accessToken } },
    );
    return res.data
      .filter((c) => !options.since || new Date(c.timestamp) >= options.since)
      .map((c) => ({
        platformCommentId: c.id,
        platformPostId: options.platformPostId!,
        parentPlatformCommentId: c.parent_id,
        authorPlatformId: c.from?.id,
        authorName: c.from?.username ?? c.username,
        text: c.text,
        createdAt: new Date(c.timestamp),
      }));
  }

  override async replyToComment(account: SocialAccount, input: CommentReplyInput): Promise<MessageResult> {
    const res = await this.http.post<{ id: string }>(this.url(`${input.platformCommentId}/replies`), {
      form: { message: input.text, access_token: account.credentials.accessToken },
    });
    return { platformMessageId: res.id, sentAt: new Date() };
  }

  override async getConversations(account: SocialAccount): Promise<NormalizedConversation[]> {
    const res = await this.http.get<{ data: { id: string; updated_time: string; participants: { data: { id: string; username?: string }[] } }[] }>(
      this.url('me/conversations'),
      { query: { platform: 'instagram', fields: 'id,updated_time,participants', access_token: account.credentials.accessToken } },
    );
    return res.data.map((c) => {
      const other = c.participants.data.find((p) => p.id !== account.platformAccountId) ?? c.participants.data[0]!;
      return { platformConversationId: c.id, participant: { platformUserId: other.id, username: other.username }, updatedAt: new Date(c.updated_time) };
    });
  }

  override async getMessages(account: SocialAccount, conversationId: string): Promise<NormalizedMessage[]> {
    const res = await this.http.get<{ messages?: { data: { id: string; message?: string; created_time: string; from: { id: string } }[] } }>(
      this.url(conversationId),
      { query: { fields: 'messages{id,message,created_time,from}', access_token: account.credentials.accessToken } },
    );
    return (res.messages?.data ?? []).map((m) => ({
      platformMessageId: m.id,
      fromPlatformUserId: m.from.id,
      isFromAccount: m.from.id === account.platformAccountId,
      text: m.message ?? '',
      attachments: [],
      createdAt: new Date(m.created_time),
    }));
  }

  override async sendMessage(account: SocialAccount, input: SendMessageInput): Promise<MessageResult> {
    const res = await this.http.post<{ message_id: string }>(this.url(`${account.platformAccountId}/messages`), {
      query: { access_token: account.credentials.accessToken },
      json: { recipient: { id: input.recipientPlatformUserId }, message: { text: input.text } },
    });
    return { platformMessageId: res.message_id, sentAt: new Date() };
  }

  override async getAnalytics(account: SocialAccount, range: DateRange, postIds: string[] = []): Promise<AnalyticsResult> {
    const token = account.credentials.accessToken;
    const result: AnalyticsResult = { account: {}, posts: [], unsupportedMetrics: [] };
    for (const metric of INSTAGRAM_ACCOUNT_METRICS) {
      try {
        const res = await this.http.get<{ data: { name: string; total_value?: { value: number }; values?: { value: number }[] }[] }>(
          this.url(`${account.platformAccountId}/insights`),
          { query: { metric, period: 'day', metric_type: 'total_value', since: toUnixSeconds(range.from), until: toUnixSeconds(range.to), access_token: token } },
        );
        const row = res.data[0];
        const value = row?.total_value?.value ?? row?.values?.reduce((s, v) => s + v.value, 0);
        if (typeof value === 'number') result.account[metric] = value;
        else result.unsupportedMetrics.push(metric);
      } catch (e) {
        if (e instanceof SocialApiError && e.code === 'VALIDATION') result.unsupportedMetrics.push(metric);
        else throw e;
      }
    }
    for (const postId of postIds) {
      const media = await this.http.get<{ like_count?: number; comments_count?: number }>(this.url(postId), {
        query: { fields: 'like_count,comments_count', access_token: token },
      });
      const metrics: Record<string, number> = { likes: media.like_count ?? 0, comments: media.comments_count ?? 0 };
      try {
        const ins = await this.http.get<{ data: { name: string; values: { value: number }[] }[] }>(this.url(`${postId}/insights`), {
          query: { metric: 'reach,saved,shares,views', access_token: token },
        });
        for (const row of ins.data) metrics[row.name === 'saved' ? 'saves' : row.name] = row.values[0]?.value ?? 0;
      } catch (e) {
        if (!(e instanceof SocialApiError && e.code === 'VALIDATION')) throw e;
      }
      result.posts.push({ platformPostId: postId, metrics });
    }
    return result;
  }

  handleWebhookChallenge(query: Record<string, string | undefined>): string | null {
    return metaChallenge(query, this.config.webhookVerifyToken);
  }

  verifyWebhookSignature(req: WebhookRequest): boolean {
    return verifyMetaSignature(req, this.config.clientSecret);
  }

  parseWebhook(payload: unknown): NormalizedWebhookEvent[] {
    return parseInstagramWebhook(payload);
  }
}

interface IgWebhook {
  object?: string;
  entry?: {
    id: string;
    time?: number;
    messaging?: { sender: { id: string }; recipient: { id: string }; timestamp: number; message?: { mid: string; text?: string; is_echo?: boolean; attachments?: { type: string; payload?: { url?: string } }[] } }[];
    changes?: { field: string; value: { id?: string; text?: string; from?: { id: string; username?: string }; media?: { id: string }; parent_id?: string } }[];
  }[];
}

export function parseInstagramWebhook(payload: unknown): NormalizedWebhookEvent[] {
  const body = payload as IgWebhook;
  if (body?.object !== 'instagram') return [];
  const events: NormalizedWebhookEvent[] = [];
  for (const entry of body.entry ?? []) {
    for (const m of entry.messaging ?? []) {
      if (!m.message) continue;
      const isEcho = Boolean(m.message.is_echo);
      const customerId = isEcho ? m.recipient.id : m.sender.id;
      events.push({
        kind: 'message',
        eventKey: `INSTAGRAM:msg:${m.message.mid}`,
        platformAccountId: entry.id,
        platformConversationId: `${entry.id}:${customerId}`,
        contact: { platformUserId: customerId },
        message: {
          platformMessageId: m.message.mid,
          text: m.message.text ?? '',
          attachments: (m.message.attachments ?? []).map((a) => ({ type: a.type, url: a.payload?.url })),
          createdAt: new Date(m.timestamp),
        },
        isEcho,
      });
    }
    for (const change of entry.changes ?? []) {
      const v = change.value;
      if (change.field !== 'comments' || !v.id || !v.media?.id) continue;
      const authorId = v.from?.id ?? 'unknown';
      events.push({
        kind: 'comment',
        eventKey: `INSTAGRAM:comment:${v.id}`,
        platformAccountId: entry.id,
        contact: { platformUserId: authorId, username: v.from?.username },
        isFromAccount: authorId === entry.id,
        comment: {
          platformCommentId: v.id,
          platformPostId: v.media.id,
          parentPlatformCommentId: v.parent_id,
          authorPlatformId: authorId,
          authorName: v.from?.username,
          text: v.text ?? '',
          createdAt: entry.time ? new Date(entry.time * 1000) : new Date(),
        },
      });
    }
  }
  return events;
}
