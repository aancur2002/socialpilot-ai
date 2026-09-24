import { codeForStatus, parseRetryAfter, SocialApiError, type SocialErrorCode } from './errors';
import type { PlatformKey } from './types';

export interface PlatformErrorInfo {
  code?: SocialErrorCode;
  message?: string;
  platformCode?: string;
  retryable?: boolean;
  requiresReauth?: boolean;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  /** JSON body (object) or pre-encoded body */
  json?: unknown;
  form?: Record<string, string>;
  body?: BodyInit;
  query?: Record<string, string | number | boolean | undefined>;
  timeoutMs?: number;
}

export type ErrorParser = (status: number, body: unknown) => PlatformErrorInfo;

/**
 * Thin fetch wrapper for platform APIs: timeouts, normalized errors, and
 * redaction (URLs are logged without query strings so tokens never leak).
 */
export class HttpClient {
  constructor(
    private readonly platform: PlatformKey,
    private readonly parseError: ErrorParser = () => ({}),
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  async request<T = unknown>(url: string, options: RequestOptions = {}): Promise<{ data: T; headers: Headers; status: number }> {
    const target = new URL(url);
    for (const [k, v] of Object.entries(options.query ?? {})) {
      if (v !== undefined) target.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
    let body: BodyInit | undefined = options.body;
    if (options.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.json);
    } else if (options.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(options.form).toString();
    }

    let res: Response;
    try {
      res = await this.fetchImpl(target, {
        method: options.method ?? (body ? 'POST' : 'GET'),
        headers,
        body,
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
    } catch (err) {
      const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new SocialApiError({
        platform: this.platform,
        code: isTimeout ? 'TIMEOUT' : 'NETWORK',
        message: `${isTimeout ? 'Timed out' : 'Network error'} calling ${target.origin}${target.pathname}`,
      });
    }

    const text = await res.text();
    let data: unknown = text;
    if (text && (res.headers.get('content-type') ?? '').includes('json')) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (!res.ok) {
      const info = this.parseError(res.status, data);
      const code = info.code ?? codeForStatus(res.status);
      throw new SocialApiError({
        platform: this.platform,
        code,
        status: res.status,
        message: info.message ?? `${this.platform} API returned HTTP ${res.status} for ${target.pathname}`,
        platformCode: info.platformCode,
        retryable: info.retryable,
        requiresReauth: info.requiresReauth,
        retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
      });
    }
    return { data: data as T, headers: res.headers, status: res.status };
  }

  async get<T = unknown>(url: string, options: Omit<RequestOptions, 'method'> = {}): Promise<T> {
    return (await this.request<T>(url, { ...options, method: 'GET' })).data;
  }

  async post<T = unknown>(url: string, options: Omit<RequestOptions, 'method'> = {}): Promise<T> {
    return (await this.request<T>(url, { ...options, method: 'POST' })).data;
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
