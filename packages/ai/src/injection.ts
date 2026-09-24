/**
 * Prompt-injection defenses.
 *
 * 1. Separation: untrusted text (customer messages, documents, comments) is only
 *    ever placed inside <untrusted_*> blocks in the USER turn, never in the system
 *    prompt, and tag look-alikes inside it are neutralized so it cannot close the block.
 * 2. Detection: heuristic signals lower routing confidence (a suspected injection is
 *    never auto-sent — see decideReplyRoute).
 * 3. Output guard: replies are scanned for secrets, prompt leakage and off-brand links
 *    before they can be sent.
 */

const TAG_LOOKALIKE = /<\s*\/?\s*(untrusted[\w-]*|trusted[\w-]*|system[\w-]*|instructions?|client_configuration|knowledge[\w-]*)\b[^>]*>/gi;

export function sanitizeUntrusted(text: string, maxLength = 8000): string {
  const cleaned = text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, '')
    .replace(TAG_LOOKALIKE, '[tag removed]');
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}\n[truncated]` : cleaned;
}

export function untrustedBlock(label: string, text: string, maxLength?: number): string {
  const tag = `untrusted_${label.replace(/[^a-z_]/gi, '')}`;
  return `<${tag}>\n${sanitizeUntrusted(text, maxLength)}\n</${tag}>`;
}

const INJECTION_PATTERNS: { signal: string; re: RegExp }[] = [
  { signal: 'override_instructions', re: /\b(ignore|disregard|forget|override)\b.{0,40}\b(previous|prior|above|earlier|all|your|system)\b.{0,30}\b(instructions?|prompts?|rules?|directions?)\b/i },
  { signal: 'role_reassignment', re: /\b(you are now|from now on you|act as|pretend (to be|you are)|roleplay as)\b/i },
  { signal: 'prompt_extraction', re: /\b(system prompt|your (instructions|prompt|rules)|initial prompt|hidden prompt|developer message)\b/i },
  { signal: 'secret_request', re: /\b(api[\s_-]?key|access[\s_-]?token|secret[\s_-]?key|password|credentials?|private key|env(ironment)? variables?)\b/i },
  { signal: 'jailbreak', re: /\b(jailbreak|developer mode|DAN mode|do anything now|no restrictions)\b/i },
  { signal: 'tenant_escape', re: /\b(other (client|customer|tenant|compan(y|ies))'?s?|another (client|account)|all (clients|customers|users))\b.{0,40}\b(data|messages|info|details)\b/i },
  { signal: 'code_execution', re: /\b(execute|run|eval)\b.{0,20}\b(code|script|command|shell|sql)\b/i },
  { signal: 'settings_change', re: /\b(change|disable|turn off|update)\b.{0,30}\b(settings?|configuration|permissions?|auto[- ]?reply|rules?)\b/i },
  { signal: 'fake_system_tag', re: /\[(system|admin|developer)\]|<\s*(system|admin)\s*>/i },
];

export interface InjectionAssessment {
  suspected: boolean;
  signals: string[];
}

export function detectPromptInjection(text: string): InjectionAssessment {
  const signals = INJECTION_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.signal);
  return { suspected: signals.length > 0, signals };
}

export interface ReplySafetyIssue {
  code: 'SECRET_LEAK' | 'PROMPT_LEAK' | 'UNTRUSTED_LINK' | 'FORBIDDEN_TOPIC' | 'EMPTY';
  detail: string;
}

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/, // vendor API keys
  /\bsk-ant-[A-Za-z0-9_-]{10,}/,
  /\b(EAA[A-Za-z0-9]{20,})/, // Meta access tokens
  /\bmock_(access|refresh)_[0-9a-f-]{8,}/,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/i,
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key ids
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bv\d+:[A-Za-z0-9+/=]{16}:[A-Za-z0-9+/=]{24}:/, // our own ciphertext format
];

const PROMPT_LEAK = /\b(untrusted_[a-z_]+|system prompt|my instructions (are|say)|as an ai (language )?model,? my instructions|REPLY_AGENT_V\d|CONTENT_AGENT_V\d|INTENT_AGENT_V\d)\b/i;

export function checkReplySafety(reply: string, opts: { allowedDomains?: string[]; forbiddenTopics?: string[] } = {}): ReplySafetyIssue[] {
  const issues: ReplySafetyIssue[] = [];
  if (!reply.trim()) issues.push({ code: 'EMPTY', detail: 'Reply is empty' });
  for (const re of SECRET_PATTERNS) {
    if (re.test(reply)) issues.push({ code: 'SECRET_LEAK', detail: 'Reply contains a credential-like string' });
  }
  if (PROMPT_LEAK.test(reply)) issues.push({ code: 'PROMPT_LEAK', detail: 'Reply references internal instructions' });
  const allowed = (opts.allowedDomains ?? []).map((d) => d.toLowerCase().replace(/^www\./, ''));
  for (const match of reply.matchAll(/https?:\/\/([^\s/?#)]+)/gi)) {
    const host = match[1]!.toLowerCase().replace(/^www\./, '');
    if (!allowed.some((d) => host === d || host.endsWith(`.${d}`))) {
      issues.push({ code: 'UNTRUSTED_LINK', detail: `Reply links to ${host}, which is not the brand's website` });
    }
  }
  for (const topic of opts.forbiddenTopics ?? []) {
    if (topic.trim() && reply.toLowerCase().includes(topic.toLowerCase())) {
      issues.push({ code: 'FORBIDDEN_TOPIC', detail: `Reply mentions forbidden topic "${topic}"` });
    }
  }
  return issues;
}

export function domainOf(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}
