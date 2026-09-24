import { isValidTimezone } from '@socialpilot/ai';
import { isUniqueViolation, type Prisma } from '@socialpilot/database';
import type { BrandProfileInput, ClientSettingsInput } from '@socialpilot/validation';
import { assertClientAccess, requirePermission, type AuthContext, type ServiceContext } from '../context';
import { badRequest, conflict, notFound } from '../errors';
import { getInfra } from '../infra';
import { randomSuffix, slugify } from '../lib/util';
import { audit } from './audit.service';
import { assertWithinLimit } from './organization.service';

const clientInclude = { brandProfile: true, settings: true } satisfies Prisma.ClientInclude;

export async function listClients(ctx: ServiceContext, opts: { includeArchived?: boolean } = {}) {
  requirePermission(ctx, 'clients:view');
  const scoped = ctx.kind === 'user' && ctx.clientIds !== null ? { id: { in: [...ctx.clientIds] } } : {};
  const clients = await getInfra().db.client.findMany({
    where: { organizationId: ctx.organizationId, ...scoped, ...(opts.includeArchived ? {} : { status: 'ACTIVE' as const }) },
    include: { brandProfile: { select: { brandName: true, industry: true } }, _count: { select: { socialAccounts: true, contents: true, leads: true } } },
    orderBy: { name: 'asc' },
  });
  return clients;
}

/** Loads a client inside the caller's organization; NOT_FOUND if outside their scope. */
export async function getClient(ctx: ServiceContext, clientId: string) {
  requirePermission(ctx, 'clients:view');
  assertClientAccess(ctx, clientId);
  const client = await getInfra().db.client.findFirst({ where: { id: clientId, organizationId: ctx.organizationId }, include: clientInclude });
  if (!client) throw notFound('Client');
  return client;
}

export async function createClient(ctx: AuthContext, input: { name: string; timezone: string; brand?: Partial<BrandProfileInput> }) {
  requirePermission(ctx, 'clients:create');
  if (!isValidTimezone(input.timezone)) throw badRequest(`Unknown timezone "${input.timezone}"`);
  const { db } = getInfra();
  await assertWithinLimit(ctx.organizationId, 'clients', await db.client.count({ where: { organizationId: ctx.organizationId, status: 'ACTIVE' } }));
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = attempt === 0 ? slugify(input.name) : `${slugify(input.name)}-${randomSuffix()}`;
    try {
      return await db.$transaction(async (tx) => {
        const client = await tx.client.create({ data: { organizationId: ctx.organizationId, name: input.name, slug, timezone: input.timezone } });
        await tx.brandProfile.create({ data: { ...normalizeBrand({ brandName: input.name, ...input.brand }), clientId: client.id, organizationId: ctx.organizationId } });
        await tx.clientSettings.create({ data: { clientId: client.id, organizationId: ctx.organizationId } });
        // Members restricted to assigned clients get access to clients they create.
        if (ctx.clientIds !== null) {
          const member = await tx.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: ctx.organizationId, userId: ctx.userId } } });
          await tx.clientMember.create({ data: { memberId: member.id, clientId: client.id } });
        }
        await audit(ctx, { action: 'client.created', resourceType: 'Client', resourceId: client.id, clientId: client.id, after: { name: input.name } }, tx);
        return tx.client.findUniqueOrThrow({ where: { id: client.id }, include: clientInclude });
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
  }
  throw conflict('Could not allocate a client slug');
}

export async function updateClient(ctx: AuthContext, clientId: string, input: { name?: string; timezone?: string; status?: 'ACTIVE' | 'ARCHIVED' }) {
  requirePermission(ctx, 'clients:edit');
  if (input.status === 'ARCHIVED') requirePermission(ctx, 'clients:delete');
  if (input.timezone && !isValidTimezone(input.timezone)) throw badRequest(`Unknown timezone "${input.timezone}"`);
  const before = await getClient(ctx, clientId);
  const updated = await getInfra().db.client.update({ where: { id: clientId }, data: input, include: clientInclude });
  await audit(ctx, {
    action: input.status === 'ARCHIVED' ? 'client.archived' : 'client.updated',
    resourceType: 'Client',
    resourceId: clientId,
    clientId,
    before: { name: before.name, timezone: before.timezone, status: before.status },
    after: { name: updated.name, timezone: updated.timezone, status: updated.status },
  });
  return updated;
}

function normalizeBrand(input: Partial<BrandProfileInput> & { brandName: string }) {
  return {
    brandName: input.brandName,
    industry: input.industry ?? null,
    description: input.description ?? null,
    tone: input.tone ?? null,
    targetAudience: input.targetAudience ?? null,
    services: input.services ?? [],
    products: input.products ?? [],
    location: input.location ?? null,
    website: input.website || null,
    phone: input.phone ?? null,
    email: input.email || null,
    brandRules: input.brandRules ?? [],
    forbiddenTopics: input.forbiddenTopics ?? [],
    preferredHashtags: (input.preferredHashtags ?? []).map((h) => h.replace(/^#/, '')),
    cta: input.cta ?? null,
  };
}

export async function updateBrandProfile(ctx: AuthContext, clientId: string, input: BrandProfileInput) {
  requirePermission(ctx, 'clients:edit');
  const client = await getClient(ctx, clientId);
  const data = normalizeBrand(input);
  const updated = await getInfra().db.brandProfile.upsert({
    where: { clientId },
    create: { ...data, clientId, organizationId: ctx.organizationId },
    update: data,
  });
  await audit(ctx, { action: 'client.brand_updated', resourceType: 'BrandProfile', resourceId: updated.id, clientId, before: client.brandProfile, after: updated });
  return updated;
}

export async function updateClientSettings(ctx: AuthContext, clientId: string, input: ClientSettingsInput) {
  requirePermission(ctx, 'clients:edit');
  const touchesAutoReply = input.autoReplyEnabled !== undefined || input.autoReplyThreshold !== undefined || input.allowedAutoIntents !== undefined || input.escalationIntents !== undefined;
  if (touchesAutoReply) requirePermission(ctx, 'messages:auto_reply');
  const client = await getClient(ctx, clientId);
  const current = client.settings;
  const autoT = input.autoReplyThreshold ?? current?.autoReplyThreshold ?? 0.9;
  const apprT = input.approvalThreshold ?? current?.approvalThreshold ?? 0.7;
  if (apprT > autoT) throw badRequest('approvalThreshold must be less than or equal to autoReplyThreshold');
  const data: Prisma.ClientSettingsUpdateInput = { ...input, businessHours: input.businessHours as Prisma.InputJsonValue | undefined };
  const updated = await getInfra().db.clientSettings.upsert({
    where: { clientId },
    create: { ...(data as Prisma.ClientSettingsCreateInput), client: { connect: { id: clientId } }, organizationId: ctx.organizationId } as Prisma.ClientSettingsCreateInput,
    update: data,
  });
  await audit(ctx, { action: touchesAutoReply ? 'automation.settings_changed' : 'client.settings_updated', resourceType: 'ClientSettings', resourceId: updated.id, clientId, before: current, after: updated });
  return updated;
}

export async function getClientSettings(organizationId: string, clientId: string) {
  const { db } = getInfra();
  const settings = await db.clientSettings.findFirst({ where: { clientId, organizationId } });
  return settings ?? db.clientSettings.create({ data: { clientId, organizationId } });
}
