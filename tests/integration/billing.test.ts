import * as core from '@socialpilot/core';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../apps/api/src/server';
import { uid } from './helpers';

const ORIGIN = 'http://localhost:3000';
const DAY = 86_400_000;

function client(app: FastifyInstance) {
  let cookie = '';
  let org = '';
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      payload: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), origin: ORIGIN, ...(cookie ? { cookie } : {}), ...(org ? { 'x-organization-id': org } : {}) },
    });
    const set = res.headers['set-cookie'];
    if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
  };
  return { call, setOrg: (id: string) => (org = id) };
}

const settings: core.PlatformSettings = { currency: 'USD', graceDays: 7, trialDays: 14, allowPublicSignup: true, paymentInstructions: null };
const base = { plan: 'PRO' as const, subscriptionStatus: 'ACTIVE' as const, billingMode: 'MANUAL' as const, trialEndsAt: null, paidUntil: null, suspendedAt: null, suspendReason: null };

describe('access rule', () => {
  const now = new Date('2026-09-27T12:00:00Z');
  const at = (days: number) => new Date(now.getTime() + days * DAY);

  it('allows paid, complimentary and free-plan customers', () => {
    expect(core.accessFor({ ...base, paidUntil: at(10) }, settings, 7900, now).state).toBe('active');
    expect(core.accessFor({ ...base, billingMode: 'COMPLIMENTARY', paidUntil: at(-100) }, settings, 7900, now).state).toBe('active');
    expect(core.accessFor({ ...base, paidUntil: at(-100) }, settings, 0, now).state).toBe('active');
  });

  it('gives a grace period after paid-until, then blocks', () => {
    expect(core.accessFor({ ...base, paidUntil: at(-3) }, settings, 7900, now)).toMatchObject({ state: 'grace', blockAt: at(4) });
    expect(core.accessFor({ ...base, paidUntil: at(-8) }, settings, 7900, now)).toMatchObject({ state: 'blocked', reason: 'overdue' });
  });

  it('blocks an ended trial but not a running one', () => {
    expect(core.accessFor({ ...base, subscriptionStatus: 'TRIALING', trialEndsAt: at(2) }, settings, 7900, now).state).toBe('trial');
    expect(core.accessFor({ ...base, subscriptionStatus: 'TRIALING', trialEndsAt: at(-1) }, settings, 7900, now)).toMatchObject({ state: 'blocked', reason: 'trial_ended' });
  });

  it('blocks suspended and cancelled accounts even when paid or complimentary', () => {
    expect(core.accessFor({ ...base, billingMode: 'COMPLIMENTARY', suspendedAt: now, suspendReason: 'Chargeback' }, settings, 0, now)).toMatchObject({ state: 'blocked', reason: 'suspended', message: expect.stringContaining('Chargeback') });
    expect(core.accessFor({ ...base, subscriptionStatus: 'CANCELED', paidUntil: at(30) }, settings, 7900, now)).toMatchObject({ state: 'blocked', reason: 'canceled' });
  });
});

describe('SaaS billing (platform admin)', () => {
  let app: FastifyInstance;
  let admin: { id: string; isSuperAdmin: boolean };

  beforeAll(async () => {
    app = await buildServer();
    const u = await core.getInfra().db.user.create({ data: { email: `super-${uid()}@test.local`, name: 'Super', passwordHash: 'x', isSuperAdmin: true } });
    admin = { id: u.id, isSuperAdmin: true };
  });
  afterAll(async () => {
    await core.updatePlatformSettings(admin, { allowPublicSignup: true });
    await app.close();
    await core.closeInfra();
  });

  it('creates a customer whose owner can sign in with the handed-over password', async () => {
    const email = `owner-${uid()}@test.local`;
    const created = await core.adminCreateCustomer(admin, { organizationName: 'Paid Agency', plan: 'PRO', billingMode: 'MANUAL', trialDays: 14, owner: { name: 'Owner', email } });
    expect(created.owner.password).toHaveLength(16);
    expect(created.organization).toMatchObject({ plan: 'PRO', subscriptionStatus: 'TRIALING', access: { state: 'trial' } });

    const api = client(app);
    expect((await api.call('POST', '/api/v1/auth/login', { email, password: created.owner.password })).status).toBe(200);
    api.setOrg(created.organization.id);
    expect((await api.call('GET', '/api/v1/clients')).status).toBe(200);
  });

  it('refuses non-admins', async () => {
    await expect(core.adminListCustomers({ id: 'x', isSuperAdmin: false })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(core.updatePlan({ id: 'x', isSuperAdmin: false }, 'PRO', { priceCents: 1 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('blocks an unpaid customer except for its billing page, and a payment restores access', async () => {
    const email = `late-${uid()}@test.local`;
    const created = await core.adminCreateCustomer(admin, { organizationName: 'Late Agency', plan: 'PRO', billingMode: 'MANUAL', trialDays: 0, owner: { name: 'Late', email, password: 'password-1234' } });
    const orgId = created.organization.id;
    await core.adminUpdateCustomer(admin, orgId, { paidUntil: new Date(Date.now() - 30 * DAY) });

    const api = client(app);
    await api.call('POST', '/api/v1/auth/login', { email, password: 'password-1234' });
    api.setOrg(orgId);
    expect(await api.call('GET', '/api/v1/clients')).toMatchObject({ status: 402, body: { error: { code: 'ACCOUNT_BLOCKED' } } });
    expect((await api.call('GET', '/api/v1/organizations/current')).body.access).toMatchObject({ state: 'blocked', reason: 'overdue' });
    const billing = await api.call('GET', '/api/v1/billing');
    expect(billing.status).toBe(200);
    expect(billing.body).toMatchObject({ priceCents: 7900, currency: 'USD', access: { state: 'blocked' } });

    // Paying 2 months from an overdue state counts from today, not from the old date.
    const after = await core.adminRecordPayment(admin, orgId, { amountCents: 15800, months: 2, method: 'bank_transfer', reference: 'INV-1' });
    expect(after.access.state).toBe('active');
    expect(after.subscriptionStatus).toBe('ACTIVE');
    expect(after.paidUntil!.getTime()).toBeGreaterThan(Date.now() + 55 * DAY);
    expect(after.paidUntil!.getTime()).toBeLessThan(Date.now() + 63 * DAY);
    expect((await api.call('GET', '/api/v1/clients')).status).toBe(200);

    // A second payment extends from the current paid-until.
    const again = await core.adminRecordPayment(admin, orgId, { amountCents: 7900, months: 1, method: 'cash' });
    expect(again.paidUntil!.getTime()).toBeGreaterThan(after.paidUntil!.getTime() + 27 * DAY);
    expect(again.payments).toHaveLength(2);
  });

  it('suspends and restores a customer immediately', async () => {
    const created = await core.adminCreateCustomer(admin, { organizationName: 'Sus Agency', plan: 'STARTER', billingMode: 'COMPLIMENTARY', owner: { name: 'S', email: `sus-${uid()}@test.local` } });
    const suspended = await core.adminUpdateCustomer(admin, created.organization.id, { suspended: true, suspendReason: 'Terms violation' });
    expect(suspended.access).toMatchObject({ state: 'blocked', reason: 'suspended' });
    await expect(core.assertOrganizationAccess(created.organization.id)).rejects.toMatchObject({ code: 'ACCOUNT_BLOCKED' });
    const restored = await core.adminUpdateCustomer(admin, created.organization.id, { suspended: false });
    expect(restored.access.state).toBe('active');
    await expect(core.assertOrganizationAccess(created.organization.id)).resolves.toBeUndefined();
  });

  it('uses admin-set plan prices and limits, with per-customer overrides', async () => {
    await core.updatePlan(admin, 'STARTER', { priceCents: 1900, limits: { clients: 4 } });
    const created = await core.adminCreateCustomer(admin, { organizationName: 'Priced', plan: 'STARTER', billingMode: 'MANUAL', owner: { name: 'P', email: `p-${uid()}@test.local` } });
    expect(created.organization).toMatchObject({ priceCents: 1900, limits: { clients: 4 } });
    const custom = await core.adminUpdateCustomer(admin, created.organization.id, { customPriceCents: 1500, limits: { clients: 6 } });
    expect(custom).toMatchObject({ priceCents: 1500, limits: { clients: 6 } });
    await core.updatePlan(admin, 'STARTER', { priceCents: 2900, limits: { clients: 3 } });
  });

  it('closes public sign-up and self-created organizations when turned off', async () => {
    await core.updatePlatformSettings(admin, { allowPublicSignup: false });
    const api = client(app);
    expect((await api.call('GET', '/api/v1/public/signup')).body).toEqual({ allowPublicSignup: false });
    const res = await api.call('POST', '/api/v1/auth/register', { name: 'X', email: `x-${uid()}@test.local`, password: 'password-1234', organizationName: 'X' });
    expect(res.status).toBe(403);

    const created = await core.adminCreateCustomer(admin, { organizationName: 'Closed', plan: 'FREE', billingMode: 'MANUAL', owner: { name: 'C', email: `c-${uid()}@test.local`, password: 'password-1234' } });
    await api.call('POST', '/api/v1/auth/login', { email: created.owner.email, password: 'password-1234' });
    expect((await api.call('POST', '/api/v1/organizations', { name: 'Second free org' })).status).toBe(403);
    await core.updatePlatformSettings(admin, { allowPublicSignup: true });
  });

  it('resets a customer password and signs them out', async () => {
    const email = `r-${uid()}@test.local`;
    await core.adminCreateCustomer(admin, { organizationName: 'Reset', plan: 'FREE', billingMode: 'MANUAL', owner: { name: 'R', email, password: 'password-1234' } });
    const api = client(app);
    await api.call('POST', '/api/v1/auth/login', { email, password: 'password-1234' });
    const user = await core.getInfra().db.user.findUniqueOrThrow({ where: { email } });
    const reset = await core.adminResetPassword(admin, user.id, {});
    expect((await api.call('GET', '/api/v1/auth/me')).status).toBe(401);
    expect((await client(app).call('POST', '/api/v1/auth/login', { email, password: reset.password })).status).toBe(200);
  });
});
