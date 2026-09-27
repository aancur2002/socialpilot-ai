'use client';

/** Browser API client. Requests go to /api/v1 on this origin (proxied to the API). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const ORG_KEY = 'sp.currentOrg';

export function getCurrentOrg(): string | null {
  try {
    return localStorage.getItem(ORG_KEY);
  } catch {
    return null;
  }
}

export function setCurrentOrg(id: string | null) {
  try {
    if (id) localStorage.setItem(ORG_KEY, id);
    else localStorage.removeItem(ORG_KEY);
  } catch {
    /* storage unavailable (private mode) — org falls back to the first membership */
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; query?: Query; form?: FormData } = {}): Promise<T> {
  const url = new URL(`/api/v1${path}`, window.location.origin);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const headers: Record<string, string> = {};
  const org = getCurrentOrg();
  if (org) headers['x-organization-id'] = org;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body, credentials: 'same-origin' });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: unknown } }).error;
    throw new ApiError(res.status, err?.code ?? 'ERROR', err?.message ?? `Request failed (${res.status})`, err?.details);
  }
  return data as T;
}

/** Human-readable message for any thrown error, including field-level validation details. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'VALIDATION_ERROR' && Array.isArray(error.details)) {
      return `${error.message}: ${(error.details as { path: string; message: string }[]).map((d) => `${d.path || 'value'} ${d.message.toLowerCase()}`).join('; ')}`;
    }
    const variants = (error.details as { variants?: { platform: string; issues: string[] }[] } | undefined)?.variants;
    if (variants) return `${error.message}. ${variants.map((v) => `${v.platform}: ${v.issues.join(' ')}`).join(' ')}`;
    return error.message;
  }
  return error instanceof Error ? error.message : 'Something went wrong';
}

/** Downloads a file from the API (sends the organization header a plain link can't). */
export async function downloadFile(path: string, query: Query, filename: string): Promise<void> {
  const url = new URL(`/api/v1${path}`, window.location.origin);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const org = getCurrentOrg();
  const res = await fetch(url, { headers: org ? { 'x-organization-id': org } : {}, credentials: 'same-origin' });
  if (!res.ok) {
    const err = ((await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } }).error;
    throw new ApiError(res.status, err?.code ?? 'ERROR', err?.message ?? `Download failed (${res.status})`);
  }
  const href = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}
