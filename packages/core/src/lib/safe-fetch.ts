import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF-safe fetch for user-supplied URLs (website knowledge sources).
 * Only http(s) on standard ports, every hop's resolved address must be public,
 * redirects are followed manually and re-validated, and the body size is capped.
 */
function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::1' || v6 === '::') return true;
  if (v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80')) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  return mapped ? isPrivateAddress(mapped[1]!) : false;
}

export class UnsafeUrlError extends Error {}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError('Invalid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UnsafeUrlError('Only http and https URLs are allowed');
  if (url.port && url.port !== '80' && url.port !== '443') throw new UnsafeUrlError('Only standard ports are allowed');
  if (url.username || url.password) throw new UnsafeUrlError('Credentials in URLs are not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true }).catch(() => []);
  if (!addresses.length) throw new UnsafeUrlError('Hostname could not be resolved');
  if (addresses.some((a) => isPrivateAddress(a.address))) throw new UnsafeUrlError('URL resolves to a private or reserved address');
  return url;
}

export async function safeFetchText(raw: string, opts: { maxBytes?: number; timeoutMs?: number } = {}): Promise<{ text: string; contentType: string; finalUrl: string }> {
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  let current = raw;
  for (let hop = 0; hop < 4; hop++) {
    const url = await assertPublicUrl(current);
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000), headers: { 'user-agent': 'SocialPilotBot/1.0 (+knowledge-import)' } });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new UnsafeUrlError('Redirect without location');
      current = new URL(location, url).toString();
      continue;
    }
    if (!res.ok) throw new Error(`Fetching ${url.hostname} failed with HTTP ${res.status}`);
    const reader = res.body?.getReader();
    if (!reader) return { text: '', contentType: res.headers.get('content-type') ?? '', finalUrl: url.toString() };
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
    return { text: Buffer.concat(chunks).toString('utf8'), contentType: res.headers.get('content-type') ?? '', finalUrl: url.toString() };
  }
  throw new UnsafeUrlError('Too many redirects');
}
