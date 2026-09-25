import { ContentAgent, type BrandContext } from '@socialpilot/ai';
import type { ContentStatus, Platform, Prisma } from '@socialpilot/database';
import { getPlatformCapabilities, validateContentForPlatform, type MediaRef } from '@socialpilot/social';
import type { CreateContentInput, GenerateContentInput, VariantInput } from '@socialpilot/validation';
import { requirePermission, tenantWhere, type AuthContext, type ServiceContext } from '../context';
import { AppError, badRequest, notFound } from '../errors';
import { getInfra } from '../infra';
import { paginate } from '../lib/util';
import { audit } from './audit.service';
import { generationLogger } from './ai-log.service';
import { aiFor } from './ai-settings.service';
import { getClient, getClientSettings } from './client.service';
import { notifyClientMembers } from './notification.service';
import { incrementUsage } from './organization.service';

const contentInclude = {
  variants: { include: { media: { include: { media: true }, orderBy: { position: 'asc' } } }, orderBy: { platform: 'asc' } },
  approvals: { orderBy: { createdAt: 'desc' }, take: 20 },
  scheduledPosts: { include: { publishedPost: true, socialAccount: { select: { id: true, platform: true, displayName: true, isMock: true } } }, orderBy: { scheduledAt: 'asc' } },
  campaign: { select: { id: true, name: true } },
} satisfies Prisma.ContentInclude;

const EDITABLE: ContentStatus[] = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SCHEDULED', 'FAILED', 'CANCELLED'];

async function loadContent(ctx: ServiceContext, id: string) {
  const content = await getInfra().db.content.findFirst({ where: { id, deletedAt: null, ...tenantWhere(ctx) }, include: contentInclude });
  if (!content) throw notFound('Content');
  return content;
}

export async function getContent(ctx: ServiceContext, id: string) {
  requirePermission(ctx, 'content:view');
  return loadContent(ctx, id);
}

export async function listContent(ctx: ServiceContext, query: { clientId?: string; status?: ContentStatus; from?: Date; to?: Date; search?: string; limit: number; cursor?: string }) {
  requirePermission(ctx, 'content:view');
  const where: Prisma.ContentWhereInput = { ...tenantWhere(ctx, query.clientId), deletedAt: null };
  if (query.status) where.status = query.status;
  if (query.search) where.OR = [{ title: { contains: query.search, mode: 'insensitive' } }, { baseContent: { contains: query.search, mode: 'insensitive' } }];
  if (query.from || query.to) where.scheduledAt = { gte: query.from, lte: query.to };
  const rows = await getInfra().db.content.findMany({
    where,
    include: { variants: { select: { id: true, platform: true, status: true } }, client: { select: { id: true, name: true } } },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });
  return paginate(rows, query.limit);
}

async function assertAccountForVariant(ctx: ServiceContext, clientId: string, platform: Platform, socialAccountId: string | null | undefined) {
  if (!socialAccountId) return;
  const account = await getInfra().db.socialAccount.findFirst({ where: { id: socialAccountId, organizationId: ctx.organizationId, clientId } });
  if (!account) throw badRequest('The selected social account does not belong to this client');
  if (account.platform !== platform) throw badRequest(`The selected account is a ${account.platform} account, not ${platform}`);
}

async function assertMediaForClient(ctx: ServiceContext, clientId: string, mediaIds: string[] | undefined) {
  if (!mediaIds?.length) return;
  const count = await getInfra().db.mediaAsset.count({ where: { id: { in: mediaIds }, organizationId: ctx.organizationId, clientId } });
  if (count !== new Set(mediaIds).size) throw badRequest('One or more media files do not belong to this client');
}

function variantData(v: VariantInput) {
  return {
    platform: v.platform,
    socialAccountId: v.socialAccountId ?? null,
    title: v.title ?? null,
    caption: v.caption,
    hashtags: v.hashtags.map((h) => h.replace(/^#/, '')),
    callToAction: v.callToAction ?? null,
    mediaType: v.mediaType ?? null,
    mediaPrompt: v.mediaPrompt ?? null,
  };
}

export async function createContent(ctx: AuthContext, input: CreateContentInput, meta: { aiGenerated?: boolean; aiGenerationId?: string; missingInfo?: string[] } = {}) {
  requirePermission(ctx, 'content:create');
  await getClient(ctx, input.clientId);
  for (const v of input.variants) {
    await assertAccountForVariant(ctx, input.clientId, v.platform, v.socialAccountId);
    await assertMediaForClient(ctx, input.clientId, v.mediaIds);
  }
  if (input.campaignId) {
    const campaign = await getInfra().db.campaign.findFirst({ where: { id: input.campaignId, organizationId: ctx.organizationId, clientId: input.clientId } });
    if (!campaign) throw badRequest('Campaign not found for this client');
  }
  const content = await getInfra().db.$transaction(async (tx) => {
    const created = await tx.content.create({
      data: {
        organizationId: ctx.organizationId,
        clientId: input.clientId,
        campaignId: input.campaignId ?? null,
        title: input.title,
        topic: input.topic ?? null,
        objective: input.objective ?? null,
        contentType: input.contentType,
        baseContent: input.baseContent,
        createdById: ctx.userId,
        aiGenerated: meta.aiGenerated ?? false,
        aiGenerationId: meta.aiGenerationId,
        missingInfo: meta.missingInfo ?? [],
      },
    });
    for (const v of input.variants) {
      const variant = await tx.contentVariant.create({ data: { ...variantData(v), organizationId: ctx.organizationId, clientId: input.clientId, contentId: created.id } });
      if (v.mediaIds?.length) await tx.variantMedia.createMany({ data: v.mediaIds.map((mediaId, position) => ({ variantId: variant.id, mediaId, position })) });
    }
    await audit(ctx, { action: meta.aiGenerated ? 'content.ai_generated' : 'content.created', resourceType: 'Content', resourceId: created.id, clientId: input.clientId, after: { title: input.title, variants: input.variants.map((v) => v.platform) } }, tx);
    return created;
  });
  return loadContent(ctx, content.id);
}

/** Editing approved/scheduled content sends it back to draft so it must be re-approved. */
async function resetApprovalOnEdit(tx: Prisma.TransactionClient, content: { id: string; status: ContentStatus }) {
  if (content.status === 'APPROVED' || content.status === 'SCHEDULED' || content.status === 'PENDING_APPROVAL') {
    await tx.scheduledPost.updateMany({ where: { contentId: content.id, status: { in: ['SCHEDULED', 'QUEUED'] } }, data: { status: 'CANCELLED', lastError: 'Content edited after approval' } });
    await tx.approval.updateMany({ where: { contentId: content.id, status: 'PENDING' }, data: { status: 'CANCELLED' } });
    await tx.content.update({ where: { id: content.id }, data: { status: 'DRAFT', approvedById: null, approvedAt: null } });
    await tx.contentVariant.updateMany({ where: { contentId: content.id }, data: { status: 'DRAFT' } });
  }
}

export async function updateContent(ctx: AuthContext, id: string, input: Partial<Omit<CreateContentInput, 'clientId' | 'variants'>>) {
  requirePermission(ctx, 'content:edit');
  const before = await loadContent(ctx, id);
  if (!EDITABLE.includes(before.status)) throw badRequest(`Content that is ${before.status.toLowerCase()} cannot be edited`);
  await getInfra().db.$transaction(async (tx) => {
    await tx.content.update({ where: { id }, data: { ...input, campaignId: input.campaignId === undefined ? undefined : input.campaignId } });
    await resetApprovalOnEdit(tx, before);
    await audit(ctx, { action: 'content.edited', resourceType: 'Content', resourceId: id, clientId: before.clientId, before: { title: before.title, baseContent: before.baseContent, status: before.status }, after: input }, tx);
  });
  return loadContent(ctx, id);
}

export async function upsertVariant(ctx: AuthContext, contentId: string, input: VariantInput, variantId?: string) {
  requirePermission(ctx, 'content:edit');
  const content = await loadContent(ctx, contentId);
  if (!EDITABLE.includes(content.status)) throw badRequest(`Content that is ${content.status.toLowerCase()} cannot be edited`);
  await assertAccountForVariant(ctx, content.clientId, input.platform, input.socialAccountId);
  await assertMediaForClient(ctx, content.clientId, input.mediaIds);
  const existing = variantId ? content.variants.find((v) => v.id === variantId) : undefined;
  if (variantId && !existing) throw notFound('Variant');
  await getInfra().db.$transaction(async (tx) => {
    const variant = existing
      ? await tx.contentVariant.update({ where: { id: existing.id }, data: { ...variantData(input), platform: existing.platform } })
      : await tx.contentVariant.create({ data: { ...variantData(input), organizationId: ctx.organizationId, clientId: content.clientId, contentId } });
    if (input.mediaIds) {
      await tx.variantMedia.deleteMany({ where: { variantId: variant.id } });
      await tx.variantMedia.createMany({ data: input.mediaIds.map((mediaId, position) => ({ variantId: variant.id, mediaId, position })) });
    }
    await resetApprovalOnEdit(tx, content);
    await audit(ctx, { action: existing ? 'content.variant_edited' : 'content.variant_added', resourceType: 'ContentVariant', resourceId: variant.id, clientId: content.clientId, before: existing ? { caption: existing.caption, hashtags: existing.hashtags } : undefined, after: { platform: variant.platform, caption: variant.caption } }, tx);
  });
  return loadContent(ctx, contentId);
}

export async function deleteVariant(ctx: AuthContext, contentId: string, variantId: string) {
  requirePermission(ctx, 'content:edit');
  const content = await loadContent(ctx, contentId);
  const variant = content.variants.find((v) => v.id === variantId);
  if (!variant) throw notFound('Variant');
  await getInfra().db.$transaction(async (tx) => {
    await tx.contentVariant.delete({ where: { id: variantId } });
    await audit(ctx, { action: 'content.variant_deleted', resourceType: 'ContentVariant', resourceId: variantId, clientId: content.clientId, before: { platform: variant.platform } }, tx);
  });
  return loadContent(ctx, contentId);
}

export async function deleteContent(ctx: AuthContext, id: string) {
  requirePermission(ctx, 'content:delete');
  const content = await loadContent(ctx, id);
  if (content.status === 'PUBLISHING') throw badRequest('Content is being published right now; try again in a moment');
  await getInfra().db.$transaction(async (tx) => {
    await tx.scheduledPost.updateMany({ where: { contentId: id, status: { in: ['SCHEDULED', 'QUEUED'] } }, data: { status: 'CANCELLED', lastError: 'Content deleted' } });
    await tx.content.update({ where: { id }, data: { deletedAt: new Date(), status: content.status === 'PUBLISHED' ? 'PUBLISHED' : 'CANCELLED' } });
    await audit(ctx, { action: 'content.deleted', resourceType: 'Content', resourceId: id, clientId: content.clientId, before: { title: content.title, status: content.status } }, tx);
  });
}

export async function duplicateContent(ctx: AuthContext, id: string) {
  requirePermission(ctx, 'content:create');
  const src = await loadContent(ctx, id);
  return createContent(ctx, {
    clientId: src.clientId,
    campaignId: src.campaignId,
    title: `${src.title} (copy)`.slice(0, 200),
    topic: src.topic,
    objective: src.objective,
    contentType: src.contentType,
    baseContent: src.baseContent,
    variants: src.variants.map((v) => ({
      platform: v.platform,
      socialAccountId: v.socialAccountId,
      title: v.title,
      caption: v.caption,
      hashtags: v.hashtags,
      callToAction: v.callToAction,
      mediaType: (v.mediaType as VariantInput['mediaType']) ?? null,
      mediaPrompt: v.mediaPrompt,
      mediaIds: v.media.map((m) => m.mediaId),
    })),
  });
}

// ── AI generation ───────────────────────────────────────────────────────

export function brandContext(brand: {
  brandName: string; industry: string | null; description: string | null; tone: string | null; targetAudience: string | null; services: string[]; products: string[];
  location: string | null; website: string | null; phone: string | null; email: string | null; brandRules: string[]; forbiddenTopics: string[]; preferredHashtags: string[]; cta: string | null;
} | null, fallbackName: string): BrandContext {
  return brand ?? { brandName: fallbackName };
}

export async function generateContent(ctx: AuthContext, input: GenerateContentInput) {
  requirePermission(ctx, 'content:create');
  const client = await getClient(ctx, input.clientId);
  const settings = await getClientSettings(ctx.organizationId, client.id);
  if (!settings.aiEnabled) throw badRequest('AI is disabled for this client');
  const publishable = input.platforms.filter((p) => getPlatformCapabilities(p).publishing);
  if (!publishable.length) throw badRequest('None of the selected platforms supports publishing posts');

  const { db } = getInfra();
  const { ai } = await aiFor(ctx.organizationId);
  const previous = await db.content.findMany({ where: { clientId: client.id, organizationId: ctx.organizationId, deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 5, select: { baseContent: true } });
  const agent = new ContentAgent(ai, generationLogger({ organizationId: ctx.organizationId, clientId: client.id, userId: ctx.userId }));
  let outcome;
  try {
    outcome = await agent.generate({
      brand: brandContext(client.brandProfile, client.name),
      topic: input.topic,
      campaignGoal: input.campaignGoal,
      platforms: publishable,
      tone: input.tone ?? settings.defaultTone,
      language: input.language ?? settings.defaultLanguage,
      contentType: input.contentType,
      previousContent: previous.map((p) => p.baseContent),
      additionalInstructions: input.additionalInstructions,
    });
  } catch (error) {
    throw new AppError('INTEGRATION_ERROR', `AI content generation failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  await incrementUsage(ctx.organizationId, 'aiGenerations');

  const accounts = await db.socialAccount.findMany({ where: { clientId: client.id, organizationId: ctx.organizationId, status: 'ACTIVE' }, select: { id: true, platform: true } });
  const content = await createContent(
    ctx,
    {
      clientId: client.id,
      campaignId: input.campaignId ?? null,
      title: outcome.data.title,
      topic: input.topic,
      objective: input.campaignGoal ?? null,
      contentType: input.contentType,
      baseContent: outcome.data.baseContent,
      variants: outcome.data.variants.map((v) => ({
        platform: v.platform,
        socialAccountId: accounts.find((a) => a.platform === v.platform)?.id ?? null,
        title: v.title,
        caption: v.caption,
        hashtags: v.hashtags,
        callToAction: v.callToAction ?? settings.defaultCta,
        mediaType: v.mediaType,
        mediaPrompt: v.mediaPrompt,
      })),
    },
    { aiGenerated: true, aiGenerationId: outcome.generationId, missingInfo: outcome.data.missingInformation },
  );
  return { content, missingInformation: outcome.data.missingInformation, promptVersion: outcome.promptVersion, model: outcome.model };
}

export async function regenerateVariant(ctx: AuthContext, contentId: string, variantId: string, instructions?: string) {
  requirePermission(ctx, 'content:edit');
  const content = await loadContent(ctx, contentId);
  const variant = content.variants.find((v) => v.id === variantId);
  if (!variant) throw notFound('Variant');
  const client = await getClient(ctx, content.clientId);
  const settings = await getClientSettings(ctx.organizationId, client.id);
  const agent = new ContentAgent((await aiFor(ctx.organizationId)).ai, generationLogger({ organizationId: ctx.organizationId, clientId: client.id, userId: ctx.userId }));
  const outcome = await agent.generate({
    brand: brandContext(client.brandProfile, client.name),
    topic: content.topic ?? content.title,
    campaignGoal: content.objective,
    platforms: [variant.platform],
    language: settings.defaultLanguage,
    tone: settings.defaultTone,
    contentType: content.contentType,
    previousContent: [variant.caption],
    additionalInstructions: instructions ?? 'Write a fresh alternative to the previous caption.',
  });
  await incrementUsage(ctx.organizationId, 'aiGenerations');
  const v = outcome.data.variants[0];
  if (!v) throw new AppError('INTEGRATION_ERROR', 'AI returned no variant');
  return upsertVariant(
    ctx,
    contentId,
    { platform: variant.platform, socialAccountId: variant.socialAccountId, title: v.title, caption: v.caption, hashtags: v.hashtags, callToAction: v.callToAction, mediaType: v.mediaType, mediaPrompt: v.mediaPrompt },
    variantId,
  );
}

// ── Approval workflow ───────────────────────────────────────────────────

export async function submitForApproval(ctx: AuthContext, id: string) {
  requirePermission(ctx, 'content:edit');
  const content = await loadContent(ctx, id);
  if (content.status !== 'DRAFT' && content.status !== 'FAILED') throw badRequest(`Only drafts can be submitted for approval (current: ${content.status})`);
  if (!content.variants.length) throw badRequest('Add at least one platform version before submitting');
  await getInfra().db.$transaction(async (tx) => {
    await tx.content.update({ where: { id }, data: { status: 'PENDING_APPROVAL', rejectionReason: null } });
    await tx.contentVariant.updateMany({ where: { contentId: id }, data: { status: 'PENDING_APPROVAL' } });
    await tx.approval.create({ data: { organizationId: ctx.organizationId, clientId: content.clientId, contentId: id, requestedById: ctx.userId } });
    await audit(ctx, { action: 'content.submitted_for_approval', resourceType: 'Content', resourceId: id, clientId: content.clientId }, tx);
  });
  await notifyClientMembers(ctx.organizationId, content.clientId, 'content:approve', {
    type: 'APPROVAL_REQUIRED',
    title: 'Content waiting for approval',
    body: content.title,
    link: `/content/${id}`,
  });
  return loadContent(ctx, id);
}

export async function decideApproval(ctx: AuthContext, id: string, input: { decision: 'APPROVE' | 'REJECT' | 'REQUEST_CHANGES'; comment?: string | null }) {
  requirePermission(ctx, 'content:approve');
  const content = await loadContent(ctx, id);
  if (content.status !== 'PENDING_APPROVAL') throw badRequest('This content is not waiting for approval');
  const status = input.decision === 'APPROVE' ? 'APPROVED' : input.decision === 'REJECT' ? 'REJECTED' : 'CHANGES_REQUESTED';
  await getInfra().db.$transaction(async (tx) => {
    await tx.approval.updateMany({ where: { contentId: id, status: 'PENDING' }, data: { status, reviewerId: ctx.userId, comment: input.comment ?? null, decidedAt: new Date() } });
    if (input.decision === 'APPROVE') {
      await tx.content.update({ where: { id }, data: { status: 'APPROVED', approvedById: ctx.userId, approvedAt: new Date(), rejectionReason: null } });
      await tx.contentVariant.updateMany({ where: { contentId: id }, data: { status: 'APPROVED' } });
    } else {
      await tx.content.update({ where: { id }, data: { status: 'DRAFT', rejectionReason: input.comment ?? (input.decision === 'REJECT' ? 'Rejected' : 'Changes requested') } });
      await tx.contentVariant.updateMany({ where: { contentId: id }, data: { status: 'DRAFT' } });
    }
    await audit(ctx, { action: input.decision === 'APPROVE' ? 'content.approved' : input.decision === 'REJECT' ? 'content.rejected' : 'content.changes_requested', resourceType: 'Content', resourceId: id, clientId: content.clientId, after: { comment: input.comment } }, tx);
  });
  await notifyClientMembers(
    ctx.organizationId,
    content.clientId,
    'content:view',
    { type: input.decision === 'APPROVE' ? 'CONTENT_APPROVED' : 'CONTENT_REJECTED', title: `Content ${input.decision === 'APPROVE' ? 'approved' : input.decision === 'REJECT' ? 'rejected' : 'needs changes'}`, body: `${content.title}${input.comment ? ` — ${input.comment}` : ''}`, link: `/content/${id}` },
    { userIds: [content.createdById] },
  );
  // Content that already has a target date is scheduled automatically once approved.
  if (input.decision === 'APPROVE' && content.scheduledAt && content.scheduledAt > new Date() && ctx.permissions.has('content:publish')) {
    try {
      return await scheduleContent(ctx, id, { scheduledAt: content.scheduledAt });
    } catch {
      return loadContent(ctx, id);
    }
  }
  return loadContent(ctx, id);
}

export async function listApprovals(ctx: ServiceContext, query: { clientId?: string; status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED' }) {
  requirePermission(ctx, 'content:view');
  return getInfra().db.approval.findMany({
    where: { ...tenantWhere(ctx, query.clientId), status: query.status ?? 'PENDING' },
    include: { content: { select: { id: true, title: true, status: true, scheduledAt: true, clientId: true, aiGenerated: true, variants: { select: { platform: true } } } } },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
}

// ── Scheduling ──────────────────────────────────────────────────────────

export function mediaRefs(variant: { media: { media: { url: string; mimeType: string; kind: 'IMAGE' | 'VIDEO' | 'DOCUMENT'; size: number; width: number | null; height: number | null; durationSec: number | null } }[] }): MediaRef[] {
  return variant.media.map(({ media: m }) => ({ url: m.url, mimeType: m.mimeType, kind: m.kind, size: m.size, width: m.width, height: m.height, durationSec: m.durationSec }));
}

export async function scheduleContent(ctx: AuthContext, id: string, input: { scheduledAt: Date; targets?: { variantId: string; socialAccountId: string }[] }) {
  requirePermission(ctx, 'content:publish');
  const content = await loadContent(ctx, id);
  const settings = await getClientSettings(ctx.organizationId, content.clientId);
  if (settings.humanApprovalRequired && content.status !== 'APPROVED' && content.status !== 'SCHEDULED') {
    throw badRequest('This client requires approval before content can be scheduled');
  }
  if (!['DRAFT', 'APPROVED', 'SCHEDULED', 'FAILED'].includes(content.status)) throw badRequest(`Content that is ${content.status.toLowerCase()} cannot be scheduled`);
  if (input.scheduledAt.getTime() < Date.now() - 60_000) throw badRequest('The scheduled time is in the past');

  const { db, env, queues } = getInfra();
  const targets = content.variants.map((v) => ({ variant: v, socialAccountId: input.targets?.find((t) => t.variantId === v.id)?.socialAccountId ?? v.socialAccountId }));
  const errors: { variantId: string; platform: string; issues: string[] }[] = [];
  const accounts = await db.socialAccount.findMany({ where: { organizationId: ctx.organizationId, clientId: content.clientId, id: { in: targets.flatMap((t) => (t.socialAccountId ? [t.socialAccountId] : [])) } } });

  for (const t of targets) {
    const issues: string[] = [];
    const account = accounts.find((a) => a.id === t.socialAccountId);
    if (!account) issues.push('Select a connected social account for this platform');
    else {
      if (account.platform !== t.variant.platform) issues.push(`Account is ${account.platform}, variant is ${t.variant.platform}`);
      if (account.status !== 'ACTIVE') issues.push(`Account status is ${account.status} — reconnect it first`);
    }
    const validation = validateContentForPlatform(getPlatformCapabilities(t.variant.platform), { platform: t.variant.platform, caption: t.variant.caption, hashtags: t.variant.hashtags, media: mediaRefs(t.variant) });
    // Mock accounts use local media URLs; the HTTPS requirement only applies to real platforms.
    issues.push(...validation.filter((i) => !(account?.isMock && i.code === 'MEDIA_NOT_PUBLIC')).map((i) => i.message));
    if (issues.length) errors.push({ variantId: t.variant.id, platform: t.variant.platform, issues });
  }
  if (!targets.length) throw badRequest('Add at least one platform version before scheduling');
  if (errors.length) throw new AppError('VALIDATION_ERROR', 'Some platform versions cannot be published', { variants: errors });

  const maxAttempts = settings.maxPublishAttempts ?? env.PUBLISH_MAX_ATTEMPTS;
  const created = await db.$transaction(async (tx) => {
    // Replace any pending schedule for this content.
    await tx.scheduledPost.updateMany({ where: { contentId: id, status: { in: ['SCHEDULED', 'QUEUED', 'FAILED'] } }, data: { status: 'CANCELLED', lastError: 'Rescheduled' } });
    const posts = [];
    for (const t of targets) {
      posts.push(
        await tx.scheduledPost.create({
          data: {
            organizationId: ctx.organizationId,
            clientId: content.clientId,
            contentId: id,
            variantId: t.variant.id,
            socialAccountId: t.socialAccountId!,
            scheduledAt: input.scheduledAt,
            maxAttempts,
            idempotencyKey: `${t.variant.id}:${t.socialAccountId}:${input.scheduledAt.toISOString()}`,
          },
        }),
      );
      await tx.contentVariant.update({ where: { id: t.variant.id }, data: { socialAccountId: t.socialAccountId, status: 'SCHEDULED' } });
    }
    await tx.content.update({ where: { id }, data: { status: 'SCHEDULED', scheduledAt: input.scheduledAt } });
    await audit(ctx, { action: 'content.scheduled', resourceType: 'Content', resourceId: id, clientId: content.clientId, after: { scheduledAt: input.scheduledAt, targets: targets.map((t) => ({ platform: t.variant.platform, socialAccountId: t.socialAccountId })) } }, tx);
    return posts;
  });

  for (const post of created) {
    const jobId = await queues.add('publish', { scheduledPostId: post.id }, {
      jobId: post.id,
      delay: Math.max(0, input.scheduledAt.getTime() - Date.now()),
      attempts: post.maxAttempts,
      backoff: { type: 'exponential', delay: 30_000 },
    });
    await db.scheduledPost.update({ where: { id: post.id }, data: { jobId: jobId ?? post.id } });
  }
  return loadContent(ctx, id);
}

export async function publishNow(ctx: AuthContext, id: string) {
  return scheduleContent(ctx, id, { scheduledAt: new Date() });
}

/** Calendar drag-and-drop. Scheduled content is re-queued; unscheduled content just moves its planned date. */
export async function rescheduleContent(ctx: AuthContext, id: string, scheduledAt: Date) {
  requirePermission(ctx, 'content:edit');
  const content = await loadContent(ctx, id);
  if (content.status === 'SCHEDULED') {
    await cancelScheduledJobs(content.scheduledPosts.filter((p) => p.status === 'SCHEDULED' || p.status === 'QUEUED').map((p) => p.id));
    return scheduleContent(ctx, id, { scheduledAt, targets: content.scheduledPosts.filter((p) => p.status === 'SCHEDULED' || p.status === 'QUEUED').map((p) => ({ variantId: p.variantId, socialAccountId: p.socialAccountId })) });
  }
  if (['PUBLISHED', 'PUBLISHING'].includes(content.status)) throw badRequest('Published content cannot be rescheduled');
  await getInfra().db.content.update({ where: { id }, data: { scheduledAt } });
  await audit(ctx, { action: 'content.rescheduled', resourceType: 'Content', resourceId: id, clientId: content.clientId, before: { scheduledAt: content.scheduledAt }, after: { scheduledAt } });
  return loadContent(ctx, id);
}

async function cancelScheduledJobs(postIds: string[]) {
  const queue = getInfra().queues.get('publish');
  for (const pid of postIds) {
    const job = await queue.getJob(pid);
    if (job && (await job.isDelayed() || await job.isWaiting())) await job.remove().catch(() => undefined);
  }
}

export async function cancelSchedule(ctx: AuthContext, id: string) {
  requirePermission(ctx, 'content:publish');
  const content = await loadContent(ctx, id);
  const pending = content.scheduledPosts.filter((p) => p.status === 'SCHEDULED' || p.status === 'QUEUED');
  if (!pending.length) throw badRequest('Nothing is scheduled for this content');
  await cancelScheduledJobs(pending.map((p) => p.id));
  await getInfra().db.$transaction(async (tx) => {
    await tx.scheduledPost.updateMany({ where: { id: { in: pending.map((p) => p.id) } }, data: { status: 'CANCELLED', lastError: 'Cancelled by user' } });
    await tx.content.update({ where: { id }, data: { status: content.approvedAt ? 'APPROVED' : 'DRAFT' } });
    await tx.contentVariant.updateMany({ where: { contentId: id }, data: { status: content.approvedAt ? 'APPROVED' : 'DRAFT' } });
    await audit(ctx, { action: 'content.schedule_cancelled', resourceType: 'Content', resourceId: id, clientId: content.clientId }, tx);
  });
  return loadContent(ctx, id);
}

export async function getCalendar(ctx: ServiceContext, query: { clientId?: string; from: Date; to: Date }) {
  requirePermission(ctx, 'content:view');
  const scope = tenantWhere(ctx, query.clientId);
  return getInfra().db.content.findMany({
    where: {
      ...scope,
      deletedAt: null,
      OR: [{ scheduledAt: { gte: query.from, lte: query.to } }, { scheduledPosts: { some: { publishedPost: { publishedAt: { gte: query.from, lte: query.to } } } } }],
    },
    select: {
      id: true,
      clientId: true,
      title: true,
      status: true,
      scheduledAt: true,
      aiGenerated: true,
      client: { select: { name: true } },
      variants: { select: { id: true, platform: true, status: true } },
      scheduledPosts: { select: { id: true, status: true, scheduledAt: true, lastError: true, publishedPost: { select: { publishedAt: true, url: true } } } },
    },
    orderBy: { scheduledAt: 'asc' },
    take: 1000,
  });
}

export async function createCampaign(ctx: AuthContext, input: { clientId: string; name: string; goal?: string | null; startsAt?: Date | null; endsAt?: Date | null }) {
  requirePermission(ctx, 'content:create');
  await getClient(ctx, input.clientId);
  const campaign = await getInfra().db.campaign.create({ data: { organizationId: ctx.organizationId, ...input } });
  await audit(ctx, { action: 'campaign.created', resourceType: 'Campaign', resourceId: campaign.id, clientId: input.clientId, after: { name: input.name } });
  return campaign;
}

export async function listCampaigns(ctx: ServiceContext, clientId?: string) {
  requirePermission(ctx, 'content:view');
  return getInfra().db.campaign.findMany({ where: tenantWhere(ctx, clientId), orderBy: { createdAt: 'desc' }, include: { _count: { select: { contents: true } } } });
}

