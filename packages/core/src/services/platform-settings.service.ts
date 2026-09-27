import { decryptSecret, encryptSecret } from '@socialpilot/auth';
import type { Prisma } from '@socialpilot/database';
import { forbidden } from '../errors';
import { getInfra } from '../infra';
import { auditGlobal } from './audit.service';

/**
 * Platform-wide settings the operator enters in Platform admin (company details,
 * legal pages, email delivery, card payments). Each group is one PlatformSetting
 * row; secret fields are encrypted and never returned, only whether they're set.
 */

export interface CompanySettings {
  /** Product name shown to customers */
  productName: string;
  legalName: string | null;
  address: string | null;
  supportEmail: string | null;
  website: string | null;
  /** Country or state whose law governs the terms */
  jurisdiction: string | null;
}
export interface LegalSettings {
  /** Markdown; empty = the built-in template filled with company details */
  terms: string | null;
  privacy: string | null;
  /** ISO date shown as "Last updated" */
  updatedOn: string | null;
}
export interface EmailSettings {
  enabled: boolean;
  host: string | null;
  port: number;
  /** true = TLS from the start (port 465); false = STARTTLS when offered (587) */
  secure: boolean;
  user: string | null;
  password: string | null;
  fromName: string | null;
  fromEmail: string | null;
}
export interface StripeSettings {
  enabled: boolean;
  publishableKey: string | null;
  secretKey: string | null;
  webhookSecret: string | null;
}

interface Groups {
  company: CompanySettings;
  legal: LegalSettings;
  email: EmailSettings;
  stripe: StripeSettings;
}
type GroupKey = keyof Groups;

const DEFAULTS: Groups = {
  company: { productName: 'SocialPilot', legalName: null, address: null, supportEmail: null, website: null, jurisdiction: null },
  legal: { terms: null, privacy: null, updatedOn: null },
  email: { enabled: false, host: null, port: 587, secure: false, user: null, password: null, fromName: null, fromEmail: null },
  stripe: { enabled: false, publishableKey: null, secretKey: null, webhookSecret: null },
};
const SECRET_FIELDS: { [K in GroupKey]: (keyof Groups[K])[] } = {
  company: [],
  legal: [],
  email: ['password'],
  stripe: ['secretKey', 'webhookSecret'],
};

const TTL_MS = 30_000;
const cache = new Map<GroupKey, { expires: number; value: unknown }>();
const aad = (group: string, field: string) => `platform-settings:${group}:${field}`;

/** Full settings including decrypted secrets, for server-side use only. */
export async function getPlatformGroup<K extends GroupKey>(group: K): Promise<Groups[K]> {
  const hit = cache.get(group);
  if (hit && hit.expires > Date.now()) return hit.value as Groups[K];
  const { db, keyRing } = getInfra();
  const row = await db.platformSetting.findUnique({ where: { key: `group:${group}` } });
  const stored = (row?.value ?? {}) as Record<string, unknown>;
  const value = { ...DEFAULTS[group], ...stored } as Record<string, unknown>;
  for (const field of SECRET_FIELDS[group] as string[]) {
    const enc = stored[`${field}Enc`];
    value[field] = typeof enc === 'string' ? decryptSecret(keyRing, enc, aad(group, field)) : null;
    delete value[`${field}Enc`];
  }
  cache.set(group, { expires: Date.now() + TTL_MS, value });
  return value as unknown as Groups[K];
}

/** What the admin screen shows: secrets replaced by set/hint. */
export async function adminGetPlatformGroup<K extends GroupKey>(user: { isSuperAdmin: boolean }, group: K) {
  if (!user.isSuperAdmin) throw forbidden('Super admin only');
  const full = (await getPlatformGroup(group)) as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ...full };
  for (const field of SECRET_FIELDS[group] as string[]) {
    const v = full[field];
    out[field] = typeof v === 'string' && v ? { set: true, hint: `…${v.slice(-4)}` } : { set: false, hint: null };
  }
  return out;
}

/**
 * Saves a group. For secret fields: undefined keeps the stored value, null or ''
 * removes it, a string replaces it.
 */
export async function adminUpdatePlatformGroup<K extends GroupKey>(user: { id: string; isSuperAdmin: boolean }, group: K, input: Partial<Groups[K]>) {
  if (!user.isSuperAdmin) throw forbidden('Super admin only');
  const { db, keyRing } = getInfra();
  const row = await db.platformSetting.findUnique({ where: { key: `group:${group}` } });
  const stored = { ...((row?.value ?? {}) as Record<string, unknown>) };
  const secrets = SECRET_FIELDS[group] as string[];
  const changedSecrets: string[] = [];
  for (const [field, v] of Object.entries(input)) {
    if (v === undefined) continue;
    if (secrets.includes(field)) {
      changedSecrets.push(field);
      if (v === null || v === '') delete stored[`${field}Enc`];
      else stored[`${field}Enc`] = encryptSecret(keyRing, String(v), aad(group, field));
    } else {
      stored[field] = v;
    }
  }
  await db.platformSetting.upsert({ where: { key: `group:${group}` }, create: { key: `group:${group}`, value: stored as Prisma.InputJsonValue }, update: { value: stored as Prisma.InputJsonValue } });
  cache.delete(group);
  const safe = Object.fromEntries(Object.entries(input).filter(([k]) => !secrets.includes(k)));
  await auditGlobal({ action: `platform.${group}_settings_changed`, resourceType: 'PlatformSetting', resourceId: group, userId: user.id, after: { ...safe, secretsChanged: changedSecrets } });
  return adminGetPlatformGroup(user, group);
}

/** For tests and after restores. */
export function clearPlatformSettingsCache() {
  cache.clear();
}
