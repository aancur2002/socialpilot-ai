import { z } from 'zod';
import { INTENTS, PLATFORMS } from '@socialpilot/validation';

// Output contracts for every agent. Optional values are modelled as nullable so
// the JSON schema can mark every property required (strict structured outputs).

const confidence = z.number().min(0).max(1);

export const contentVariantOutputSchema = z.object({
  platform: z.enum(PLATFORMS),
  title: z.string().nullable(),
  caption: z.string().min(1).max(10000),
  hashtags: z.array(z.string()).max(30),
  callToAction: z.string().nullable(),
  mediaType: z.enum(['none', 'image', 'video', 'carousel']),
  mediaPrompt: z.string().nullable(),
});

export const contentGenerationOutputSchema = z.object({
  title: z.string().min(1).max(200),
  baseContent: z.string().min(1).max(5000),
  variants: z.array(contentVariantOutputSchema).min(1).max(10),
  /** Facts the brand profile did not provide and the AI refused to invent */
  missingInformation: z.array(z.string()).max(20),
});
export type ContentGenerationOutput = z.infer<typeof contentGenerationOutputSchema>;

export const intentOutputSchema = z.object({
  intent: z.enum(INTENTS),
  confidence,
  isSpam: z.boolean(),
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  requestsHuman: z.boolean(),
  containsThreat: z.boolean(),
  containsSensitivePersonalInfo: z.boolean(),
  buyingSignal: z.boolean(),
  reason: z.string().max(500),
});
export type IntentOutput = z.infer<typeof intentOutputSchema>;

export const replyOutputSchema = z.object({
  suggestedReply: z.string().min(1).max(2000),
  confidence,
  requiresHuman: z.boolean(),
  reason: z.string().max(500),
  usedKnowledgeIds: z.array(z.string()).max(20),
  missingInformation: z.array(z.string()).max(10),
});
export type ReplyOutput = z.infer<typeof replyOutputSchema>;

export const leadOutputSchema = z.object({
  isLead: z.boolean(),
  confidence,
  name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  interest: z.string().nullable(),
  reason: z.string().max(500),
});
export type LeadOutput = z.infer<typeof leadOutputSchema>;

export const analyticsOutputSchema = z.object({
  headline: z.string().max(300),
  summary: z.string().max(3000),
  highlights: z.array(z.string()).max(10),
  trends: z.array(z.object({ metric: z.string(), direction: z.enum(['up', 'down', 'flat']), observation: z.string() })).max(15),
  contentIdeas: z.array(z.string()).max(10),
  engagementObservations: z.array(z.string()).max(10),
  leadObservations: z.array(z.string()).max(10),
  caveats: z.array(z.string()).max(10),
});
export type AnalyticsOutput = z.infer<typeof analyticsOutputSchema>;

export const conversationSummaryOutputSchema = z.object({
  summary: z.string().max(2000),
});
export type ConversationSummaryOutput = z.infer<typeof conversationSummaryOutputSchema>;
