import { getPlatformCapabilities } from '../capabilities';
import { notConfigured, unsupported } from '../errors';
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
} from '../types';

export interface OAuthAppCredentials {
  clientId?: string;
  clientSecret?: string;
}

/**
 * Default implementations throw UNSUPPORTED so an adapter only overrides what the
 * official API genuinely supports. Nothing here ever fakes success.
 */
export abstract class BaseAdapter implements SocialPlatformAdapter {
  abstract readonly platform: PlatformKey;
  readonly isMock: boolean = false;

  constructor(protected readonly app: OAuthAppCredentials) {}

  getCapabilities(): PlatformCapabilities {
    return getPlatformCapabilities(this.platform);
  }

  isConfigured(): boolean {
    return Boolean(this.app.clientId && this.app.clientSecret);
  }

  protected requireConfigured(): { clientId: string; clientSecret: string } {
    const missing: string[] = [];
    if (!this.app.clientId) missing.push(`${this.platform}_CLIENT_ID`);
    if (!this.app.clientSecret) missing.push(`${this.platform}_CLIENT_SECRET`);
    if (missing.length) throw notConfigured(this.platform, missing);
    return { clientId: this.app.clientId!, clientSecret: this.app.clientSecret! };
  }

  abstract getScopes(): string[];
  abstract getAuthorizationUrl(input: OAuthInput): Promise<string>;
  abstract handleOAuthCallback(input: OAuthCallbackInput): Promise<ConnectedAccount[]>;
  abstract getProfile(account: SocialAccount): Promise<SocialProfile>;

  async refreshAccessToken(_account: SocialAccount): Promise<TokenResult> {
    throw unsupported(this.platform, 'Token refresh');
  }
  async publishPost(_account: SocialAccount, _post: SocialPost): Promise<PublishResult> {
    throw unsupported(this.platform, 'Publishing');
  }
  async publishMedia(account: SocialAccount, media: MediaPost): Promise<PublishResult> {
    return this.publishPost(account, media);
  }
  async getComments(_account: SocialAccount, _options?: CommentOptions): Promise<NormalizedComment[]> {
    throw unsupported(this.platform, 'Reading comments');
  }
  async replyToComment(_account: SocialAccount, _input: CommentReplyInput): Promise<MessageResult> {
    throw unsupported(this.platform, 'Replying to comments');
  }
  async getConversations(_account: SocialAccount): Promise<NormalizedConversation[]> {
    throw unsupported(this.platform, 'Listing conversations');
  }
  async getMessages(_account: SocialAccount, _conversationId: string): Promise<NormalizedMessage[]> {
    throw unsupported(this.platform, 'Reading messages');
  }
  async sendMessage(_account: SocialAccount, _input: SendMessageInput): Promise<MessageResult> {
    throw unsupported(this.platform, 'Direct messages');
  }
  async getAnalytics(_account: SocialAccount, _range: DateRange, _postIds?: string[]): Promise<AnalyticsResult> {
    throw unsupported(this.platform, 'Analytics');
  }
}

export const toUnixSeconds = (d: Date) => Math.floor(d.getTime() / 1000);
export const expiresInToDate = (seconds: number | undefined | null): Date | undefined =>
  typeof seconds === 'number' && seconds > 0 ? new Date(Date.now() + seconds * 1000) : undefined;
