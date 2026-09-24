import { INTENTS } from '@socialpilot/validation';
import { untrustedBlock } from '../injection';
import { UNTRUSTED_CONTENT_RULES } from './shared';

export const INTENT_AGENT_VERSION = 'INTENT_AGENT_V1';

export interface IntentPromptInput {
  brandName: string;
  industry?: string | null;
  platform: string;
  channel: 'DIRECT_MESSAGE' | 'COMMENT';
  message: string;
  recentContext: string[];
}

export function buildIntentPrompt(input: IntentPromptInput) {
  const system = `You classify inbound social media messages for a business's customer inbox.

Choose exactly one intent from: ${INTENTS.join(', ')}.
Definitions:
- PRICE: asks what something costs. PRODUCT_INFO / SERVICE_INFO: asks about features or what is offered.
- AVAILABILITY: stock or open slots. LOCATION: address or directions. HOURS: opening hours.
- BOOKING: wants to book/reserve. QUOTE_REQUEST: wants a custom quote. LEAD: clear purchase intent not covered above.
- COMPLAINT: dissatisfaction. REFUND: wants money back. LEGAL: legal threats, lawsuits, regulatory matters. CONTRACT: contract terms or disputes.
- SPAM: unsolicited promotion, scams, bots, link spam. ABUSE: harassment, hate, threats.
- HUMAN_REQUEST: explicitly asks for a person. GENERAL_QUESTION: other answerable questions. OTHER: greetings or messages with no clear intent.

"confidence" is your subjective certainty in the chosen intent from 0 to 1 — use lower values for ambiguous, very short or multi-intent messages. It is not a probability guarantee.
Set requestsHuman when the customer asks for a person. Set containsThreat for threats of violence or self-harm. Set containsSensitivePersonalInfo when the message contains health, financial account, government ID or similar sensitive data. Set buyingSignal when the person shows interest in purchasing.

${UNTRUSTED_CONTENT_RULES}`;

  const context = input.recentContext.length
    ? untrustedBlock('conversation_history', input.recentContext.join('\n'), 3000)
    : '(no earlier messages)';

  const user = `Business: ${input.brandName}${input.industry ? ` (${input.industry})` : ''}
Channel: ${input.platform} ${input.channel === 'COMMENT' ? 'public comment' : 'direct message'}

Earlier messages in this conversation:
${context}

Message to classify:
${untrustedBlock('customer_message', input.message, 4000)}`;

  return { system, user };
}
