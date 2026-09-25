import { canAssignRole, defaultClientAccess, generateToken, hashPassword, sha256, type RoleKey } from '@socialpilot/auth';
import { isUniqueViolation, type Plan, type Prisma } from '@socialpilot/database';
import { buildAuthContext, requirePermission, type AuthContext } from '../context';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors';
import { getInfra } from '../infra';
import { currentPeriod, randomSuffix, slugify } from '../lib/util';
import { audit } from './audit.service';

// ── Plans & usage (billing-ready; no payment processing yet) ──────────────

export type LimitKey = 'clients' | 'socialAccounts' | 'members' | 'aiGenerations' | 'posts' | 'messages' | 'storageMb';
export const PLAN_LIMITS: Record<Plan, Record<LimitKey, number>> = {
  FREE: { clients: 1, socialAccounts: 3, members: 2, aiGenerations: 100, posts: 30, messages: 500, storageMb: 500 },
  STARTER: { clients: 3, socialAccounts: 10, members: 5, aiGenerations: 1000, posts: 300, messages: 5000, storageMb: 5000 },
  PRO: { clients: 10, socialAccounts: 40, members: 15, aiGenerations: 5000, posts: 1500, messages: 25000, storageMb: 20000 },
  AGENCY: { clients: 50, socialAccounts: 250, members: 50, aiGenerations: 25000, posts: 10000, messages: 150000, storageMb: 100000 },
  ENTERPRISE: { clients: 100000, socialAccounts: 100000, members: 100000, aiGenerations: 1000000, posts: 1000000, messages: 10000000, storageMb: 10000000 },
};

export async function getLimits(organizationId: string): Promise<Record<LimitKey, number>> {
  const org = await getInfra().db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { plan: true, limits: true } });
  return { ...PLAN_LIMITS[org.plan], ...((org.limits ?? {}) as Partial<Record<LimitKey, number>>) };
}

/** Throws PLAN_LIMIT when adding `increment` would exceed the organization's plan. */
export async function assertWithinLimit(organizationId: string, key: LimitKey, current: number, increment = 1): Promise<void> {
  const limits = await getLimits(organizationId);
  if (current + increment > limits[key]) {
    throw new AppError('PLAN_LIMIT', `Your plan allows ${limits[key]} ${key}. Upgrade to add more.`, { key, limit: limits[key] });
  }
}

/** Monthly usage counters for metered features (AI generations, messages, posts). */
export async function incrementUsage(organizationId: string, metric: 'aiGenerations' | 'posts' | 'messages', by = 1): Promise<void> {
  const period = currentPeriod();
  await getInfra().db.usageCounter.upsert({
    where: { organizationId_metric_period: { organizationId, metric, period } },
    create: { organizationId, metric, period, count: by },
    update: { count: { increment: by } },
  });
}

export async function getUsage(organizationId: string) {
  const period = currentPeriod();
  const { db } = getInfra();
  const [counters, clients, socialAccounts, members] = await Promise.all([
    db.usageCounter.findMany({ where: { organizationId, period } }),
    db.client.count({ where: { organizationId, status: 'ACTIVE' } }),
    db.socialAccount.count({ where: { organizationId, status: { not: 'DISCONNECTED' } } }),
    db.organizationMember.count({ where: { organizationId } }),
  ]);
  const metered = Object.fromEntries(counters.map((c) => [c.metric, c.count]));
  return { period, clients, socialAccounts, members, aiGenerations: metered.aiGenerations ?? 0, posts: metered.posts ?? 0, messages: metered.messages ?? 0 };
}

// ── Organizations ───────────────────────────────────────────────────────

export async function createOrganizationForUser(userId: string, name: string) {
  const { db } = getInfra();
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = attempt === 0 ? slugify(name) : `${slugify(name)}-${randomSuffix()}`;
    try {
      return await db.$transaction(async (tx) => {
        const org = await tx.organization.create({ data: { name, slug, onboardingStep: 'create_client' } });
        await tx.organizationMember.create({ data: { organizationId: org.id, userId, role: 'ORG_OWNER', clientAccess: 'ALL' } });
        await tx.auditLog.create({ data: { organizationId: org.id, userId, action: 'organization.created', resourceType: 'Organization', resourceId: org.id, after: { name } } });
        return org;
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
  }
  throw conflict('Could not allocate an organization slug');
}

export async function listUserOrganizations(userId: string) {
  const memberships = await getInfra().db.organizationMember.findMany({
    where: { userId },
    include: { organization: { select: { id: true, name: true, slug: true, plan: true, onboardingStep: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return memberships.map((m) => ({ ...m.organization, role: m.role }));
}

/** Builds the AuthContext for a user acting in an organization they belong to. */
export async function resolveAuthContext(
  user: { id: string; isSuperAdmin: boolean },
  organizationId: string,
  meta: { requestId?: string; ip?: string; userAgent?: string } = {},
): Promise<AuthContext> {
  const { db } = getInfra();
  const member = await db.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId: user.id } },
    include: { clients: { select: { clientId: true } } },
  });
  // Membership is required for everyone, including platform super admins: they use the
  // aggregate /admin views and never browse a tenant's inbox or content implicitly.
  if (!member) throw notFound('Organization');
  return buildAuthContext({
    userId: user.id,
    isSuperAdmin: user.isSuperAdmin,
    organizationId,
    role: member.role,
    clientAccess: member.clientAccess,
    assignedClientIds: member.clients.map((c) => c.clientId),
    ...meta,
  });
}

export async function getOrganization(ctx: AuthContext) {
  const org = await getInfra().db.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } });
  return { ...org, limits: await getLimits(org.id), usage: await getUsage(org.id) };
}

export async function updateOrganization(ctx: AuthContext, input: { name?: string; onboardingStep?: string | null }) {
  const isOnboardingOnly = input.name === undefined;
  if (!isOnboardingOnly) requirePermission(ctx, 'settings:manage');
  const { db } = getInfra();
  const before = await db.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } });
  const updated = await db.organization.update({ where: { id: ctx.organizationId }, data: input });
  if (!isOnboardingOnly) await audit(ctx, { action: 'organization.updated', resourceType: 'Organization', resourceId: updated.id, before: { name: before.name }, after: { name: updated.name } });
  return updated;
}

// ── Members & invitations ───────────────────────────────────────────────

export async function listMembers(ctx: AuthContext) {
  requirePermission(ctx, 'users:view');
  const members = await getInfra().db.organizationMember.findMany({
    where: { organizationId: ctx.organizationId },
    include: { user: { select: { id: true, name: true, email: true, avatarUrl: true, lastLoginAt: true } }, clients: { select: { clientId: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const invitations = await getInfra().db.invitation.findMany({
    where: { organizationId: ctx.organizationId, acceptedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
  });
  return { members: members.map((m) => ({ ...m, clientIds: m.clients.map((c) => c.clientId), clients: undefined })), invitations };
}

async function assertClientsInOrg(organizationId: string, clientIds: string[]) {
  if (!clientIds.length) return;
  const count = await getInfra().db.client.count({ where: { organizationId, id: { in: clientIds } } });
  if (count !== new Set(clientIds).size) throw badRequest('One or more clients do not belong to this organization');
}

export async function inviteMember(ctx: AuthContext, input: { email: string; role: Exclude<RoleKey, 'SUPER_ADMIN'>; clientIds?: string[] }) {
  requirePermission(ctx, 'users:manage');
  if (!canAssignRole(ctx.role, input.role)) throw forbidden('You cannot invite a member with a role above your own');
  const { db, env } = getInfra();
  await assertClientsInOrg(ctx.organizationId, input.clientIds ?? []);
  const existingUser = await db.user.findUnique({ where: { email: input.email }, select: { id: true } });
  if (existingUser) {
    const already = await db.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: ctx.organizationId, userId: existingUser.id } } });
    if (already) throw conflict('This person is already a member');
  }
  await assertWithinLimit(ctx.organizationId, 'members', await db.organizationMember.count({ where: { organizationId: ctx.organizationId } }));
  const token = generateToken(32);
  const invitation = await db.invitation.create({
    data: {
      organizationId: ctx.organizationId,
      email: input.email,
      role: input.role,
      tokenHash: sha256(token),
      invitedById: ctx.userId,
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    },
  });
  // Store intended client assignments on the invitation via audit trail; applied on acceptance.
  await audit(ctx, { action: 'member.invited', resourceType: 'Invitation', resourceId: invitation.id, after: { email: input.email, role: input.role, clientIds: input.clientIds ?? [] } });
  const acceptUrl = `${env.APP_URL}/invite?token=${encodeURIComponent(token)}`;
  getInfra().logger.info({ organizationId: ctx.organizationId, invitationId: invitation.id }, 'invitation created (email delivery via EMAIL_DRIVER)');
  return { invitation: { id: invitation.id, email: invitation.email, role: invitation.role, expiresAt: invitation.expiresAt }, acceptUrl, clientIds: input.clientIds ?? [] };
}

export async function acceptInvitation(input: { token: string; name?: string; password?: string }, sessionUser?: { id: string; email: string }) {
  const { db } = getInfra();
  const invitation = await db.invitation.findUnique({ where: { tokenHash: sha256(input.token) } });
  if (!invitation || invitation.acceptedAt || invitation.expiresAt < new Date()) throw badRequest('This invitation is invalid or has expired');

  let userId: string;
  if (sessionUser) {
    if (sessionUser.email !== invitation.email) throw forbidden('This invitation was sent to a different email address');
    userId = sessionUser.id;
  } else {
    const existing = await db.user.findUnique({ where: { email: invitation.email } });
    if (existing) throw badRequest('Sign in with this email to accept the invitation');
    if (!input.name || !input.password) throw badRequest('Name and password are required to create your account');
    userId = (await db.user.create({ data: { email: invitation.email, name: input.name, passwordHash: await hashPassword(input.password) } })).id;
  }
  const inviteAudit = await db.auditLog.findFirst({ where: { resourceType: 'Invitation', resourceId: invitation.id, action: 'member.invited' } });
  const clientIds = ((inviteAudit?.after as { clientIds?: string[] } | null)?.clientIds ?? []).filter(Boolean);

  await db.$transaction(async (tx) => {
    const member = await tx.organizationMember.create({
      data: { organizationId: invitation.organizationId, userId, role: invitation.role, clientAccess: defaultClientAccess(invitation.role) },
    });
    if (clientIds.length) {
      const valid = await tx.client.findMany({ where: { organizationId: invitation.organizationId, id: { in: clientIds } }, select: { id: true } });
      await tx.clientMember.createMany({ data: valid.map((c) => ({ memberId: member.id, clientId: c.id })) });
    }
    await tx.invitation.update({ where: { id: invitation.id }, data: { acceptedAt: new Date() } });
    await tx.auditLog.create({ data: { organizationId: invitation.organizationId, userId, action: 'member.joined', resourceType: 'OrganizationMember', resourceId: member.id, after: { role: invitation.role } } });
  });
  return { organizationId: invitation.organizationId, userId };
}

export async function updateMember(ctx: AuthContext, memberId: string, input: { role?: Exclude<RoleKey, 'SUPER_ADMIN'>; clientAccess?: 'ALL' | 'ASSIGNED'; clientIds?: string[] }) {
  requirePermission(ctx, 'users:manage');
  const { db } = getInfra();
  const member = await db.organizationMember.findFirst({ where: { id: memberId, organizationId: ctx.organizationId }, include: { clients: true } });
  if (!member) throw notFound('Member');
  if (member.userId === ctx.userId && input.role && input.role !== member.role) throw badRequest('You cannot change your own role');
  if (member.role === 'ORG_OWNER' && ctx.role !== 'ORG_OWNER' && ctx.role !== 'SUPER_ADMIN') throw forbidden('Only an owner can change another owner');
  if (input.role && !canAssignRole(ctx.role, input.role)) throw forbidden('You cannot assign a role above your own');
  if (member.role === 'ORG_OWNER' && input.role && input.role !== 'ORG_OWNER') {
    const owners = await db.organizationMember.count({ where: { organizationId: ctx.organizationId, role: 'ORG_OWNER' } });
    if (owners <= 1) throw badRequest('An organization must keep at least one owner');
  }
  if (input.clientIds) await assertClientsInOrg(ctx.organizationId, input.clientIds);

  const updated = await db.$transaction(async (tx) => {
    const data: Prisma.OrganizationMemberUpdateInput = {};
    if (input.role) data.role = input.role;
    if (input.clientAccess) data.clientAccess = input.clientAccess;
    const m = await tx.organizationMember.update({ where: { id: memberId }, data });
    if (input.clientIds) {
      await tx.clientMember.deleteMany({ where: { memberId } });
      await tx.clientMember.createMany({ data: input.clientIds.map((clientId) => ({ memberId, clientId })) });
    }
    await audit(
      ctx,
      {
        action: 'member.permissions_changed',
        resourceType: 'OrganizationMember',
        resourceId: memberId,
        before: { role: member.role, clientAccess: member.clientAccess, clientIds: member.clients.map((c) => c.clientId) },
        after: { role: m.role, clientAccess: m.clientAccess, clientIds: input.clientIds },
      },
      tx,
    );
    return m;
  });
  return updated;
}

export async function removeMember(ctx: AuthContext, memberId: string) {
  requirePermission(ctx, 'users:manage');
  const { db } = getInfra();
  const member = await db.organizationMember.findFirst({ where: { id: memberId, organizationId: ctx.organizationId } });
  if (!member) throw notFound('Member');
  if (member.userId === ctx.userId) throw badRequest('You cannot remove yourself');
  if (member.role === 'ORG_OWNER') {
    if (ctx.role !== 'ORG_OWNER' && ctx.role !== 'SUPER_ADMIN') throw forbidden('Only an owner can remove an owner');
    const owners = await db.organizationMember.count({ where: { organizationId: ctx.organizationId, role: 'ORG_OWNER' } });
    if (owners <= 1) throw badRequest('An organization must keep at least one owner');
  }
  await db.organizationMember.delete({ where: { id: memberId } });
  await audit(ctx, { action: 'member.removed', resourceType: 'OrganizationMember', resourceId: memberId, before: { userId: member.userId, role: member.role } });
}
