import { untrustedBlock } from '../injection';
import { UNTRUSTED_CONTENT_RULES } from './shared';

export const LEAD_AGENT_VERSION = 'LEAD_AGENT_V1';

export interface LeadPromptInput {
  brandName: string;
  services: string[];
  products: string[];
  contactName?: string | null;
  messages: string[];
}

export function buildLeadPrompt(input: LeadPromptInput) {
  const system = `You decide whether a social media conversation represents a sales lead for the business, and extract contact details the customer has shared.

- isLead is true only when the person shows genuine interest in buying, booking or requesting a quote.
- Extract name, email, phone and interest only when they appear in the messages (or the known contact name). Use null otherwise — never invent contact details.
- interest is a short phrase naming the product or service they want.
- confidence is your subjective certainty (0–1).

${UNTRUSTED_CONTENT_RULES}`;

  const user = `Business: ${input.brandName}
Services: ${input.services.join('; ') || '(not provided)'}
Products: ${input.products.join('; ') || '(not provided)'}
Known contact name: ${input.contactName ?? '(unknown)'}

Customer messages:
${untrustedBlock('customer_messages', input.messages.join('\n---\n'), 6000)}`;

  return { system, user };
}
