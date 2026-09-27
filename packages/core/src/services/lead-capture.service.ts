import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { decryptSecret, encryptSecret, sha256 } from '@socialpilot/auth';
import type { Lead, LeadForm, Prisma } from '@socialpilot/database';
import { assertClientAccess, requirePermission, tenantWhere, type AuthContext } from '../context';
import { AppError, badRequest, notFound } from '../errors';
import { getInfra } from '../infra';
import { assertPublicUrl, UnsafeUrlError } from '../lib/safe-fetch';
import { assertOrganizationAccess } from './billing.service';
import { audit } from './audit.service';
import { runAutomationForEvent } from './automation.service';
import { getClient } from './client.service';
import { sendEmail } from './email.service';
import { notifyClientMembers } from './notification.service';
import { getPlatformGroup } from './platform-settings.service';

/**
 * Lead capture from outside the app: website forms (embed or hosted page), an
 * inbound API for tools like Zapier/Make or a website backend, and outgoing
 * webhooks that push leads to other systems. Every lead lands in the CRM.
 */

export interface FormField {
  key: string;
  label: string;
  type: 'text' | 'email' | 'phone' | 'textarea' | 'select';
  required: boolean;
  options?: string[];
}

/** Field keys stored in their own lead columns; anything else goes to customFields. */
const STANDARD_KEYS = ['name', 'email', 'phone', 'company', 'message'] as const;
type StandardKey = (typeof STANDARD_KEYS)[number];

export const DEFAULT_FORM_FIELDS: FormField[] = [
  { key: 'name', label: 'Name', type: 'text', required: true },
  { key: 'email', label: 'Email', type: 'email', required: true },
  { key: 'phone', label: 'Phone', type: 'phone', required: false },
  { key: 'message', label: 'How can we help?', type: 'textarea', required: false },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[+()\-\s.\d]{6,25}$/;

// ── Captured lead (shared by forms and the API) ───────────────────────

interface CapturedLead {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  message?: string | null;
  customFields?: Record<string, string>;
  pageUrl?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  tags?: string[];
  value?: number | null;
}

const clip = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);

/**
 * Creates the lead, or, when an open lead with the same email or phone already
 * exists for the client, adds the new submission to it as a note.
 */
async function captureLead(organizationId: string, clientId: string, source: string, data: CapturedLead, opts: { formId?: string; notifyEmails?: string[]; formName?: string } = {}) {
  const { db } = getInfra();
  const email = data.email?.toLowerCase() ?? null;
  const duplicate = email || data.phone
    ? await db.lead.findFirst({
        where: { organizationId, clientId, status: { notIn: ['WON', 'LOST'] }, OR: [...(email ? [{ email }] : []), ...(data.phone ? [{ phone: data.phone }] : [])] },
        orderBy: { createdAt: 'desc' },
      })
    : null;

  const summary = [data.message, ...Object.entries(data.customFields ?? {}).map(([k, v]) => `${k}: ${v}`)].filter(Boolean).join('\n');
  let lead: Lead;
  let event: 'lead.created' | 'lead.updated';
  if (duplicate) {
    lead = await db.lead.update({
      where: { id: duplicate.id },
      data: {
        name: duplicate.name ?? data.name ?? null,
        phone: duplicate.phone ?? data.phone ?? null,
        email: duplicate.email ?? email,
        company: duplicate.company ?? data.company ?? null,
        tags: [...new Set([...duplicate.tags, ...(data.tags ?? [])])],
      },
    });
    await db.leadNote.create({ data: { leadId: lead.id, authorId: 'system', body: `New ${opts.formName ? `submission of "${opts.formName}"` : `lead from ${source}`}${summary ? `:\n${summary}` : ''}` } });
    event = 'lead.updated';
  } else {
    lead = await db.lead.create({
      data: {
        organizationId,
        clientId,
        source,
        name: data.name ?? null,
        email,
        phone: data.phone ?? null,
        company: data.company ?? null,
        message: data.message ?? null,
        interest: clip(data.message, 200),
        customFields: (data.customFields ?? {}) as Prisma.InputJsonValue,
        pageUrl: data.pageUrl ?? null,
        utmSource: data.utmSource ?? null,
        utmMedium: data.utmMedium ?? null,
        utmCampaign: data.utmCampaign ?? null,
        tags: data.tags ?? [],
        value: data.value ?? null,
        formId: opts.formId ?? null,
        status: 'NEW',
      },
    });
    event = 'lead.created';
  }

  const client = await db.client.findUniqueOrThrow({ where: { id: clientId }, select: { name: true } });
  const who = data.name || email || data.phone || 'Someone';
  await notifyClientMembers(organizationId, clientId, 'leads:view', {
    type: 'NEW_LEAD',
    title: duplicate ? `${who} got in touch again (${client.name})` : `New lead for ${client.name}: ${who}`,
    body: summary ? summary.slice(0, 300) : undefined,
    link: `/leads/${lead.id}`,
    data: { leadId: lead.id, source },
  });
  if (opts.notifyEmails?.length) {
    const { env } = getInfra();
    const lines = [`Name: ${data.name ?? '—'}`, `Email: ${email ?? '—'}`, `Phone: ${data.phone ?? '—'}`, ...(data.company ? [`Company: ${data.company}`] : []), ...(summary ? ['', summary] : [])];
    await sendEmail({
      to: opts.notifyEmails,
      subject: `${duplicate ? 'Returning' : 'New'} lead for ${client.name}: ${who}`,
      text: `${lines.join('\n')}\n\nOpen in the CRM: ${env.APP_URL}/leads/${lead.id}`,
      replyTo: email ?? undefined,
    }).catch((error) => getInfra().logger.warn({ error: error instanceof Error ? error.message : String(error), leadId: lead.id }, 'lead notification email failed'));
  }
  if (!duplicate) {
    // Website and API leads run the same automation rules as leads found in the inbox.
    await runAutomationForEvent({ trigger: 'LEAD_CREATED', organizationId, clientId, resourceType: 'Lead', resourceId: lead.id, facts: { leadDetected: true, text: data.message ?? undefined } }).catch((error) =>
      getInfra().logger.warn({ error: error instanceof Error ? error.message : String(error), leadId: lead.id }, 'automation for captured lead failed'),
    );
  }
  await emitLeadEvent(organizationId, clientId, event, lead.id);
  return { lead, duplicate: Boolean(duplicate) };
}

// ── Forms (managed in the app) ────────────────────────────────────────

function publicKey() {
  return `lf_${randomBytes(12).toString('base64url')}`;
}

function normalizeFields(fields: FormField[]): FormField[] {
  const seen = new Set<string>();
  const out = fields.map((f) => {
    const key = f.key.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40) || 'field';
    if (seen.has(key)) throw badRequest(`Two fields use the key "${key}"`);
    seen.add(key);
    if (f.type === 'select' && !f.options?.length) throw badRequest(`"${f.label}" needs at least one option`);
    return { ...f, key, label: f.label.trim().slice(0, 80), options: f.type === 'select' ? f.options!.map((o) => o.trim()).filter(Boolean).slice(0, 30) : undefined };
  });
  if (!out.some((f) => f.key === 'email' || f.key === 'phone')) throw badRequest('Add an email or phone field so you can reach the lead');
  return out;
}

const normalizeDomain = (d: string) => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');

type FormInput = {
  clientId: string; name: string; title?: string | null; description?: string | null; fields: FormField[]; submitLabel?: string; successMessage?: string;
  redirectUrl?: string | null; allowedDomains?: string[]; notifyEmails?: string[]; accentColor?: string; active?: boolean;
};

export async function listLeadForms(ctx: AuthContext, clientId?: string) {
  requirePermission(ctx, 'leads:view');
  if (clientId) assertClientAccess(ctx, clientId);
  return getInfra().db.leadForm.findMany({
    where: tenantWhere(ctx, clientId),
    orderBy: { createdAt: 'desc' },
    include: { client: { select: { id: true, name: true } } },
  });
}

export async function getLeadForm(ctx: AuthContext, id: string) {
  requirePermission(ctx, 'leads:view');
  const form = await getInfra().db.leadForm.findFirst({ where: { id, organizationId: ctx.organizationId }, include: { client: { select: { id: true, name: true } } } });
  if (!form) throw notFound('Form');
  assertClientAccess(ctx, form.clientId);
  return form;
}

export async function createLeadForm(ctx: AuthContext, input: FormInput) {
  requirePermission(ctx, 'leads:manage');
  await getClient(ctx, input.clientId);
  const form = await getInfra().db.leadForm.create({
    data: {
      organizationId: ctx.organizationId,
      clientId: input.clientId,
      name: input.name,
      publicKey: publicKey(),
      title: input.title ?? null,
      description: input.description ?? null,
      fields: normalizeFields(input.fields) as unknown as Prisma.InputJsonValue,
      submitLabel: input.submitLabel ?? 'Send',
      successMessage: input.successMessage ?? "Thanks! We'll be in touch soon.",
      redirectUrl: input.redirectUrl ?? null,
      allowedDomains: (input.allowedDomains ?? []).map(normalizeDomain).filter(Boolean),
      notifyEmails: input.notifyEmails ?? [],
      accentColor: input.accentColor ?? '#0f766e',
      active: input.active ?? true,
      createdById: ctx.userId,
    },
  });
  await audit(ctx, { action: 'lead_form.created', resourceType: 'LeadForm', resourceId: form.id, clientId: form.clientId, after: { name: form.name } });
  return getLeadForm(ctx, form.id);
}

export async function updateLeadForm(ctx: AuthContext, id: string, input: Partial<Omit<FormInput, 'clientId'>>) {
  requirePermission(ctx, 'leads:manage');
  await getLeadForm(ctx, id);
  const data: Prisma.LeadFormUpdateInput = {};
  for (const k of ['name', 'title', 'description', 'submitLabel', 'successMessage', 'redirectUrl', 'notifyEmails', 'accentColor', 'active'] as const) {
    if (input[k] !== undefined) (data as Record<string, unknown>)[k] = input[k];
  }
  if (input.fields) data.fields = normalizeFields(input.fields) as unknown as Prisma.InputJsonValue;
  if (input.allowedDomains) data.allowedDomains = input.allowedDomains.map(normalizeDomain).filter(Boolean);
  await getInfra().db.leadForm.update({ where: { id }, data });
  await audit(ctx, { action: 'lead_form.updated', resourceType: 'LeadForm', resourceId: id, after: input });
  return getLeadForm(ctx, id);
}

export async function deleteLeadForm(ctx: AuthContext, id: string) {
  requirePermission(ctx, 'leads:manage');
  const form = await getLeadForm(ctx, id);
  await getInfra().db.leadForm.delete({ where: { id } });
  await audit(ctx, { action: 'lead_form.deleted', resourceType: 'LeadForm', resourceId: id, clientId: form.clientId, before: { name: form.name } });
}

// ── Public form endpoints (no sign-in) ────────────────────────────────

async function activeForm(key: string): Promise<LeadForm> {
  const form = await getInfra().db.leadForm.findUnique({ where: { publicKey: key } });
  if (!form || !form.active) throw notFound('Form');
  return form;
}

/** What the embed script and hosted page need to render the form. */
export async function publicFormConfig(key: string) {
  const form = await activeForm(key);
  const { db } = getInfra();
  const client = await db.client.findUniqueOrThrow({ where: { id: form.clientId }, select: { name: true } });
  const company = await getPlatformGroup('company');
  return {
    key: form.publicKey,
    title: form.title ?? `Contact ${client.name}`,
    description: form.description,
    businessName: client.name,
    fields: form.fields as unknown as FormField[],
    submitLabel: form.submitLabel,
    successMessage: form.successMessage,
    redirectUrl: form.redirectUrl,
    accentColor: form.accentColor,
    poweredBy: company.productName,
  };
}

/** Is this Origin/Referer allowed to submit? The hosted page on our own domain always is. */
export function originAllowed(allowedDomains: string[], origin: string | undefined, appUrl: string): boolean {
  if (!allowedDomains.length) return true;
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return false;
  }
  if (host === new URL(appUrl).hostname.toLowerCase().replace(/^www\./, '')) return true;
  return allowedDomains.some((d) => host === d || host.endsWith(`.${d}`));
}

async function rateLimited(key: string, max: number, windowSec: number): Promise<boolean> {
  const { redis } = getInfra();
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, windowSec);
  return n > max;
}

export async function submitLeadForm(key: string, body: Record<string, unknown>, meta: { ip?: string; origin?: string }) {
  const form = await activeForm(key);
  const { env } = getInfra();
  if (!originAllowed(form.allowedDomains, meta.origin, env.APP_URL)) throw new AppError('FORBIDDEN', 'This form is not allowed on this website');
  // Honeypot: a hidden field people never fill. Pretend success so bots learn nothing.
  if (typeof body.website === 'string' && body.website.trim()) return { ok: true, message: form.successMessage, redirectUrl: form.redirectUrl };
  if (await rateLimited(`socialpilot:rl:form:${form.id}:${meta.ip ?? 'unknown'}`, 5, 600)) throw new AppError('RATE_LIMITED', 'Too many submissions. Please try again in a few minutes.');
  await assertOrganizationAccess(form.organizationId).catch(() => {
    throw new AppError('FORBIDDEN', 'This form is not accepting submissions right now');
  });

  const fields = form.fields as unknown as FormField[];
  const values = (typeof body.fields === 'object' && body.fields ? body.fields : body) as Record<string, unknown>;
  const errors: { path: string; message: string }[] = [];
  const std: Partial<Record<StandardKey, string>> = {};
  const custom: Record<string, string> = {};
  for (const f of fields) {
    const raw = clip(values[f.key], f.type === 'textarea' ? 5000 : 300);
    if (!raw) {
      if (f.required) errors.push({ path: f.key, message: `${f.label} is required` });
      continue;
    }
    if (f.type === 'email' && !EMAIL_RE.test(raw)) errors.push({ path: f.key, message: 'Enter a valid email address' });
    else if (f.type === 'phone' && !PHONE_RE.test(raw)) errors.push({ path: f.key, message: 'Enter a valid phone number' });
    else if (f.type === 'select' && !f.options?.includes(raw)) errors.push({ path: f.key, message: `Choose one of the ${f.label} options` });
    else if ((STANDARD_KEYS as readonly string[]).includes(f.key)) std[f.key as StandardKey] = raw;
    else custom[f.label] = raw;
  }
  if (errors.length) throw new AppError('VALIDATION_ERROR', 'Please check the highlighted fields', errors);

  const { lead } = await captureLead(
    form.organizationId,
    form.clientId,
    'website_form',
    { ...std, customFields: custom, pageUrl: clip(body.pageUrl, 500), utmSource: clip(body.utm_source, 100), utmMedium: clip(body.utm_medium, 100), utmCampaign: clip(body.utm_campaign, 150) },
    { formId: form.id, notifyEmails: form.notifyEmails, formName: form.name },
  );
  await getInfra().db.leadForm.update({ where: { id: form.id }, data: { submissions: { increment: 1 } } });
  return { ok: true, message: form.successMessage, redirectUrl: form.redirectUrl, leadId: lead.id };
}

// ── Inbound lead API (Zapier, Make, website backends) ─────────────────

export async function listLeadApiKeys(ctx: AuthContext) {
  requirePermission(ctx, 'leads:manage');
  return getInfra().db.leadApiKey.findMany({
    where: { ...tenantWhere(ctx), revokedAt: null },
    select: { id: true, name: true, prefix: true, clientId: true, lastUsedAt: true, createdAt: true, client: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  });
}

/** Returns the full key once; only its hash is stored. */
export async function createLeadApiKey(ctx: AuthContext, input: { clientId: string; name: string }) {
  requirePermission(ctx, 'leads:manage');
  await getClient(ctx, input.clientId);
  const key = `spk_${randomBytes(24).toString('base64url')}`;
  const row = await getInfra().db.leadApiKey.create({ data: { organizationId: ctx.organizationId, clientId: input.clientId, name: input.name, keyHash: sha256(key), prefix: key.slice(0, 10), createdById: ctx.userId } });
  await audit(ctx, { action: 'lead_api_key.created', resourceType: 'LeadApiKey', resourceId: row.id, clientId: input.clientId, after: { name: input.name } });
  return { id: row.id, name: row.name, prefix: row.prefix, key };
}

export async function revokeLeadApiKey(ctx: AuthContext, id: string) {
  requirePermission(ctx, 'leads:manage');
  const row = await getInfra().db.leadApiKey.findFirst({ where: { id, organizationId: ctx.organizationId, revokedAt: null } });
  if (!row) throw notFound('API key');
  assertClientAccess(ctx, row.clientId);
  await getInfra().db.leadApiKey.update({ where: { id }, data: { revokedAt: new Date() } });
  await audit(ctx, { action: 'lead_api_key.revoked', resourceType: 'LeadApiKey', resourceId: id, clientId: row.clientId });
}

export async function ingestLeadViaApi(key: string | undefined, body: Record<string, unknown>) {
  if (!key) throw new AppError('UNAUTHENTICATED', 'Send the API key in the Authorization header: Bearer spk_…');
  const { db } = getInfra();
  const row = await db.leadApiKey.findUnique({ where: { keyHash: sha256(key) } });
  if (!row || row.revokedAt) throw new AppError('UNAUTHENTICATED', 'Invalid or revoked API key');
  if (await rateLimited(`socialpilot:rl:leadapi:${row.id}`, 120, 60)) throw new AppError('RATE_LIMITED', 'Too many requests; at most 120 leads a minute per key');
  await assertOrganizationAccess(row.organizationId);

  const email = clip(body.email, 200);
  const phone = clip(body.phone, 30);
  const errors: { path: string; message: string }[] = [];
  if (!email && !phone) errors.push({ path: 'email', message: 'Send an email or phone' });
  if (email && !EMAIL_RE.test(email)) errors.push({ path: 'email', message: 'Invalid email' });
  if (phone && !PHONE_RE.test(phone)) errors.push({ path: 'phone', message: 'Invalid phone' });
  const value = body.value === undefined || body.value === null ? null : Number(body.value);
  if (value !== null && (!Number.isFinite(value) || value < 0)) errors.push({ path: 'value', message: 'value must be a positive number' });
  if (errors.length) throw new AppError('VALIDATION_ERROR', 'Some fields are invalid', errors);

  const custom = typeof body.fields === 'object' && body.fields && !Array.isArray(body.fields)
    ? Object.fromEntries(Object.entries(body.fields as Record<string, unknown>).slice(0, 30).flatMap(([k, v]) => (clip(v, 1000) ? [[k.slice(0, 80), clip(v, 1000)!]] : [])))
    : {};
  const tags = Array.isArray(body.tags) ? body.tags.flatMap((t) => (clip(t, 40) ? [clip(t, 40)!] : [])).slice(0, 10) : [];
  const { lead, duplicate } = await captureLead(row.organizationId, row.clientId, clip(body.source, 60) ?? 'api', {
    name: clip(body.name, 200), email, phone, company: clip(body.company, 200), message: clip(body.message, 5000), customFields: custom,
    pageUrl: clip(body.pageUrl, 500), utmSource: clip(body.utm_source, 100), utmMedium: clip(body.utm_medium, 100), utmCampaign: clip(body.utm_campaign, 150), tags, value,
  });
  await db.leadApiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } });
  return { id: lead.id, status: lead.status, duplicate };
}

// ── Outgoing webhooks ─────────────────────────────────────────────────

export type LeadEvent = 'lead.created' | 'lead.updated' | 'lead.status_changed';
const secretAad = (orgId: string) => `lead-webhook:${orgId}`;

export async function listLeadWebhooks(ctx: AuthContext) {
  requirePermission(ctx, 'leads:manage');
  const rows = await getInfra().db.leadWebhook.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { createdAt: 'desc' } });
  return rows.map(({ secretEnc: _secret, ...r }) => r);
}

async function assertWebhookUrl(url: string) {
  try {
    const u = await assertPublicUrl(url);
    if (u.protocol !== 'https:' && getInfra().env.NODE_ENV === 'production') throw new UnsafeUrlError('Use an https:// URL');
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : 'Invalid URL');
  }
}

/** Returns the signing secret once. */
export async function createLeadWebhook(ctx: AuthContext, input: { name: string; url: string; clientId?: string | null; events?: LeadEvent[] }) {
  requirePermission(ctx, 'leads:manage');
  if (input.clientId) await getClient(ctx, input.clientId);
  await assertWebhookUrl(input.url);
  const secret = `whsec_${randomBytes(24).toString('base64url')}`;
  const row = await getInfra().db.leadWebhook.create({
    data: { organizationId: ctx.organizationId, clientId: input.clientId ?? null, name: input.name, url: input.url, events: input.events?.length ? input.events : ['lead.created'], secretEnc: encryptSecret(getInfra().keyRing, secret, secretAad(ctx.organizationId)), createdById: ctx.userId },
  });
  await audit(ctx, { action: 'lead_webhook.created', resourceType: 'LeadWebhook', resourceId: row.id, after: { name: input.name, url: input.url, events: row.events } });
  const { secretEnc: _s, ...rest } = row;
  return { ...rest, secret };
}

export async function updateLeadWebhook(ctx: AuthContext, id: string, input: { name?: string; url?: string; events?: LeadEvent[]; active?: boolean }) {
  requirePermission(ctx, 'leads:manage');
  const row = await getInfra().db.leadWebhook.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!row) throw notFound('Webhook');
  if (input.url) await assertWebhookUrl(input.url);
  const updated = await getInfra().db.leadWebhook.update({ where: { id }, data: { ...input, ...(input.events ? { events: input.events } : {}) } });
  await audit(ctx, { action: 'lead_webhook.updated', resourceType: 'LeadWebhook', resourceId: id, after: input });
  const { secretEnc: _s, ...rest } = updated;
  return rest;
}

export async function deleteLeadWebhook(ctx: AuthContext, id: string) {
  requirePermission(ctx, 'leads:manage');
  const row = await getInfra().db.leadWebhook.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!row) throw notFound('Webhook');
  await getInfra().db.leadWebhook.delete({ where: { id } });
  await audit(ctx, { action: 'lead_webhook.deleted', resourceType: 'LeadWebhook', resourceId: id, before: { url: row.url } });
}

/** Queues deliveries for every active webhook that wants this event. */
export async function emitLeadEvent(organizationId: string, clientId: string, event: LeadEvent, leadId: string) {
  const { db, queues } = getInfra();
  const hooks = await db.leadWebhook.findMany({ where: { organizationId, active: true, events: { has: event }, OR: [{ clientId: null }, { clientId }] }, select: { id: true } });
  for (const h of hooks) {
    await queues.add('outbound', { webhookId: h.id, event, leadId }, { attempts: 6, backoff: { type: 'exponential', delay: 30_000 } });
  }
}

/** Signature header value: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>">. */
export function signWebhook(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)) {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** For receivers written in JS/TS; also documents the scheme. */
export function verifyWebhookSignature(secret: string, body: string, header: string, toleranceSec = 300): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const t = Number(parts.t);
  if (!t || !parts.v1 || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = Buffer.from(signWebhook(secret, body, t).split('v1=')[1]!, 'hex');
  const given = Buffer.from(parts.v1, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

function leadPayload(lead: Lead & { client: { id: string; name: string }; form: { id: string; name: string } | null }) {
  return {
    id: lead.id,
    client: lead.client,
    status: lead.status,
    source: lead.source,
    form: lead.form,
    name: lead.name,
    email: lead.email,
    phone: lead.phone,
    company: lead.company,
    message: lead.message,
    fields: lead.customFields,
    tags: lead.tags,
    value: lead.value,
    pageUrl: lead.pageUrl,
    utm: { source: lead.utmSource, medium: lead.utmMedium, campaign: lead.utmCampaign },
    createdAt: lead.createdAt,
    updatedAt: lead.updatedAt,
  };
}

/** Worker: one delivery attempt. Throws on failure so the queue retries with backoff. */
export async function deliverLeadWebhook(webhookId: string, event: LeadEvent, leadId: string) {
  const { db, keyRing } = getInfra();
  const hook = await db.leadWebhook.findUnique({ where: { id: webhookId } });
  if (!hook || !hook.active) return { skipped: true };
  const lead = await db.lead.findUnique({ where: { id: leadId }, include: { client: { select: { id: true, name: true } }, form: { select: { id: true, name: true } } } });
  if (!lead) return { skipped: true };
  const body = JSON.stringify({ event, sentAt: new Date().toISOString(), data: leadPayload(lead) });
  const secret = decryptSecret(keyRing, hook.secretEnc, secretAad(hook.organizationId));
  let status: number | null = null;
  let error: string | null = null;
  try {
    const url = await assertPublicUrl(hook.url);
    const res = await fetch(url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { 'content-type': 'application/json', 'user-agent': 'SocialPilot-Webhooks/1.0', 'x-socialpilot-event': event, 'x-socialpilot-signature': signWebhook(secret, body) }, body });
    status = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  await db.leadWebhook.update({ where: { id: hook.id }, data: { lastStatus: status, lastError: error, lastDeliveredAt: new Date() } });
  if (error) throw new Error(`Webhook ${hook.name} failed: ${error}`);
  return { status };
}

/** Sends a sample lead so people can check their receiver. */
export async function testLeadWebhook(ctx: AuthContext, id: string) {
  requirePermission(ctx, 'leads:manage');
  const hook = await getInfra().db.leadWebhook.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!hook) throw notFound('Webhook');
  const lead = await getInfra().db.lead.findFirst({ where: { organizationId: ctx.organizationId, ...(hook.clientId ? { clientId: hook.clientId } : {}) }, orderBy: { createdAt: 'desc' } });
  if (!lead) throw badRequest('There are no leads yet to send as a sample');
  try {
    return await deliverLeadWebhook(hook.id, 'lead.created', lead.id);
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : String(error));
  }
}

// ── CRM helpers ───────────────────────────────────────────────────────

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Neutralize spreadsheet formulas (=, +, -, @) so a lead can't run code in Excel.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export async function exportLeadsCsv(ctx: AuthContext, query: { clientId?: string; status?: Lead['status'] }) {
  requirePermission(ctx, 'leads:view');
  if (query.clientId) assertClientAccess(ctx, query.clientId);
  const rows = await getInfra().db.lead.findMany({
    where: { ...tenantWhere(ctx, query.clientId), ...(query.status ? { status: query.status } : {}) },
    include: { client: { select: { name: true } }, form: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    take: 50_000,
  });
  const header = ['Created', 'Client', 'Status', 'Name', 'Email', 'Phone', 'Company', 'Source', 'Form', 'Value', 'Tags', 'Follow up', 'Lost reason', 'Message', 'Page', 'UTM source', 'UTM medium', 'UTM campaign', 'Other fields'];
  const lines = rows.map((l) => [l.createdAt, l.client.name, l.status, l.name, l.email, l.phone, l.company, l.source, l.form?.name, l.value, l.tags.join('; '), l.followUpAt, l.lostReason, l.message, l.pageUrl, l.utmSource, l.utmMedium, l.utmCampaign, l.customFields].map(csvCell).join(','));
  return [header.join(','), ...lines].join('\r\n');
}

/** Maintenance: notify about follow-ups that are due, once each. */
export async function sendDueFollowUpReminders() {
  const { db } = getInfra();
  const due = await db.lead.findMany({ where: { followUpAt: { lte: new Date() }, followUpNotifiedAt: null, status: { notIn: ['WON', 'LOST'] } }, take: 200, include: { client: { select: { name: true } } } });
  for (const l of due) {
    await notifyClientMembers(l.organizationId, l.clientId, 'leads:view', { type: 'NEW_LEAD', title: `Follow up with ${l.name ?? l.email ?? l.phone ?? 'a lead'} (${l.client.name})`, link: `/leads/${l.id}`, data: { leadId: l.id, reminder: true } }, l.assignedToId ? { userIds: [l.assignedToId] } : {});
    await db.lead.update({ where: { id: l.id }, data: { followUpNotifiedAt: new Date() } });
  }
  return { reminded: due.length };
}
