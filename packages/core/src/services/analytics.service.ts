import { AnalyticsAgent } from '@socialpilot/ai';
import { Prisma, type Platform } from '@socialpilot/database';
import { requirePermission, tenantWhere, type AuthContext, type ServiceContext } from '../context';
import { AppError } from '../errors';
import { getInfra } from '../infra';
import { startOfDayUtc } from '../lib/util';
import { generationLogger } from './ai-log.service';
import { audit } from './audit.service';
import { getClient } from './client.service';
import { loadAdapterAccount } from './social.service';

export const STANDARD_METRICS = ['reach', 'impressions', 'likes', 'comments', 'shares', 'saves', 'clicks', 'followers', 'engagement', 'views'];
/** Point-in-time metrics: report the latest value, never a sum. */
const LEVEL_METRICS = new Set(['followers']);

/** Metric name normalization across platforms (only renames — never derives values). */
const METRIC_ALIASES: Record<string, string> = {
  page_impressions_unique: 'reach',
  page_post_engagements: 'engagement',
  page_follows: 'followers',
  page_views_total: 'views',
  accounts_engaged: 'engagement',
  total_interactions: 'interactions',
};

// ── Collection (worker) ─────────────────────────────────────────────────

/** Pulls metrics for one account and day range, storing append-only snapshots (upsert per day). */
export async function collectAccountAnalytics(socialAccountId: string, from: Date, to: Date): Promise<{ stored: number; unsupported: string[] }> {
  const { db, rateLimits } = getInfra();
  const account = await db.socialAccount.findUnique({ where: { id: socialAccountId } });
  if (!account || account.status !== 'ACTIVE') return { stored: 0, unsupported: [] };
  const { adapter, account: adapterAccount } = await loadAdapterAccount(account.organizationId, socialAccountId);
  if (!adapter.getCapabilities().analytics) return { stored: 0, unsupported: ['analytics'] };
  const rl = await rateLimits.consume(account.platform, account.id, 'read');
  if (!rl.allowed) throw new Error(`Rate limited; retry in ${rl.retryAfterMs}ms`);

  const posts = await db.publishedPost.findMany({ where: { socialAccountId, publishedAt: { gte: new Date(Date.now() - 30 * 86_400_000) } }, select: { id: true, platformPostId: true } });
  const result = await adapter.getAnalytics(adapterAccount, { from, to }, posts.map((p) => p.platformPostId));
  const date = startOfDayUtc(from);
  const source = account.isMock ? 'MOCK' : 'PLATFORM_API';
  let stored = 0;
  const upsert = async (scopeKey: string, publishedPostId: string | null, metric: string, value: number) => {
    const name = METRIC_ALIASES[metric] ?? metric;
    await db.analyticsSnapshot.upsert({
      where: { socialAccountId_scopeKey_metric_date: { socialAccountId, scopeKey, metric: name, date } },
      create: { organizationId: account.organizationId, clientId: account.clientId, socialAccountId, publishedPostId, scopeKey, platform: account.platform, metric: name, value, date, source },
      update: { value, capturedAt: new Date(), source },
    });
    stored++;
  };
  for (const [metric, value] of Object.entries(result.account)) await upsert('account', null, metric, value);
  for (const p of result.posts) {
    const post = posts.find((x) => x.platformPostId === p.platformPostId);
    if (!post) continue;
    for (const [metric, value] of Object.entries(p.metrics)) await upsert(post.id, post.id, metric, value);
  }
  await db.socialAccount.update({ where: { id: socialAccountId }, data: { lastSyncedAt: new Date() } });
  return { stored, unsupported: result.unsupportedMetrics };
}

// ── Reporting ───────────────────────────────────────────────────────────

interface Range {
  clientId?: string;
  from: Date;
  to: Date;
  platform?: Platform;
}

export async function analyticsOverview(ctx: ServiceContext, range: Range) {
  requirePermission(ctx, 'analytics:view');
  const { db } = getInfra();
  const scope = tenantWhere(ctx, range.clientId);
  const platformFilter = range.platform ? { platform: range.platform } : {};
  const inRange = { gte: range.from, lte: range.to };

  const [published, scheduled, failed, inbound, outbound, aiSent, leads, pendingApprovals, snapshots, escalations] = await Promise.all([
    db.publishedPost.count({ where: { ...scope, ...platformFilter, publishedAt: inRange } }),
    db.scheduledPost.count({ where: { ...scope, status: { in: ['SCHEDULED', 'QUEUED'] }, ...(range.platform ? { socialAccount: { platform: range.platform } } : {}) } }),
    db.scheduledPost.count({ where: { ...scope, status: 'FAILED', updatedAt: inRange, ...(range.platform ? { socialAccount: { platform: range.platform } } : {}) } }),
    db.message.count({ where: { ...scope, direction: 'INBOUND', isSpam: false, createdAt: inRange, ...(range.platform ? { conversation: { platform: range.platform } } : {}) } }),
    db.message.count({ where: { ...scope, direction: 'OUTBOUND', status: 'SENT', createdAt: inRange, ...(range.platform ? { conversation: { platform: range.platform } } : {}) } }),
    db.message.count({ where: { ...scope, direction: 'OUTBOUND', senderType: 'AI', status: 'SENT', createdAt: inRange } }),
    db.lead.count({ where: { ...scope, ...platformFilter, createdAt: inRange } }),
    db.approval.count({ where: { ...scope, status: 'PENDING' } }),
    db.analyticsSnapshot.findMany({ where: { ...scope, ...platformFilter, scopeKey: 'account', date: { gte: startOfDayUtc(range.from), lte: range.to } }, orderBy: { date: 'asc' } }),
    db.escalation.count({ where: { ...scope, createdAt: inRange } }),
  ]);

  // Platform metrics: sum daily values; level metrics use the latest value per account.
  const platformMetrics: Record<string, number> = {};
  const latestLevel = new Map<string, number>();
  for (const s of snapshots) {
    if (LEVEL_METRICS.has(s.metric)) latestLevel.set(`${s.socialAccountId}:${s.metric}`, s.value);
    else platformMetrics[s.metric] = (platformMetrics[s.metric] ?? 0) + s.value;
  }
  for (const [key, value] of latestLevel) {
    const metric = key.split(':')[1]!;
    platformMetrics[metric] = (platformMetrics[metric] ?? 0) + value;
  }
  const present = new Set(Object.keys(platformMetrics));
  const unavailableMetrics = STANDARD_METRICS.filter((m) => !present.has(m));
  const mockDataPresent = snapshots.some((s) => s.source === 'MOCK');

  return {
    range: { from: range.from, to: range.to },
    posts: { published, scheduled, failed, pendingApprovals },
    messages: { inbound, outbound, aiAutoSent: aiSent, escalations, averageFirstResponseMinutes: await averageFirstResponseMinutes(scope, range) },
    leads: { created: leads },
    platformMetrics,
    unavailableMetrics,
    mockDataPresent,
  };
}

/** Mean minutes from a customer's message to the next outbound reply in the same conversation. */
async function averageFirstResponseMinutes(scope: { organizationId: string; clientId?: string | { in: string[] } }, range: Range): Promise<number | null> {
  const clientFilter = typeof scope.clientId === 'string' ? [scope.clientId] : scope.clientId?.in;
  const rows = await getInfra().db.$queryRaw<{ avg: number | null }[]>`
    SELECT AVG(EXTRACT(EPOCH FROM (o."createdAt" - i."createdAt")) / 60.0)::float AS avg
    FROM "Message" i
    JOIN LATERAL (
      SELECT m."createdAt" FROM "Message" m
      WHERE m."conversationId" = i."conversationId" AND m.direction = 'OUTBOUND' AND m.status = 'SENT' AND m."createdAt" > i."createdAt"
      ORDER BY m."createdAt" ASC LIMIT 1
    ) o ON TRUE
    WHERE i."organizationId" = ${scope.organizationId}
      AND i.direction = 'INBOUND' AND i."isSpam" = false
      AND i."createdAt" BETWEEN ${range.from} AND ${range.to}
      ${clientFilter ? (clientFilter.length ? Prisma.sql`AND i."clientId" IN (${Prisma.join(clientFilter)})` : Prisma.sql`AND FALSE`) : Prisma.empty}
  `;
  const avg = rows[0]?.avg;
  return avg === null || avg === undefined ? null : Math.round(avg * 10) / 10;
}

export async function contentPerformance(ctx: ServiceContext, range: Range) {
  requirePermission(ctx, 'analytics:view');
  const { db } = getInfra();
  const posts = await db.publishedPost.findMany({
    where: { ...tenantWhere(ctx, range.clientId), ...(range.platform ? { platform: range.platform } : {}), publishedAt: { gte: range.from, lte: range.to } },
    include: {
      scheduledPost: { select: { content: { select: { id: true, title: true } }, variant: { select: { caption: true } } } },
      analytics: { orderBy: { date: 'desc' } },
      socialAccount: { select: { isMock: true, displayName: true } },
    },
    orderBy: { publishedAt: 'desc' },
    take: 200,
  });
  return posts.map((p) => {
    const metrics: Record<string, number> = {};
    for (const s of p.analytics) if (!(s.metric in metrics)) metrics[s.metric] = s.value; // latest per metric
    const engagementParts = ['likes', 'comments', 'shares', 'saves'].filter((m) => m in metrics);
    return {
      publishedPostId: p.id,
      contentId: p.scheduledPost.content.id,
      title: p.scheduledPost.content.title,
      caption: p.scheduledPost.variant.caption,
      platform: p.platform,
      account: p.socialAccount.displayName,
      isMock: p.socialAccount.isMock,
      url: p.url,
      publishedAt: p.publishedAt,
      metrics,
      engagement: engagementParts.length ? engagementParts.reduce((s, m) => s + metrics[m]!, 0) : null,
    };
  });
}

export async function platformPerformance(ctx: ServiceContext, range: Range) {
  requirePermission(ctx, 'analytics:view');
  const { db } = getInfra();
  const scope = tenantWhere(ctx, range.clientId);
  const [posts, messages, leads] = await Promise.all([
    db.publishedPost.groupBy({ by: ['platform'], where: { ...scope, publishedAt: { gte: range.from, lte: range.to } }, _count: { _all: true } }),
    db.conversation.groupBy({ by: ['platform'], where: { ...scope, lastMessageAt: { gte: range.from, lte: range.to } }, _count: { _all: true } }),
    db.lead.groupBy({ by: ['platform'], where: { ...scope, createdAt: { gte: range.from, lte: range.to } }, _count: { _all: true } }),
  ]);
  const platforms = new Set<string>([...posts, ...messages].map((r) => r.platform));
  for (const l of leads) if (l.platform) platforms.add(l.platform);
  return [...platforms].map((platform) => ({
    platform,
    posts: posts.find((p) => p.platform === platform)?._count._all ?? 0,
    conversations: messages.find((m) => m.platform === platform)?._count._all ?? 0,
    leads: leads.find((l) => l.platform === platform)?._count._all ?? 0,
  }));
}

export async function leadPerformance(ctx: ServiceContext, range: Range) {
  requirePermission(ctx, 'analytics:view');
  const { db } = getInfra();
  const scope = tenantWhere(ctx, range.clientId);
  const where = { ...scope, createdAt: { gte: range.from, lte: range.to } };
  const [byStatus, bySource, total] = await Promise.all([
    db.lead.groupBy({ by: ['status'], where, _count: { _all: true }, _sum: { value: true } }),
    db.lead.groupBy({ by: ['source'], where, _count: { _all: true } }),
    db.lead.count({ where }),
  ]);
  const won = byStatus.find((s) => s.status === 'WON')?._count._all ?? 0;
  return {
    total,
    byStatus: byStatus.map((s) => ({ status: s.status, count: s._count._all, value: s._sum.value ?? 0 })),
    bySource: bySource.map((s) => ({ source: s.source, count: s._count._all })),
    conversionRate: total ? Math.round((won / total) * 1000) / 10 : null,
  };
}

export async function aiPerformance(ctx: ServiceContext, range: Range) {
  requirePermission(ctx, 'analytics:view');
  const { db } = getInfra();
  const where = { ...tenantWhere(ctx, range.clientId), createdAt: { gte: range.from, lte: range.to } };
  const [byDecision, byIntent, avg, escalations] = await Promise.all([
    db.aiReplySuggestion.groupBy({ by: ['decision'], where, _count: { _all: true } }),
    db.aiReplySuggestion.groupBy({ by: ['intent'], where, _count: { _all: true } }),
    db.aiReplySuggestion.aggregate({ where: { ...where, decision: { not: 'SKIPPED' } }, _avg: { confidence: true } }),
    db.escalation.groupBy({ by: ['reason'], where, _count: { _all: true } }),
  ]);
  return {
    byDecision: byDecision.map((d) => ({ decision: d.decision, count: d._count._all })),
    byIntent: byIntent.map((d) => ({ intent: d.intent, count: d._count._all })).sort((a, b) => b.count - a.count),
    averageConfidence: avg._avg.confidence === null ? null : Math.round(avg._avg.confidence * 100) / 100,
    escalationsByReason: escalations.map((e) => ({ reason: e.reason, count: e._count._all })),
    note: 'Confidence is the model’s self-reported certainty used for routing, not a measured accuracy rate.',
  };
}

export async function generateReport(ctx: AuthContext, input: { clientId: string; from: Date; to: Date }) {
  requirePermission(ctx, 'analytics:view');
  const client = await getClient(ctx, input.clientId);
  const overview = await analyticsOverview(ctx, input);
  const days = Math.max(1, Math.round((input.to.getTime() - input.from.getTime()) / 86_400_000));
  const previous = await analyticsOverview(ctx, { clientId: input.clientId, from: new Date(input.from.getTime() - days * 86_400_000), to: input.from });
  const perf = await contentPerformance(ctx, input);
  const flatten = (o: typeof overview) => ({
    postsPublished: o.posts.published,
    postsFailed: o.posts.failed,
    messagesReceived: o.messages.inbound,
    repliesSent: o.messages.outbound,
    aiAutoReplies: o.messages.aiAutoSent,
    escalations: o.messages.escalations,
    averageFirstResponseMinutes: o.messages.averageFirstResponseMinutes,
    leadsDetected: o.leads.created,
    ...o.platformMetrics,
  });
  const metrics = flatten(overview);
  const agent = new AnalyticsAgent(getInfra().ai, generationLogger({ organizationId: ctx.organizationId, clientId: input.clientId, userId: ctx.userId }));
  let summary;
  try {
    summary = await agent.summarize({
      brandName: client.brandProfile?.brandName ?? client.name,
      periodLabel: `${input.from.toISOString().slice(0, 10)} to ${input.to.toISOString().slice(0, 10)}`,
      metrics,
      previousMetrics: flatten(previous),
      topPosts: perf
        .filter((p) => p.engagement !== null)
        .sort((a, b) => (b.engagement ?? 0) - (a.engagement ?? 0))
        .slice(0, 5)
        .map((p) => ({ caption: p.caption, platform: p.platform, metrics: p.metrics })),
      unavailableMetrics: overview.unavailableMetrics,
      mockDataPresent: overview.mockDataPresent,
    });
  } catch (error) {
    throw new AppError('INTEGRATION_ERROR', `AI report generation failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  const report = await getInfra().db.analyticsReport.create({
    data: {
      organizationId: ctx.organizationId,
      clientId: input.clientId,
      periodStart: input.from,
      periodEnd: input.to,
      metrics: metrics as unknown as Prisma.InputJsonValue,
      summary: summary.data as unknown as Prisma.InputJsonValue,
      aiGenerationId: summary.generationId,
      createdById: ctx.userId,
    },
  });
  await audit(ctx, { action: 'analytics.report_generated', resourceType: 'AnalyticsReport', resourceId: report.id, clientId: input.clientId });
  return report;
}

export async function listReports(ctx: ServiceContext, clientId?: string) {
  requirePermission(ctx, 'analytics:view');
  return getInfra().db.analyticsReport.findMany({ where: tenantWhere(ctx, clientId), orderBy: { createdAt: 'desc' }, take: 50 });
}

/** Dashboard cards. */
export async function dashboardSummary(ctx: ServiceContext, clientId?: string) {
  const { db } = getInfra();
  const scope = tenantWhere(ctx, clientId);
  const monthStart = new Date(Date.now() - 30 * 86_400_000);
  const can = (p: Parameters<typeof requirePermission>[1]) => ctx.kind === 'system' || ctx.permissions.has(p);
  const [scheduled, published, unread, newLeads, pendingApprovals, failed, accounts, escalations] = await Promise.all([
    can('content:view') ? db.scheduledPost.count({ where: { ...scope, status: { in: ['SCHEDULED', 'QUEUED'] } } }) : null,
    can('content:view') ? db.publishedPost.count({ where: { ...scope, publishedAt: { gte: monthStart } } }) : null,
    can('messages:view') ? db.conversation.aggregate({ where: { ...scope, status: { not: 'SPAM' } }, _sum: { unreadCount: true } }).then((r) => r._sum.unreadCount ?? 0) : null,
    can('leads:view') ? db.lead.count({ where: { ...scope, status: 'NEW' } }) : null,
    can('content:view') ? db.approval.count({ where: { ...scope, status: 'PENDING' } }) : null,
    can('content:view') ? db.scheduledPost.count({ where: { ...scope, status: 'FAILED', updatedAt: { gte: monthStart } } }) : null,
    can('social_accounts:view') ? db.socialAccount.count({ where: { ...scope, status: { not: 'DISCONNECTED' } } }) : null,
    can('messages:view') ? db.escalation.count({ where: { ...scope, status: 'OPEN' } }) : null,
  ]);
  return { scheduledPosts: scheduled, publishedPosts30d: published, unreadMessages: unread, newLeads, pendingApprovals, failedPosts30d: failed, connectedAccounts: accounts, openEscalations: escalations };
}
