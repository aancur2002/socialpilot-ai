import type { PlatformKey } from './types';

export type SocialErrorCode =
  | 'UNAUTHORIZED'
  | 'TOKEN_EXPIRED'
  | 'FORBIDDEN'
  | 'INVALID_PERMISSIONS'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'VALIDATION'
  | 'SERVER_ERROR'
  | 'BAD_GATEWAY'
  | 'UNAVAILABLE'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'UNSUPPORTED'
  | 'NOT_CONFIGURED'
  | 'UNKNOWN';

/** Normalized error for every external platform call. */
export class SocialApiError extends Error {
  readonly platform: PlatformKey;
  readonly code: SocialErrorCode;
  readonly status?: number;
  readonly retryable: boolean;
  readonly requiresReauth: boolean;
  readonly retryAfterMs?: number;
  /** Platform-specific error code/subcode, safe to log (never contains tokens). */
  readonly platformCode?: string;

  constructor(init: {
    platform: PlatformKey;
    code: SocialErrorCode;
    message: string;
    status?: number;
    retryable?: boolean;
    requiresReauth?: boolean;
    retryAfterMs?: number;
    platformCode?: string;
  }) {
    super(init.message);
    this.name = 'SocialApiError';
    this.platform = init.platform;
    this.code = init.code;
    this.status = init.status;
    this.retryable = init.retryable ?? DEFAULT_RETRYABLE[init.code];
    this.requiresReauth = init.requiresReauth ?? (init.code === 'UNAUTHORIZED' || init.code === 'TOKEN_EXPIRED');
    this.retryAfterMs = init.retryAfterMs;
    this.platformCode = init.platformCode;
  }

  toJSON() {
    return {
      platform: this.platform,
      code: this.code,
      message: this.message,
      status: this.status,
      retryable: this.retryable,
      requiresReauth: this.requiresReauth,
      retryAfterMs: this.retryAfterMs,
      platformCode: this.platformCode,
    };
  }
}

const DEFAULT_RETRYABLE: Record<SocialErrorCode, boolean> = {
  UNAUTHORIZED: false,
  TOKEN_EXPIRED: false,
  FORBIDDEN: false,
  INVALID_PERMISSIONS: false,
  NOT_FOUND: false,
  CONFLICT: false,
  RATE_LIMITED: true,
  VALIDATION: false,
  SERVER_ERROR: true,
  BAD_GATEWAY: true,
  UNAVAILABLE: true,
  TIMEOUT: true,
  NETWORK: true,
  UNSUPPORTED: false,
  NOT_CONFIGURED: false,
  UNKNOWN: false,
};

export function isSocialApiError(e: unknown): e is SocialApiError {
  return e instanceof SocialApiError;
}

/** Parses a Retry-After header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/** Maps an HTTP status to a normalized error code. */
export function codeForStatus(status: number): SocialErrorCode {
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 400 || status === 422) return 'VALIDATION';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 502) return 'BAD_GATEWAY';
  if (status === 503 || status === 504) return 'UNAVAILABLE';
  if (status >= 500) return 'SERVER_ERROR';
  return 'UNKNOWN';
}

export function unsupported(platform: PlatformKey, operation: string): SocialApiError {
  return new SocialApiError({
    platform,
    code: 'UNSUPPORTED',
    message: `${operation} is not supported by the official ${platform} API`,
  });
}

export function notConfigured(platform: PlatformKey, missing: string[]): SocialApiError {
  return new SocialApiError({
    platform,
    code: 'NOT_CONFIGURED',
    message: `${platform} integration is not configured. Missing: ${missing.join(', ')}. See docs/integrations/${platform.toLowerCase()}.md`,
  });
}
