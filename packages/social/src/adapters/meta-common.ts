import { hmacSha256, safeEqual } from '@socialpilot/auth';
import type { PlatformErrorInfo } from '../http';
import type { WebhookRequest } from '../types';

/**
 * Shared helpers for Meta platforms (Facebook, Instagram, WhatsApp).
 * Error codes: https://developers.facebook.com/docs/graph-api/guides/error-handling
 */
export function parseMetaError(status: number, body: unknown): PlatformErrorInfo {
  const err = (body as { error?: { message?: string; code?: number; error_subcode?: number; type?: string } } | null)?.error;
  if (!err) return {};
  const code = err.code ?? 0;
  const sub = err.error_subcode;
  const platformCode = sub ? `${code}/${sub}` : String(code);
  const message = `Meta API error ${platformCode}: ${err.message ?? 'unknown error'}`;
  if (code === 190) {
    return { code: sub === 463 ? 'TOKEN_EXPIRED' : 'UNAUTHORIZED', message, platformCode, requiresReauth: true, retryable: false };
  }
  if ([4, 17, 32, 613].includes(code) || (code >= 80001 && code <= 80014)) {
    return { code: 'RATE_LIMITED', message, platformCode, retryable: true };
  }
  if (code === 10 || (code >= 200 && code <= 299)) {
    return { code: 'INVALID_PERMISSIONS', message, platformCode, retryable: false, requiresReauth: true };
  }
  if (code === 1 || code === 2) return { code: 'UNAVAILABLE', message, platformCode, retryable: true };
  if (code === 100) return { code: 'VALIDATION', message, platformCode, retryable: false };
  if (code === 368) return { code: 'FORBIDDEN', message, platformCode, retryable: false };
  return { message, platformCode, retryable: status >= 500 };
}

function headerValue(headers: WebhookRequest['headers'], name: string): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/** Verifies X-Hub-Signature-256 (HMAC-SHA256 of the raw body with the app secret). */
export function verifyMetaSignature(req: WebhookRequest, appSecret: string | undefined): boolean {
  if (!appSecret) return false;
  const header = headerValue(req.headers, 'x-hub-signature-256');
  if (!header?.startsWith('sha256=')) return false;
  const expected = hmacSha256(appSecret, req.rawBody, 'hex');
  return safeEqual(header.slice('sha256='.length), expected);
}

/** Answers the GET subscription handshake (hub.mode / hub.verify_token / hub.challenge). */
export function metaChallenge(query: Record<string, string | undefined>, verifyToken: string | undefined): string | null {
  if (query['hub.mode'] !== 'subscribe' || !verifyToken) return null;
  const token = query['hub.verify_token'];
  if (!token || !safeEqual(token, verifyToken)) return null;
  return query['hub.challenge'] ?? null;
}

export const graphUrl = (version: string, path: string, host = 'graph.facebook.com') =>
  `https://${host}/${version}/${path.replace(/^\//, '')}`;
