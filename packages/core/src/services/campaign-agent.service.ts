import { CAMPAIGN_AGENT_VERSION, CAMPAIGN_MAX_POSTS, CAMPAIGN_TOOLS, campaignSystemPrompt, campaignUserMessage, selectKnowledge, type AgentMessage, type ToolCall } from '@socialpilot/ai';
import type { Platform, Prisma } from '@socialpilot/database';
import { getPlatformCapabilities } from '@socialpilot/social';
import { requirePermission, tenantWhere, type AuthContext } from '../context';
import { badRequest, notFound } from '../errors';
import { getInfra } from '../infra';
import { aiFor } from './ai-settings.service';
import { audit } from './audit.service';
import { getClient } from './client.service';
import { createCampaign, createContent, generateVariantImage, getContent, rescheduleContent, submitForApproval, upsertVariant } from './content.service';
import { searchKnowledgeInternal } from './knowledge.service';
import { createLeadForm } from './lead-capture.service';
import { assertAiQuota, incrementUsage, resolveAuthContext } from './organization.service';

/**
 * Campaign Agent: a goal becomes post drafts, images and a sign-up form through
 * tool calls the model chooses step by step. Runs in the worker with the
 * permissions of the person who started it; every step is recorded for the
 * timeline, and all posts go to the approval queue at the end. Nothing is published.
 */

const MAX_TURNS = 24;
const MAX_CALLS_PER_TURN = 8;
const POSTABLE: Platform[] = ['FACEBOOK', 'INSTAGRAM', 'LINKEDIN', 'TIKTOK'];

export interface AgentStep {
  at: string;
  tool: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  ok: boolean;
}

export async function startCampaignRun(ctx: AuthContext, input: { clientId: string; goal: string; startDate?: Date; days?: number }) {
  requirePermission(ctx, 'content:create');
  await getClient(ctx, input.clientId);
  await assertAiQuota(ctx.organizationId);
  const { db, queues } = getInfra();
  const days = Math.min(Math.max(input.days ?? 7, 2), 30);
  const start = input.startDate ?? new Date(Date.now() + 86_400_000);
  const run = await db.agentRun.create({
    data: { organizationId: ctx.organizationId, clientId: input.clientId, createdById: ctx.userId, goal: input.goal.trim().slice(0, 1000), startDate: start, days },
  });
  await queues.add('agent', { runId: run.id }, { attempts: 1 });
  await audit(ctx, { action: 'agent.run_started', resourceType: 'AgentRun', resourceId: run.id, clientId: input.clientId, after: { goal: run.goal, days } });
  return run;
}

export async function getCampaignRun(ctx: AuthContext, id: string) {
  requirePermission(ctx, 'content:view');
  const run = await getInfra().db.agentRun.findFirst({ where: { id, ...tenantWhere(ctx) }, include: { client: { select: { id: true, name: true } } } });
  if (!run) throw notFound('Agent run');
  const contentIds = (run.steps as unknown as AgentStep[]).flatMap((s) => (s.tool === 'create_post_draft' && s.ok && typeof s.output.contentId === 'string' ? [s.output.contentId] : []));
  const contents = contentIds.length
    ? await getInfra().db.content.findMany({
        where: { id: { in: contentIds }, organizationId: ctx.organizationId },
        select: { id: true, title: true, status: true, scheduledAt: true, variants: { select: { platform: true, caption: true, media: { select: { media: { select: { url: true, kind: true } } }, take: 1 } } } },
      })
    : [];
  return { ...run, contents: contentIds.map((cid) => contents.find((c) => c.id === cid)).filter(Boolean) };
}

export async function listCampaignRuns(ctx: AuthContext, clientId?: string) {
  requirePermission(ctx, 'content:view');
  return getInfra().db.agentRun.findMany({
    where: tenantWhere(ctx, clientId),
    orderBy: { createdAt: 'desc' },
    take: 30,
    select: { id: true, goal: true, status: true, summary: true, createdAt: true, finishedAt: true, client: { select: { id: true, name: true } } },
  });
}

export async function cancelCampaignRun(ctx: AuthContext, id: string) {
  requirePermission(ctx, 'content:create');
  const run = await getInfra().db.agentRun.findFirst({ where: { id, ...tenantWhere(ctx) } });
  if (!run) throw notFound('Agent run');
  if (run.status !== 'QUEUED' && run.status !== 'RUNNING') throw badRequest('This run has already finished');
  await getInfra().db.agentRun.update({ where: { id }, data: { status: 'CANCELLED', finishedAt: new Date() } });
  await audit(ctx, { action: 'agent.run_cancelled', resourceType: 'AgentRun', resourceId: id, clientId: run.clientId });
}

const clip = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Worker entry point: runs the agent loop for one queued run. */
export async function executeCampaignRun(runId: string) {
  const { db, logger, env } = getInfra();
  const run = await db.agentRun.findUnique({ where: { id: runId } });
  if (!run || run.status !== 'QUEUED') return { skipped: true };
  const log = logger.child({ runId, organizationId: run.organizationId, operation: 'campaign_agent' });
  const steps: AgentStep[] = [];
  const createdIds: string[] = [];
  let formLink: string | null = null;
  let usage = { inputTokens: 0, outputTokens: 0 };
  let lastProvider: string | undefined;
  let lastModel: string | undefined;
  const save = (data: Prisma.AgentRunUpdateInput = {}) =>
    db.agentRun.update({ where: { id: runId }, data: { steps: steps as unknown as Prisma.InputJsonValue, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, provider: lastProvider, model: lastModel, ...data } });

  try {
    const user = await db.user.findUniqueOrThrow({ where: { id: run.createdById }, select: { id: true, isSuperAdmin: true } });
    const ctx = await resolveAuthContext(user, run.organizationId);
    const client = await getClient(ctx, run.clientId);
    const { ai } = await aiFor(run.organizationId);
    if (!ai.chatWithTools) throw new Error('The configured AI provider does not support tool calling');
    const accounts = await db.socialAccount.findMany({ where: { clientId: client.id, organizationId: run.organizationId, status: 'ACTIVE' }, select: { id: true, platform: true } });
    const accountFor = (p: Platform) => accounts.find((a) => a.platform === p)?.id ?? null;
    const connected = [...new Set(accounts.map((a) => a.platform))].filter((p) => POSTABLE.includes(p) && getPlatformCapabilities(p).publishing);
    const start = run.startDate;
    const end = new Date(start.getTime() + (run.days - 1) * 86_400_000);
    await db.agentRun.update({ where: { id: runId }, data: { status: 'RUNNING', startedAt: new Date() } });
    const campaign = await createCampaign(ctx, { clientId: client.id, name: run.goal.slice(0, 120), goal: run.goal, startsAt: start, endsAt: end });
    await db.agentRun.update({ where: { id: runId }, data: { campaignId: campaign.id } });

    const brief = { goal: run.goal, startDate: isoDay(start), days: run.days, maxPosts: CAMPAIGN_MAX_POSTS };
    const messages: AgentMessage[] = [
      { role: 'system', content: campaignSystemPrompt(brief) },
      { role: 'user', content: campaignUserMessage(brief) },
    ];

    const tools: Record<string, (args: Record<string, unknown>) => Promise<{ input: Record<string, unknown>; output: Record<string, unknown> }>> = {
      get_business_profile: async () => {
        const b = client.brandProfile;
        return {
          input: {},
          output: {
            brandName: b?.brandName ?? client.name, industry: b?.industry, description: b?.description, tone: b?.tone, targetAudience: b?.targetAudience,
            services: b?.services ?? [], products: b?.products ?? [], location: b?.location, website: b?.website, preferredHashtags: b?.preferredHashtags ?? [], cta: b?.cta,
            connectedPlatforms: connected,
          },
        };
      },
      search_knowledge: async (a) => {
        const query = clip(a.query, 300) || run.goal;
        const hits = selectKnowledge(await searchKnowledgeInternal(run.organizationId, client.id, query, 4));
        return { input: { query }, output: { snippets: hits.map((h) => ({ title: h.title, content: h.content.slice(0, 900) })) } };
      },
      get_recent_posts: async () => {
        const recent = await db.content.findMany({ where: { clientId: client.id, organizationId: run.organizationId, deletedAt: null, campaignId: { not: campaign.id } }, orderBy: { createdAt: 'desc' }, take: 6, select: { title: true, baseContent: true } });
        return { input: {}, output: { posts: recent.map((p) => ({ title: p.title, text: p.baseContent.slice(0, 200) })) } };
      },
      create_post_draft: async (a) => {
        if (createdIds.length >= CAMPAIGN_MAX_POSTS) throw new Error(`The campaign already has ${CAMPAIGN_MAX_POSTS} posts`);
        const raw = Array.isArray(a.variants) ? (a.variants as Record<string, unknown>[]) : [];
        const variants = raw
          .filter((v) => connected.includes(v.platform as Platform) && clip(v.caption, 5000))
          .slice(0, 4)
          .map((v) => ({
            platform: v.platform as Platform,
            socialAccountId: accountFor(v.platform as Platform),
            caption: clip(v.caption, 5000),
            hashtags: (Array.isArray(v.hashtags) ? v.hashtags : []).map((h) => clip(h, 60).replace(/^#/, '')).filter(Boolean).slice(0, 15),
            mediaPrompt: clip(a.imageBrief, 1000) || null,
          }));
        if (!variants.length) throw new Error(`No version for a connected platform. Connected: ${connected.join(', ') || 'none'}`);
        const title = clip(a.title, 200) || 'Campaign post';
        const content = await createContent(ctx, { clientId: client.id, campaignId: campaign.id, title, topic: run.goal.slice(0, 500), objective: run.goal.slice(0, 500), contentType: 'POST', baseContent: clip(a.baseContent, 2000) || variants[0]!.caption, variants }, { aiGenerated: true });
        // Plan it on the calendar at 10:00 UTC on the chosen day, kept inside the campaign period.
        const wanted = Date.parse(`${clip(a.plannedDate, 10)}T10:00:00Z`);
        const day = Number.isFinite(wanted) ? Math.min(Math.max(wanted, start.getTime()), end.getTime() + 36e6) : start.getTime();
        await rescheduleContent(ctx, content.id, new Date(day));
        createdIds.push(content.id);
        return { input: { title, plannedDate: isoDay(new Date(day)), platforms: variants.map((v) => v.platform) }, output: { contentId: content.id, title, plannedDate: isoDay(new Date(day)), platforms: variants.map((v) => v.platform) } };
      },
      generate_post_image: async (a) => {
        const contentId = clip(a.contentId, 64);
        if (!createdIds.includes(contentId)) throw new Error('Only posts created in this run can get images');
        const content = await getContent(ctx, contentId);
        const variant = content.variants.find((v) => v.platform === a.platform) ?? content.variants[0];
        if (!variant) throw new Error('This post has no platform versions');
        const image = await generateVariantImage(ctx, contentId, variant.id);
        await upsertVariant(ctx, contentId, { platform: variant.platform, socialAccountId: variant.socialAccountId, caption: variant.caption, hashtags: variant.hashtags, callToAction: variant.callToAction, mediaPrompt: variant.mediaPrompt, mediaIds: [...variant.media.map((m) => m.media.id), image.media.id] }, variant.id);
        return { input: { contentId, platform: variant.platform }, output: { ok: true, mediaUrl: image.media.url, model: image.model, provider: image.provider } };
      },
      create_signup_form: async (a) => {
        if (formLink) return { input: {}, output: { link: formLink, note: 'A form already exists for this campaign' } };
        const extra = (Array.isArray(a.extraQuestions) ? (a.extraQuestions as Record<string, unknown>[]) : []).slice(0, 3).map((q, i) => {
          const options = (Array.isArray(q.options) ? q.options : []).map((o) => clip(o, 80)).filter(Boolean).slice(0, 12);
          return { key: `question_${i + 1}`, label: clip(q.label, 80) || `Question ${i + 1}`, type: options.length ? ('select' as const) : ('text' as const), required: false, ...(options.length ? { options } : {}) };
        });
        const form = await createLeadForm(ctx, {
          clientId: client.id,
          name: `Campaign: ${run.goal.slice(0, 60)}`,
          title: clip(a.title, 120) || null,
          description: clip(a.description, 500) || null,
          fields: [
            { key: 'name', label: 'Name', type: 'text', required: true },
            { key: 'email', label: 'Email', type: 'email', required: true },
            ...(a.askPhone ? [{ key: 'phone', label: 'Phone', type: 'phone' as const, required: false }] : []),
            ...extra,
          ],
        });
        formLink = `${env.APP_URL}/f/${form.publicKey}`;
        return { input: { title: form.title }, output: { formId: form.id, link: formLink } };
      },
    };

    let summary: string | null = null;
    for (let turn = 0; turn < MAX_TURNS && summary === null; turn++) {
      if ((await db.agentRun.findUnique({ where: { id: runId }, select: { status: true } }))?.status === 'CANCELLED') {
        log.info('run cancelled');
        return { cancelled: true };
      }
      const res = await ai.chatWithTools({ messages, tools: CAMPAIGN_TOOLS, effort: 'medium', maxTokens: 4000 });
      usage = { inputTokens: usage.inputTokens + (res.usage.inputTokens ?? 0), outputTokens: usage.outputTokens + (res.usage.outputTokens ?? 0) };
      lastProvider = res.provider ?? ai.name;
      lastModel = res.model;
      await incrementUsage(run.organizationId, 'aiGenerations');
      const calls: ToolCall[] = res.toolCalls.slice(0, MAX_CALLS_PER_TURN);
      if (!calls.length) {
        summary = res.text?.trim() || 'The agent stopped without a summary.';
        break;
      }
      messages.push({ role: 'assistant', content: res.text, toolCalls: calls });
      for (const call of calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.arguments || '{}') as Record<string, unknown>;
        } catch {
          /* answered below as an error the model can correct */
        }
        let result: Record<string, unknown>;
        if (call.name === 'finish') {
          summary = clip(args.summary, 1500) || 'Campaign prepared.';
          result = { ok: true };
          steps.push({ at: new Date().toISOString(), tool: 'finish', input: {}, output: { summary }, ok: true });
        } else if (!tools[call.name]) {
          result = { error: `Unknown tool ${call.name}` };
          steps.push({ at: new Date().toISOString(), tool: call.name, input: {}, output: result, ok: false });
        } else {
          try {
            const r = await tools[call.name]!(args);
            result = r.output;
            steps.push({ at: new Date().toISOString(), tool: call.name, input: r.input, output: r.output, ok: true });
          } catch (error) {
            result = { error: error instanceof Error ? error.message : String(error) };
            steps.push({ at: new Date().toISOString(), tool: call.name, input: { ...args, variants: undefined }, output: result, ok: false });
          }
        }
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify(result).slice(0, 6000) });
        await save();
      }
    }

    // Everything the agent made goes to people for approval.
    for (const id of createdIds) {
      await submitForApproval(ctx, id).catch((error) => log.warn({ contentId: id, error: error instanceof Error ? error.message : String(error) }, 'could not submit for approval'));
    }
    const status = createdIds.length ? 'COMPLETED' : 'FAILED';
    await save({ status, summary: summary ?? `Stopped after ${MAX_TURNS} steps.`, error: createdIds.length ? null : 'No posts were created', finishedAt: new Date() });
    await audit(ctx, { action: 'agent.run_finished', resourceType: 'AgentRun', resourceId: runId, clientId: client.id, after: { status, posts: createdIds.length, form: Boolean(formLink), promptVersion: CAMPAIGN_AGENT_VERSION } });
    return { status, posts: createdIds.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({ error: message }, 'campaign agent failed');
    await save({ status: 'FAILED', error: message.slice(0, 1000), finishedAt: new Date() });
    return { status: 'FAILED', error: message };
  }
}
