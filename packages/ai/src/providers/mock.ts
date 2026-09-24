import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { IntentKey } from '@socialpilot/validation';
import { detectPromptInjection } from '../injection';
import {
  AiOutputValidationError,
  type AIProvider,
  type EmbeddingProvider,
  type GenerateStructuredInput,
  type GenerateStructuredResult,
  type GenerateTextInput,
  type GenerateTextResult,
  type ModelTier,
} from './types';

// ── Deterministic heuristics ─────────────────────────────────────────────

const INTENT_RULES: { intent: IntentKey; re: RegExp; confidence: number }[] = [
  { intent: 'SPAM', re: /(free followers|crypto|bitcoin|click (this|my) link|dm me for promo|earn \$\d+|whatsapp me at|investment opportunity)/i, confidence: 0.95 },
  { intent: 'ABUSE', re: /\b(idiot|stupid|hate you|kill|scam artists|trash company)\b/i, confidence: 0.9 },
  { intent: 'LEGAL', re: /\b(lawyer|attorney|lawsuit|sue|legal action|court)\b/i, confidence: 0.93 },
  { intent: 'REFUND', re: /\b(refund|money back|chargeback|reimburse)\b/i, confidence: 0.93 },
  { intent: 'CONTRACT', re: /\b(contract|agreement terms|cancel (my|the) (subscription|contract))\b/i, confidence: 0.88 },
  { intent: 'COMPLAINT', re: /\b(terrible|awful|disappointed|worst|complain|broken|never arrived|unacceptable|rude)\b/i, confidence: 0.9 },
  { intent: 'HUMAN_REQUEST', re: /\b(speak|talk) (to|with) (a |an )?(human|person|manager|someone|agent)\b|\breal person\b/i, confidence: 0.95 },
  { intent: 'QUOTE_REQUEST', re: /\b(quote|estimate|proposal)\b/i, confidence: 0.9 },
  { intent: 'BOOKING', re: /\b(book|booking|appointment|reserve|reservation|schedule a)\b/i, confidence: 0.92 },
  { intent: 'PRICE', re: /\b(price|cost|how much|pricing|rates?|fee|€|\$)\b/i, confidence: 0.94 },
  { intent: 'HOURS', re: /\b(hours|open|close|closing|opening)\b/i, confidence: 0.93 },
  { intent: 'LOCATION', re: /\b(where are you|address|located|location|directions)\b/i, confidence: 0.93 },
  { intent: 'AVAILABILITY', re: /\b(available|availability|in stock|slots?)\b/i, confidence: 0.9 },
  { intent: 'SERVICE_INFO', re: /\b(services?|do you (offer|provide|do))\b/i, confidence: 0.9 },
  { intent: 'PRODUCT_INFO', re: /\b(products?|features?|sizes?|colou?rs?|materials?)\b/i, confidence: 0.9 },
  { intent: 'LEAD', re: /\b(interested|want to buy|i'?d like to (buy|order|purchase)|sign me up)\b/i, confidence: 0.88 },
];

export function mockClassifyIntent(text: string): { intent: IntentKey; confidence: number } {
  const trimmed = text.trim();
  if (trimmed.length < 3) return { intent: 'OTHER', confidence: 0.5 };
  for (const rule of INTENT_RULES) if (rule.re.test(trimmed)) return { intent: rule.intent, confidence: rule.confidence };
  if (trimmed.endsWith('?')) return { intent: 'GENERAL_QUESTION', confidence: 0.8 };
  return { intent: 'OTHER', confidence: 0.6 };
}

const STOPWORDS = new Set('a an the and or but is are was were be to of in on for with at by from do does did you your we our i me my it this that what how when where who can could would will please hi hello hey thanks'.split(' '));
const tokens = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter((t) => t.length > 1 && !STOPWORDS.has(t)) ?? [];

function bestSentence(query: string, content: string): { sentence: string; overlap: number } {
  const q = new Set(tokens(query));
  let best = { sentence: '', overlap: 0 };
  for (const sentence of content.split(/(?<=[.!?])\s+|\n+/)) {
    const overlap = tokens(sentence).filter((t) => q.has(t)).length;
    if (overlap > best.overlap) best = { sentence: sentence.trim(), overlap };
  }
  return best;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_RE = /(\+?\d[\d\s().-]{7,}\d)/;

// ── Mock context contracts (what agents pass as mockContext) ─────────────

interface ContentCtx {
  brand: { brandName: string; description?: string | null; cta?: string | null; preferredHashtags?: string[]; website?: string | null; services?: string[] };
  topic: string;
  platforms: string[];
  campaignGoal?: string | null;
}
interface ReplyCtx {
  message: string;
  intent: string;
  brandName: string;
  knowledge: { id: string; content: string }[];
  channel: string;
}
interface LeadCtx {
  messages: string[];
  contactName?: string | null;
}
interface AnalyticsCtx {
  brandName: string;
  periodLabel: string;
  metrics: Record<string, number | string | null>;
  mockDataPresent: boolean;
  unavailableMetrics: string[];
}
interface SummaryCtx {
  previousSummary?: string | null;
  messages: { from: string; text: string }[];
}

function mockOutput(schemaName: string, ctx: unknown): unknown {
  switch (schemaName) {
    case 'content_generation': {
      const c = ctx as ContentCtx;
      const tags = (c.brand.preferredHashtags?.length ? c.brand.preferredHashtags : [c.brand.brandName.replace(/\W/g, ''), c.topic.split(' ')[0] ?? 'news'])
        .map((t) => t.replace(/^#/, ''))
        .slice(0, 5);
      const cta = c.brand.cta ?? null;
      const about = c.brand.description ? ` ${c.brand.description.split('.')[0]}.` : '';
      const variants = c.platforms
        .filter((p) => p !== 'WHATSAPP')
        .map((platform) => {
          switch (platform) {
            case 'INSTAGRAM':
              return { platform, title: null, caption: `✨ ${c.topic} ✨\n\nAt ${c.brand.brandName}, we're all about this.${about}\n\n${cta ? `👉 ${cta}` : 'Tell us what you think below 👇'}`, hashtags: tags, callToAction: cta, mediaType: 'image', mediaPrompt: `Bright lifestyle photo illustrating "${c.topic}" for ${c.brand.brandName}` };
            case 'LINKEDIN':
              return { platform, title: c.topic, caption: `${c.topic}: what it means for our customers.\n\nAt ${c.brand.brandName}, we believe the details matter.${about}\n\n${cta ?? 'What has your experience been? Share below.'}`, hashtags: tags.slice(0, 3), callToAction: cta, mediaType: 'none', mediaPrompt: null };
            case 'TIKTOK':
              return { platform, title: null, caption: `POV: ${c.topic.toLowerCase()} done right 🔥 ${cta ?? ''}`.trim(), hashtags: [...tags.slice(0, 3), 'fyp'], callToAction: cta, mediaType: 'video', mediaPrompt: `15-second vertical video: quick cuts showing ${c.topic} at ${c.brand.brandName}` };
            default:
              return { platform, title: null, caption: `${c.topic} — here's what's new at ${c.brand.brandName}.${about} ${cta ?? ''}`.trim(), hashtags: tags.slice(0, 2), callToAction: cta, mediaType: 'image', mediaPrompt: `Photo representing ${c.topic}` };
          }
        });
      const missing: string[] = [];
      if (!c.brand.description) missing.push('Brand description (to explain what makes the brand different)');
      if (!c.brand.cta) missing.push('Default call to action');
      if (!c.brand.website) missing.push('Website URL for link posts');
      return { title: c.topic.slice(0, 120), baseContent: `${c.brand.brandName} shares ${c.topic.toLowerCase()}${c.campaignGoal ? ` to ${c.campaignGoal.toLowerCase()}` : ''}.`, variants, missingInformation: missing };
    }
    case 'intent_classification': {
      const text = (ctx as { message: string }).message;
      const { intent, confidence } = mockClassifyIntent(text);
      return {
        intent,
        confidence,
        isSpam: intent === 'SPAM',
        sentiment: ['COMPLAINT', 'REFUND', 'ABUSE', 'LEGAL'].includes(intent) ? 'negative' : 'neutral',
        requestsHuman: intent === 'HUMAN_REQUEST',
        containsThreat: /\b(kill|hurt you|bomb)\b/i.test(text),
        containsSensitivePersonalInfo: /\b(ssn|social security|credit card|card number|passport number|diagnos)/i.test(text),
        buyingSignal: ['PRICE', 'BOOKING', 'QUOTE_REQUEST', 'LEAD', 'AVAILABILITY'].includes(intent),
        reason: `Mock classifier matched ${intent}.`,
      };
    }
    case 'reply_generation': {
      const c = ctx as ReplyCtx;
      if (detectPromptInjection(c.message).suspected) {
        return { suggestedReply: `Thanks for reaching out! I can only help with questions about ${c.brandName}. What would you like to know?`, confidence: 0.55, requiresHuman: false, reason: 'Message contained an instruction-override attempt; declined and redirected.', usedKnowledgeIds: [], missingInformation: [] };
      }
      let best = { id: '', sentence: '', overlap: 0 };
      for (const k of c.knowledge) {
        const s = bestSentence(c.message, k.content);
        if (s.overlap > best.overlap) best = { id: k.id, ...s };
      }
      const publicNote = c.channel === 'COMMENT' ? ' Feel free to send us a DM for anything specific!' : '';
      if (best.overlap >= 2 || (best.overlap >= 1 && tokens(c.message).length <= 3)) {
        return { suggestedReply: `Thanks for your message! ${best.sentence}${publicNote}`, confidence: best.overlap >= 2 ? 0.93 : 0.82, requiresHuman: false, reason: 'Answered from the knowledge base.', usedKnowledgeIds: [best.id], missingInformation: [] };
      }
      return { suggestedReply: `Thanks for reaching out to ${c.brandName}! Let me check on that and get back to you shortly.`, confidence: 0.45, requiresHuman: true, reason: 'No relevant knowledge found for this question.', usedKnowledgeIds: [], missingInformation: ['Knowledge base has no answer for this question'] };
    }
    case 'lead_extraction': {
      const c = ctx as LeadCtx;
      const all = c.messages.join('\n');
      const email = EMAIL_RE.exec(all)?.[0] ?? null;
      const phone = PHONE_RE.exec(all)?.[1]?.trim() ?? null;
      const buying = /\b(price|cost|book|quote|interested|buy|order|appointment|available|how much)\b/i.test(all);
      return { isLead: buying || Boolean(email || phone), confidence: buying ? 0.85 : 0.6, name: c.contactName ?? null, email, phone, interest: buying ? (c.messages.at(-1) ?? '').slice(0, 120) : null, reason: 'Mock lead heuristic.' };
    }
    case 'analytics_summary': {
      const c = ctx as AnalyticsCtx;
      const entries = Object.entries(c.metrics).filter(([, v]) => v !== null && v !== undefined);
      const caveats = [...(c.mockDataPresent ? ['Includes simulated metrics from mock integrations — not real platform data.'] : [])];
      if (c.unavailableMetrics.length) caveats.push(`Not provided by the platforms: ${c.unavailableMetrics.join(', ')}.`);
      return {
        headline: `${c.brandName} — ${c.periodLabel} summary`,
        summary: entries.map(([k, v]) => `${k}: ${v}`).join(' · ') || 'No activity recorded in this period.',
        highlights: entries.slice(0, 5).map(([k, v]) => `${k}: ${v}`),
        trends: [],
        contentIdeas: ['Repeat the format of your best-performing post', 'Answer a frequent customer question as a post'],
        engagementObservations: [],
        leadObservations: [],
        caveats,
      };
    }
    case 'conversation_summary': {
      const c = ctx as SummaryCtx;
      const recent = c.messages.slice(-6).map((m) => `${m.from}: ${m.text.slice(0, 80)}`).join(' | ');
      return { summary: `${c.previousSummary ? `${c.previousSummary.slice(0, 600)} ` : ''}${recent}`.slice(0, 1900) };
    }
    default:
      throw new Error(`Mock AI provider has no handler for schema "${schemaName}"`);
  }
}

/** Offline, deterministic provider for development and tests. Refused in production by config validation. */
export class MockAIProvider implements AIProvider {
  readonly name = 'mock';

  modelFor(tier: ModelTier): string {
    return tier === 'fast' ? 'mock-fast-v1' : 'mock-v1';
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    const last = input.messages.at(-1)?.content ?? '';
    return { text: `[mock] ${last.slice(0, 200)}`, model: this.modelFor(input.tier ?? 'default'), usage: { inputTokens: Math.ceil(last.length / 4), outputTokens: 20 } };
  }

  async generateStructured<S extends z.ZodType>(input: GenerateStructuredInput<S>): Promise<GenerateStructuredResult<z.infer<S>>> {
    const raw = mockOutput(input.schemaName, input.mockContext);
    const parsed = input.schema.safeParse(raw);
    if (!parsed.success) throw new AiOutputValidationError(`mock ${input.schemaName}: ${parsed.error.message}`, JSON.stringify(raw));
    const promptChars = input.system.length + input.messages.reduce((n, m) => n + m.content.length, 0);
    return { data: parsed.data, model: this.modelFor(input.tier ?? 'default'), usage: { inputTokens: Math.ceil(promptChars / 4), outputTokens: Math.ceil(JSON.stringify(raw).length / 4) } };
  }
}

/**
 * Deterministic feature-hashing embedder (unigrams + bigrams → 1536 dims, L2-normalized).
 * Captures lexical overlap only — use a real embedding model for semantic quality.
 */
export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'mock';
  readonly model = 'hashing-1536-v1';
  readonly dimensions = 1536;

  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const vec = new Array<number>(this.dimensions).fill(0);
      const toks = tokens(text);
      const features = [...toks, ...toks.slice(1).map((t, i) => `${toks[i]}_${t}`)];
      for (const f of features) {
        const h = createHash('md5').update(f).digest();
        const idx = h.readUInt32BE(0) % this.dimensions;
        vec[idx]! += h[4]! & 1 ? 1 : -1;
      }
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
      if (norm === 0) {
        vec[0] = 1; // pgvector cosine distance is undefined for the zero vector
        return vec;
      }
      return vec.map((v) => v / norm);
    });
  }
}
