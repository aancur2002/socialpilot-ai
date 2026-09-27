import type { Intent, LeadStatus, Platform, Prisma } from '@socialpilot/database';
import { emitLeadEvent } from './lead-capture.service';
import { requirePermission, systemContext, tenantWhere, type AuthContext, type ServiceContext } from '../context';
import { badRequest, notFound } from '../errors';
import { getInfra } from '../infra';
import { paginate } from '../lib/util';
import { audit } from './audit.service';
import { runAutomationForEvent } from './automation.service';
import { getClient } from './client.service';
import { notifyClientMembers } from './notification.service';

const leadInclude = {
  contact: { select: { id: true, name: true, username: true, email: true, phone: true, platform: true } },
  conversation: { select: { id: true, platform: true, lastMessagePreview: true } },
  notes: { orderBy: { createdAt: 'desc' }, take: 50 },
  client: { select: { id: true, name: true } },
} satisfies Prisma.LeadInclude;

export async function listLeads(ctx: ServiceContext, query: { clientId?: string; status?: LeadStatus; search?: string; limit: number; cursor?: string }) {
  requirePermission(ctx, 'leads:view');
  const where: Prisma.LeadWhereInput = { ...tenantWhere(ctx, query.clientId) };
  if (query.status) where.status = query.status;
  if (query.search) {
    where.OR = ['name', 'username', 'email', 'phone', 'interest'].map((f) => ({ [f]: { contains: query.search, mode: 'insensitive' } }));
  }
  const rows = await getInfra().db.lead.findMany({
    where,
    include: { contact: { select: { name: true, username: true } }, client: { select: { name: true } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });
  return paginate(rows, query.limit);
}

export async function pipeline(ctx: ServiceContext, clientId?: string) {
  requirePermission(ctx, 'leads:view');
  const grouped = await getInfra().db.lead.groupBy({ by: ['status'], where: tenantWhere(ctx, clientId), _count: { _all: true }, _sum: { value: true } });
  const leads = await getInfra().db.lead.findMany({
    where: { ...tenantWhere(ctx, clientId), status: { notIn: ['LOST'] } },
    select: { id: true, name: true, username: true, platform: true, interest: true, status: true, value: true, createdAt: true, assignedToId: true, clientId: true },
    orderBy: { updatedAt: 'desc' },
    take: 500,
  });
  return { stages: grouped.map((g) => ({ status: g.status, count: g._count._all, value: g._sum.value ?? 0 })), leads };
}

export async function getLead(ctx: ServiceContext, id: string) {
  requirePermission(ctx, 'leads:view');
  const lead = await getInfra().db.lead.findFirst({ where: { id, ...tenantWhere(ctx) }, include: leadInclude });
  if (!lead) throw notFound('Lead');
  return lead;
}

async function assertAssignee(organizationId: string, userId: string | null | undefined) {
  if (!userId) return;
  const m = await getInfra().db.organizationMember.findUnique({ where: { organizationId_userId: { organizationId, userId } } });
  if (!m) throw badRequest('Assignee is not a member of this organization');
}

export async function createLead(
  ctx: AuthContext,
  input: {
    clientId: string; contactId?: string | null; conversationId?: string | null; name?: string | null; username?: string | null; platform?: Platform | null; source: string;
    email?: string | null; phone?: string | null; interest?: string | null; intent?: Intent | null; status: LeadStatus; value?: number | null; assignedToId?: string | null;
  },
) {
  requirePermission(ctx, 'leads:manage');
  await getClient(ctx, input.clientId);
  const { db } = getInfra();
  if (input.contactId && !(await db.contact.findFirst({ where: { id: input.contactId, clientId: input.clientId, organizationId: ctx.organizationId } }))) throw badRequest('Contact not found for this client');
  if (input.conversationId && !(await db.conversation.findFirst({ where: { id: input.conversationId, clientId: input.clientId, organizationId: ctx.organizationId } }))) throw badRequest('Conversation not found for this client');
  await assertAssignee(ctx.organizationId, input.assignedToId);
  const lead = await db.lead.create({ data: { ...input, email: input.email || null, organizationId: ctx.organizationId } });
  await audit(ctx, { action: 'lead.created', resourceType: 'Lead', resourceId: lead.id, clientId: input.clientId, after: { source: input.source, status: input.status } });
  await emitLeadEvent(ctx.organizationId, input.clientId, 'lead.created', lead.id);
  return getLead(ctx, lead.id);
}

export async function updateLead(ctx: AuthContext, id: string, input: Partial<{ name: string | null; username: string | null; platform: Platform | null; email: string | null; phone: string | null; interest: string | null; intent: Intent | null; status: LeadStatus; value: number | null; assignedToId: string | null; company: string | null; message: string | null; tags: string[]; followUpAt: Date | null; lostReason: string | null }>) {
  requirePermission(ctx, 'leads:manage');
  const before = await getLead(ctx, id);
  await assertAssignee(ctx.organizationId, input.assignedToId);
  await getInfra().db.lead.update({
    where: { id },
    data: {
      ...input,
      ...(input.email !== undefined ? { email: input.email?.toLowerCase() || null } : {}),
      // A new follow-up date gets its own reminder.
      ...(input.followUpAt !== undefined ? { followUpNotifiedAt: null } : {}),
      ...(input.tags ? { tags: [...new Set(input.tags.map((t) => t.trim()).filter(Boolean))] } : {}),
    },
  });
  const statusChanged = Boolean(input.status && input.status !== before.status);
  await emitLeadEvent(ctx.organizationId, before.clientId, statusChanged ? 'lead.status_changed' : 'lead.updated', id);
  await audit(ctx, { action: input.status && input.status !== before.status ? 'lead.status_changed' : 'lead.updated', resourceType: 'Lead', resourceId: id, clientId: before.clientId, before: { status: before.status, assignedToId: before.assignedToId }, after: input });
  return getLead(ctx, id);
}

export async function addLeadNote(ctx: AuthContext, id: string, body: string) {
  requirePermission(ctx, 'leads:manage');
  const lead = await getLead(ctx, id);
  const note = await getInfra().db.leadNote.create({ data: { leadId: id, authorId: ctx.userId, body } });
  await audit(ctx, { action: 'lead.note_added', resourceType: 'Lead', resourceId: id, clientId: lead.clientId });
  return note;
}

/**
 * Creates or enriches the lead for a conversation from AI extraction.
 * One open lead per conversation — later messages fill in missing details.
 */
export async function upsertDetectedLead(input: {
  organizationId: string; clientId: string; conversationId: string; contactId: string; platform: Platform; intent: Intent; confidence: number;
  name?: string | null; username?: string | null; email?: string | null; phone?: string | null; interest?: string | null;
}): Promise<{ leadId: string; created: boolean }> {
  const { db } = getInfra();
  const existing = await db.lead.findFirst({ where: { conversationId: input.conversationId, organizationId: input.organizationId, status: { notIn: ['WON', 'LOST'] } } });
  if (existing) {
    await db.lead.update({
      where: { id: existing.id },
      data: {
        name: existing.name ?? input.name,
        email: existing.email ?? input.email,
        phone: existing.phone ?? input.phone,
        interest: existing.interest ?? input.interest,
        confidence: Math.max(existing.confidence ?? 0, input.confidence),
      },
    });
    await emitLeadEvent(input.organizationId, input.clientId, 'lead.updated', existing.id);
    return { leadId: existing.id, created: false };
  }
  const lead = await db.lead.create({
    data: {
      organizationId: input.organizationId,
      clientId: input.clientId,
      conversationId: input.conversationId,
      contactId: input.contactId,
      platform: input.platform,
      source: `ai:${input.platform.toLowerCase()}`,
      name: input.name,
      username: input.username,
      email: input.email,
      phone: input.phone,
      interest: input.interest,
      intent: input.intent,
      confidence: input.confidence,
    },
  });
  if (input.email || input.phone) {
    await db.contact.update({ where: { id: input.contactId }, data: { ...(input.email ? { email: input.email } : {}), ...(input.phone ? { phone: input.phone } : {}) } });
  }
  await audit(systemContext(input.organizationId), { action: 'lead.detected', resourceType: 'Lead', resourceId: lead.id, clientId: input.clientId, after: { intent: input.intent, confidence: input.confidence } });
  await notifyClientMembers(input.organizationId, input.clientId, 'leads:view', {
    type: 'NEW_LEAD',
    title: `New lead from ${input.platform}`,
    body: `${input.name ?? input.username ?? 'A customer'}${input.interest ? ` — ${input.interest}` : ''}`.slice(0, 300),
    link: `/leads/${lead.id}`,
  });
  await runAutomationForEvent({ trigger: 'LEAD_CREATED', organizationId: input.organizationId, clientId: input.clientId, resourceType: 'Lead', resourceId: lead.id, facts: { intent: input.intent, confidence: input.confidence, platform: input.platform, leadDetected: true } });
  await emitLeadEvent(input.organizationId, input.clientId, 'lead.created', lead.id);
  return { leadId: lead.id, created: true };
}

// ── Contacts ────────────────────────────────────────────────────────────

export async function listContacts(ctx: ServiceContext, query: { clientId?: string; search?: string; limit: number; cursor?: string }) {
  requirePermission(ctx, 'leads:view');
  const where: Prisma.ContactWhereInput = { ...tenantWhere(ctx, query.clientId) };
  if (query.search) where.OR = ['name', 'username', 'email', 'phone'].map((f) => ({ [f]: { contains: query.search, mode: 'insensitive' } }));
  const rows = await getInfra().db.contact.findMany({
    where,
    include: { _count: { select: { conversations: true, leads: true } }, client: { select: { name: true } } },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });
  return paginate(rows, query.limit);
}

export async function getContact(ctx: ServiceContext, id: string) {
  requirePermission(ctx, 'leads:view');
  const contact = await getInfra().db.contact.findFirst({
    where: { id, ...tenantWhere(ctx) },
    include: { conversations: { select: { id: true, platform: true, lastMessagePreview: true, lastMessageAt: true, status: true }, orderBy: { lastMessageAt: 'desc' } }, leads: true },
  });
  if (!contact) throw notFound('Contact');
  return contact;
}

export async function createContact(ctx: AuthContext, input: { clientId: string; platform: Platform; platformUserId?: string | null; name?: string | null; username?: string | null; email?: string | null; phone?: string | null; notes?: string | null; tags: string[] }) {
  requirePermission(ctx, 'leads:manage');
  await getClient(ctx, input.clientId);
  const contact = await getInfra().db.contact.create({ data: { ...input, email: input.email || null, organizationId: ctx.organizationId } });
  await audit(ctx, { action: 'contact.created', resourceType: 'Contact', resourceId: contact.id, clientId: input.clientId });
  return contact;
}

export async function updateContact(ctx: AuthContext, id: string, input: Partial<{ name: string | null; username: string | null; email: string | null; phone: string | null; notes: string | null; tags: string[] }>) {
  requirePermission(ctx, 'leads:manage');
  const before = await getContact(ctx, id);
  const contact = await getInfra().db.contact.update({ where: { id }, data: { ...input, ...(input.email !== undefined ? { email: input.email || null } : {}) } });
  await audit(ctx, { action: 'contact.updated', resourceType: 'Contact', resourceId: id, clientId: before.clientId, after: input });
  return contact;
}
