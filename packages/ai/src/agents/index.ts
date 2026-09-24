import { buildAnalyticsPrompt, buildSummaryPrompt, ANALYTICS_AGENT_VERSION, SUMMARY_AGENT_VERSION, type AnalyticsPromptInput } from '../prompts/analytics-agent';
import { buildContentPrompt, CONTENT_AGENT_VERSION, type ContentPromptInput } from '../prompts/content-agent';
import { buildIntentPrompt, INTENT_AGENT_VERSION, type IntentPromptInput } from '../prompts/intent-agent';
import { buildLeadPrompt, LEAD_AGENT_VERSION, type LeadPromptInput } from '../prompts/lead-agent';
import { buildReplyPrompt, REPLY_AGENT_VERSION, type ReplyPromptInput } from '../prompts/reply-agent';
import type { AIProvider } from '../providers/types';
import {
  analyticsOutputSchema,
  contentGenerationOutputSchema,
  conversationSummaryOutputSchema,
  intentOutputSchema,
  leadOutputSchema,
  replyOutputSchema,
  type AnalyticsOutput,
  type ContentGenerationOutput,
  type IntentOutput,
  type LeadOutput,
  type ReplyOutput,
} from '../schemas';
import { runStructured, type GenerationLogger, type StructuredOutcome } from './runner';

export class ContentAgent {
  constructor(private readonly provider: AIProvider, private readonly log: GenerationLogger) {}

  async generate(input: ContentPromptInput): Promise<StructuredOutcome<ContentGenerationOutput>> {
    const { system, user } = buildContentPrompt(input);
    const outcome = await runStructured(
      this.provider,
      {
        agent: 'ContentAgent',
        promptVersion: CONTENT_AGENT_VERSION,
        inputType: 'content_brief',
        schemaName: 'content_generation',
        schema: contentGenerationOutputSchema,
        system,
        user,
        effort: 'medium',
        maxTokens: 8000,
        mockContext: { brand: input.brand, topic: input.topic, platforms: input.platforms, campaignGoal: input.campaignGoal },
      },
      this.log,
    );
    // Keep only requested platforms, one variant each.
    const seen = new Set<string>();
    outcome.data.variants = outcome.data.variants.filter((v) => input.platforms.includes(v.platform) && !seen.has(v.platform) && seen.add(v.platform));
    return outcome;
  }
}

export class IntentAgent {
  constructor(private readonly provider: AIProvider, private readonly log: GenerationLogger) {}

  async classify(input: IntentPromptInput): Promise<StructuredOutcome<IntentOutput>> {
    const { system, user } = buildIntentPrompt(input);
    return runStructured(
      this.provider,
      {
        agent: 'IntentAgent',
        promptVersion: INTENT_AGENT_VERSION,
        inputType: input.channel === 'COMMENT' ? 'comment' : 'direct_message',
        schemaName: 'intent_classification',
        schema: intentOutputSchema,
        system,
        user,
        tier: 'fast',
        effort: 'low',
        maxTokens: 1024,
        mockContext: { message: input.message },
      },
      this.log,
    );
  }
}

export class ReplyAgent {
  constructor(private readonly provider: AIProvider, private readonly log: GenerationLogger) {}

  async draft(input: ReplyPromptInput): Promise<StructuredOutcome<ReplyOutput>> {
    const { system, user } = buildReplyPrompt(input);
    const outcome = await runStructured(
      this.provider,
      {
        agent: 'ReplyAgent',
        promptVersion: REPLY_AGENT_VERSION,
        inputType: input.channel === 'COMMENT' ? 'comment' : 'direct_message',
        schemaName: 'reply_generation',
        schema: replyOutputSchema,
        system,
        user,
        effort: 'medium',
        maxTokens: 2048,
        mockContext: { message: input.message, intent: input.intent, brandName: input.brand.brandName, knowledge: input.knowledge, channel: input.channel },
      },
      this.log,
    );
    // Drop hallucinated knowledge ids.
    const valid = new Set(input.knowledge.map((k) => k.id));
    outcome.data.usedKnowledgeIds = outcome.data.usedKnowledgeIds.filter((id) => valid.has(id));
    return outcome;
  }
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export class LeadAgent {
  constructor(private readonly provider: AIProvider, private readonly log: GenerationLogger) {}

  async extract(input: LeadPromptInput): Promise<StructuredOutcome<LeadOutput>> {
    const { system, user } = buildLeadPrompt(input);
    const outcome = await runStructured(
      this.provider,
      {
        agent: 'LeadAgent',
        promptVersion: LEAD_AGENT_VERSION,
        inputType: 'conversation',
        schemaName: 'lead_extraction',
        schema: leadOutputSchema,
        system,
        user,
        tier: 'fast',
        effort: 'low',
        maxTokens: 1024,
        mockContext: { messages: input.messages, contactName: input.contactName },
      },
      this.log,
    );
    // Contact details must literally appear in the customer's messages — never trust invented values.
    const text = input.messages.join('\n');
    const emails = new Set((text.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase()));
    if (outcome.data.email && !emails.has(outcome.data.email.toLowerCase())) outcome.data.email = null;
    const digits = text.replace(/\D/g, '');
    if (outcome.data.phone && !digits.includes(outcome.data.phone.replace(/\D/g, ''))) outcome.data.phone = null;
    return outcome;
  }
}

export class AnalyticsAgent {
  constructor(private readonly provider: AIProvider, private readonly log: GenerationLogger) {}

  async summarize(input: AnalyticsPromptInput): Promise<StructuredOutcome<AnalyticsOutput>> {
    const { system, user } = buildAnalyticsPrompt(input);
    return runStructured(
      this.provider,
      {
        agent: 'AnalyticsAgent',
        promptVersion: ANALYTICS_AGENT_VERSION,
        inputType: 'metrics',
        schemaName: 'analytics_summary',
        schema: analyticsOutputSchema,
        system,
        user,
        effort: 'medium',
        maxTokens: 4000,
        mockContext: { brandName: input.brandName, periodLabel: input.periodLabel, metrics: input.metrics, mockDataPresent: input.mockDataPresent, unavailableMetrics: input.unavailableMetrics },
      },
      this.log,
    );
  }
}

export class ConversationSummaryAgent {
  constructor(private readonly provider: AIProvider, private readonly log: GenerationLogger) {}

  async summarize(input: { previousSummary?: string | null; messages: { from: string; text: string }[] }) {
    const { system, user } = buildSummaryPrompt(input);
    return runStructured(
      this.provider,
      {
        agent: 'ConversationSummaryAgent',
        promptVersion: SUMMARY_AGENT_VERSION,
        inputType: 'conversation',
        schemaName: 'conversation_summary',
        schema: conversationSummaryOutputSchema,
        system,
        user,
        tier: 'fast',
        effort: 'low',
        maxTokens: 800,
        mockContext: input,
      },
      this.log,
    );
  }
}
