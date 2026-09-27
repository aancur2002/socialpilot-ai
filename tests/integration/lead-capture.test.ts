import { createHmac } from 'node:crypto';
import { sha256 } from '@socialpilot/auth';
import * as core from '@socialpilot/core';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../apps/api/src/server';
import { addMember, createOwner, uid } from './helpers';

async function inject(app: FastifyInstance, method: 'GET' | 'POST', url: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({ method, url, payload: body === undefined ? undefined : JSON.stringify(body), headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers } });
  return { status: res.statusCode, headers: res.headers, body: res.body && res.headers['content-type']?.toString().includes('json') ? JSON.parse(res.body) : res.body };
}

describe('lead capture', () => {
  let app: FastifyInstance;
  let owner: Awaited<ReturnType<typeof createOwner>>;
  let clientId: string;
  let superUser: { id: string; isSuperAdmin: boolean };

  beforeAll(async () => {
    app = await buildServer();
    owner = await createOwner('Leads');
    await core.getInfra().db.organization.update({ where: { id: owner.organizationId }, data: { plan: 'AGENCY' } });
    clientId = (await core.createClient(owner.ctx, { name: `Bakery ${uid()}`, timezone: 'UTC', brand: { brandName: 'Bakery' } })).id;
    const u = await core.getInfra().db.user.create({ data: { email: `super-${uid()}@test.local`, name: 'Super', passwordHash: 'x', isSuperAdmin: true } });
    superUser = { id: u.id, isSuperAdmin: true };
  });
  afterAll(async () => {
    await core.adminUpdatePlatformGroup(superUser, 'stripe', { enabled: false, publishableKey: null, secretKey: null, webhookSecret: null });
    await app.close();
    await core.closeInfra();
  });

  const newForm = (extra: Partial<Parameters<typeof core.createLeadForm>[1]> = {}) =>
    core.createLeadForm(owner.ctx, { clientId, name: 'Contact', fields: [...core.DEFAULT_FORM_FIELDS, { key: 'budget', label: 'Budget', type: 'select', required: false, options: ['Under 500', '500+'] }], notifyEmails: ['sales@test.local'], ...extra });

  it('serves a public form and turns a submission into a CRM lead', async () => {
    const form = await newForm();
    const config = await inject(app, 'GET', `/api/v1/public/forms/${form.publicKey}`);
    expect(config.status).toBe(200);
    expect(config.body.fields.map((f: { key: string }) => f.key)).toEqual(['name', 'email', 'phone', 'message', 'budget']);
    expect(config.body).not.toHaveProperty('notifyEmails');

    const res = await inject(app, 'POST', `/api/v1/public/forms/${form.publicKey}/submit`, { name: 'Ana', email: 'Ana@Example.com', message: 'Wedding cake for 80', budget: '500+', pageUrl: 'https://bakery.example/cakes', utm_source: 'facebook' }, { origin: 'https://bakery.example', 'x-forwarded-for': '203.0.113.1' });
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    const lead = await core.getInfra().db.lead.findUniqueOrThrow({ where: { id: res.body.leadId } });
    expect(lead).toMatchObject({ clientId, source: 'website_form', email: 'ana@example.com', message: 'Wedding cake for 80', utmSource: 'facebook', formId: form.id, status: 'NEW', customFields: { Budget: '500+' } });
    expect((await core.getLeadForm(owner.ctx, form.id)).submissions).toBe(1);
    expect(await core.getInfra().db.notification.count({ where: { organizationId: owner.organizationId, type: 'NEW_LEAD', link: `/leads/${lead.id}` } })).toBeGreaterThan(0);
  });

  it('validates fields, ignores bots and adds repeat submissions to the open lead', async () => {
    const form = await newForm();
    const url = `/api/v1/public/forms/${form.publicKey}/submit`;
    const bad = await inject(app, 'POST', url, { name: '', email: 'not-an-email', budget: 'huge' }, { 'x-forwarded-for': '203.0.113.2' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(['budget', 'email', 'name']);

    const before = await core.getInfra().db.lead.count({ where: { clientId } });
    const bot = await inject(app, 'POST', url, { name: 'Bot', email: 'bot@spam.test', website: 'http://spam' }, { 'x-forwarded-for': '203.0.113.3' });
    expect(bot.status).toBe(200);
    expect(await core.getInfra().db.lead.count({ where: { clientId } })).toBe(before);

    const email = `repeat-${uid()}@example.com`;
    const first = await inject(app, 'POST', url, { name: 'Repeat', email }, { 'x-forwarded-for': '203.0.113.4' });
    const second = await inject(app, 'POST', url, { name: 'Repeat', email, phone: '+1 555 0100', message: 'Still interested' }, { 'x-forwarded-for': '203.0.113.5' });
    expect(second.body.leadId).toBe(first.body.leadId);
    const lead = await core.getLead(owner.ctx, first.body.leadId);
    expect(lead.phone).toBe('+1 555 0100');
    expect(lead.notes.some((n: { body: string }) => n.body.includes('Still interested'))).toBe(true);
  });

  it('only accepts submissions from allowed websites and rate-limits each visitor', async () => {
    const form = await newForm({ allowedDomains: ['https://www.bakery.example/'] });
    const url = `/api/v1/public/forms/${form.publicKey}/submit`;
    const body = { name: 'X', email: `x-${uid()}@example.com` };
    expect((await inject(app, 'POST', url, body, { origin: 'https://evil.example', 'x-forwarded-for': '203.0.113.6' })).status).toBe(403);
    expect((await inject(app, 'POST', url, body, { origin: 'https://shop.bakery.example', 'x-forwarded-for': '203.0.113.6' })).status).toBe(200);
    for (let i = 0; i < 4; i++) await inject(app, 'POST', url, { ...body, email: `r${i}-${uid()}@example.com` }, { origin: 'https://bakery.example', 'x-forwarded-for': '203.0.113.7' });
    expect((await inject(app, 'POST', url, { ...body, email: `r9-${uid()}@example.com` }, { origin: 'https://bakery.example', 'x-forwarded-for': '203.0.113.7' })).status).toBe(200);
    expect((await inject(app, 'POST', url, { ...body, email: `r10-${uid()}@example.com` }, { origin: 'https://bakery.example', 'x-forwarded-for': '203.0.113.7' })).status).toBe(429);
  });

  it('refuses forms without a way to reach the lead, and inactive forms', async () => {
    await expect(core.createLeadForm(owner.ctx, { clientId, name: 'No contact', fields: [{ key: 'name', label: 'Name', type: 'text', required: true }] })).rejects.toThrow(/email or phone/);
    const form = await newForm();
    await core.updateLeadForm(owner.ctx, form.id, { active: false });
    expect((await inject(app, 'GET', `/api/v1/public/forms/${form.publicKey}`)).status).toBe(404);
  });

  it('accepts leads through the API with a key, and rejects revoked keys', async () => {
    const created = await core.createLeadApiKey(owner.ctx, { clientId, name: 'Zapier' });
    expect(created.key).toMatch(/^spk_/);
    expect(JSON.stringify(await core.listLeadApiKeys(owner.ctx))).not.toContain(created.key);
    const res = await inject(app, 'POST', '/api/v1/public/leads', { name: 'API Lead', email: `api-${uid()}@example.com`, company: 'Acme', value: 1200, tags: ['zapier'], fields: { 'Guests': '80' } }, { authorization: `Bearer ${created.key}` });
    expect(res.status).toBe(201);
    expect(await core.getInfra().db.lead.findUniqueOrThrow({ where: { id: res.body.id } })).toMatchObject({ source: 'api', company: 'Acme', value: 1200, tags: ['zapier'], customFields: { Guests: '80' } });
    expect((await inject(app, 'POST', '/api/v1/public/leads', { name: 'No contact' }, { authorization: `Bearer ${created.key}` })).status).toBe(422);
    expect((await inject(app, 'POST', '/api/v1/public/leads', { email: 'a@b.co' })).status).toBe(401);
    await core.revokeLeadApiKey(owner.ctx, created.id);
    expect((await inject(app, 'POST', '/api/v1/public/leads', { email: 'a@b.co' }, { authorization: `Bearer ${created.key}` })).status).toBe(401);
  });

  it('keeps other organizations and restricted members out', async () => {
    const other = await createOwner('Other');
    const form = await newForm();
    await expect(core.getLeadForm(other.ctx, form.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const viewer = await addMember(owner.organizationId, 'VIEWER');
    await expect(core.createLeadApiKey(viewer.ctx, { clientId, name: 'x' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('queues signed webhooks for lead events and refuses private URLs', async () => {
    await expect(core.createLeadWebhook(owner.ctx, { name: 'Local', url: 'http://127.0.0.1/hook' })).rejects.toThrow(/private|reserved/);
    const hook = await core.createLeadWebhook(owner.ctx, { name: 'CRM', url: 'https://example.com/hook', events: ['lead.created', 'lead.status_changed'] });
    expect(hook.secret).toMatch(/^whsec_/);
    expect(JSON.stringify(await core.listLeadWebhooks(owner.ctx))).not.toContain(hook.secret);

    const queue = core.getInfra().queues.get('outbound');
    const before = await queue.getJobCountByTypes('waiting', 'delayed', 'active', 'completed', 'failed');
    const lead = await core.createLead(owner.ctx, { clientId, source: 'manual', status: 'NEW', name: 'Webhook lead', email: `wh-${uid()}@example.com` });
    await core.updateLead(owner.ctx, lead.id, { status: 'QUALIFIED' });
    await core.updateLead(owner.ctx, lead.id, { name: 'Renamed' }); // lead.updated: not subscribed
    expect(await queue.getJobCountByTypes('waiting', 'delayed', 'active', 'completed', 'failed')).toBe(before + 2);

    const body = JSON.stringify({ event: 'lead.created' });
    expect(core.verifyWebhookSignature('whsec_test', body, core.signWebhook('whsec_test', body))).toBe(true);
    expect(core.verifyWebhookSignature('whsec_other', body, core.signWebhook('whsec_test', body))).toBe(false);
    expect(core.verifyWebhookSignature('whsec_test', body, core.signWebhook('whsec_test', body, Math.floor(Date.now() / 1000) - 3600))).toBe(false);
  });

  it('exports leads as CSV with spreadsheet formulas neutralized', async () => {
    await core.createLead(owner.ctx, { clientId, source: 'manual', status: 'NEW', name: '=HYPERLINK("http://evil")', email: `csv-${uid()}@example.com` });
    const csv = await core.exportLeadsCsv(owner.ctx, { clientId });
    expect(csv.split('\r\n')[0]).toContain('Created,Client,Status,Name,Email');
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
  });

  it('sends a follow-up reminder once when it is due', async () => {
    const lead = await core.createLead(owner.ctx, { clientId, source: 'manual', status: 'CONTACTED', name: 'Call back', email: `fu-${uid()}@example.com` });
    await core.updateLead(owner.ctx, lead.id, { followUpAt: new Date(Date.now() - 60_000) });
    expect((await core.sendDueFollowUpReminders()).reminded).toBeGreaterThanOrEqual(1);
    expect((await core.getInfra().db.lead.findUniqueOrThrow({ where: { id: lead.id } })).followUpNotifiedAt).not.toBeNull();
    const count = () => core.getInfra().db.notification.count({ where: { link: `/leads/${lead.id}`, title: { startsWith: 'Follow up' } } });
    const afterFirst = await count();
    expect(afterFirst).toBeGreaterThan(0);
    const again = await core.sendDueFollowUpReminders();
    expect(again.reminded).toBe(0);
    expect(await count()).toBe(afterFirst);
  });

  it('resets a password with a one-time emailed link', async () => {
    const res = await inject(app, 'POST', '/api/v1/auth/forgot-password', { email: 'nobody@nowhere.test' });
    expect(res).toMatchObject({ status: 200, body: { ok: true } }); // same answer for unknown emails
    const user = await core.getInfra().db.user.findUniqueOrThrow({ where: { email: owner.email } });
    await core.requestPasswordReset(owner.email, {});
    expect(await core.getInfra().db.passwordResetToken.count({ where: { userId: user.id, usedAt: null } })).toBeGreaterThan(0);

    const token = `test-token-${uid()}-${uid()}`;
    await core.getInfra().db.passwordResetToken.create({ data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 60_000) } });
    expect((await inject(app, 'POST', '/api/v1/auth/reset-password', { token, password: 'brand-new-pass-1' })).status).toBe(200);
    expect((await inject(app, 'POST', '/api/v1/auth/reset-password', { token, password: 'another-pass-22' })).status).toBe(400);
    expect((await inject(app, 'POST', '/api/v1/auth/login', { email: owner.email, password: 'brand-new-pass-1' })).status).toBe(200);
  });

  it('locks an account after 10 wrong passwords, whatever the IP, and a reset unlocks it', async () => {
    const victim = await createOwner('Lock');
    for (let i = 0; i < 10; i++) {
      expect((await inject(app, 'POST', '/api/v1/auth/login', { email: victim.email, password: `wrong-${i}-pass` }, { 'x-forwarded-for': `198.51.100.${i + 1}` })).status).toBe(401);
    }
    const locked = await inject(app, 'POST', '/api/v1/auth/login', { email: victim.email, password: 'password-1234' }, { 'x-forwarded-for': '198.51.100.99' });
    expect(locked).toMatchObject({ status: 429, body: { error: { code: 'RATE_LIMITED' } } });
    // Unknown emails get the same treatment, so the lock doesn't reveal which accounts exist.
    const ghost = `ghost-${uid()}@test.local`;
    for (let i = 0; i < 10; i++) await inject(app, 'POST', '/api/v1/auth/login', { email: ghost, password: 'nope-nope-1' }, { 'x-forwarded-for': `198.51.101.${i + 1}` });
    expect((await inject(app, 'POST', '/api/v1/auth/login', { email: ghost, password: 'nope-nope-1' }, { 'x-forwarded-for': '198.51.101.99' })).status).toBe(429);

    const user = await core.getInfra().db.user.findUniqueOrThrow({ where: { email: victim.email } });
    const token = `unlock-${uid()}-${uid()}-${uid()}`;
    await core.getInfra().db.passwordResetToken.create({ data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 60_000) } });
    await core.resetPasswordWithToken({ token, password: 'fresh-password-9' }, {});
    expect((await inject(app, 'POST', '/api/v1/auth/login', { email: victim.email, password: 'fresh-password-9' }, { 'x-forwarded-for': '198.51.100.100' })).status).toBe(200);
  });

  it('stores platform secrets encrypted and never returns them', async () => {
    const saved = await core.adminUpdatePlatformGroup(superUser, 'email', { enabled: false, host: 'smtp.example.com', port: 587, user: 'mailer', password: 'super-secret-pass', fromEmail: 'hello@example.com' });
    expect(saved.password).toEqual({ set: true, hint: '…pass' });
    const row = await core.getInfra().db.platformSetting.findUniqueOrThrow({ where: { key: 'group:email' } });
    expect(JSON.stringify(row.value)).not.toContain('super-secret-pass');
    expect((await core.getPlatformGroup('email')).password).toBe('super-secret-pass');
    const kept = await core.adminUpdatePlatformGroup(superUser, 'email', { host: 'smtp2.example.com' });
    expect(kept.password).toMatchObject({ set: true });
    await expect(core.adminGetPlatformGroup({ isSuperAdmin: false }, 'email')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('shows legal templates filled with company details until custom text is saved', async () => {
    await core.adminUpdatePlatformGroup(superUser, 'company', { productName: 'PilotTest', legalName: 'Pilot Test Ltd', supportEmail: 'help@pilot.test', jurisdiction: 'Nepal' });
    const legal = (await inject(app, 'GET', '/api/v1/public/legal')).body;
    expect(legal.terms).toContain('Pilot Test Ltd');
    expect(legal.terms).toContain('laws of Nepal');
    expect(legal.privacy).toContain('help@pilot.test');
    await core.adminUpdatePlatformGroup(superUser, 'legal', { terms: '# Our own terms' });
    expect((await core.publicLegal()).terms).toBe('# Our own terms');
    await core.adminUpdatePlatformGroup(superUser, 'legal', { terms: null });
    await core.adminUpdatePlatformGroup(superUser, 'company', { productName: 'SocialPilot', legalName: null, supportEmail: null, jurisdiction: null });
  });
});

describe('card payments (Stripe, off by default)', () => {
  let owner: Awaited<ReturnType<typeof createOwner>>;
  let superUser: { id: string; isSuperAdmin: boolean };
  const webhookSecret = 'whsec_testsecret123';
  const stripeFetch = (async () => new Response(JSON.stringify({ livemode: false }), { status: 200 })) as typeof fetch;

  beforeAll(async () => {
    owner = await createOwner('Card');
    const u = await core.getInfra().db.user.create({ data: { email: `super-${uid()}@test.local`, name: 'Super', passwordHash: 'x', isSuperAdmin: true } });
    superUser = { id: u.id, isSuperAdmin: true };
  });
  afterAll(async () => core.adminUpdatePlatformGroup(superUser, 'stripe', { enabled: false, publishableKey: null, secretKey: null, webhookSecret: null }));

  const signed = (payload: object) => {
    const raw = Buffer.from(JSON.stringify(payload));
    const t = Math.floor(Date.now() / 1000);
    return { raw, sig: `t=${t},v1=${createHmac('sha256', webhookSecret).update(`${t}.${raw.toString()}`).digest('hex')}` };
  };

  it('stays off: no checkout, webhook refused, cannot switch on without valid keys', async () => {
    expect(await core.stripeEnabled()).toBe(false);
    await expect(core.createCheckout(owner.ctx, { months: 1 })).rejects.toThrow(/not available/);
    const { raw, sig } = signed({ type: 'checkout.session.completed' });
    await expect(core.handleStripeWebhook(raw, sig)).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    await expect(core.setStripeEnabled(superUser, true, stripeFetch)).rejects.toThrow(/Save the/);
    await core.adminUpdatePlatformGroup(superUser, 'stripe', { publishableKey: 'pk_live_abc', secretKey: 'sk_test_abc', webhookSecret });
    await expect(core.setStripeEnabled(superUser, true, stripeFetch)).rejects.toThrow(/same mode/);
  });

  it('after the key check passes, records a paid checkout exactly once', async () => {
    await core.adminUpdatePlatformGroup(superUser, 'stripe', { publishableKey: 'pk_test_abc', secretKey: 'sk_test_abc', webhookSecret });
    expect(await core.checkStripeKeys(superUser, stripeFetch)).toEqual({ ok: true, mode: 'test' });
    await core.setStripeEnabled(superUser, true, stripeFetch);
    expect(await core.stripeEnabled()).toBe(true);

    const event = { id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: `cs_${uid()}`, payment_status: 'paid', amount_total: 2900, currency: 'usd', client_reference_id: owner.organizationId, payment_intent: 'pi_1', metadata: { organizationId: owner.organizationId, months: '1' } } } };
    const { raw, sig } = signed(event);
    expect(await core.handleStripeWebhook(raw, sig)).toMatchObject({ recorded: true });
    expect(await core.handleStripeWebhook(raw, sig)).toMatchObject({ recorded: false });
    const payments = await core.getInfra().db.payment.findMany({ where: { organizationId: owner.organizationId } });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ provider: 'stripe', amountCents: 2900, method: 'card', currency: 'USD' });
    await expect(core.handleStripeWebhook(raw, 't=1,v1=00')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});
