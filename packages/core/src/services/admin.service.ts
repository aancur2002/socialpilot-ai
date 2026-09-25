import { forbidden } from '../errors';
import { getInfra } from '../infra';
import { readinessReport } from '../health';
import { getSocial } from './platform-credentials.service';

/**
 * Super-admin (platform operator) views. Deliberately exposes counts and
 * metadata only — never customer message contents or credentials.
 */
function assertSuperAdmin(user: { isSuperAdmin: boolean }) {
  if (!user.isSuperAdmin) throw forbidden('Super admin only');
}

export async function adminOverview(user: { isSuperAdmin: boolean }) {
  assertSuperAdmin(user);
  const { db } = getInfra();
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [organizations, users, clients, socialAccounts, byPlatform, aiGenerations, aiByStatus, webhookFailed] = await Promise.all([
    db.organization.count(),
    db.user.count(),
    db.client.count(),
    db.socialAccount.count({ where: { status: { not: 'DISCONNECTED' } } }),
    db.socialAccount.groupBy({ by: ['platform', 'status', 'isMock'], _count: { _all: true } }),
    db.aiGeneration.count({ where: { createdAt: { gte: since } } }),
    db.aiGeneration.groupBy({ by: ['provider', 'status'], where: { createdAt: { gte: since } }, _count: { _all: true }, _sum: { inputTokens: true, outputTokens: true } }),
    db.webhookEvent.count({ where: { status: 'FAILED' } }),
  ]);
  return {
    totals: { organizations, users, clients, socialAccounts, aiGenerations30d: aiGenerations, failedWebhooks: webhookFailed },
    integrations: byPlatform.map((r) => ({ platform: r.platform, status: r.status, isMock: r.isMock, count: r._count._all })),
    aiUsage: aiByStatus.map((r) => ({ provider: r.provider, status: r.status, count: r._count._all, inputTokens: r._sum.inputTokens ?? 0, outputTokens: r._sum.outputTokens ?? 0 })),
    platforms: (await getSocial()).statuses().map((s) => ({ platform: s.platform, implemented: s.implemented, configured: s.configured, verification: s.verification })),
  };
}

export async function adminOrganizations(user: { isSuperAdmin: boolean }) {
  assertSuperAdmin(user);
  return getInfra().db.organization.findMany({
    select: { id: true, name: true, slug: true, plan: true, subscriptionStatus: true, createdAt: true, _count: { select: { members: true, clients: true } } },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });
}

export async function adminUsers(user: { isSuperAdmin: boolean }) {
  assertSuperAdmin(user);
  return getInfra().db.user.findMany({
    select: { id: true, email: true, name: true, isSuperAdmin: true, lastLoginAt: true, disabledAt: true, createdAt: true, _count: { select: { memberships: true } } },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });
}

export async function adminQueues(user: { isSuperAdmin: boolean }) {
  assertSuperAdmin(user);
  const { queues } = getInfra();
  const out = [];
  for (const q of queues.all()) {
    const counts = await q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
    const failed = await q.getFailed(0, 19);
    out.push({
      name: q.name,
      counts,
      // Job payloads contain only ids; failure reasons are truncated.
      recentFailures: failed.map((j) => ({ id: j.id, attemptsMade: j.attemptsMade, failedReason: j.failedReason?.slice(0, 300), timestamp: j.timestamp, data: j.data })),
    });
  }
  return out;
}

export async function adminAuditLogs(user: { isSuperAdmin: boolean }, limit = 100) {
  assertSuperAdmin(user);
  return getInfra().db.auditLog.findMany({
    select: { id: true, organizationId: true, clientId: true, userId: true, action: true, resourceType: true, resourceId: true, ip: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 500),
  });
}

export async function adminHealth(user: { isSuperAdmin: boolean }) {
  assertSuperAdmin(user);
  return readinessReport();
}
