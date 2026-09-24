import { IMPLEMENTED_PLATFORMS, PLATFORM_CAPABILITIES } from './capabilities';
import { SocialApiError } from './errors';
import { FacebookAdapter } from './adapters/facebook';
import { InstagramAdapter } from './adapters/instagram';
import { LinkedInAdapter } from './adapters/linkedin';
import { TikTokAdapter } from './adapters/tiktok';
import { WhatsAppAdapter } from './adapters/whatsapp';
import { MockSocialAdapter } from './mock/mock-adapter';
import type { PlatformCapabilities, PlatformKey, SocialPlatformAdapter } from './types';

export interface SocialRegistryConfig {
  mockEnabled: boolean;
  apiUrl: string;
  mockWebhookSecret: string;
  metaGraphVersion: string;
  facebook: { clientId?: string; clientSecret?: string; webhookVerifyToken?: string };
  instagram: { clientId?: string; clientSecret?: string; webhookVerifyToken?: string };
  whatsapp: { clientId?: string; clientSecret?: string; webhookVerifyToken?: string; configId?: string };
  linkedin: { clientId?: string; clientSecret?: string; apiVersion: string; organizationScopes?: boolean };
  tiktok: { clientId?: string; clientSecret?: string };
}

export interface PlatformStatus {
  platform: PlatformKey;
  implemented: boolean;
  configured: boolean;
  mockAvailable: boolean;
  /**
   * Always "UNVERIFIED" in code: an integration is only production-ready once a
   * developer has tested it end-to-end with approved credentials (see BUILD_STATUS.md).
   */
  verification: 'UNVERIFIED';
  capabilities: PlatformCapabilities;
  docsPath: string;
}

/** Resolves the adapter for a platform (real or development mock). */
export class SocialAdapterRegistry {
  private readonly real = new Map<PlatformKey, SocialPlatformAdapter>();
  private readonly mocks = new Map<PlatformKey, MockSocialAdapter>();

  constructor(private readonly config: SocialRegistryConfig) {
    const v = config.metaGraphVersion;
    this.real.set('FACEBOOK', new FacebookAdapter({ ...config.facebook, graphVersion: v }));
    this.real.set('INSTAGRAM', new InstagramAdapter({ ...config.instagram, graphVersion: v }));
    this.real.set('WHATSAPP', new WhatsAppAdapter({ ...config.whatsapp, graphVersion: v }));
    this.real.set('LINKEDIN', new LinkedInAdapter(config.linkedin));
    this.real.set('TIKTOK', new TikTokAdapter(config.tiktok));
    if (config.mockEnabled) {
      for (const p of IMPLEMENTED_PLATFORMS) {
        this.mocks.set(p, new MockSocialAdapter(p, { apiUrl: config.apiUrl, webhookSecret: config.mockWebhookSecret }));
      }
    }
  }

  get mockEnabled(): boolean {
    return this.config.mockEnabled;
  }

  /** Adapter for an existing account: mock accounts only resolve while mock mode is enabled. */
  forAccount(account: { platform: PlatformKey; isMock: boolean }): SocialPlatformAdapter {
    return account.isMock ? this.mock(account.platform) : this.realAdapter(account.platform);
  }

  realAdapter(platform: PlatformKey): SocialPlatformAdapter {
    const adapter = this.real.get(platform);
    if (!adapter) {
      throw new SocialApiError({ platform, code: 'UNSUPPORTED', message: `${platform} integration is not implemented yet` });
    }
    return adapter;
  }

  mock(platform: PlatformKey): MockSocialAdapter {
    const adapter = this.mocks.get(platform);
    if (!adapter) {
      throw new SocialApiError({
        platform,
        code: 'NOT_CONFIGURED',
        message: 'Mock social providers are disabled (SOCIAL_MOCK_MODE=false or production environment)',
      });
    }
    return adapter;
  }

  statuses(): PlatformStatus[] {
    return (Object.keys(PLATFORM_CAPABILITIES) as PlatformKey[]).map((platform) => {
      const adapter = this.real.get(platform);
      return {
        platform,
        implemented: Boolean(adapter),
        configured: adapter?.isConfigured() ?? false,
        mockAvailable: this.mocks.has(platform),
        verification: 'UNVERIFIED',
        capabilities: PLATFORM_CAPABILITIES[platform],
        docsPath: `docs/integrations/${platform.toLowerCase()}.md`,
      };
    });
  }
}
