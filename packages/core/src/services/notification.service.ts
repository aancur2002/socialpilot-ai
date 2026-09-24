import { roleHasPermission, type Permission } from '@socialpilot/auth';
import type { NotificationType, Prisma } from '@socialpilot/database';
import type { AuthContext } from '../context';
import { notFound } from '../errors';
import { getInfra } from '../infra';
import { paginate } from '../lib/util';

export interface NotificationInput {
  type: NotificationType;
  title: string;
  body?: string;
  link?: string;
  data?: Record<string, unknown>;
}

/** Event types that should also be delivered by email. */
const EMAIL_TYPES: NotificationType[] = ['POST_FAILED', 'AI_ESCALATION', 'TOKEN_EXPIRED', 'INTEGRATION_DISCONNECTED', 'APPROVAL_REQUIRED', 'NEW_LEAD'];

/**
 * Notifies every member who holds `permission` and can access the client.
 * Returns the created notification ids.
 */
export async function notifyClientMembers(organizationId: string, clientId: string | null, permission: Permission, input: NotificationInput, opts: { userIds?: string[] } = {}): Promise<string[]> {
  const { db, queues, logger } = getInfra();
  const members = await db.organizationMember.findMany({
    where: { organizationId, ...(opts.userIds ? { userId: { in: opts.userIds } } : {}) },
    include: { clients: { select: { clientId: true } }, user: { select: { disabledAt: true } } },
  });
  const recipients = members.filter((m) => {
    if (m.user.disabledAt) return false;
    if (!roleHasPermission(m.role, permission)) return false;
    if (!clientId) return true;
    const allClients = m.role === 'ORG_OWNER' || m.role === 'ORG_ADMIN' || m.clientAccess === 'ALL';
    return allClients || m.clients.some((c) => c.clientId === clientId);
  });
  const ids: string[] = [];
  for (const m of recipients) {
    const n = await db.notification.create({
      data: {
        organizationId,
        userId: m.userId,
        clientId,
        type: input.type,
        title: input.title.slice(0, 200),
        body: input.body?.slice(0, 1000),
        link: input.link,
        data: (input.data ?? {}) as Prisma.InputJsonValue,
        emailStatus: EMAIL_TYPES.includes(input.type) ? 'PENDING' : 'NOT_REQUIRED',
      },
    });
    ids.push(n.id);
    if (n.emailStatus === 'PENDING') {
      await queues.add('notifications', { notificationId: n.id }).catch((error: unknown) => logger.warn({ error: String(error) }, 'could not enqueue notification email'));
    }
  }
  return ids;
}

export async function listNotifications(ctx: AuthContext, query: { unreadOnly?: boolean; limit: number; cursor?: string }) {
  const { db } = getInfra();
  const rows = await db.notification.findMany({
    where: { userId: ctx.userId, organizationId: ctx.organizationId, ...(query.unreadOnly ? { readAt: null } : {}) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });
  const unread = await db.notification.count({ where: { userId: ctx.userId, organizationId: ctx.organizationId, readAt: null } });
  return { ...paginate(rows, query.limit), unread };
}

export async function markNotificationsRead(ctx: AuthContext, ids: string[] | 'all') {
  const where: Prisma.NotificationWhereInput = { userId: ctx.userId, organizationId: ctx.organizationId, readAt: null };
  if (ids !== 'all') where.id = { in: ids };
  const res = await getInfra().db.notification.updateMany({ where, data: { readAt: new Date() } });
  return { updated: res.count };
}

/** Email delivery hook (worker). EMAIL_DRIVER=log writes the email to the log; smtp is pluggable. */
export async function deliverNotificationEmail(notificationId: string): Promise<void> {
  const { db, env, logger } = getInfra();
  const n = await db.notification.findUnique({ where: { id: notificationId }, include: { user: { select: { email: true, name: true } } } });
  if (!n) throw notFound('Notification');
  if (n.emailStatus !== 'PENDING') return;
  const link = n.link ? `${env.APP_URL}${n.link}` : env.APP_URL;
  if (env.EMAIL_DRIVER === 'log') {
    logger.info({ to: n.user.email, subject: n.title, link, notificationId }, 'email (log driver)');
  } else {
    // SMTP delivery is intentionally not bundled; plug a transport here (e.g. nodemailer with SMTP_URL).
    throw new Error('SMTP email driver is not implemented yet — set EMAIL_DRIVER=log');
  }
  await db.notification.update({ where: { id: notificationId }, data: { emailStatus: 'SENT' } });
}
