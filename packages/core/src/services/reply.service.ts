import {
  checkReplySafety,
  ConversationSummaryAgent,
  decideReplyRoute,
  detectPromptInjection,
  domainOf,
  IntentAgent,
  isWithinBusinessHours,
  LeadAgent,
  selectKnowledge,
  ReplyAgent,
  type AutomationOverrides,
  type BusinessHoursConfig,
  type IntentOutput,
  type ReplyOutput,
} from '@socialpilot/ai';
import { organizationAccess } from './billing.service';
import type { Intent, Prisma, ReplyDecision } from '@socialpilot/database';
import { getPlatformCapabilities } from '@socialpilot/social';
import type { AutomationAction, IntentKey } from '@socialpilot/validation';
import { requirePermission, systemContext, type AuthContext } from '../context';
import { notFound } from '../errors';
import { getInfra } from '../infra';
import { generationLogger } from './ai-log.service';
import { aiFor } from './ai-settings.service';
import { audit } from './audit.service';
import { runAutomationForEvent } from './automation.service';
import { brandContext } from './content.service';
import { escalateConversation, sendConversationReply } from './inbox.service';
import { upsertDetectedLead } from './lead.service';
import { notifyClientMembers } from './notification.service';
import { searchKnowledgeInternal } from './knowledge.service';

const LEAD_INTENTS: IntentKey[] = ['PRICE', 'BOOKING', 'QUOTE_REQUEST', 'LEAD', 'AVAILABILITY'];
const RECENT_WINDOW = 10;
const SUMMARY_EVERY = 20;

export interface PipelineResult {
  decision: ReplyDecision | 'SKIPPED_SPAM' | 'SKIPPED_AI_DISABLED' | 'SKIPPED_ACCOUNT_BLOCKED' | 'ALREADY_PROCESSED' | 'NOT_INBOUND';
  suggestionId?: string;
  intent?: Intent;
  confidence?: number;
  leadId?: string;
  reasons?: string[];
}

/** Finds the next moment the business opens (15-minute resolution, up to 8 days ahead). */
export function nextBusinessOpening(hours: BusinessHoursConfig, timezone: string, from = new Date()): Date | null {
  const step = 15 * 60 * 1000;
  const start = Math.ceil(from.getTime() / step) * step;
  for (let t = start; t < from.getTime() + 8 * 86_400_000; t += step) {
    if (isWithinBusinessHours(hours, timezone, new Date(t))) return new Date(t);
  }
  return null;
}

function automationOverrides(actions: AutomationAction[]): AutomationOverrides {
  return {
    escalate: actions.some((a) => a.type === 'escalate'),
    requireApproval: actions.some((a) => a.type === 'require_approval'),
    disableAutoReply: actions.some((a) => a.type === 'disable_auto_reply'),
    autoSend: actions.some((a) => a.type === 'auto_send'),
  };
}

/** Applies side-effect actions (priority, assignment, tags, notifications, takeover). */
async function applySideEffects(conversation: { id: string; organizationId: string; clientId: string; contactId: string; platform: string }, actions: AutomationAction[]) {
  const { db } = getInfra();
  const data: Prisma.ConversationUpdateInput = {};
  for (const action of actions) {
    switch (action.type) {
      case 'set_priority':
        data.priority = action.priority;
        break;
      case 'assign': {
        const member = await db.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: conversation.organizationId, userId: action.userId } } });
        if (member) data.assignedToId = action.userId;
        break;
      }
      case 'human_takeover':
        data.mode = 'HUMAN';
        break;
      case 'add_tag': {
        const contact = await db.contact.findUnique({ where: { id: conversation.contactId }, select: { tags: true } });
        if (contact && !contact.tags.includes(action.tag)) await db.contact.update({ where: { id: conversation.contactId }, data: { tags: { push: action.tag } } });
        break;
      }
      case 'notify':
        await notifyClientMembers(conversation.organizationId, conversation.clientId, 'messages:view', {
          type: 'IMPORTANT_MESSAGE',
          title: action.message ?? `Automation alert: ${conversation.platform} conversation`,
          link: `/inbox/${conversation.id}`,
        });
        break;
      default:
        break;
    }
  }
  if (Object.keys(data).length) await db.conversation.update({ where: { id: conversation.id }, data });
}

/**
 * The reply pipeline:
 *   message → client/account → conversation memory → intent → automation rules →
 *   lead detection → knowledge search → draft → safety check → routing →
 *   auto-send | approval | escalation
 */
export async function processInboundMessage(messageId: string, opts: { force?: boolean; requestedBy?: AuthContext } = {}): Promise<PipelineResult> {
  // One pipeline per message at a time (webhook retries, regenerate clicks and workers can overlap).
  const { redis } = getInfra();
  const lockKey = `socialpilot:lock:reply:${messageId}`;
  const token = `${process.pid}:${Date.now()}:${Math.random()}`;
  if ((await redis.set(lockKey, token, 'PX', 180_000, 'NX')) !== 'OK') return { decision: 'ALREADY_PROCESSED' };
  try {
    return await runPipeline(messageId, opts);
  } finally {
    // Release only our own lock.
    await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, lockKey, token).catch(() => undefined);
  }
}

async function runPipeline(messageId: string, opts: { force?: boolean; requestedBy?: AuthContext }): Promise<PipelineResult> {
  const { db, logger } = getInfra();
  const message = await db.message.findUnique({
    where: { id: messageId },
    include: { conversation: { include: { socialAccount: true, contact: true, client: { include: { brandProfile: true, settings: true } } } } },
  });
  if (!message) throw notFound('Message');
  if (message.direction !== 'INBOUND') return { decision: 'NOT_INBOUND' };
  const conversation = message.conversation;
  const { client, socialAccount: account } = conversation;
  const ctx = systemContext(conversation.organizationId);
  const { ai } = await aiFor(conversation.organizationId);
  const log = logger.child({ organizationId: conversation.organizationId, clientId: client.id, conversationId: conversation.id, platform: account.platform, operation: 'reply_pipeline' });

  const existing = await db.aiReplySuggestion.findUnique({ where: { inboundMessageId: messageId } });
  if (existing && !opts.force) return { decision: 'ALREADY_PROCESSED', suggestionId: existing.id };
  if (existing && opts.force) await db.aiReplySuggestion.delete({ where: { id: existing.id } });

  const settings = client.settings ?? (await db.clientSettings.create({ data: { clientId: client.id, organizationId: client.organizationId } }));
  if (!settings.aiEnabled) return { decision: 'SKIPPED_AI_DISABLED' };
  // Blocked customers keep receiving messages, but no AI credits are spent on them.
  if ((await organizationAccess(conversation.organizationId)).state === 'blocked') return { decision: 'SKIPPED_ACCOUNT_BLOCKED' };
  const genLog = generationLogger({ organizationId: conversation.organizationId, clientId: client.id, userId: opts.requestedBy?.userId });
  const brand = brandContext(client.brandProfile, client.name);
  const channel = conversation.type === 'COMMENT' ? 'COMMENT' : 'DIRECT_MESSAGE';

  // ── Conversation memory: recent messages + rolling summary ──
  const history = await db.message.findMany({ where: { conversationId: conversation.id, createdAt: { lte: message.createdAt }, id: { not: message.id } }, orderBy: { createdAt: 'desc' }, take: RECENT_WINDOW });
  const recent = history.reverse().map((m) => ({ from: m.direction === 'INBOUND' ? ('customer' as const) : ('business' as const), text: m.content }));
  const totalMessages = await db.message.count({ where: { conversationId: conversation.id } });
  let summary = conversation.summary;
  if (totalMessages - conversation.summaryMessageCount > SUMMARY_EVERY + RECENT_WINDOW) {
    const older = await db.message.findMany({ where: { conversationId: conversation.id }, orderBy: { createdAt: 'asc' }, skip: conversation.summaryMessageCount, take: totalMessages - conversation.summaryMessageCount - RECENT_WINDOW });
    try {
      const s = await new ConversationSummaryAgent(ai, genLog).summarize({ previousSummary: summary, messages: older.map((m) => ({ from: m.direction === 'INBOUND' ? 'customer' : 'business', text: m.content })) });
      summary = s.data.summary;
      await db.conversation.update({ where: { id: conversation.id }, data: { summary, summaryMessageCount: conversation.summaryMessageCount + older.length, summaryUpdatedAt: new Date() } });
    } catch (error) {
      log.warn({ error: error instanceof Error ? error.message : String(error) }, 'conversation summary failed; continuing without update');
    }
  }

  // ── Intent ──
  let intent: IntentOutput;
  try {
    intent = (await new IntentAgent(ai, genLog).classify({ brandName: brand.brandName, industry: brand.industry, platform: account.platform, channel, message: message.content, recentContext: recent.slice(-4).map((m) => `${m.from}: ${m.text}`) })).data;
  } catch (error) {
    log.error({ error: error instanceof Error ? error.message : String(error) }, 'intent classification failed');
    await escalateConversation(ctx, conversation.id, { reason: 'AI could not classify this message', messageId });
    return { decision: 'ESCALATED', reasons: ['AI_ERROR'] };
  }
  await db.message.update({ where: { id: messageId }, data: { intent: intent.intent, confidence: intent.confidence, isSpam: intent.isSpam } });
  await db.conversation.update({ where: { id: conversation.id }, data: { lastIntent: intent.intent, lastConfidence: intent.confidence } });

  const injection = detectPromptInjection(message.content);
  const withinHours = isWithinBusinessHours(settings.businessHours as BusinessHoursConfig, client.timezone);

  // ── Automation rules ──
  const actions = await runAutomationForEvent({
    trigger: channel === 'COMMENT' ? 'COMMENT_RECEIVED' : 'MESSAGE_RECEIVED',
    organizationId: conversation.organizationId,
    clientId: client.id,
    resourceType: 'Message',
    resourceId: messageId,
    facts: {
      intent: intent.intent,
      confidence: intent.confidence,
      platform: account.platform,
      isSpam: intent.isSpam,
      text: message.content,
      priority: conversation.priority,
      withinBusinessHours: withinHours,
      conversationType: conversation.type,
      leadDetected: intent.buyingSignal,
    },
  });
  const isSpam = intent.isSpam || intent.intent === 'SPAM' || actions.some((a) => a.type === 'mark_spam');
  await applySideEffects(conversation, actions);

  if (isSpam) {
    await db.message.update({ where: { id: messageId }, data: { isSpam: true } });
    if (totalMessages <= 1) await db.conversation.update({ where: { id: conversation.id }, data: { status: 'SPAM', unreadCount: 0 } });
    const s = await db.aiReplySuggestion.create({
      data: { organizationId: conversation.organizationId, clientId: client.id, conversationId: conversation.id, inboundMessageId: messageId, suggestedReply: '', intent: 'SPAM', confidence: intent.confidence, requiresHuman: false, reason: intent.reason, decision: 'SKIPPED', decisionReason: 'Spam — no reply or lead automation' },
    });
    return { decision: 'SKIPPED_SPAM', suggestionId: s.id, intent: 'SPAM', confidence: intent.confidence };
  }

  // ── Lead detection (runs alongside the reply draft; they don't depend on each other) ──
  const leadTask = (async (): Promise<string | undefined> => {
    const forceLead = actions.some((a) => a.type === 'create_lead');
    if (forceLead || intent.buyingSignal || LEAD_INTENTS.includes(intent.intent)) {
      try {
        const inbound = await db.message.findMany({ where: { conversationId: conversation.id, direction: 'INBOUND' }, orderBy: { createdAt: 'desc' }, take: 8 });
        const lead = await new LeadAgent(ai, genLog).extract({
          brandName: brand.brandName,
          services: brand.services ?? [],
          products: brand.products ?? [],
          contactName: conversation.contact.name,
          messages: inbound.reverse().map((m) => m.content),
        });
        if (forceLead || (lead.data.isLead && lead.data.confidence >= 0.6)) {
          const res = await upsertDetectedLead({
            organizationId: conversation.organizationId,
            clientId: client.id,
            conversationId: conversation.id,
            contactId: conversation.contactId,
            platform: account.platform,
            intent: intent.intent,
            confidence: lead.data.confidence,
            name: lead.data.name ?? conversation.contact.name,
            username: conversation.contact.username,
            email: lead.data.email,
            phone: lead.data.phone,
            interest: lead.data.interest,
          });
          return res.leadId;
        }
      } catch (error) {
        log.warn({ error: error instanceof Error ? error.message : String(error) }, 'lead extraction failed; continuing');
      }
    }
    return undefined;
  })();

  // ── Knowledge + draft ──
  // Only snippets close in relevance to the best match, within a size budget (fewer tokens, less to misquote).
  const knowledge = selectKnowledge(await searchKnowledgeInternal(conversation.organizationId, client.id, message.content, 5));
  let reply: ReplyOutput;
  let generationId: string | undefined;
  try {
    const outcome = await new ReplyAgent(ai, genLog).draft({
      brand,
      platform: account.platform,
      channel,
      language: settings.defaultLanguage,
      tone: settings.defaultTone,
      intent: intent.intent,
      conversationSummary: summary,
      recentMessages: recent,
      knowledge: knowledge.map((k) => ({ id: k.id, title: k.title, content: k.content })),
      message: message.content,
      outsideBusinessHours: !withinHours,
    });
    reply = outcome.data;
    generationId = outcome.generationId;
  } catch (error) {
    log.error({ error: error instanceof Error ? error.message : String(error) }, 'reply generation failed');
    await escalateConversation(ctx, conversation.id, { reason: 'AI could not draft a reply', intent: intent.intent, messageId });
    return { decision: 'ESCALATED', intent: intent.intent, reasons: ['AI_ERROR'], leadId: await leadTask };
  }
  const leadId = await leadTask;

  const safety = checkReplySafety(reply.suggestedReply, {
    allowedDomains: [domainOf(brand.website)].filter((d): d is string => Boolean(d)),
    forbiddenTopics: brand.forbiddenTopics,
  });
  const caps = getPlatformCapabilities(account.platform);
  const canReply = account.status === 'ACTIVE' && (channel === 'COMMENT' ? caps.commentReplies : caps.directMessages);

  const routing = decideReplyRoute({
    intent: intent.intent,
    intentConfidence: intent.confidence,
    replyConfidence: reply.confidence,
    replyRequiresHuman: reply.requiresHuman,
    isSpam: false,
    requestsHuman: intent.requestsHuman,
    containsThreat: intent.containsThreat,
    containsSensitivePersonalInfo: intent.containsSensitivePersonalInfo,
    suspectedInjection: injection.suspected,
    unsafeOutput: safety.some((s) => s.code === 'SECRET_LEAK' || s.code === 'PROMPT_LEAK'),
    conversationMode: opts.force && opts.requestedBy ? 'HUMAN' : (await db.conversation.findUniqueOrThrow({ where: { id: conversation.id }, select: { mode: true } })).mode,
    canReply,
    settings: {
      aiEnabled: settings.aiEnabled,
      autoReplyEnabled: settings.autoReplyEnabled,
      autoReplyThreshold: settings.autoReplyThreshold,
      approvalThreshold: settings.approvalThreshold,
      allowedAutoIntents: settings.allowedAutoIntents,
      escalationIntents: settings.escalationIntents,
    },
    automation: automationOverrides(actions),
  });
  const reasons = [...routing.reasons, ...safety.map((s) => s.detail), ...injection.signals.map((s) => `injection signal: ${s}`)];

  // Safety issues other than leaks (links, forbidden topics) still block auto-send.
  let decision: ReplyDecision = routing.route === 'AUTO_SEND' ? (safety.length ? 'PENDING_APPROVAL' : 'AUTO_SENT') : routing.route === 'APPROVAL' ? 'PENDING_APPROVAL' : routing.route === 'ESCALATE' ? 'ESCALATED' : 'SKIPPED';
  let sendAfterHoursMessage = false;
  let queueUntil: Date | null = null;
  if (decision === 'AUTO_SENT' && !withinHours) {
    if (settings.afterHoursMode === 'QUEUE_FOR_BUSINESS_HOURS') {
      queueUntil = nextBusinessOpening(settings.businessHours as BusinessHoursConfig, client.timezone);
      decision = queueUntil ? 'QUEUED_AFTER_HOURS' : 'PENDING_APPROVAL';
      reasons.push('Outside business hours — reply queued until opening');
    } else if (settings.afterHoursMode === 'SEND_AFTER_HOURS_MESSAGE') {
      sendAfterHoursMessage = Boolean(settings.afterHoursMessage);
      decision = 'PENDING_APPROVAL';
      reasons.push('Outside business hours — after-hours message sent; full reply awaits approval');
    }
  }

  const suggestion = await db.aiReplySuggestion.create({
    data: {
      organizationId: conversation.organizationId,
      clientId: client.id,
      conversationId: conversation.id,
      inboundMessageId: messageId,
      suggestedReply: reply.suggestedReply,
      intent: intent.intent,
      confidence: routing.confidence,
      requiresHuman: reply.requiresHuman || routing.route === 'ESCALATE',
      reason: reply.reason,
      decision,
      decisionReason: reasons.join('; ').slice(0, 2000),
      knowledgeChunkIds: reply.usedKnowledgeIds,
      aiGenerationId: generationId,
    },
  });
  await audit(ctx, { action: 'ai.reply_generated', resourceType: 'AiReplySuggestion', resourceId: suggestion.id, clientId: client.id, after: { intent: intent.intent, confidence: routing.confidence, decision, reasons: reasons.slice(0, 10) } });

  if (decision === 'AUTO_SENT') {
    try {
      await sendConversationReply(ctx, conversation.id, reply.suggestedReply, { senderType: 'AI', suggestionId: suggestion.id });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      await db.aiReplySuggestion.update({ where: { id: suggestion.id }, data: { decision: 'PENDING_APPROVAL', decisionReason: `Automatic send failed: ${why}`.slice(0, 2000) } });
      decision = 'PENDING_APPROVAL';
    }
  } else if (decision === 'QUEUED_AFTER_HOURS' && queueUntil) {
    await getInfra().queues.add('ai-reply', { messageId: `send:${suggestion.id}` }, { delay: queueUntil.getTime() - Date.now(), jobId: `send-${suggestion.id}` });
  } else if (decision === 'ESCALATED' && !opts.requestedBy) {
    const urgent = intent.containsThreat || intent.intent === 'LEGAL';
    await escalateConversation(ctx, conversation.id, { reason: routing.escalationReason ?? 'Escalated by AI policy', intent: intent.intent, messageId, priority: urgent ? 'URGENT' : 'HIGH' });
  }
  if (sendAfterHoursMessage && settings.afterHoursMessage && canReply) {
    await sendConversationReply(ctx, conversation.id, settings.afterHoursMessage, { senderType: 'AI' }).catch((error: unknown) => log.warn({ error: String(error) }, 'after-hours message failed'));
  }
  return { decision, suggestionId: suggestion.id, intent: intent.intent, confidence: routing.confidence, leadId, reasons };
}

/** Sends a reply that was queued until business hours (skips if a human already handled it). */
export async function sendQueuedSuggestion(suggestionId: string): Promise<void> {
  const { db } = getInfra();
  const s = await db.aiReplySuggestion.findUnique({ where: { id: suggestionId }, include: { conversation: { select: { mode: true, organizationId: true } } } });
  if (!s || s.decision !== 'QUEUED_AFTER_HOURS') return;
  const newer = await db.message.count({ where: { conversationId: s.conversationId, direction: 'OUTBOUND', createdAt: { gt: s.createdAt } } });
  if (newer || s.conversation.mode === 'HUMAN') {
    await db.aiReplySuggestion.update({ where: { id: suggestionId }, data: { decision: 'DISCARDED', decisionReason: 'Superseded before business hours' } });
    return;
  }
  await sendConversationReply(systemContext(s.conversation.organizationId), s.conversationId, s.suggestedReply, { senderType: 'AI', suggestionId });
}

/** "Regenerate" in the inbox: re-runs the pipeline for the latest customer message as a draft only. */
export async function regenerateSuggestion(ctx: AuthContext, conversationId: string) {
  requirePermission(ctx, 'messages:reply');
  const { db } = getInfra();
  const conversation = await db.conversation.findFirst({ where: { id: conversationId, organizationId: ctx.organizationId, ...(ctx.clientIds ? { clientId: { in: [...ctx.clientIds] } } : {}) } });
  if (!conversation) throw notFound('Conversation');
  const latest = await db.message.findFirst({ where: { conversationId, direction: 'INBOUND' }, orderBy: { createdAt: 'desc' } });
  if (!latest) throw notFound('Customer message');
  return processInboundMessage(latest.id, { force: true, requestedBy: ctx });
}
