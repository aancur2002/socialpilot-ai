import { randomBytes } from 'node:crypto';
import { hashPassword } from '@socialpilot/auth';
import { isUniqueViolation, type Organization, type Plan, type Prisma } from '@socialpilot/database';
import type { AuthContext } from '../context';
import { requirePermission } from '../context';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors';
import { getInfra } from '../infra';
import { auditGlobal } from './audit.service';
import { createOrganizationForUser, getLimits, getUsage, PLAN_LIMITS, type LimitKey } from './organization.service';

/**
 * SaaS billing, run by the platform admin: plan prices, customer accounts,
 * manually recorded payments and the access rule that blocks unpaid or
 * suspended customers. No card processing: payments arrive outside the app
 * (bank transfer, cash, a payment link) and the admin records them.
 */

type SuperUser = { id: string; isSuperAdmin: boolean };
function assertSuperAdmin(user: { isSuperAdmin: boolean }) {
  if (!user.isSuperAdmin) throw forbidden('Super admin only');
}

// ── Platform settings ─────────────────────────────────────────────────

export interface PlatformSettings {
  currency: string;
  /** Days of access after paid-until before the account is blocked */
  graceDays: number;
  /** Default free trial for new customers */
  trialDays: number;
  /** When false, only the platform admin can create accounts */
  allowPublicSignup: boolean;
  /** Shown to customers on their billing page, e.g. bank details */
  paymentInstructions: string | null;
}

const SETTINGS_KEY = 'platform';
const DEFAULT_SETTINGS: PlatformSettings = { currency: 'USD', graceDays: 7, trialDays: 14, allowPublicSignup: true, paymentInstructions: null };
const TTL_MS = 30_000;
let settingsCache: { expires: number; value: PlatformSettings } | null = null;

export async function getPlatformSettings(): Promise<PlatformSettings> {
  if (settingsCache && settingsCache.expires > Date.now()) return settingsCache.value;
  const row = await getInfra().db.platformSetting.findUnique({ where: { key: SETTINGS_KEY } });
  const value = { ...DEFAULT_SETTINGS, ...((row?.value ?? {}) as Partial<PlatformSettings>) };
  settingsCache = { expires: Date.now() + TTL_MS, value };
  return value;
}

export async function updatePlatformSettings(user: SuperUser, input: Partial<PlatformSettings>) {
  assertSuperAdmin(user);
  const before = await getPlatformSettings();
  const next = { ...before, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as PlatformSettings;
  await getInfra().db.platformSetting.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, value: next as unknown as Prisma.InputJsonValue },
    update: { value: next as unknown as Prisma.InputJsonValue },
  });
  settingsCache = null;
  clearAccessCache();
  await auditGlobal({ action: 'platform.settings_changed', resourceType: 'PlatformSetting', resourceId: SETTINGS_KEY, userId: user.id, before, after: next });
  return next;
}

/** What the sign-up page needs to know; safe to expose without signing in. */
export async function publicSignupSettings() {
  const s = await getPlatformSettings();
  return { allowPublicSignup: s.allowPublicSignup };
}

// ── Plans ─────────────────────────────────────────────────────────────

export const PLAN_ORDER: Plan[] = ['FREE', 'STARTER', 'PRO', 'AGENCY', 'ENTERPRISE'];
const DEFAULT_PLAN: Record<Plan, { name: string; priceCents: number }> = {
  FREE: { name: 'Free', priceCents: 0 },
  STARTER: { name: 'Starter', priceCents: 2900 },
  PRO: { name: 'Pro', priceCents: 7900 },
  AGENCY: { name: 'Agency', priceCents: 19900 },
  ENTERPRISE: { name: 'Enterprise', priceCents: 49900 },
};

export async function listPlans() {
  const rows = await getInfra().db.planPrice.findMany();
  return PLAN_ORDER.map((plan) => {
    const row = rows.find((r) => r.plan === plan);
    return {
      plan,
      name: row?.name ?? DEFAULT_PLAN[plan].name,
      description: row?.description ?? null,
      priceCents: row?.priceCents ?? DEFAULT_PLAN[plan].priceCents,
      public: row?.public ?? true,
      limits: { ...PLAN_LIMITS[plan], ...((row?.limits ?? {}) as Partial<Record<LimitKey, number>>) },
    };
  });
}

export async function updatePlan(user: SuperUser, plan: Plan, input: { name?: string; description?: string | null; priceCents?: number; limits?: Partial<Record<LimitKey, number>>; public?: boolean }) {
  assertSuperAdmin(user);
  if (!PLAN_ORDER.includes(plan)) throw notFound('Plan');
  const current = (await listPlans()).find((p) => p.plan === plan)!;
  const data = {
    name: input.name ?? current.name,
    description: input.description !== undefined ? input.description : current.description,
    priceCents: input.priceCents ?? current.priceCents,
    public: input.public ?? current.public,
    // Store only what differs from the built-in limits, so code defaults can still evolve.
    limits: Object.fromEntries(Object.entries({ ...current.limits, ...input.limits }).filter(([k, v]) => PLAN_LIMITS[plan][k as LimitKey] !== v)) as Prisma.InputJsonValue,
  };
  await getInfra().db.planPrice.upsert({ where: { plan }, create: { plan, ...data }, update: data });
  clearAccessCache();
  await auditGlobal({ action: 'platform.plan_changed', resourceType: 'PlanPrice', resourceId: plan, userId: user.id, before: current, after: data });
  return (await listPlans()).find((p) => p.plan === plan)!;
}

// ── Access rule ───────────────────────────────────────────────────────

type BillingFields = Pick<Organization, 'plan' | 'subscriptionStatus' | 'billingMode' | 'trialEndsAt' | 'paidUntil' | 'suspendedAt' | 'suspendReason'>;
export type AccessState =
  | { state: 'active' }
  | { state: 'trial'; endsAt: Date | null }
  | { state: 'grace'; blockAt: Date }
  | { state: 'blocked'; reason: 'suspended' | 'canceled' | 'trial_ended' | 'overdue'; message: string };

const DAY = 86_400_000;

/** Whether an organization may use the app right now, and why not. */
export function accessFor(org: BillingFields, settings: PlatformSettings, priceCents: number, now = new Date()): AccessState {
  if (org.suspendedAt) return { state: 'blocked', reason: 'suspended', message: org.suspendReason ? `This account is suspended: ${org.suspendReason}` : 'This account is suspended. Contact your provider.' };
  if (org.subscriptionStatus === 'CANCELED') return { state: 'blocked', reason: 'canceled', message: 'This subscription was cancelled. Contact your provider to reactivate it.' };
  if (org.billingMode === 'COMPLIMENTARY' || priceCents === 0) return { state: 'active' };
  // A payment always counts, even during a trial.
  if (org.paidUntil && org.paidUntil > now) return { state: 'active' };
  if (org.subscriptionStatus === 'TRIALING' && !org.paidUntil) {
    if (!org.trialEndsAt || org.trialEndsAt > now) return { state: 'trial', endsAt: org.trialEndsAt };
    return { state: 'blocked', reason: 'trial_ended', message: 'The free trial has ended. Pay for a plan to keep using the app.' };
  }
  if (!org.paidUntil) return { state: 'active' };
  const blockAt = new Date(org.paidUntil.getTime() + settings.graceDays * DAY);
  if (blockAt > now) return { state: 'grace', blockAt };
  return { state: 'blocked', reason: 'overdue', message: 'Payment is overdue. Pay to restore access.' };
}

const BILLING_SELECT = { plan: true, subscriptionStatus: true, billingMode: true, customPriceCents: true, trialEndsAt: true, paidUntil: true, suspendedAt: true, suspendReason: true } as const;

const accessCache = new Map<string, { expires: number; value: AccessState }>();
const ACCESS_TTL_MS = 15_000;

/** Checked on every organization request, so cached briefly; admin changes clear it in this process. */
export async function organizationAccess(organizationId: string): Promise<AccessState> {
  const hit = accessCache.get(organizationId);
  if (hit && hit.expires > Date.now()) return hit.value;
  const org = await getInfra().db.organization.findUnique({ where: { id: organizationId }, select: BILLING_SELECT });
  if (!org) throw notFound('Organization');
  const value = accessFor(org, await getPlatformSettings(), await priceFor(org));
  accessCache.set(organizationId, { expires: Date.now() + ACCESS_TTL_MS, value });
  return value;
}

function clearAccessCache(organizationId?: string) {
  if (organizationId) accessCache.delete(organizationId);
  else accessCache.clear();
}

/** Throws ACCOUNT_BLOCKED when the organization may not use the app. */
export async function assertOrganizationAccess(organizationId: string): Promise<void> {
  const access = await organizationAccess(organizationId);
  if (access.state === 'blocked') throw new AppError('ACCOUNT_BLOCKED', access.message, { reason: access.reason });
}

async function priceFor(org: Pick<Organization, 'plan' | 'customPriceCents' | 'billingMode'>) {
  if (org.billingMode === 'COMPLIMENTARY') return 0;
  if (org.customPriceCents !== null) return org.customPriceCents;
  return (await listPlans()).find((p) => p.plan === org.plan)!.priceCents;
}

// ── Customer's own view ───────────────────────────────────────────────

export async function getBilling(ctx: AuthContext) {
  requirePermission(ctx, 'settings:manage');
  const { db } = getInfra();
  const org = await db.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } });
  const settings = await getPlatformSettings();
  const plan = (await listPlans()).find((p) => p.plan === org.plan)!;
  const payments = await db.payment.findMany({ where: { organizationId: org.id }, orderBy: { createdAt: 'desc' }, take: 24, select: { id: true, amountCents: true, currency: true, method: true, periodStart: true, periodEnd: true, createdAt: true } });
  return {
    plan: { key: plan.plan, name: plan.name, description: plan.description },
    priceCents: await priceFor(org),
    currency: settings.currency,
    billingMode: org.billingMode,
    subscriptionStatus: org.subscriptionStatus,
    trialEndsAt: org.trialEndsAt,
    paidUntil: org.paidUntil,
    access: accessFor(org, settings, await priceFor(org)),
    paymentInstructions: settings.paymentInstructions,
    limits: await getLimits(org.id),
    usage: await getUsage(org.id),
    payments,
  };
}

// ── Platform admin: customers ─────────────────────────────────────────

function generatePassword() {
  // 16 URL-safe characters (~96 bits); easy to paste, hard to guess.
  return randomBytes(12).toString('base64url');
}

export async function adminListCustomers(user: SuperUser) {
  assertSuperAdmin(user);
  const { db } = getInfra();
  const [orgs, settings, plans] = await Promise.all([
    db.organization.findMany({
      orderBy: { createdAt: 'desc' },
      take: 1000,
      include: {
        _count: { select: { members: true, clients: true } },
        members: { where: { role: 'ORG_OWNER' }, take: 1, orderBy: { createdAt: 'asc' }, select: { user: { select: { id: true, name: true, email: true, lastLoginAt: true } } } },
      },
    }),
    getPlatformSettings(),
    listPlans(),
  ]);
  return {
    currency: settings.currency,
    customers: orgs.map((o) => {
      const priceCents = o.billingMode === 'COMPLIMENTARY' ? 0 : (o.customPriceCents ?? plans.find((p) => p.plan === o.plan)!.priceCents);
      return {
      id: o.id,
      name: o.name,
      plan: o.plan,
      planName: plans.find((p) => p.plan === o.plan)!.name,
      priceCents,
      billingMode: o.billingMode,
      subscriptionStatus: o.subscriptionStatus,
      trialEndsAt: o.trialEndsAt,
      paidUntil: o.paidUntil,
      access: accessFor(o, settings, priceCents),
      owner: o.members[0]?.user ?? null,
      members: o._count.members,
      clients: o._count.clients,
      createdAt: o.createdAt,
      };
    }),
  };
}

export async function adminGetCustomer(user: SuperUser, id: string) {
  assertSuperAdmin(user);
  const { db } = getInfra();
  const org = await db.organization.findUnique({
    where: { id },
    include: {
      members: { orderBy: { createdAt: 'asc' }, select: { role: true, user: { select: { id: true, name: true, email: true, lastLoginAt: true, disabledAt: true } } } },
      payments: { orderBy: { createdAt: 'desc' }, take: 50 },
    },
  });
  if (!org) throw notFound('Customer');
  const settings = await getPlatformSettings();
  return {
    id: org.id,
    name: org.name,
    plan: org.plan,
    billingMode: org.billingMode,
    customPriceCents: org.customPriceCents,
    priceCents: await priceFor(org),
    currency: settings.currency,
    billingEmail: org.billingEmail,
    billingNotes: org.billingNotes,
    subscriptionStatus: org.subscriptionStatus,
    trialEndsAt: org.trialEndsAt,
    paidUntil: org.paidUntil,
    suspendedAt: org.suspendedAt,
    suspendReason: org.suspendReason,
    access: accessFor(org, settings, await priceFor(org)),
    limitOverrides: org.limits,
    limits: await getLimits(org.id),
    usage: await getUsage(org.id),
    members: org.members.map((m) => ({ role: m.role, ...m.user })),
    payments: org.payments,
    createdAt: org.createdAt,
  };
}

export async function adminCreateCustomer(
  user: SuperUser,
  input: { organizationName: string; plan: Plan; billingMode: 'MANUAL' | 'COMPLIMENTARY'; customPriceCents?: number | null; trialDays?: number; billingEmail?: string | null; owner: { name: string; email: string; password?: string } },
) {
  assertSuperAdmin(user);
  const { db } = getInfra();
  const settings = await getPlatformSettings();
  const existing = await db.user.findUnique({ where: { email: input.owner.email } });
  if (existing && input.owner.password) throw conflict('That email already has an account. Leave the password empty to add the existing user as owner, or use another email.');

  let owner = existing;
  let password: string | null = null;
  if (!owner) {
    password = input.owner.password ?? generatePassword();
    try {
      owner = await db.user.create({ data: { email: input.owner.email, name: input.owner.name, passwordHash: await hashPassword(password) } });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('An account with this email already exists');
      throw e;
    }
  }

  const org = await createOrganizationForUser(owner.id, input.organizationName);
  const trialDays = input.trialDays ?? settings.trialDays;
  const complimentary = input.billingMode === 'COMPLIMENTARY';
  await db.organization.update({
    where: { id: org.id },
    data: {
      plan: input.plan,
      billingMode: input.billingMode,
      customPriceCents: input.customPriceCents ?? null,
      billingEmail: input.billingEmail ?? input.owner.email,
      subscriptionStatus: complimentary ? 'ACTIVE' : trialDays > 0 ? 'TRIALING' : 'PAST_DUE',
      trialEndsAt: !complimentary && trialDays > 0 ? new Date(Date.now() + trialDays * DAY) : null,
      // No trial and no payment yet: the account starts inside its grace period.
      paidUntil: !complimentary && trialDays === 0 ? new Date() : null,
    },
  });
  await auditGlobal({ action: 'platform.customer_created', resourceType: 'Organization', resourceId: org.id, organizationId: org.id, userId: user.id, after: { name: input.organizationName, plan: input.plan, billingMode: input.billingMode, ownerEmail: input.owner.email, newUser: !existing } });
  return {
    organization: await adminGetCustomer(user, org.id),
    owner: { email: owner.email, name: owner.name, existingAccount: Boolean(existing), password },
  };
}

export async function adminUpdateCustomer(
  user: SuperUser,
  id: string,
  input: {
    name?: string; plan?: Plan; billingMode?: 'MANUAL' | 'COMPLIMENTARY'; customPriceCents?: number | null; billingEmail?: string | null; billingNotes?: string | null;
    trialEndsAt?: Date | null; paidUntil?: Date | null; subscriptionStatus?: Organization['subscriptionStatus']; suspended?: boolean; suspendReason?: string | null; limits?: Partial<Record<LimitKey, number>>;
  },
) {
  assertSuperAdmin(user);
  const { db } = getInfra();
  const before = await db.organization.findUnique({ where: { id } });
  if (!before) throw notFound('Customer');
  const data: Prisma.OrganizationUpdateInput = {};
  for (const key of ['name', 'plan', 'billingMode', 'customPriceCents', 'billingEmail', 'billingNotes', 'trialEndsAt', 'paidUntil', 'subscriptionStatus'] as const) {
    if (input[key] !== undefined) (data as Record<string, unknown>)[key] = input[key];
  }
  if (input.limits !== undefined) data.limits = input.limits as Prisma.InputJsonValue;
  if (input.suspended !== undefined) {
    data.suspendedAt = input.suspended ? (before.suspendedAt ?? new Date()) : null;
    data.suspendReason = input.suspended ? (input.suspendReason ?? before.suspendReason) : null;
  } else if (input.suspendReason !== undefined) {
    data.suspendReason = input.suspendReason;
  }
  await db.organization.update({ where: { id }, data });
  clearAccessCache(id);
  await auditGlobal({
    action: input.suspended === true ? 'platform.customer_suspended' : input.suspended === false && before.suspendedAt ? 'platform.customer_unsuspended' : 'platform.customer_updated',
    resourceType: 'Organization', resourceId: id, organizationId: id, userId: user.id,
    before: { plan: before.plan, billingMode: before.billingMode, customPriceCents: before.customPriceCents, paidUntil: before.paidUntil, trialEndsAt: before.trialEndsAt, subscriptionStatus: before.subscriptionStatus, suspended: Boolean(before.suspendedAt) },
    after: input,
  });
  return adminGetCustomer(user, id);
}

/** Records a payment and extends paid-until by the months paid for, from today or the current paid-until, whichever is later. */
export async function adminRecordPayment(user: SuperUser, id: string, input: { amountCents: number; months: number; method: string; reference?: string | null; note?: string | null }) {
  assertSuperAdmin(user);
  const { db } = getInfra();
  const settings = await getPlatformSettings();
  const payment = await db.$transaction(async (tx) => {
    // Lock the row so two payments recorded at once both extend the period.
    const rows = await tx.$queryRaw<{ paidUntil: Date | null }[]>`SELECT "paidUntil" FROM "Organization" WHERE id = ${id} FOR UPDATE`;
    if (!rows.length) throw notFound('Customer');
    const now = new Date();
    const periodStart = rows[0]!.paidUntil && rows[0]!.paidUntil > now ? rows[0]!.paidUntil : now;
    const periodEnd = new Date(periodStart);
    periodEnd.setUTCMonth(periodEnd.getUTCMonth() + input.months);
    await tx.organization.update({ where: { id }, data: { paidUntil: periodEnd, subscriptionStatus: 'ACTIVE' } });
    return tx.payment.create({
      data: { organizationId: id, amountCents: input.amountCents, currency: settings.currency, method: input.method, reference: input.reference ?? null, note: input.note ?? null, periodStart, periodEnd, recordedById: user.id },
    });
  });
  clearAccessCache(id);
  await auditGlobal({ action: 'platform.payment_recorded', resourceType: 'Payment', resourceId: payment.id, organizationId: id, userId: user.id, after: { amountCents: payment.amountCents, currency: payment.currency, method: payment.method, periodEnd: payment.periodEnd } });
  return adminGetCustomer(user, id);
}

/** Sets a new password for any user (generated when omitted) and signs them out everywhere. */
export async function adminResetPassword(user: SuperUser, userId: string, input: { password?: string }) {
  assertSuperAdmin(user);
  const { db } = getInfra();
  const target = await db.user.findUnique({ where: { id: userId }, select: { id: true, email: true, isSuperAdmin: true } });
  if (!target) throw notFound('User');
  if (target.isSuperAdmin && target.id !== user.id) throw badRequest('Platform admins reset their own password in Settings → Your account.');
  const password = input.password ?? generatePassword();
  await db.$transaction([
    db.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(password) } }),
    db.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
  await auditGlobal({ action: 'platform.password_reset', resourceType: 'User', resourceId: userId, userId: user.id });
  return { email: target.email, password };
}
