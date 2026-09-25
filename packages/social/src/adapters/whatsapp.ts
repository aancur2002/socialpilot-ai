import { SocialApiError } from '../errors';
import { HttpClient } from '../http';
import type {
  ConnectedAccount,
  MessageResult,
  NormalizedWebhookEvent,
  OAuthCallbackInput,
  OAuthInput,
  SendMessageInput,
  SocialAccount,
  SocialProfile,
  WebhookRequest,
} from '../types';
import { BaseAdapter, type OAuthAppCredentials } from './base';
import { graphUrl, metaChallenge, parseMetaError, verifyMetaSignature } from './meta-common';

export interface WhatsAppConfig extends OAuthAppCredentials {
  graphVersion: string;
  webhookVerifyToken?: string;
  /** Embedded Signup configuration id (Facebook Login for Business). */
  configId?: string;
}

/**
 * WhatsApp Business Platform — Cloud API. Messaging only.
 * Onboarding uses Embedded Signup; each business phone number becomes one account.
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
 */
export class WhatsAppAdapter extends BaseAdapter {
  readonly platform = 'WHATSAPP' as const;
  private readonly http = new HttpClient('WHATSAPP', parseMetaError);

  constructor(private readonly config: WhatsAppConfig) {
    super(config);
  }

  private url(path: string) {
    return graphUrl(this.config.graphVersion, path);
  }

  override isConfigured(): boolean {
    return super.isConfigured() && Boolean(this.config.configId);
  }

  getScopes(): string[] {
    return ['whatsapp_business_management', 'whatsapp_business_messaging', 'business_management'];
  }

  /** Requests an app access token (client_credentials) — proves the app ID and secret are valid. */
  async checkAppCredentials(): Promise<{ ok: boolean | null; message: string }> {
    const { clientId, clientSecret } = this.requireConfigured();
    await this.http.get(this.url('oauth/access_token'), { query: { client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' } });
    return { ok: true, message: this.config.configId ? 'Meta accepted the app ID and secret.' : 'Meta accepted the app ID and secret. Add the Embedded Signup configuration ID to finish setup.' };
  }

  async getAuthorizationUrl(input: OAuthInput): Promise<string> {
    const { clientId } = this.requireConfigured();
    if (!this.config.configId) {
      throw new SocialApiError({ platform: 'WHATSAPP', code: 'NOT_CONFIGURED', message: 'WHATSAPP_CONFIG_ID (Embedded Signup configuration) is not set' });
    }
    const url = new URL(`https://www.facebook.com/${this.config.graphVersion}/dialog/oauth`);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('state', input.state);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('config_id', this.config.configId);
    url.searchParams.set('override_default_response_type', 'true');
    return url.toString();
  }

  /**
   * Exchanges the code for a business integration token, discovers the shared
   * WhatsApp Business Accounts from the token's granular scopes, subscribes the
   * app to each WABA's webhooks and returns one account per phone number.
   */
  async handleOAuthCallback(input: OAuthCallbackInput): Promise<ConnectedAccount[]> {
    const { clientId, clientSecret } = this.requireConfigured();
    const token = await this.http.get<{ access_token: string }>(this.url('oauth/access_token'), {
      query: { client_id: clientId, client_secret: clientSecret, redirect_uri: input.redirectUri, code: input.code },
    });
    const debug = await this.http.get<{ data: { scopes?: string[]; granular_scopes?: { scope: string; target_ids?: string[] }[] } }>(this.url('debug_token'), {
      query: { input_token: token.access_token, access_token: `${clientId}|${clientSecret}` },
    });
    const wabaIds = new Set(
      (debug.data.granular_scopes ?? []).filter((s) => s.scope === 'whatsapp_business_management').flatMap((s) => s.target_ids ?? []),
    );
    if (!wabaIds.size) {
      throw new SocialApiError({ platform: 'WHATSAPP', code: 'INVALID_PERMISSIONS', message: 'No WhatsApp Business Account was shared during signup' });
    }
    const accounts: ConnectedAccount[] = [];
    for (const wabaId of wabaIds) {
      await this.http.post(this.url(`${wabaId}/subscribed_apps`), { form: { access_token: token.access_token } });
      const phones = await this.http.get<{ data: { id: string; display_phone_number: string; verified_name: string }[] }>(this.url(`${wabaId}/phone_numbers`), {
        query: { fields: 'id,display_phone_number,verified_name', access_token: token.access_token },
      });
      for (const p of phones.data) {
        accounts.push({
          platformAccountId: p.id,
          displayName: p.verified_name,
          username: p.display_phone_number,
          scopes: debug.data.scopes ?? this.getScopes(),
          tokens: { accessToken: token.access_token, scopes: debug.data.scopes },
          metadata: { wabaId, displayPhoneNumber: p.display_phone_number },
        });
      }
    }
    return accounts;
  }

  async getProfile(account: SocialAccount): Promise<SocialProfile> {
    const phone = await this.http.get<{ display_phone_number: string; verified_name: string }>(this.url(account.platformAccountId), {
      query: { fields: 'display_phone_number,verified_name', access_token: account.credentials.accessToken },
    });
    return { displayName: phone.verified_name, username: phone.display_phone_number };
  }

  /** Free-form text is only accepted inside the 24h customer service window; Meta rejects it otherwise. */
  override async sendMessage(account: SocialAccount, input: SendMessageInput): Promise<MessageResult> {
    const res = await this.http.post<{ messages: { id: string }[] }>(this.url(`${account.platformAccountId}/messages`), {
      headers: { authorization: `Bearer ${account.credentials.accessToken}` },
      json: { messaging_product: 'whatsapp', recipient_type: 'individual', to: input.recipientPlatformUserId, type: 'text', text: { preview_url: false, body: input.text } },
    });
    const id = res.messages[0]?.id;
    if (!id) throw new SocialApiError({ platform: 'WHATSAPP', code: 'UNKNOWN', message: 'WhatsApp did not return a message id' });
    return { platformMessageId: id, sentAt: new Date() };
  }

  handleWebhookChallenge(query: Record<string, string | undefined>): string | null {
    return metaChallenge(query, this.config.webhookVerifyToken);
  }

  verifyWebhookSignature(req: WebhookRequest): boolean {
    return verifyMetaSignature(req, this.config.clientSecret);
  }

  parseWebhook(payload: unknown): NormalizedWebhookEvent[] {
    return parseWhatsAppWebhook(payload);
  }
}

interface WaWebhook {
  object?: string;
  entry?: {
    id: string;
    changes?: {
      field: string;
      value: {
        metadata?: { phone_number_id: string; display_phone_number?: string };
        contacts?: { wa_id: string; profile?: { name?: string } }[];
        messages?: { from: string; id: string; timestamp: string; type: string; text?: { body: string }; image?: { id: string; caption?: string }; button?: { text: string }; interactive?: { button_reply?: { title: string }; list_reply?: { title: string } } }[];
        statuses?: { id: string; status: string; recipient_id: string }[];
      };
    }[];
  }[];
}

export function parseWhatsAppWebhook(payload: unknown): NormalizedWebhookEvent[] {
  const body = payload as WaWebhook;
  if (body?.object !== 'whatsapp_business_account') return [];
  const events: NormalizedWebhookEvent[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages') continue;
      const v = change.value;
      const phoneId = v.metadata?.phone_number_id;
      if (!phoneId) continue;
      for (const m of v.messages ?? []) {
        const contact = v.contacts?.find((c) => c.wa_id === m.from);
        const text =
          m.text?.body ?? m.image?.caption ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? '';
        events.push({
          kind: 'message',
          eventKey: `WHATSAPP:msg:${m.id}`,
          platformAccountId: phoneId,
          platformConversationId: `${phoneId}:${m.from}`,
          contact: { platformUserId: m.from, name: contact?.profile?.name, phone: `+${m.from}` },
          message: {
            platformMessageId: m.id,
            text,
            attachments: m.type !== 'text' && m.type !== 'button' && m.type !== 'interactive' ? [{ type: m.type }] : [],
            createdAt: new Date(Number(m.timestamp) * 1000),
          },
          isEcho: false,
        });
      }
      for (const s of v.statuses ?? []) {
        events.push({ kind: 'status', eventKey: `WHATSAPP:status:${s.id}:${s.status}`, platformAccountId: phoneId, platformMessageId: s.id, status: s.status });
      }
    }
  }
  return events;
}
