import type { AgentMessage, ChatWithToolsResult, ToolSpec } from '../providers/types';
import { UNTRUSTED_CONTENT_RULES } from '../prompts/shared';

/**
 * Campaign Agent: turns a business goal ("fill our weekend baking classes") into a
 * campaign of post drafts, images and a sign-up form by calling tools step by step.
 * Everything it creates is a draft that goes to human approval.
 */
export const CAMPAIGN_AGENT_VERSION = 'CAMPAIGN_AGENT_V2';
export const CAMPAIGN_MAX_POSTS = 5;

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const CAMPAIGN_TOOLS: ToolSpec[] = [
  {
    name: 'get_business_profile',
    description: 'Get the business profile: name, industry, description, tone, audience, services, products, location, website, and which social platforms are connected (only these can be posted to).',
    parameters: obj({}),
  },
  {
    name: 'search_knowledge',
    description: "Search the business's own knowledge base (prices, opening hours, policies, offers). Use it for any fact you put in a post.",
    parameters: obj({ query: { type: 'string', description: 'What to look up' } }, ['query']),
  },
  {
    name: 'get_recent_posts',
    description: 'Get the most recent posts, so the campaign does not repeat them.',
    parameters: obj({}),
  },
  {
    name: 'create_post_draft',
    description: `Create one post draft for the campaign, with a version per connected platform, planned for a date. It goes to the approval queue; nothing is published. At most ${CAMPAIGN_MAX_POSTS} posts.`,
    parameters: obj(
      {
        title: { type: 'string', description: 'Short internal title' },
        plannedDate: { type: 'string', description: 'YYYY-MM-DD, within the campaign period' },
        baseContent: { type: 'string', description: 'The core message in one or two sentences' },
        imageBrief: { type: 'string', description: 'What the image for this post should show (no text in the image)' },
        variants: {
          type: 'array',
          description: 'One per connected platform',
          items: obj(
            {
              platform: { type: 'string', enum: ['FACEBOOK', 'INSTAGRAM', 'LINKEDIN', 'TIKTOK'] },
              caption: { type: 'string', description: 'Full caption written for this platform, in the brand voice' },
              hashtags: { type: 'array', items: { type: 'string' } },
            },
            ['platform', 'caption', 'hashtags'],
          ),
        },
      },
      ['title', 'plannedDate', 'baseContent', 'imageBrief', 'variants'],
    ),
  },
  {
    name: 'generate_post_image',
    description: "Create the image for a post draft with Muse Image, from the post's image brief, sized for the platform, and attach it.",
    parameters: obj({ contentId: { type: 'string' }, platform: { type: 'string', enum: ['FACEBOOK', 'INSTAGRAM', 'LINKEDIN', 'TIKTOK'] } }, ['contentId', 'platform']),
  },
  {
    name: 'create_signup_form',
    description: 'Create a website sign-up or enquiry form for the campaign (for bookings, classes, orders or leads). Returns a shareable link the posts can point to.',
    parameters: obj(
      {
        title: { type: 'string', description: 'Heading shown on the form' },
        description: { type: 'string', description: 'One or two sentences shown above the questions' },
        askPhone: { type: 'boolean' },
        extraQuestions: {
          type: 'array',
          description: 'Up to 3 extra questions, e.g. preferred date or number of people',
          items: obj({ label: { type: 'string' }, options: { type: 'array', items: { type: 'string' }, description: 'Choices, if it is a dropdown' } }, ['label']),
        },
      },
      ['title', 'description'],
    ),
  },
  {
    name: 'finish',
    description: 'End the run with a short summary for the business owner of what was created and what they should review.',
    parameters: obj({ summary: { type: 'string' } }, ['summary']),
  },
];

export interface CampaignBrief {
  goal: string;
  startDate: string;
  days: number;
  maxPosts: number;
  language?: string | null;
}

export function campaignSystemPrompt(brief: CampaignBrief): string {
  return `You are SocialPilot's Campaign Agent. You plan and prepare a short social media campaign for one small business by calling tools.

Campaign period: ${brief.startDate} for ${brief.days} days. Create between 2 and ${brief.maxPosts} posts.${brief.language ? ` Write in ${brief.language}.` : ''}

How to work:
1. Call get_business_profile first. Post only to the connected platforms it lists.
2. Look up any fact you will mention with search_knowledge. Use ONLY facts from the business profile and knowledge results: never invent products, dishes, flavours, prices, dates, times, discounts, quantities or claims. Where a post needs a detail you don't have, write a clearly marked placeholder in square brackets, such as [dish name] or [launch date], for the owner to fill in.
3. Call get_recent_posts so the campaign doesn't repeat them.
4. Plan a short arc (for example: announce, details, reminder or social proof, last chance) spread across the period. Create each post with create_post_draft, with a caption written for each platform in the brand's voice.
5. If the goal is about bookings, sign-ups, classes, orders or enquiries, call create_signup_form once and mention its link in the captions as "link in bio" or "sign up via the link".
6. Call generate_post_image for each post, using its Instagram version if there is one, else the first platform.
7. Call finish with a two or three sentence summary for the owner. If you used any [placeholders], list them so the owner knows what to fill in.

Work efficiently: call several tools in one turn when they don't depend on each other (for example, create all post drafts together, then all images together). Everything you create is a draft that a person reviews before anything is published. Keep captions specific and human; no generic filler or excessive emoji. ${UNTRUSTED_CONTENT_RULES}`;
}

export function campaignUserMessage(brief: CampaignBrief): string {
  return `<untrusted_goal>${brief.goal.slice(0, 1000)}</untrusted_goal>\nPrepare the campaign for this goal.`;
}

// ── Offline stand-in: works through the same tools in a fixed order ──

type Done = { name: string; args: Record<string, unknown>; result: Record<string, unknown> };

function history(messages: AgentMessage[]): Done[] {
  const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
  const done: Done[] = [];
  for (const m of messages) {
    if (m.role === 'assistant') for (const c of m.toolCalls ?? []) calls.set(c.id, { name: c.name, args: safeJson(c.arguments) });
    if (m.role === 'tool') {
      const call = calls.get(m.toolCallId);
      if (call) done.push({ ...call, result: safeJson(m.content) });
    }
  }
  return done;
}

function safeJson(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Deterministic next step for the offline provider, so demos and tests run without a key. */
export function mockCampaignTurn(messages: AgentMessage[]): ChatWithToolsResult {
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const startDate = /Campaign period: (\d{4}-\d{2}-\d{2}) for (\d+) days/.exec(system);
  const start = startDate?.[1] ?? new Date().toISOString().slice(0, 10);
  const days = Number(startDate?.[2] ?? 7);
  const userMsg = messages.find((m) => m.role === 'user')?.content ?? '';
  const goal = /<untrusted_goal>([\s\S]*?)<\/untrusted_goal>/.exec(userMsg)?.[1]?.trim() ?? 'our next campaign';
  const done = history(messages);
  const has = (name: string) => done.some((d) => d.name === name);
  const profile = done.find((d) => d.name === 'get_business_profile')?.result ?? {};
  const brand = String(profile.brandName ?? 'our business');
  const platforms = ((profile.connectedPlatforms as string[] | undefined) ?? ['INSTAGRAM']).filter((p) => p !== 'WHATSAPP');
  const posts = done.filter((d) => d.name === 'create_post_draft');
  const form = done.find((d) => d.name === 'create_signup_form')?.result;
  const wantsForm = /sign|book|class|register|enrol|enroll|order|lead|enquir|reserve|ticket/i.test(goal);

  let n = 0;
  const call = (name: string, args: Record<string, unknown>): ChatWithToolsResult => ({ text: null, toolCalls: [{ id: `mock_${messages.length}_${n++}`, name, arguments: JSON.stringify(args) }], model: 'mock-v1', usage: {} });

  if (!has('get_business_profile')) return call('get_business_profile', {});
  if (!has('search_knowledge')) return call('search_knowledge', { query: goal });
  if (!has('get_recent_posts')) return call('get_recent_posts', {});
  if (wantsForm && !form) return call('create_signup_form', { title: `Sign up: ${goal.slice(0, 60)}`, description: `Leave your details and ${brand} will confirm your place.`, askPhone: true, extraQuestions: [{ label: 'Preferred date' }, { label: 'Number of people', options: ['1', '2', '3', '4+'] }] });

  const arc = [
    { title: 'Announcement', offset: 0, line: `Big news from ${brand}: ${goal}.` },
    { title: 'The details', offset: Math.max(1, Math.floor(days / 3)), line: `Here's what to expect: ${goal}.` },
    { title: 'Last chance', offset: Math.max(2, days - 1), line: `Last chance: ${goal}. Don't miss out.` },
  ];
  const link = form ? ' Sign up via the link in our bio.' : '';
  const next = arc[posts.length];
  if (next) {
    return call('create_post_draft', {
      title: next.title,
      plannedDate: addDays(start, next.offset),
      baseContent: next.line,
      imageBrief: `${brand}: ${goal}, warm natural light`,
      variants: platforms.slice(0, 3).map((platform) => ({ platform, caption: `${next.line}${link}`, hashtags: [brand.replace(/[^A-Za-z0-9]/g, '')].filter(Boolean) })),
    });
  }
  const withImage = new Set(done.filter((d) => d.name === 'generate_post_image').map((d) => String(d.args.contentId)));
  const missing = posts.find((p) => p.result.contentId && !withImage.has(String(p.result.contentId)));
  if (missing) {
    const variants = (missing.args.variants as { platform: string }[] | undefined) ?? [];
    const platform = variants.find((v) => v.platform === 'INSTAGRAM')?.platform ?? variants[0]?.platform ?? 'INSTAGRAM';
    return call('generate_post_image', { contentId: missing.result.contentId, platform });
  }
  return call('finish', { summary: `Prepared ${posts.length} posts for "${goal}"${form ? ' and a sign-up form' : ''}. Review them in Approvals.` });
}
