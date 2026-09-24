import type { Prisma } from '@socialpilot/database';
import { getPlatformCapabilities, isSocialApiError, SocialApiError, validateContentForPlatform } from '@socialpilot/social';
import { systemContext } from '../context';
import { getInfra } from '../infra';
import { audit } from './audit.service';
import { mediaRefs } from './content.service';
import { runAutomationForEvent } from './automation.service';
import { notifyClientMembers } from './notification.service';
import { incrementUsage } from './organization.service';
import { flagReauthRequired, loadAdapterAccount } from './social.service';

export type PublishOutcome =
  | { status: 'published'; platformPostId: string }
  | { status: 'skipped'; reason: string }
  | { status: 'rate_limited'; retryAfterMs: number }
  | { status: 'retry'; error: string }
  | { status: 'failed'; error: string };

/** A stale PUBLISHING claim older than this is never re-published automatically (outcome unknown). */
const STALE_PUBLISHING_MS = 15 * 60 * 1000;

async function recomputeContentStatus(tx: Prisma.TransactionClient, contentId: string) {
  // Serialize concurrent publishers of the same content so the last one sees every sibling's result.
  await tx.$queryRaw`SELECT id FROM "Content" WHERE id = ${contentId} FOR UPDATE`;
  const posts = await tx.scheduledPost.findMany({ where: { contentId, status: { not: 'CANCELLED' } }, select: { status: true } });
  if (!posts.length) return;
  const s = posts.map((p) => p.status);
  const status = s.includes('PUBLISHING')
    ? 'PUBLISHING'
    : s.every((x) => x === 'PUBLISHED')
      ? 'PUBLISHED'
      : s.some((x) => x === 'SCHEDULED' || x === 'QUEUED')
        ? 'SCHEDULED'
        : 'FAILED';
  await tx.content.update({ where: { id: contentId }, data: { status } });
}

async function markFailed(scheduledPostId: string, error: string, code: string | undefined) {
  const { db } = getInfra();
  const post = await db.$transaction(async (tx) => {
    const p = await tx.scheduledPost.update({ where: { id: scheduledPostId }, data: { status: 'FAILED', lastError: error.slice(0, 1000), lastErrorCode: code ?? null }, include: { content: { select: { title: true } }, socialAccount: { select: { platform: true, displayName: true } } } });
    await tx.contentVariant.update({ where: { id: p.variantId }, data: { status: 'FAILED' } });
    await recomputeContentStatus(tx, p.contentId);
    await audit(systemContext(p.organizationId), { action: 'post.failed', resourceType: 'ScheduledPost', resourceId: p.id, clientId: p.clientId, after: { error, code, attempts: p.attempts } }, tx);
    return p;
  });
  await notifyClientMembers(post.organizationId, post.clientId, 'content:publish', {
    type: 'POST_FAILED',
    title: `Post failed on ${post.socialAccount.platform}`,
    body: `${post.content.title}: ${error}`.slice(0, 900),
    link: `/content/${post.contentId}`,
  });
  await runAutomationForEvent({ trigger: 'POST_FAILED', organizationId: post.organizationId, clientId: post.clientId, resourceType: 'ScheduledPost', resourceId: post.id, facts: { platform: post.socialAccount.platform } }).catch(() => undefined);
}

/**
 * Publishes one scheduled post. Safe to call repeatedly: a post is claimed
 * atomically, a post that already has a PublishedPost is never re-sent, and a
 * claim whose outcome is unknown (worker crashed mid-publish) is failed for a
 * human to verify rather than risking a duplicate.
 *
 * @param attempt 1-based attempt number (from the queue)
 */
export async function executePublish(scheduledPostId: string, attempt: number): Promise<PublishOutcome> {
  const { db, rateLimits, logger } = getInfra();
  const existing = await db.scheduledPost.findUnique({ where: { id: scheduledPostId }, include: { publishedPost: true } });
  if (!existing) return { status: 'skipped', reason: 'Scheduled post no longer exists' };
  if (existing.publishedPost || existing.status === 'PUBLISHED') return { status: 'skipped', reason: 'Already published' };
  if (existing.status === 'CANCELLED') return { status: 'skipped', reason: 'Cancelled' };
  if (existing.status === 'PUBLISHING') {
    if (existing.publishingAt && Date.now() - existing.publishingAt.getTime() < STALE_PUBLISHING_MS) return { status: 'skipped', reason: 'Another worker is publishing this post' };
    await markFailed(scheduledPostId, 'Publishing was interrupted and the result is unknown. Check the platform before retrying to avoid a duplicate post.', 'UNKNOWN_OUTCOME');
    return { status: 'failed', error: 'Unknown outcome of interrupted publish' };
  }
  if (existing.scheduledAt.getTime() > Date.now() + 5_000) return { status: 'skipped', reason: 'Not due yet' };

  const post = await db.scheduledPost.findUniqueOrThrow({
    where: { id: scheduledPostId },
    include: {
      content: true,
      variant: { include: { media: { include: { media: true }, orderBy: { position: 'asc' } } } },
      socialAccount: true,
    },
  });
  const settings = await db.clientSettings.findUnique({ where: { clientId: post.clientId } });
  const log = logger.child({ organizationId: post.organizationId, clientId: post.clientId, platform: post.socialAccount.platform, scheduledPostId, operation: 'publish' });

  // ── Pre-publish checks (non-retryable) ──
  if (post.content.deletedAt) {
    await db.scheduledPost.update({ where: { id: post.id }, data: { status: 'CANCELLED', lastError: 'Content deleted' } });
    return { status: 'skipped', reason: 'Content deleted' };
  }
  if ((settings?.humanApprovalRequired ?? true) && !post.content.approvedAt) {
    await markFailed(post.id, 'Content is not approved', 'NOT_APPROVED');
    return { status: 'failed', error: 'Content is not approved' };
  }
  if (post.socialAccount.status !== 'ACTIVE') {
    await markFailed(post.id, `Social account is ${post.socialAccount.status.toLowerCase().replace('_', ' ')}; reconnect it and reschedule`, 'ACCOUNT_INACTIVE');
    return { status: 'failed', error: 'Account inactive' };
  }
  const caps = getPlatformCapabilities(post.socialAccount.platform);
  const media = mediaRefs(post.variant);
  const issues = validateContentForPlatform(caps, { platform: post.socialAccount.platform, caption: post.variant.caption, hashtags: post.variant.hashtags, media }).filter(
    (i) => !(post.socialAccount.isMock && i.code === 'MEDIA_NOT_PUBLIC'),
  );
  if (issues.length) {
    await markFailed(post.id, issues.map((i) => i.message).join(' '), 'VALIDATION');
    return { status: 'failed', error: 'Validation failed' };
  }

  // ── Rate limit (does not consume a retry attempt) ──
  const rl = await rateLimits.consume(post.socialAccount.platform, post.socialAccountId, 'publish');
  if (!rl.allowed) {
    await db.scheduledPost.update({ where: { id: post.id }, data: { status: 'QUEUED', lastError: 'Waiting for platform rate limit', lastErrorCode: 'RATE_LIMITED' } });
    return { status: 'rate_limited', retryAfterMs: rl.retryAfterMs };
  }

  // ── Atomic claim ──
  const claimed = await db.scheduledPost.updateMany({
    where: { id: post.id, status: { in: ['SCHEDULED', 'QUEUED', 'FAILED'] } },
    data: { status: 'PUBLISHING', publishingAt: new Date(), attempts: { increment: 1 } },
  });
  if (!claimed.count) return { status: 'skipped', reason: 'Could not claim post (state changed)' };
  await db.$transaction((tx) => recomputeContentStatus(tx, post.contentId));

  try {
    const { adapter, account } = await loadAdapterAccount(post.organizationId, post.socialAccountId);
    const started = Date.now();
    const result = await adapter.publishPost(account, {
      text: post.variant.caption,
      title: post.variant.title,
      hashtags: post.variant.hashtags,
      media,
      idempotencyKey: post.idempotencyKey,
    });
    await db.$transaction(async (tx) => {
      await tx.publishedPost.create({
        data: {
          organizationId: post.organizationId,
          clientId: post.clientId,
          scheduledPostId: post.id,
          socialAccountId: post.socialAccountId,
          platform: post.socialAccount.platform,
          platformPostId: result.platformPostId,
          url: result.url,
          publishedAt: result.publishedAt,
        },
      });
      await tx.scheduledPost.update({ where: { id: post.id }, data: { status: 'PUBLISHED', lastError: null, lastErrorCode: null } });
      await tx.contentVariant.update({ where: { id: post.variantId }, data: { status: 'PUBLISHED' } });
      await recomputeContentStatus(tx, post.contentId);
      await audit(systemContext(post.organizationId), { action: 'post.published', resourceType: 'ScheduledPost', resourceId: post.id, clientId: post.clientId, after: { platform: post.socialAccount.platform, platformPostId: result.platformPostId, isMock: post.socialAccount.isMock } }, tx);
    });
    await incrementUsage(post.organizationId, 'posts');
    log.info({ durationMs: Date.now() - started, success: true, platformPostId: result.platformPostId }, 'post published');
    return { status: 'published', platformPostId: result.platformPostId };
  } catch (error) {
    const err = isSocialApiError(error)
      ? error
      : new SocialApiError({ platform: post.socialAccount.platform, code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error), retryable: false });
    log.warn({ success: false, code: err.code, retryable: err.retryable, attempt, error: err.message }, 'publish attempt failed');

    if (err.requiresReauth) {
      await flagReauthRequired(post.socialAccountId, err.message);
      await markFailed(post.id, `${err.message} — reconnect the account and reschedule.`, err.code);
      return { status: 'failed', error: err.message };
    }
    if (err.code === 'RATE_LIMITED') {
      await rateLimits.cooldown(post.socialAccount.platform, post.socialAccountId, 'publish', err.retryAfterMs ?? 60_000);
    }
    if (err.retryable && attempt < post.maxAttempts) {
      await db.$transaction(async (tx) => {
        await tx.scheduledPost.update({ where: { id: post.id }, data: { status: 'QUEUED', lastError: err.message.slice(0, 1000), lastErrorCode: err.code } });
        await recomputeContentStatus(tx, post.contentId);
      });
      return err.code === 'RATE_LIMITED' ? { status: 'rate_limited', retryAfterMs: err.retryAfterMs ?? 60_000 } : { status: 'retry', error: err.message };
    }
    await markFailed(post.id, err.message, err.code);
    return { status: 'failed', error: err.message };
  }
}

/** Safety net: enqueue due posts whose delayed job was lost (e.g. Redis flushed). */
export async function sweepDueScheduledPosts(): Promise<number> {
  const { db, queues } = getInfra();
  const due = await db.scheduledPost.findMany({ where: { status: 'SCHEDULED', scheduledAt: { lte: new Date(Date.now() - 60_000) } }, take: 200 });
  const queue = queues.get('publish');
  let enqueued = 0;
  for (const p of due) {
    const job = await queue.getJob(p.id);
    if (!job) {
      await queues.add('publish', { scheduledPostId: p.id }, { jobId: p.id, attempts: p.maxAttempts, backoff: { type: 'exponential', delay: 30_000 } });
      enqueued++;
    }
  }
  return enqueued;
}
