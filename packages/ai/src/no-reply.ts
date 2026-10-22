/**
 * Messages that need no AI at all: emoji-only reactions and short acknowledgements
 * ("thanks", "ok", "got it"). Skipping them saves the whole triage, lead and reply
 * pipeline (about 1,800 tokens each). Deliberately strict: anything with a question
 * mark, "yes"/"no"/"sure" (often answers that need a follow-up) and greetings
 * ("hi", which usually opens a conversation) are never skipped.
 */
const ACKNOWLEDGEMENTS = new Set([
  'thanks', 'thank you', 'thanks a lot', 'thanks so much', 'thank you so much', 'thank you very much', 'many thanks', 'thx', 'thnx', 'ty', 'tysm', 'cheers',
  'ok', 'okay', 'okk', 'k', 'kk', 'alright', 'all right', 'got it', 'noted', 'understood', 'will do', 'sounds good',
  'great', 'perfect', 'cool', 'awesome', 'nice', 'lovely', 'amazing', 'excellent', 'brilliant', 'wonderful', 'appreciate it', 'much appreciated',
]);

// Emoji, symbols and joiners only (no letters or digits).
const EMOJI_ONLY = /^(?:[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Emoji_Component}\s\p{P}]|‍|️)+$/u;

export type NoReplyReason = 'emoji_only' | 'acknowledgement';

export function noReplyNeeded(text: string): NoReplyReason | null {
  const raw = text.trim();
  if (!raw || raw.length > 60 || raw.includes('?')) return null;
  if (EMOJI_ONLY.test(raw) && /\p{Extended_Pictographic}/u.test(raw)) return 'emoji_only';
  const normalized = raw
    .toLowerCase()
    .replace(/(?:[\p{Extended_Pictographic}\p{Emoji_Modifier}]|‍|️)/gu, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return null;
  if (ACKNOWLEDGEMENTS.has(normalized)) return 'acknowledgement';
  // Two acknowledgements together: "ok thanks", "great thank you".
  const words = normalized.split(' ');
  for (let i = 1; i < words.length; i++) {
    if (ACKNOWLEDGEMENTS.has(words.slice(0, i).join(' ')) && ACKNOWLEDGEMENTS.has(words.slice(i).join(' '))) return 'acknowledgement';
  }
  return null;
}
