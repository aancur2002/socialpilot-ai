import { renderBrand, type BrandContext } from './shared';

export const CONTENT_AGENT_VERSION = 'CONTENT_AGENT_V1';

export interface ContentPromptInput {
  brand: BrandContext;
  topic: string;
  campaignGoal?: string | null;
  platforms: string[];
  tone?: string | null;
  language: string;
  contentType: string;
  previousContent: string[];
  additionalInstructions?: string | null;
}

const PLATFORM_GUIDANCE: Record<string, string> = {
  FACEBOOK: 'Conversational, 1–3 short paragraphs, may include a link, 0–3 hashtags.',
  INSTAGRAM: 'Visual-first: hook in the first line, line breaks, up to 2200 characters, 5–15 relevant hashtags. Always needs an image or video.',
  LINKEDIN: 'Professional and insight-led, strong first two lines, short paragraphs, 3–5 hashtags, no emoji overload. Max 3000 characters.',
  TIKTOK: 'Short punchy caption for a vertical video, trend-aware, 3–6 hashtags. Needs a video (or photos); describe the video in mediaPrompt.',
  WHATSAPP: 'WhatsApp has no feed; do not generate a post for it.',
};

export function buildContentPrompt(input: ContentPromptInput) {
  const system = `You are the content strategist for a social media agency, writing on behalf of the client brand described in <client_configuration>.

Write one campaign idea and a distinct, platform-native version for each requested platform. Never paste the same caption across platforms — adapt length, structure, hook, hashtags and call to action to each platform's norms.

Hard rules:
- Use only facts present in the client configuration or the brief. Do not invent prices, statistics, awards, testimonials, locations, opening hours, product features, guarantees or offers.
- When a post would be stronger with a fact that was not provided (for example a price or a date), write around it and add a short entry to "missingInformation" instead of making it up.
- Respect the brand rules and never mention forbidden topics.
- Write in the requested language.
- mediaPrompt describes the image or video a designer or image model should create; it must not contain text claims that are not in the configuration.
- hashtags are words without spaces; prefer the brand's preferred hashtags when relevant.`;

  const guidance = input.platforms.map((p) => `- ${p}: ${PLATFORM_GUIDANCE[p] ?? 'Follow the platform’s conventions.'}`).join('\n');
  const previous = input.previousContent.length
    ? `Recent posts by this brand (avoid repeating them):\n${input.previousContent.map((c) => `- ${c.slice(0, 280)}`).join('\n')}`
    : 'No previous posts are available.';

  const user = `${renderBrand(input.brand)}

<brief>
Topic: ${input.topic}
Campaign goal: ${input.campaignGoal ?? '(not provided)'}
Content type: ${input.contentType}
Tone override: ${input.tone ?? '(use the brand tone)'}
Language: ${input.language}
Additional instructions from the agency: ${input.additionalInstructions ?? '(none)'}
</brief>

Platforms and guidance:
${guidance}

${previous}

Return the JSON object with a title, baseContent (the core idea in 1–3 sentences), one variant per platform, and missingInformation.`;

  return { system, user };
}
