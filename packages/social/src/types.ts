import type { PlatformKey } from '@socialpilot/validation';

export type { PlatformKey };

export interface PlatformCapabilities {
  publishing: boolean;
  textPublishing: boolean;
  imagePublishing: boolean;
  videoPublishing: boolean;
  carouselPublishing: boolean;
  comments: boolean;
  commentReplies: boolean;
  directMessages: boolean;
  /** Can the API list historical conversations (vs. webhook-only delivery)? */
  conversationHistory: boolean;
  analytics: boolean;
  webhooks: boolean;
  tokenRefresh: boolean;
  /** Posts must include at least one image/video (e.g. Instagram, TikTok). */
  requiresMedia: boolean;
  maxCaptionLength: number;
  maxHashtags: number;
  maxMediaItems: number;
  supportedImageTypes: string[];
  supportedVideoTypes: string[];
  maxImageBytes: number;
  maxVideoBytes: number;
  maxVideoDurationSec: number;
  /** Human-readable constraints shown in the UI. */
  notes: string[];
}

export interface TokenResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  refreshExpiresAt?: Date;
  scopes?: string[];
  tokenType?: string;
}

/** Decrypted account context passed to adapters. Never serialized to clients or logs. */
export interface SocialAccount {
  id: string;
  platform: PlatformKey;
  platformAccountId: string;
  platformUserId?: string | null;
  metadata: Record<string, unknown>;
  credentials: TokenResult;
}

export interface OAuthInput {
  state: string;
  redirectUri: string;
  codeChallenge?: string;
}

export interface OAuthCallbackInput {
  code: string;
  redirectUri: string;
  codeVerifier?: string;
}

export interface ConnectedAccount {
  platformAccountId: string;
  platformUserId?: string;
  displayName: string;
  username?: string;
  avatarUrl?: string;
  scopes: string[];
  tokens: TokenResult;
  metadata?: Record<string, unknown>;
}

export interface SocialProfile {
  displayName: string;
  username?: string;
  avatarUrl?: string;
  followers?: number;
  following?: number;
  postsCount?: number;
  bio?: string;
  profileUrl?: string;
}

export type MediaKind = 'IMAGE' | 'VIDEO' | 'DOCUMENT';

export interface MediaRef {
  url: string;
  mimeType: string;
  kind: MediaKind;
  size: number;
  width?: number | null;
  height?: number | null;
  durationSec?: number | null;
}

export interface SocialPost {
  text: string;
  title?: string | null;
  hashtags: string[];
  link?: string | null;
  media: MediaRef[];
  /** Stable key so adapters that support it can deduplicate on the platform side. */
  idempotencyKey: string;
}

export type MediaPost = SocialPost & { media: [MediaRef, ...MediaRef[]] };

export interface PublishResult {
  platformPostId: string;
  url?: string;
  publishedAt: Date;
}

export interface CommentOptions {
  platformPostId?: string;
  since?: Date;
  limit?: number;
}

export interface NormalizedComment {
  platformCommentId: string;
  platformPostId: string;
  parentPlatformCommentId?: string;
  authorPlatformId?: string;
  authorName?: string;
  text: string;
  createdAt: Date;
}

export interface CommentReplyInput {
  platformCommentId: string;
  text: string;
}

export interface NormalizedConversation {
  platformConversationId: string;
  participant: { platformUserId: string; name?: string; username?: string };
  updatedAt: Date;
}

export interface NormalizedMessage {
  platformMessageId: string;
  fromPlatformUserId: string;
  isFromAccount: boolean;
  text: string;
  attachments: { type: string; url?: string }[];
  createdAt: Date;
}

export interface SendMessageInput {
  platformConversationId: string;
  recipientPlatformUserId: string;
  text: string;
}

export interface MessageResult {
  platformMessageId: string;
  sentAt: Date;
}

export interface DateRange {
  from: Date;
  to: Date;
}

export interface AnalyticsResult {
  /** Metric name → value for the account over the range (only metrics the API returned). */
  account: Record<string, number>;
  posts: { platformPostId: string; metrics: Record<string, number> }[];
  /** Metrics we asked for but the platform did not provide. Never fabricated. */
  unsupportedMetrics: string[];
}

// ── Webhooks ───────────────────────────────────────────────────────────

export interface WebhookRequest {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | undefined>;
}

export type NormalizedWebhookEvent =
  | {
      kind: 'message';
      eventKey: string;
      platformAccountId: string;
      platformConversationId: string;
      contact: { platformUserId: string; name?: string; username?: string; phone?: string };
      message: { platformMessageId: string; text: string; attachments: { type: string; url?: string }[]; createdAt: Date };
      /** true when the account itself sent it (echo) — stored, never answered */
      isEcho: boolean;
    }
  | {
      kind: 'comment';
      eventKey: string;
      platformAccountId: string;
      contact: { platformUserId: string; name?: string; username?: string };
      comment: NormalizedComment;
      isFromAccount: boolean;
    }
  | {
      kind: 'status';
      eventKey: string;
      platformAccountId: string;
      platformMessageId: string;
      status: string;
    };

// ── Adapter contract ───────────────────────────────────────────────────

export interface SocialPlatformAdapter {
  readonly platform: PlatformKey;
  readonly isMock: boolean;

  getCapabilities(): PlatformCapabilities;
  /** True when the credentials this adapter needs are present in the environment. */
  isConfigured(): boolean;
  /** Scopes requested during OAuth. */
  getScopes(): string[];

  getAuthorizationUrl(input: OAuthInput): Promise<string>;
  /** May return several accounts (e.g. every Facebook Page the user manages). */
  handleOAuthCallback(input: OAuthCallbackInput): Promise<ConnectedAccount[]>;
  refreshAccessToken(account: SocialAccount): Promise<TokenResult>;
  revokeToken?(account: SocialAccount): Promise<void>;
  getProfile(account: SocialAccount): Promise<SocialProfile>;

  publishPost(account: SocialAccount, post: SocialPost): Promise<PublishResult>;
  publishMedia(account: SocialAccount, media: MediaPost): Promise<PublishResult>;

  getComments(account: SocialAccount, options?: CommentOptions): Promise<NormalizedComment[]>;
  replyToComment(account: SocialAccount, input: CommentReplyInput): Promise<MessageResult>;

  getConversations(account: SocialAccount): Promise<NormalizedConversation[]>;
  getMessages(account: SocialAccount, conversationId: string): Promise<NormalizedMessage[]>;
  sendMessage(account: SocialAccount, input: SendMessageInput): Promise<MessageResult>;

  getAnalytics(account: SocialAccount, range: DateRange, platformPostIds?: string[]): Promise<AnalyticsResult>;

  /**
   * Verifies the app credentials with the platform without a user login, where the
   * platform allows it. ok=null means the platform offers no such check.
   */
  checkAppCredentials?(): Promise<{ ok: boolean | null; message: string }>;

  /** Answers the platform's webhook subscription challenge, or null if not a challenge. */
  handleWebhookChallenge?(query: Record<string, string | undefined>): string | null;
  verifyWebhookSignature?(req: WebhookRequest): boolean;
  parseWebhook?(payload: unknown): NormalizedWebhookEvent[];
}
