import type { Db, Prisma } from '@socialpilot/database';
import { actorId, tenantWhere, requirePermission, type ServiceContext } from '../context';
import { getInfra } from '../infra';
import { paginate, redactSecrets } from '../lib/util';

export interface AuditEntry {
  action: string;
  resourceType: string;
  resourceId?: string | null;
  clientId?: string | null;
  before?: unknown;
  after?: unknown;
}

const toJson = (v: unknown) => (v === undefined || v === null ? undefined : (JSON.parse(JSON.stringify(redactSecrets(v))) as Prisma.InputJsonValue));

/** Appends an audit record. Pass the transaction client to make it atomic with the change. */
export async function audit(ctx: ServiceContext, entry: AuditEntry, db: Db = getInfra().db): Promise<void> {
  await db.auditLog.create({
    data: {
      organizationId: ctx.organizationId,
      clientId: entry.clientId ?? null,
      userId: actorId(ctx),
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId ?? null,
      before: toJson(entry.before),
      after: toJson(entry.after),
      ip: ctx.kind === 'user' ? ctx.ip : undefined,
      userAgent: ctx.kind === 'user' ? ctx.userAgent?.slice(0, 300) : undefined,
      requestId: ctx.requestId,
    },
  });
}

/** Audit for events outside an organization (login, registration). */
export async function auditGlobal(entry: AuditEntry & { userId?: string | null; ip?: string; userAgent?: string; organizationId?: string | null }): Promise<void> {
  await getInfra().db.auditLog.create({
    data: {
      organizationId: entry.organizationId ?? null,
      userId: entry.userId ?? null,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId ?? null,
      after: toJson(entry.after),
      ip: entry.ip,
      userAgent: entry.userAgent?.slice(0, 300),
    },
  });
}

export async function listAuditLogs(ctx: ServiceContext, query: { clientId?: string; resourceType?: string; limit: number; cursor?: string }) {
  requirePermission(ctx, 'audit:view');
  const scope = tenantWhere(ctx, query.clientId);
  // Organization-level events (clientId null) are visible to members who can see every client.
  const where: Prisma.AuditLogWhereInput =
    query.clientId || (ctx.kind === 'user' && ctx.clientIds !== null)
      ? { organizationId: scope.organizationId, clientId: scope.clientId }
      : { organizationId: ctx.organizationId };
  if (query.resourceType) where.resourceType = query.resourceType;
  const rows = await getInfra().db.auditLog.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    include: { user: { select: { id: true, name: true, email: true } } },
  });
  return paginate(rows, query.limit);
}
