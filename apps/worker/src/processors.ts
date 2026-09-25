import {
  collectAccountAnalytics,
  deliverNotificationEmail,
  executePublish,
  getInfra,
  getSocial,
  processInboundMessage,
  processKnowledgeSource,
  processWebhookEvent,
  sendQueuedSuggestion,
  sweepDueScheduledPosts,
  TokenService,
  type JobPayloads,
} from '@socialpilot/core';
import { DelayedError, type Job } from 'bullmq';

/** Publishing: retries (with exponential backoff) only for retryable errors; rate limits delay without consuming an attempt. */
export async function publishProcessor(job: Job<JobPayloads['publish']>, token?: string) {
  const outcome = await executePublish(job.data.scheduledPostId, job.attemptsMade + 1);
  switch (outcome.status) {
    case 'rate_limited':
      await job.moveToDelayed(Date.now() + Math.max(1000, outcome.retryAfterMs), token);
      throw new DelayedError();
    case 'retry':
      throw new Error(outcome.error);
    default:
      return outcome;
  }
}

export async function webhookProcessor(job: Job<JobPayloads['webhook']>) {
  await processWebhookEvent(job.data.webhookEventId);
}

export async function aiReplyProcessor(job: Job<JobPayloads['ai-reply']>) {
  const { messageId } = job.data;
  if (messageId.startsWith('send:')) return sendQueuedSuggestion(messageId.slice('send:'.length));
  return processInboundMessage(messageId);
}

export async function knowledgeProcessor(job: Job<JobPayloads['knowledge']>) {
  await processKnowledgeSource(job.data.sourceId);
}

export async function notificationProcessor(job: Job<JobPayloads['notifications']>) {
  await deliverNotificationEmail(job.data.notificationId);
}

export async function analyticsProcessor(job: Job<JobPayloads['analytics']>) {
  const { db, queues } = getInfra();
  if ('sweep' in job.data) {
    // Collect today's metrics for every active account (one job per account).
    const now = new Date();
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const accounts = await db.socialAccount.findMany({ where: { status: 'ACTIVE' }, select: { id: true, capabilities: true } });
    for (const a of accounts) {
      if ((a.capabilities as { analytics?: boolean })?.analytics) {
        await queues.add('analytics', { socialAccountId: a.id, from: from.toISOString(), to: now.toISOString() }, { attempts: 3, backoff: { type: 'exponential', delay: 60_000 } });
      }
    }
    return { accounts: accounts.length };
  }
  return collectAccountAnalytics(job.data.socialAccountId, new Date(job.data.from), new Date(job.data.to));
}

export async function maintenanceProcessor(job: Job<JobPayloads['maintenance']>) {
  const { db, logger } = getInfra();
  const social = await getSocial();
  switch (job.data.task) {
    case 'sweep-scheduled':
      return { enqueued: await sweepDueScheduledPosts() };
    case 'refresh-tokens': {
      // Refresh tokens expiring within 24 hours for platforms that support refresh.
      const soon = new Date(Date.now() + 24 * 3600 * 1000);
      const tokens = await db.socialToken.findMany({
        where: { revokedAt: null, expiresAt: { lte: soon }, socialAccount: { status: 'ACTIVE' } },
        include: { socialAccount: true },
        take: 200,
      });
      let refreshed = 0;
      for (const t of tokens) {
        try {
          const adapter = social.forAccount({ platform: t.socialAccount.platform, isMock: t.socialAccount.isMock });
          if (!adapter.getCapabilities().tokenRefresh) continue;
          await TokenService.ensureFresh(t.socialAccount, adapter);
          refreshed++;
        } catch (error) {
          logger.warn({ socialAccountId: t.socialAccountId, platform: t.socialAccount.platform, error: error instanceof Error ? error.message : String(error) }, 'token refresh failed');
        }
      }
      return { checked: tokens.length, refreshed };
    }
    case 'cleanup': {
      const [sessions, states] = await Promise.all([
        db.session.deleteMany({ where: { OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { lt: new Date(Date.now() - 7 * 86_400_000) } }] } }),
        db.oAuthState.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 86_400_000) } } }),
      ]);
      return { sessions: sessions.count, oauthStates: states.count };
    }
  }
}
