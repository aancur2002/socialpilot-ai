import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getPlatformCapabilities, PLATFORM_CAPABILITIES } from './capabilities';
import { SocialApiError } from './errors';
import { FacebookAdapter, parseFacebookWebhook } from './adapters/facebook';
import { parseInstagramWebhook } from './adapters/instagram';
import { parseMetaError, verifyMetaSignature, metaChallenge } from './adapters/meta-common';
import { parseWhatsAppWebhook, WhatsAppAdapter } from './adapters/whatsapp';
import { HttpClient } from './http';
import { MOCK_FAILURE_MARKERS, MockSocialAdapter, parseMockWebhook, signMockWebhook } from './mock/mock-adapter';
import { SocialAdapterRegistry } from './registry';
import type { MediaRef, SocialAccount } from './types';
import { composeCaption, validateContentForPlatform } from './validation';

const img = (over: Partial<MediaRef> = {}): MediaRef => ({ url: 'https://cdn.example/a.jpg', mimeType: 'image/jpeg', kind: 'IMAGE', size: 100_000, ...over });
const account: SocialAccount = { id: 'a1', platform: 'FACEBOOK', platformAccountId: 'page1', metadata: {}, credentials: { accessToken: 'tok' } };

describe('content validation', () => {
  it('requires media on Instagram and TikTok', () => {
    for (const p of ['INSTAGRAM', 'TIKTOK'] as const) {
      const issues = validateContentForPlatform(getPlatformCapabilities(p), { platform: p, caption: 'hi', hashtags: [], media: [] });
      expect(issues.map((i) => i.code)).toContain('MEDIA_REQUIRED');
    }
  });

  it('refuses publishing to WhatsApp (messaging only)', () => {
    const issues = validateContentForPlatform(getPlatformCapabilities('WHATSAPP'), { platform: 'WHATSAPP', caption: 'hi', hashtags: [], media: [] });
    expect(issues[0]!.code).toBe('PUBLISHING_UNSUPPORTED');
  });

  it('checks caption length including hashtags', () => {
    const caption = 'x'.repeat(2195);
    const issues = validateContentForPlatform(getPlatformCapabilities('INSTAGRAM'), { platform: 'INSTAGRAM', caption, hashtags: ['longtag'], media: [img()] });
    expect(issues.map((i) => i.code)).toContain('CAPTION_TOO_LONG');
  });

  it('checks media type, size and HTTPS reachability', () => {
    const codes = validateContentForPlatform(getPlatformCapabilities('INSTAGRAM'), {
      platform: 'INSTAGRAM',
      caption: 'hi',
      hashtags: [],
      media: [img({ mimeType: 'image/png' }), img({ size: 50 * 1024 * 1024 }), img({ url: 'http://localhost/a.jpg' })],
    }).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['MEDIA_TYPE_UNSUPPORTED', 'MEDIA_TOO_LARGE', 'MEDIA_NOT_PUBLIC']));
  });

  it('rejects video and carousels on LinkedIn (not implemented/unsupported)', () => {
    const codes = validateContentForPlatform(getPlatformCapabilities('LINKEDIN'), {
      platform: 'LINKEDIN',
      caption: 'hi',
      hashtags: [],
      media: [img(), { url: 'https://x/v.mp4', mimeType: 'video/mp4', kind: 'VIDEO', size: 1000 }],
    }).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['VIDEO_UNSUPPORTED', 'CAROUSEL_UNSUPPORTED']));
  });

  it('accepts a valid Facebook text post', () => {
    expect(validateContentForPlatform(getPlatformCapabilities('FACEBOOK'), { platform: 'FACEBOOK', caption: 'Hello', hashtags: ['news'], media: [] })).toEqual([]);
  });

  it('composes hashtags without duplicating ones already in the caption', () => {
    expect(composeCaption('Fresh bread #bakery', ['bakery', '#london'])).toBe('Fresh bread #bakery\n\n#london');
  });
});

describe('capability matrix', () => {
  it('marks future platforms as unimplemented', () => {
    for (const p of ['YOUTUBE', 'X', 'PINTEREST', 'GOOGLE_BUSINESS', 'THREADS'] as const) expect(PLATFORM_CAPABILITIES[p].publishing).toBe(false);
  });
  it('reflects official API limits', () => {
    expect(PLATFORM_CAPABILITIES.WHATSAPP.directMessages).toBe(true);
    expect(PLATFORM_CAPABILITIES.WHATSAPP.publishing).toBe(false);
    expect(PLATFORM_CAPABILITIES.LINKEDIN.directMessages).toBe(false);
    expect(PLATFORM_CAPABILITIES.TIKTOK.comments).toBe(false);
  });
});

describe('error normalization', () => {
  it('maps Meta error codes', () => {
    expect(parseMetaError(400, { error: { code: 190, error_subcode: 463, message: 'expired' } })).toMatchObject({ code: 'TOKEN_EXPIRED', requiresReauth: true });
    expect(parseMetaError(400, { error: { code: 4, message: 'rate' } })).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    expect(parseMetaError(403, { error: { code: 200, message: 'perm' } })).toMatchObject({ code: 'INVALID_PERMISSIONS' });
    expect(parseMetaError(400, { error: { code: 100, message: 'param' } })).toMatchObject({ code: 'VALIDATION', retryable: false });
  });

  const clientWith = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new HttpClient('FACEBOOK', parseMetaError, async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } }));

  it.each([
    [401, 'UNAUTHORIZED', false, true],
    [403, 'FORBIDDEN', false, false],
    [404, 'NOT_FOUND', false, false],
    [409, 'CONFLICT', false, false],
    [429, 'RATE_LIMITED', true, false],
    [500, 'SERVER_ERROR', true, false],
    [502, 'BAD_GATEWAY', true, false],
    [503, 'UNAVAILABLE', true, false],
  ] as const)('HTTP %i → %s (retryable=%s, reauth=%s)', async (status, code, retryable, reauth) => {
    const err = await clientWith(status, {}).get('https://graph.facebook.com/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SocialApiError);
    expect(err).toMatchObject({ code, retryable, requiresReauth: reauth, status });
  });

  it('parses Retry-After on 429', async () => {
    const err = (await clientWith(429, {}, { 'retry-after': '7' }).get('https://graph.facebook.com/x').catch((e: unknown) => e)) as SocialApiError;
    expect(err.retryAfterMs).toBe(7000);
  });

  it('normalizes network timeouts', async () => {
    const client = new HttpClient('LINKEDIN', undefined, async () => {
      const e = new Error('timed out');
      e.name = 'TimeoutError';
      throw e;
    });
    await expect(client.get('https://api.linkedin.com/x')).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true });
  });
});

describe('webhooks', () => {
  const secret = 'app-secret';
  const body = Buffer.from(JSON.stringify({ hello: 'world' }));
  const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

  it('verifies Meta X-Hub-Signature-256', () => {
    expect(verifyMetaSignature({ rawBody: body, headers: { 'x-hub-signature-256': sig }, query: {} }, secret)).toBe(true);
    expect(verifyMetaSignature({ rawBody: Buffer.from('tampered'), headers: { 'x-hub-signature-256': sig }, query: {} }, secret)).toBe(false);
    expect(verifyMetaSignature({ rawBody: body, headers: {}, query: {} }, secret)).toBe(false);
    expect(verifyMetaSignature({ rawBody: body, headers: { 'x-hub-signature-256': sig }, query: {} }, undefined)).toBe(false);
  });

  it('answers the subscription challenge only with the right token', () => {
    expect(metaChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'tok', 'hub.challenge': '123' }, 'tok')).toBe('123');
    expect(metaChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'bad', 'hub.challenge': '123' }, 'tok')).toBeNull();
  });

  it('normalizes Facebook messages, echoes and comments', () => {
    const events = parseFacebookWebhook({
      object: 'page',
      entry: [
        {
          id: 'PAGE',
          messaging: [
            { sender: { id: 'U1' }, recipient: { id: 'PAGE' }, timestamp: 1700000000000, message: { mid: 'm1', text: 'hi' } },
            { sender: { id: 'PAGE' }, recipient: { id: 'U1' }, timestamp: 1700000000001, message: { mid: 'm2', text: 'hello', is_echo: true } },
          ],
          changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'c1', post_id: 'PAGE_1', message: 'nice', from: { id: 'U2', name: 'Ann' }, created_time: 1700000000 } }],
        },
      ],
    });
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ kind: 'message', platformConversationId: 'PAGE:U1', isEcho: false });
    expect(events[1]).toMatchObject({ kind: 'message', platformConversationId: 'PAGE:U1', isEcho: true });
    expect(events[2]).toMatchObject({ kind: 'comment', eventKey: 'FACEBOOK:comment:c1' });
  });

  it('normalizes Instagram comments and WhatsApp messages/statuses', () => {
    const ig = parseInstagramWebhook({ object: 'instagram', entry: [{ id: 'IG', changes: [{ field: 'comments', value: { id: 'c9', text: 'price?', from: { id: 'U', username: 'ann' }, media: { id: 'M1' } } }] }] });
    expect(ig[0]).toMatchObject({ kind: 'comment', comment: { platformPostId: 'M1', text: 'price?' } });
    const wa = parseWhatsAppWebhook({
      object: 'whatsapp_business_account',
      entry: [{ id: 'W', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'P1' }, contacts: [{ wa_id: '447', profile: { name: 'Bob' } }], messages: [{ from: '447', id: 'wamid.1', timestamp: '1700000000', type: 'text', text: { body: 'open?' } }], statuses: [{ id: 'wamid.0', status: 'delivered', recipient_id: '447' }] } }] }],
    });
    expect(wa[0]).toMatchObject({ kind: 'message', platformAccountId: 'P1', contact: { name: 'Bob', phone: '+447' }, message: { text: 'open?' } });
    expect(wa[1]).toMatchObject({ kind: 'status', status: 'delivered' });
  });

  it('keeps the media id of a WhatsApp voice note so it can be downloaded and transcribed', () => {
    const [event] = parseWhatsAppWebhook({
      object: 'whatsapp_business_account',
      entry: [{ id: 'W', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'P1' }, messages: [{ from: '447', id: 'wamid.2', timestamp: '1700000000', type: 'audio', audio: { id: 'MEDIA1', mime_type: 'audio/ogg; codecs=opus', voice: true } }] } }] }],
    });
    expect(event).toMatchObject({ kind: 'message', message: { text: '', attachments: [{ type: 'audio', mediaId: 'MEDIA1', mimeType: 'audio/ogg; codecs=opus' }] } });
  });

  it('ignores payloads for other objects', () => {
    expect(parseFacebookWebhook({ object: 'instagram', entry: [] })).toEqual([]);
    expect(parseWhatsAppWebhook(null)).toEqual([]);
  });
});

describe('adapters never fake unsupported functionality', () => {
  it('throws UNSUPPORTED for WhatsApp publishing', async () => {
    const wa = new WhatsAppAdapter({ clientId: 'x', clientSecret: 'y', graphVersion: 'v23.0' });
    await expect(wa.publishPost({ ...account, platform: 'WHATSAPP' }, { text: 'x', hashtags: [], media: [], idempotencyKey: 'k' })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('reports NOT_CONFIGURED without credentials', async () => {
    const fb = new FacebookAdapter({ graphVersion: 'v23.0' });
    expect(fb.isConfigured()).toBe(false);
    await expect(fb.getAuthorizationUrl({ state: 's', redirectUri: 'https://x/cb' })).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });

  it('never marks a real integration verified', () => {
    const reg = new SocialAdapterRegistry({
      mockEnabled: false,
      apiUrl: 'http://localhost:4000',
      mockWebhookSecret: 's',
      metaGraphVersion: 'v23.0',
      facebook: { clientId: 'a', clientSecret: 'b' },
      instagram: {},
      whatsapp: {},
      linkedin: { apiVersion: '202509' },
      tiktok: {},
    });
    const fb = reg.statuses().find((s) => s.platform === 'FACEBOOK')!;
    expect(fb.configured).toBe(true);
    expect(fb.verification).toBe('UNVERIFIED');
    expect(() => reg.mock('FACEBOOK')).toThrow(/disabled/);
  });
});

describe('mock adapter', () => {
  const mock = new MockSocialAdapter('INSTAGRAM', { apiUrl: 'http://localhost:4000', webhookSecret: 'secret' });
  const igAccount = { ...account, platform: 'INSTAGRAM' as const };

  it('is clearly marked and returns mock-prefixed ids', async () => {
    expect(mock.isMock).toBe(true);
    expect(mock.getCapabilities().notes[0]).toMatch(/MockInstagram/);
    const res = await mock.publishPost(igAccount, { text: 'hi', hashtags: [], media: [img()], idempotencyKey: 'k1' });
    expect(res.platformPostId).toMatch(/^mock_instagram_post_/);
  });

  it('enforces the same capability rules as the real platform', async () => {
    await expect(mock.publishPost(igAccount, { text: 'hi', hashtags: [], media: [], idempotencyKey: 'k' })).rejects.toMatchObject({ code: 'VALIDATION' });
    const li = new MockSocialAdapter('LINKEDIN', { apiUrl: 'http://x', webhookSecret: 's' });
    await expect(li.sendMessage({ ...account, platform: 'LINKEDIN' }, { platformConversationId: 'c', recipientPlatformUserId: 'u', text: 'x' })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('injects failures for testing retries', async () => {
    const post = (marker: string) => mock.publishPost(igAccount, { text: `hi ${marker}`, hashtags: [], media: [img()], idempotencyKey: 'k' });
    await expect(post(MOCK_FAILURE_MARKERS.transient)).rejects.toMatchObject({ code: 'SERVER_ERROR', retryable: true });
    await expect(post(MOCK_FAILURE_MARKERS.permanent)).rejects.toMatchObject({ code: 'VALIDATION', retryable: false });
    await expect(post(MOCK_FAILURE_MARKERS.auth)).rejects.toMatchObject({ requiresReauth: true });
  });

  it('verifies signed simulated webhooks', () => {
    const raw = Buffer.from(JSON.stringify({ events: [] }));
    expect(mock.verifyWebhookSignature({ rawBody: raw, headers: { 'x-mock-signature': signMockWebhook('secret', raw) }, query: {} })).toBe(true);
    expect(mock.verifyWebhookSignature({ rawBody: raw, headers: { 'x-mock-signature': signMockWebhook('other', raw) }, query: {} })).toBe(false);
    expect(parseMockWebhook('INSTAGRAM', { events: [{ type: 'message', id: '1', accountId: 'A', from: { id: 'U' }, text: 'hi' }] })[0]).toMatchObject({ kind: 'message', platformConversationId: 'A:U' });
  });
});
