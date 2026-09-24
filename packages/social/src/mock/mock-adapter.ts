import { createHash, randomUUID } from 'node:crypto';
import { hmacSha256, safeEqual } from '@socialpilot/auth';
import { getPlatformCapabilities } from '../capabilities';
import { SocialApiError, unsupported } from '../errors';
import type {
  AnalyticsResult,
  CommentOptions,
  CommentReplyInput,
  ConnectedAccount,
  DateRange,
  MediaPost,
  MessageResult,
  NormalizedComment,
  NormalizedConversation,
  NormalizedMessage,
  NormalizedWebhookEvent,
  OAuthCallbackInput,
  OAuthInput,
  PlatformCapabilities,
  PlatformKey,
  PublishResult,
  SendMessageInput,
  SocialAccount,
  SocialPlatformAdapter,
  SocialPost,
  SocialProfile,
  TokenResult,
  WebhookRequest,
} from '../types';

export interface MockAdapterConfig {
  /** Base URL of the API — the mock consent screen lives at /social/oauth/mock/authorize */
  apiUrl: string;
  /** Secret used to sign simulated webhook deliveries */
  webhookSecret: string;
}

/** Markers that make mock publishing fail, for exercising retry/error paths. */
export const MOCK_FAILURE_MARKERS = {
  transient: '[mock:fail-transient]',
  permanent: '[mock:fail-permanent]',
  auth: '[mock:fail-auth]',
  rateLimit: '[mock:fail-ratelimit]',
} as const;

const MOCK_NAMES: Record<PlatformKey, string> = {
  FACEBOOK: 'MockFacebook',
  INSTAGRAM: 'MockInstagram',
  WHATSAPP: 'MockWhatsApp',
  LINKEDIN: 'MockLinkedIn',
  TIKTOK: 'MockTikTok',
  YOUTUBE: 'MockYouTube',
  X: 'MockX',
  PINTEREST: 'MockPinterest',
  GOOGLE_BUSINESS: 'MockGoogleBusiness',
  THREADS: 'MockThreads',
};

function seeded(seed: string): () => number {
  let h = createHash('sha256').update(seed).digest().readUInt32BE(0);
  return () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return ((h >>> 0) % 10000) / 10000;
  };
}

/**
 * Development-only adapter. Mirrors the real platform's capability matrix so
 * validation behaves identically, but never talks to a real platform.
 * All ids it returns are prefixed `mock_` and accounts are flagged isMock.
 */
export class MockSocialAdapter implements SocialPlatformAdapter {
  readonly isMock = true;
  readonly name: string;

  constructor(
    readonly platform: PlatformKey,
    private readonly config: MockAdapterConfig,
  ) {
    this.name = MOCK_NAMES[platform];
  }

  getCapabilities(): PlatformCapabilities {
    const real = getPlatformCapabilities(this.platform);
    return { ...real, notes: [`${this.name}: simulated integration for development — nothing is posted to ${this.platform}.`, ...real.notes] };
  }

  isConfigured(): boolean {
    return true;
  }

  getScopes(): string[] {
    return ['mock.read', 'mock.write'];
  }

  private assertCapability(flag: keyof PlatformCapabilities, operation: string) {
    if (!this.getCapabilities()[flag]) throw unsupported(this.platform, operation);
  }

  async getAuthorizationUrl(input: OAuthInput): Promise<string> {
    const url = new URL('/api/v1/social/oauth/mock/authorize', this.config.apiUrl);
    url.searchParams.set('platform', this.platform);
    url.searchParams.set('state', input.state);
    url.searchParams.set('redirect_uri', input.redirectUri);
    return url.toString();
  }

  async handleOAuthCallback(input: OAuthCallbackInput): Promise<ConnectedAccount[]> {
    if (!input.code.startsWith('mock_code_')) {
      throw new SocialApiError({ platform: this.platform, code: 'UNAUTHORIZED', message: 'Invalid mock authorization code' });
    }
    const suffix = createHash('sha256').update(input.code).digest('hex').slice(0, 10);
    return [
      {
        platformAccountId: `mock_${this.platform.toLowerCase()}_${suffix}`,
        platformUserId: `mock_user_${suffix}`,
        displayName: `${this.name} Account ${suffix.slice(0, 4).toUpperCase()}`,
        username: `mock_${this.platform.toLowerCase()}_${suffix.slice(0, 6)}`,
        scopes: this.getScopes(),
        tokens: {
          accessToken: `mock_access_${randomUUID()}`,
          refreshToken: `mock_refresh_${randomUUID()}`,
          expiresAt: new Date(Date.now() + 60 * 24 * 3600 * 1000),
          scopes: this.getScopes(),
        },
        metadata: { mock: true },
      },
    ];
  }

  async refreshAccessToken(_account: SocialAccount): Promise<TokenResult> {
    return { accessToken: `mock_access_${randomUUID()}`, refreshToken: `mock_refresh_${randomUUID()}`, expiresAt: new Date(Date.now() + 60 * 24 * 3600 * 1000) };
  }

  async getProfile(account: SocialAccount): Promise<SocialProfile> {
    const rnd = seeded(account.platformAccountId);
    return {
      displayName: `${this.name} Account`,
      username: account.platformAccountId,
      followers: Math.floor(500 + rnd() * 20000),
      following: Math.floor(rnd() * 500),
      postsCount: Math.floor(rnd() * 300),
      bio: `Simulated ${this.platform} profile (mock mode).`,
    };
  }

  private injectFailure(text: string) {
    if (text.includes(MOCK_FAILURE_MARKERS.transient)) {
      throw new SocialApiError({ platform: this.platform, code: 'SERVER_ERROR', status: 500, message: `${this.name}: simulated transient server error` });
    }
    if (text.includes(MOCK_FAILURE_MARKERS.rateLimit)) {
      throw new SocialApiError({ platform: this.platform, code: 'RATE_LIMITED', status: 429, message: `${this.name}: simulated rate limit`, retryAfterMs: 1000 });
    }
    if (text.includes(MOCK_FAILURE_MARKERS.auth)) {
      throw new SocialApiError({ platform: this.platform, code: 'TOKEN_EXPIRED', status: 401, message: `${this.name}: simulated expired token` });
    }
    if (text.includes(MOCK_FAILURE_MARKERS.permanent)) {
      throw new SocialApiError({ platform: this.platform, code: 'VALIDATION', status: 400, message: `${this.name}: simulated permanent rejection` });
    }
  }

  async publishPost(_account: SocialAccount, post: SocialPost): Promise<PublishResult> {
    this.assertCapability('publishing', 'Publishing');
    if (this.getCapabilities().requiresMedia && post.media.length === 0) {
      throw new SocialApiError({ platform: this.platform, code: 'VALIDATION', message: `${this.platform} posts require media` });
    }
    this.injectFailure(post.text);
    const id = `mock_${this.platform.toLowerCase()}_post_${createHash('sha256').update(post.idempotencyKey).digest('hex').slice(0, 16)}`;
    return { platformPostId: id, url: `https://mock.socialpilot.invalid/${this.platform.toLowerCase()}/${id}`, publishedAt: new Date() };
  }

  async publishMedia(account: SocialAccount, media: MediaPost): Promise<PublishResult> {
    return this.publishPost(account, media);
  }

  async getComments(_account: SocialAccount, _options?: CommentOptions): Promise<NormalizedComment[]> {
    this.assertCapability('comments', 'Reading comments');
    return []; // inbound comments arrive through simulated webhooks
  }

  async replyToComment(_account: SocialAccount, input: CommentReplyInput): Promise<MessageResult> {
    this.assertCapability('commentReplies', 'Replying to comments');
    this.injectFailure(input.text);
    return { platformMessageId: `mock_reply_${randomUUID()}`, sentAt: new Date() };
  }

  async getConversations(_account: SocialAccount): Promise<NormalizedConversation[]> {
    this.assertCapability('directMessages', 'Direct messages');
    return [];
  }

  async getMessages(_account: SocialAccount, _conversationId: string): Promise<NormalizedMessage[]> {
    this.assertCapability('directMessages', 'Direct messages');
    return [];
  }

  async sendMessage(_account: SocialAccount, input: SendMessageInput): Promise<MessageResult> {
    this.assertCapability('directMessages', 'Direct messages');
    this.injectFailure(input.text);
    return { platformMessageId: `mock_msg_${randomUUID()}`, sentAt: new Date() };
  }

  /** Deterministic pseudo-metrics, always stored with source=MOCK and labelled in the UI. */
  async getAnalytics(account: SocialAccount, range: DateRange, platformPostIds: string[] = []): Promise<AnalyticsResult> {
    this.assertCapability('analytics', 'Analytics');
    const days = Math.max(1, Math.round((range.to.getTime() - range.from.getTime()) / 86_400_000));
    const rnd = seeded(`${account.platformAccountId}:${range.from.toISOString().slice(0, 10)}`);
    const account_: Record<string, number> = {
      followers: Math.floor(1000 + rnd() * 5000),
      reach: Math.floor(days * (200 + rnd() * 800)),
      impressions: Math.floor(days * (400 + rnd() * 1500)),
      engagement: Math.floor(days * (20 + rnd() * 120)),
    };
    const posts = platformPostIds.map((id) => {
      const r = seeded(id);
      return {
        platformPostId: id,
        metrics: {
          reach: Math.floor(100 + r() * 2000),
          impressions: Math.floor(200 + r() * 4000),
          likes: Math.floor(r() * 300),
          comments: Math.floor(r() * 40),
          shares: Math.floor(r() * 30),
          saves: Math.floor(r() * 25),
          clicks: Math.floor(r() * 60),
        },
      };
    });
    return { account: account_, posts, unsupportedMetrics: [] };
  }

  handleWebhookChallenge(query: Record<string, string | undefined>): string | null {
    return query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === 'mock' ? (query['hub.challenge'] ?? null) : null;
  }

  verifyWebhookSignature(req: WebhookRequest): boolean {
    const raw = req.headers['x-mock-signature'];
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (!header) return false;
    return safeEqual(header, signMockWebhook(this.config.webhookSecret, req.rawBody));
  }

  parseWebhook(payload: unknown): NormalizedWebhookEvent[] {
    return parseMockWebhook(this.platform, payload);
  }
}

export function signMockWebhook(secret: string, body: Buffer | string): string {
  return `sha256=${hmacSha256(secret, body, 'hex')}`;
}

/** Simulated webhook payload — a simplified, platform-neutral format. */
export interface MockWebhookPayload {
  events: (
    | { type: 'message'; id: string; accountId: string; from: { id: string; name?: string; username?: string }; text: string; timestamp?: string }
    | { type: 'comment'; id: string; accountId: string; postId: string; from: { id: string; name?: string; username?: string }; text: string; parentId?: string; timestamp?: string }
  )[];
}

export function parseMockWebhook(platform: PlatformKey, payload: unknown): NormalizedWebhookEvent[] {
  const body = payload as MockWebhookPayload;
  if (!Array.isArray(body?.events)) return [];
  return body.events.map((e): NormalizedWebhookEvent => {
    const createdAt = e.timestamp ? new Date(e.timestamp) : new Date();
    if (e.type === 'comment') {
      return {
        kind: 'comment',
        eventKey: `${platform}:mock-comment:${e.id}`,
        platformAccountId: e.accountId,
        contact: { platformUserId: e.from.id, name: e.from.name, username: e.from.username },
        isFromAccount: false,
        comment: {
          platformCommentId: e.id,
          platformPostId: e.postId,
          parentPlatformCommentId: e.parentId,
          authorPlatformId: e.from.id,
          authorName: e.from.name ?? e.from.username,
          text: e.text,
          createdAt,
        },
      };
    }
    return {
      kind: 'message',
      eventKey: `${platform}:mock-msg:${e.id}`,
      platformAccountId: e.accountId,
      platformConversationId: `${e.accountId}:${e.from.id}`,
      contact: { platformUserId: e.from.id, name: e.from.name, username: e.from.username },
      message: { platformMessageId: e.id, text: e.text, attachments: [], createdAt },
      isEcho: false,
    };
  });
}
