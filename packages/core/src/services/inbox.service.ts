import type { ConversationStatus, Platform, Prisma, Priority, SenderType } from '@socialpilot/database';
import { getPlatformCapabilities, isSocialApiError, type MessageAttachment, type NormalizedWebhookEvent } from '@socialpilot/social';
import { requirePermission, tenantWhere, type AuthContext, type ServiceContext } from '../context';
import { AppError, badRequest, notFound } from '../errors';
import { getInfra } from '../infra';
import { paginate, truncate } from '../lib/util';
import { audit } from './audit.service';
import { notifyClientMembers } from './notification.service';
import { incrementUsage } from './organization.service';
import { flagReauthRequired, loadAdapterAccount } from './social.service';

// ── Ingestion (from webhooks) ────────────────────────────────────────────

async function upsertContact(account: { organizationId: string; clientId: string; platform: Platform }, c: { platformUserId: string; name?: string; username?: string; phone?: string }) {
  return getInfra().db.contact.upsert({
    where: { clientId_platform_platformUserId: { clientId: account.clientId, platform: account.platform, platformUserId: c.platformUserId } },
    create: { organizationId: account.organizationId, clientId: account.clientId, platform: account.platform, platformUserId: c.platformUserId, name: c.name, username: c.username, phone: c.phone },
    update: { ...(c.name ? { name: c.name } : {}), ...(c.username ? { username: c.username } : {}), ...(c.phone ? { phone: c.phone } : {}) },
  });
}

/**
 * Stores a normalized platform event. Returns 'created', 'duplicate' or 'ignored'.
 * Duplicate deliveries are absorbed by unique constraints (conversation+platformMessageId).
 */
export async function ingestNormalizedEvent(socialAccountId: string, event: NormalizedWebhookEvent): Promise<'created' | 'duplicate' | 'ignored'> {
  const { db, queues } = getInfra();
  const account = await db.socialAccount.findUnique({ where: { id: socialAccountId } });
  if (!account || account.status === 'DISCONNECTED') return 'ignored';

  if (event.kind === 'status') {
    if (event.status === 'failed') {
      await db.message.updateMany({ where: { platformMessageId: event.platformMessageId, clientId: account.clientId }, data: { status: 'FAILED', error: 'Platform reported delivery failure' } });
    }
    return 'created';
  }

  const contact = await upsertContact(account, event.contact);
  const isComment = event.kind === 'comment';
  const platformConversationId = isComment ? `comment:${event.comment.parentPlatformCommentId ?? event.comment.platformCommentId}` : event.platformConversationId;
  const text = isComment ? event.comment.text : event.message.text;
  const platformMessageId = isComment ? event.comment.platformCommentId : event.message.platformMessageId;
  const createdAt = isComment ? event.comment.createdAt : event.message.createdAt;
  const outbound = isComment ? event.isFromAccount : event.isEcho;

  const result = await db.$transaction(async (tx) => {
    const conversation = await tx.conversation.upsert({
      where: { socialAccountId_platformConversationId: { socialAccountId, platformConversationId } },
      create: {
        organizationId: account.organizationId,
        clientId: account.clientId,
        socialAccountId,
        contactId: contact.id,
        platform: account.platform,
        type: isComment ? 'COMMENT' : 'DIRECT_MESSAGE',
        platformConversationId,
        platformPostId: isComment ? event.comment.platformPostId : null,
        lastMessageAt: createdAt,
      },
      update: {},
    });
    const existing = await tx.message.findUnique({ where: { conversationId_platformMessageId: { conversationId: conversation.id, platformMessageId } } });
    if (existing) return null;
    const message = await tx.message.create({
      data: {
        organizationId: account.organizationId,
        clientId: account.clientId,
        conversationId: conversation.id,
        direction: outbound ? 'OUTBOUND' : 'INBOUND',
        senderType: outbound ? 'USER' : 'CONTACT',
        platformMessageId,
        content: text,
        attachments: (isComment ? [] : event.message.attachments) as unknown as Prisma.InputJsonValue,
        status: outbound ? 'SENT' : 'RECEIVED',
        sentAt: outbound ? createdAt : null,
        createdAt,
      },
    });
    if (isComment) {
      const published = await tx.publishedPost.findUnique({ where: { socialAccountId_platformPostId: { socialAccountId, platformPostId: event.comment.platformPostId } } });
      await tx.comment.create({
        data: {
          organizationId: account.organizationId,
          clientId: account.clientId,
          socialAccountId,
          messageId: message.id,
          publishedPostId: published?.id,
          platformPostId: event.comment.platformPostId,
          platformCommentId: event.comment.platformCommentId,
          parentPlatformCommentId: event.comment.parentPlatformCommentId,
          authorPlatformId: event.comment.authorPlatformId,
          authorName: event.comment.authorName,
          content: text,
          createdAt,
        },
      });
    }
    await tx.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: createdAt > conversation.lastMessageAt ? createdAt : conversation.lastMessageAt,
        lastMessagePreview: truncate(text || (!isComment && event.message.attachments.some((a) => a.type === 'audio') ? 'Voice note' : text), 160),
        ...(outbound ? {} : { unreadCount: { increment: 1 }, ...(conversation.status === 'RESOLVED' ? { status: 'OPEN' as const } : {}) }),
      },
    });
    return message;
  });

  if (!result) return 'duplicate';
  if (result.direction === 'INBOUND') {
    await incrementUsage(account.organizationId, 'messages');
    await queues.add('ai-reply', { messageId: result.id }, { jobId: `reply-${result.id}`, attempts: 3, backoff: { type: 'exponential', delay: 10_000 } });
  }
  return 'created';
}

// ── Queries ─────────────────────────────────────────────────────────────

export async function listConversations(
  ctx: ServiceContext,
  query: { clientId?: string; status?: ConversationStatus; platform?: Platform; assignedToMe?: boolean; unread?: boolean; search?: string; limit: number; cursor?: string },
) {
  requirePermission(ctx, 'messages:view');
  const where: Prisma.ConversationWhereInput = { ...tenantWhere(ctx, query.clientId) };
  if (query.status) where.status = query.status;
  else where.status = { not: 'SPAM' };
  if (query.platform) where.platform = query.platform;
  if (query.assignedToMe && ctx.kind === 'user') where.assignedToId = ctx.userId;
  if (query.unread) where.unreadCount = { gt: 0 };
  if (query.search) {
    where.OR = [
      { lastMessagePreview: { contains: query.search, mode: 'insensitive' } },
      { contact: { name: { contains: query.search, mode: 'insensitive' } } },
      { contact: { username: { contains: query.search, mode: 'insensitive' } } },
    ];
  }
  const rows = await getInfra().db.conversation.findMany({
    where,
    include: {
      contact: { select: { id: true, name: true, username: true, avatarUrl: true } },
      socialAccount: { select: { id: true, platform: true, displayName: true, isMock: true } },
      client: { select: { id: true, name: true } },
      leads: { select: { id: true, status: true }, take: 1, orderBy: { createdAt: 'desc' } },
      suggestions: { where: { decision: 'PENDING_APPROVAL' }, select: { id: true, confidence: true }, take: 1, orderBy: { createdAt: 'desc' } },
    },
    orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });
  return paginate(rows, query.limit);
}

async function loadConversation(ctx: ServiceContext, id: string) {
  const conversation = await getInfra().db.conversation.findFirst({ where: { id, ...tenantWhere(ctx) }, include: { socialAccount: true, contact: true } });
  if (!conversation) throw notFound('Conversation');
  return conversation;
}

export async function getConversation(ctx: ServiceContext, id: string, opts: { markRead?: boolean } = {}) {
  requirePermission(ctx, 'messages:view');
  const { db } = getInfra();
  await loadConversation(ctx, id);
  if (opts.markRead) await db.conversation.update({ where: { id }, data: { unreadCount: 0 } });
  const conversation = await db.conversation.findUniqueOrThrow({
    where: { id },
    include: {
      contact: true,
      socialAccount: { select: { id: true, platform: true, displayName: true, username: true, isMock: true, status: true, capabilities: true } },
      client: { select: { id: true, name: true, timezone: true } },
      messages: { orderBy: { createdAt: 'asc' }, take: 300, include: { comment: { select: { platformCommentId: true, platformPostId: true } } } },
      suggestions: { orderBy: { createdAt: 'desc' }, take: 10 },
      escalations: { where: { status: 'OPEN' }, orderBy: { createdAt: 'desc' } },
      leads: { orderBy: { createdAt: 'desc' }, take: 5 },
    },
  });
  // Voice notes and photos we stored: add their playable URL.
  const assetIds = conversation.messages.flatMap((m) => (Array.isArray(m.attachments) ? (m.attachments as unknown as MessageAttachment[]).flatMap((a) => (a?.mediaAssetId ? [a.mediaAssetId] : [])) : []));
  if (!assetIds.length) return conversation;
  const assets = await db.mediaAsset.findMany({ where: { id: { in: assetIds }, organizationId: conversation.organizationId }, select: { id: true, url: true } });
  const urls = new Map(assets.map((a) => [a.id, a.url]));
  return {
    ...conversation,
    messages: conversation.messages.map((m) =>
      Array.isArray(m.attachments) ? { ...m, attachments: (m.attachments as unknown as MessageAttachment[]).map((a) => (a?.mediaAssetId && urls.has(a.mediaAssetId) ? { ...a, url: urls.get(a.mediaAssetId) } : a)) as unknown as typeof m.attachments } : m,
    ),
  };
}

// ── Replies ─────────────────────────────────────────────────────────────

/**
 * Sends a reply through the platform adapter and records it. Used for human
 * replies and approved/automatic AI replies.
 */
export async function sendConversationReply(
  ctx: ServiceContext,
  conversationId: string,
  text: string,
  opts: { senderType: SenderType; suggestionId?: string; sentById?: string | null },
) {
  const { db, rateLimits } = getInfra();
  const conversation = await loadConversation(ctx, conversationId);
  const account = conversation.socialAccount;
  const caps = getPlatformCapabilities(account.platform);
  const isComment = conversation.type === 'COMMENT';
  if (isComment ? !caps.commentReplies : !caps.directMessages) {
    throw badRequest(`${account.platform} does not allow ${isComment ? 'comment replies' : 'direct messages'} through its API`);
  }
  if (account.status !== 'ACTIVE') throw badRequest(`The ${account.platform} account needs attention (${account.status}). Reconnect it to reply.`);
  const rl = await rateLimits.consume(account.platform, account.id, 'reply');
  if (!rl.allowed) throw new AppError('RATE_LIMITED', `Platform rate limit reached; try again in ${Math.ceil(rl.retryAfterMs / 1000)}s`);

  let platformMessageId: string;
  let sentAt: Date;
  try {
    const { adapter, account: adapterAccount } = await loadAdapterAccount(ctx.organizationId, account.id);
    if (isComment) {
      const target = await db.message.findFirst({
        where: { conversationId, direction: 'INBOUND', comment: { isNot: null } },
        orderBy: { createdAt: 'desc' },
        include: { comment: true },
      });
      if (!target?.comment) throw badRequest('No comment to reply to');
      ({ platformMessageId, sentAt } = await adapter.replyToComment(adapterAccount, { platformCommentId: target.comment.platformCommentId, text }));
    } else {
      if (!conversation.contact.platformUserId) throw badRequest('Contact has no platform id');
      ({ platformMessageId, sentAt } = await adapter.sendMessage(adapterAccount, {
        platformConversationId: conversation.platformConversationId,
        recipientPlatformUserId: conversation.contact.platformUserId,
        text,
      }));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.message.create({
      data: { organizationId: conversation.organizationId, clientId: conversation.clientId, conversationId, direction: 'OUTBOUND', senderType: opts.senderType, content: text, status: 'FAILED', error: message.slice(0, 1000), sentById: opts.sentById ?? null },
    });
    if (isSocialApiError(error) && error.requiresReauth) await flagReauthRequired(account.id, error.message);
    if (error instanceof AppError) throw error;
    throw new AppError('INTEGRATION_ERROR', `Could not send the reply: ${message}`);
  }

  const message = await db.$transaction(async (tx) => {
    const m = await tx.message.create({
      data: {
        organizationId: conversation.organizationId,
        clientId: conversation.clientId,
        conversationId,
        direction: 'OUTBOUND',
        senderType: opts.senderType,
        platformMessageId,
        content: text,
        status: 'SENT',
        sentAt,
        sentById: opts.sentById ?? null,
      },
    });
    await tx.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: sentAt, lastMessagePreview: truncate(text, 160), unreadCount: 0 } });
    if (opts.suggestionId) {
      await tx.aiReplySuggestion.updateMany({
        where: { id: opts.suggestionId, conversationId },
        data: { decision: opts.senderType === 'AI' ? 'AUTO_SENT' : 'SENT', sentMessageId: m.id, decidedById: opts.sentById ?? null, decidedAt: new Date() },
      });
    }
    await audit(ctx, { action: opts.senderType === 'AI' ? 'message.auto_sent' : 'message.sent', resourceType: 'Message', resourceId: m.id, clientId: conversation.clientId, after: { conversationId, platform: account.platform, suggestionId: opts.suggestionId, length: text.length } }, tx);
    return m;
  });
  return message;
}

export async function replyToConversation(ctx: AuthContext, conversationId: string, input: { text: string; suggestionId?: string }) {
  requirePermission(ctx, 'messages:reply');
  if (input.suggestionId) {
    const s = await getInfra().db.aiReplySuggestion.findFirst({ where: { id: input.suggestionId, conversationId, organizationId: ctx.organizationId } });
    if (!s) throw notFound('Suggestion');
  }
  return sendConversationReply(ctx, conversationId, input.text, { senderType: 'USER', suggestionId: input.suggestionId, sentById: ctx.userId });
}

export async function discardSuggestion(ctx: AuthContext, conversationId: string, suggestionId: string) {
  requirePermission(ctx, 'messages:reply');
  await loadConversation(ctx, conversationId);
  const res = await getInfra().db.aiReplySuggestion.updateMany({
    where: { id: suggestionId, conversationId, decision: { in: ['PENDING_APPROVAL', 'ESCALATED', 'QUEUED_AFTER_HOURS'] } },
    data: { decision: 'DISCARDED', decidedById: ctx.userId, decidedAt: new Date() },
  });
  if (!res.count) throw notFound('Pending suggestion');
}

export async function updateConversation(ctx: AuthContext, id: string, input: { status?: ConversationStatus; priority?: Priority; assignedToId?: string | null; mode?: 'AI' | 'HUMAN' }) {
  requirePermission(ctx, input.assignedToId !== undefined || input.priority ? 'messages:assign' : 'messages:reply');
  const { db } = getInfra();
  const before = await loadConversation(ctx, id);
  if (input.assignedToId) {
    const member = await db.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: ctx.organizationId, userId: input.assignedToId } } });
    if (!member) throw badRequest('Assignee is not a member of this organization');
  }
  const updated = await db.$transaction(async (tx) => {
    const c = await tx.conversation.update({ where: { id }, data: input });
    if (input.status === 'RESOLVED') {
      await tx.escalation.updateMany({ where: { conversationId: id, status: 'OPEN' }, data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedById: ctx.userId } });
    }
    const action =
      input.mode && input.mode !== before.mode
        ? input.mode === 'HUMAN'
          ? 'conversation.human_takeover'
          : 'conversation.returned_to_ai'
        : input.status === 'RESOLVED'
          ? 'conversation.resolved'
          : input.assignedToId !== undefined
            ? 'conversation.assigned'
            : 'conversation.updated';
    await audit(ctx, { action, resourceType: 'Conversation', resourceId: id, clientId: before.clientId, before: { status: before.status, mode: before.mode, assignedToId: before.assignedToId, priority: before.priority }, after: input }, tx);
    return c;
  });
  if (input.assignedToId && input.assignedToId !== ctx.userId) {
    await notifyClientMembers(ctx.organizationId, before.clientId, 'messages:view', { type: 'IMPORTANT_MESSAGE', title: 'A conversation was assigned to you', body: before.lastMessagePreview ?? undefined, link: `/inbox/${id}` }, { userIds: [input.assignedToId] });
  }
  return updated;
}

/** Creates an escalation and hands the conversation to humans (AI auto-replies off). */
export async function escalateConversation(ctx: ServiceContext, id: string, input: { reason: string; intent?: string | null; messageId?: string; priority?: Priority }) {
  if (ctx.kind === 'user') requirePermission(ctx, 'messages:assign');
  const { db } = getInfra();
  const conversation = await loadConversation(ctx, id);
  const escalation = await db.$transaction(async (tx) => {
    const e = await tx.escalation.create({
      data: { organizationId: conversation.organizationId, clientId: conversation.clientId, conversationId: id, messageId: input.messageId, reason: input.reason, intent: (input.intent ?? null) as never },
    });
    await tx.conversation.update({ where: { id }, data: { status: 'ESCALATED', mode: 'HUMAN', priority: input.priority ?? (conversation.priority === 'URGENT' ? 'URGENT' : 'HIGH') } });
    await audit(ctx, { action: 'conversation.escalated', resourceType: 'Conversation', resourceId: id, clientId: conversation.clientId, after: { reason: input.reason, intent: input.intent } }, tx);
    return e;
  });
  await notifyClientMembers(conversation.organizationId, conversation.clientId, 'messages:reply', {
    type: 'AI_ESCALATION',
    title: `Escalated ${conversation.platform} conversation`,
    body: `${input.reason}${conversation.lastMessagePreview ? ` — “${conversation.lastMessagePreview}”` : ''}`.slice(0, 900),
    link: `/inbox/${id}`,
  });
  return escalation;
}

