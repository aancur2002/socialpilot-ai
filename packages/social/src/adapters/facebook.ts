import { SocialApiError } from '../errors';
import { HttpClient } from '../http';
import { composeCaption } from '../validation';
import type {
  AnalyticsResult,
  CommentOptions,
  CommentReplyInput,
  ConnectedAccount,
  DateRange,
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
  WebhookRequest,
} from '../types';
import { BaseAdapter, toUnixSeconds, type OAuthAppCredentials } from './base';
import { graphUrl, metaChallenge, parseMetaError, verifyMetaSignature } from './meta-common';

export interface FacebookConfig extends OAuthAppCredentials {
  graphVersion: string;
  webhookVerifyToken?: string;
}

/** Page insights we request. Meta retires metrics periodically — missing ones are reported, never invented. */
export const FACEBOOK_PAGE_METRICS = ['page_impressions_unique', 'page_post_engagements', 'page_follows', 'page_views_total'];

/**
 * Facebook Pages via the Graph API.
 * Docs: https://developers.facebook.com/docs/pages-api
 */
export class FacebookAdapter extends BaseAdapter {
  readonly platform = 'FACEBOOK' as const;
  private readonly http = new HttpClient('FACEBOOK', parseMetaError);

  constructor(private readonly config: FacebookConfig) {
    super(config);
  }

  private url(path: string) {
    return graphUrl(this.config.graphVersion, path);
  }

  getScopes(): string[] {
    return [
      'pages_show_list',
      'pages_read_engagement',
      'pages_manage_posts',
      'pages_manage_metadata',
      'pages_read_user_content',
      'pages_manage_engagement',
      'pages_messaging',
      'read_insights',
      'business_management',
    ];
  }

  async getAuthorizationUrl(input: OAuthInput): Promise<string> {
    const { clientId } = this.requireConfigured();
    const url = new URL(`https://www.facebook.com/${this.config.graphVersion}/dialog/oauth`);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('state', input.state);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', this.getScopes().join(','));
    return url.toString();
  }

  /** code → user token → long-lived user token → one long-lived Page token per managed Page. */
  async handleOAuthCallback(input: OAuthCallbackInput): Promise<ConnectedAccount[]> {
    const { clientId, clientSecret } = this.requireConfigured();
    const short = await this.http.get<{ access_token: string }>(this.url('oauth/access_token'), {
      query: { client_id: clientId, client_secret: clientSecret, redirect_uri: input.redirectUri, code: input.code },
    });
    const long = await this.http.get<{ access_token: string; expires_in?: number }>(this.url('oauth/access_token'), {
      query: { grant_type: 'fb_exchange_token', client_id: clientId, client_secret: clientSecret, fb_exchange_token: short.access_token },
    });
    const me = await this.http.get<{ id: string }>(this.url('me'), { query: { fields: 'id', access_token: long.access_token } });
    const pages = await this.http.get<{
      data: { id: string; name: string; access_token: string; tasks?: string[]; picture?: { data?: { url?: string } }; username?: string }[];
    }>(this.url('me/accounts'), {
      query: { fields: 'id,name,access_token,tasks,username,picture{url}', limit: 100, access_token: long.access_token },
    });
    const perms = await this.http.get<{ data: { permission: string; status: string }[] }>(this.url('me/permissions'), {
      query: { access_token: long.access_token },
    });
    const granted = perms.data.filter((p) => p.status === 'granted').map((p) => p.permission);
    if (!pages.data.length) {
      throw new SocialApiError({
        platform: 'FACEBOOK',
        code: 'INVALID_PERMISSIONS',
        message: 'No Facebook Pages were shared with the app. Re-connect and select at least one Page.',
      });
    }
    // Subscribe each Page to this app's webhooks so comments and messages are delivered.
    for (const page of pages.data) {
      await this.http.post(this.url(`${page.id}/subscribed_apps`), {
        form: { subscribed_fields: 'feed,messages,messaging_postbacks', access_token: page.access_token },
      });
    }
    return pages.data.map((page) => ({
      platformAccountId: page.id,
      platformUserId: me.id,
      displayName: page.name,
      username: page.username,
      avatarUrl: page.picture?.data?.url,
      scopes: granted,
      // Page tokens derived from a long-lived user token have no expiry.
      tokens: { accessToken: page.access_token, scopes: granted },
      metadata: { pageTasks: page.tasks ?? [] },
    }));
  }

  async getProfile(account: SocialAccount): Promise<SocialProfile> {
    const page = await this.http.get<{ name: string; username?: string; about?: string; followers_count?: number; fan_count?: number; link?: string; picture?: { data?: { url?: string } } }>(
      this.url(account.platformAccountId),
      { query: { fields: 'name,username,about,followers_count,fan_count,link,picture{url}', access_token: account.credentials.accessToken } },
    );
    return {
      displayName: page.name,
      username: page.username,
      bio: page.about,
      followers: page.followers_count ?? page.fan_count,
      profileUrl: page.link,
      avatarUrl: page.picture?.data?.url,
    };
  }

  override async publishPost(account: SocialAccount, post: SocialPost): Promise<PublishResult> {
    const token = account.credentials.accessToken;
    const pageId = account.platformAccountId;
    const message = composeCaption(post.text, post.hashtags);
    const images = post.media.filter((m) => m.kind === 'IMAGE');
    const video = post.media.find((m) => m.kind === 'VIDEO');
    let id: string;

    if (video) {
      const res = await this.http.post<{ id: string }>(this.url(`${pageId}/videos`), {
        form: { file_url: video.url, description: message, ...(post.title ? { title: post.title } : {}), access_token: token },
        timeoutMs: 120_000,
      });
      id = res.id;
    } else if (images.length === 1) {
      const res = await this.http.post<{ id: string; post_id?: string }>(this.url(`${pageId}/photos`), {
        form: { url: images[0]!.url, caption: message, access_token: token },
        timeoutMs: 60_000,
      });
      id = res.post_id ?? res.id;
    } else if (images.length > 1) {
      const attached: string[] = [];
      for (const img of images) {
        const res = await this.http.post<{ id: string }>(this.url(`${pageId}/photos`), {
          form: { url: img.url, published: 'false', access_token: token },
          timeoutMs: 60_000,
        });
        attached.push(res.id);
      }
      const form: Record<string, string> = { message, access_token: token };
      attached.forEach((mediaId, i) => (form[`attached_media[${i}]`] = JSON.stringify({ media_fbid: mediaId })));
      id = (await this.http.post<{ id: string }>(this.url(`${pageId}/feed`), { form })).id;
    } else {
      const form: Record<string, string> = { message, access_token: token };
      if (post.link) form.link = post.link;
      id = (await this.http.post<{ id: string }>(this.url(`${pageId}/feed`), { form })).id;
    }
    return { platformPostId: id, url: `https://www.facebook.com/${id}`, publishedAt: new Date() };
  }

  override async getComments(account: SocialAccount, options: CommentOptions = {}): Promise<NormalizedComment[]> {
    if (!options.platformPostId) throw new SocialApiError({ platform: 'FACEBOOK', code: 'VALIDATION', message: 'platformPostId is required' });
    const res = await this.http.get<{ data: { id: string; message: string; created_time: string; from?: { id: string; name: string }; parent?: { id: string } }[] }>(
      this.url(`${options.platformPostId}/comments`),
      {
        query: {
          fields: 'id,message,created_time,from,parent',
          filter: 'stream',
          limit: options.limit ?? 50,
          ...(options.since ? { since: toUnixSeconds(options.since) } : {}),
          access_token: account.credentials.accessToken,
        },
      },
    );
    return res.data.map((c) => ({
      platformCommentId: c.id,
      platformPostId: options.platformPostId!,
      parentPlatformCommentId: c.parent?.id,
      authorPlatformId: c.from?.id,
      authorName: c.from?.name,
      text: c.message,
      createdAt: new Date(c.created_time),
    }));
  }

  override async replyToComment(account: SocialAccount, input: CommentReplyInput): Promise<MessageResult> {
    const res = await this.http.post<{ id: string }>(this.url(`${input.platformCommentId}/comments`), {
      form: { message: input.text, access_token: account.credentials.accessToken },
    });
    return { platformMessageId: res.id, sentAt: new Date() };
  }

  override async getConversations(account: SocialAccount): Promise<NormalizedConversation[]> {
    const res = await this.http.get<{ data: { id: string; updated_time: string; participants: { data: { id: string; name?: string }[] } }[] }>(
      this.url(`${account.platformAccountId}/conversations`),
      { query: { platform: 'messenger', fields: 'id,updated_time,participants', access_token: account.credentials.accessToken } },
    );
    return res.data.map((c) => {
      const other = c.participants.data.find((p) => p.id !== account.platformAccountId) ?? c.participants.data[0]!;
      return { platformConversationId: c.id, participant: { platformUserId: other.id, name: other.name }, updatedAt: new Date(c.updated_time) };
    });
  }

  override async getMessages(account: SocialAccount, conversationId: string): Promise<NormalizedMessage[]> {
    const res = await this.http.get<{ data: { id: string; message: string; created_time: string; from: { id: string } }[] }>(
      this.url(`${conversationId}/messages`),
      { query: { fields: 'id,message,created_time,from', access_token: account.credentials.accessToken } },
    );
    return res.data.map((m) => ({
      platformMessageId: m.id,
      fromPlatformUserId: m.from.id,
      isFromAccount: m.from.id === account.platformAccountId,
      text: m.message,
      attachments: [],
      createdAt: new Date(m.created_time),
    }));
  }

  override async sendMessage(account: SocialAccount, input: SendMessageInput): Promise<MessageResult> {
    const res = await this.http.post<{ message_id: string }>(this.url(`${account.platformAccountId}/messages`), {
      query: { access_token: account.credentials.accessToken },
      json: { recipient: { id: input.recipientPlatformUserId }, messaging_type: 'RESPONSE', message: { text: input.text } },
    });
    return { platformMessageId: res.message_id, sentAt: new Date() };
  }

  override async getAnalytics(account: SocialAccount, range: DateRange, postIds: string[] = []): Promise<AnalyticsResult> {
    const token = account.credentials.accessToken;
    const result: AnalyticsResult = { account: {}, posts: [], unsupportedMetrics: [] };
    for (const metric of FACEBOOK_PAGE_METRICS) {
      try {
        const res = await this.http.get<{ data: { name: string; values: { value: number }[] }[] }>(this.url(`${account.platformAccountId}/insights`), {
          query: { metric, period: 'day', since: toUnixSeconds(range.from), until: toUnixSeconds(range.to), access_token: token },
        });
        const series = res.data[0]?.values ?? [];
        if (!series.length) result.unsupportedMetrics.push(metric);
        else result.account[metric] = series.reduce((sum, v) => sum + (typeof v.value === 'number' ? v.value : 0), 0);
      } catch (e) {
        if (e instanceof SocialApiError && e.code === 'VALIDATION') result.unsupportedMetrics.push(metric);
        else throw e;
      }
    }
    for (const postId of postIds) {
      const post = await this.http.get<{ shares?: { count: number }; comments?: { summary?: { total_count: number } }; reactions?: { summary?: { total_count: number } } }>(
        this.url(postId),
        { query: { fields: 'shares,comments.summary(true).limit(0),reactions.summary(true).limit(0)', access_token: token } },
      );
      result.posts.push({
        platformPostId: postId,
        metrics: {
          likes: post.reactions?.summary?.total_count ?? 0,
          comments: post.comments?.summary?.total_count ?? 0,
          shares: post.shares?.count ?? 0,
        },
      });
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
    return parseFacebookWebhook(payload);
  }
}

interface FbWebhook {
  object?: string;
  entry?: {
    id: string;
    time?: number;
    messaging?: { sender: { id: string }; recipient: { id: string }; timestamp: number; message?: { mid: string; text?: string; is_echo?: boolean; attachments?: { type: string; payload?: { url?: string } }[] } }[];
    changes?: { field: string; value: { item?: string; verb?: string; comment_id?: string; post_id?: string; parent_id?: string; message?: string; created_time?: number; from?: { id: string; name?: string } } }[];
  }[];
}

export function parseFacebookWebhook(payload: unknown): NormalizedWebhookEvent[] {
  const body = payload as FbWebhook;
  if (body?.object !== 'page') return [];
  const events: NormalizedWebhookEvent[] = [];
  for (const entry of body.entry ?? []) {
    for (const m of entry.messaging ?? []) {
      if (!m.message) continue;
      const isEcho = Boolean(m.message.is_echo);
      const customerId = isEcho ? m.recipient.id : m.sender.id;
      events.push({
        kind: 'message',
        eventKey: `FACEBOOK:msg:${m.message.mid}`,
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
      if (change.field !== 'feed' || v.item !== 'comment' || v.verb !== 'add' || !v.comment_id || !v.post_id) continue;
      const authorId = v.from?.id ?? 'unknown';
      events.push({
        kind: 'comment',
        eventKey: `FACEBOOK:comment:${v.comment_id}`,
        platformAccountId: entry.id,
        contact: { platformUserId: authorId, name: v.from?.name },
        isFromAccount: authorId === entry.id,
        comment: {
          platformCommentId: v.comment_id,
          platformPostId: v.post_id,
          parentPlatformCommentId: v.parent_id && v.parent_id !== v.post_id ? v.parent_id : undefined,
          authorPlatformId: authorId,
          authorName: v.from?.name,
          text: v.message ?? '',
          createdAt: v.created_time ? new Date(v.created_time * 1000) : new Date(),
        },
      });
    }
  }
  return events;
}

