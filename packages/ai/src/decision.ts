import type { IntentKey } from '@socialpilot/validation';

/**
 * Reply routing — the confidence system.
 *
 *   confidence ≥ autoReplyThreshold (default 0.90) → eligible for automatic reply
 *   approvalThreshold ≤ confidence < autoReplyThreshold (0.70–0.89) → approval required
 *   confidence < approvalThreshold → human escalation
 *
 * "Confidence" is the model's self-reported certainty (min of intent and reply
 * confidence). It is a routing heuristic, not a measured accuracy guarantee, so
 * hard safety rules are applied before any threshold.
 */

export type ReplyRoute = 'AUTO_SEND' | 'APPROVAL' | 'ESCALATE' | 'SKIP';

export interface ReplyRoutingSettings {
  aiEnabled: boolean;
  autoReplyEnabled: boolean;
  autoReplyThreshold: number;
  approvalThreshold: number;
  allowedAutoIntents: IntentKey[];
  escalationIntents: IntentKey[];
}

export interface AutomationOverrides {
  /** automation action "escalate" */
  escalate?: boolean;
  /** automation action "require_approval" */
  requireApproval?: boolean;
  /** automation action "disable_auto_reply" */
  disableAutoReply?: boolean;
  /** automation action "auto_send" — allows auto-send for intents outside allowedAutoIntents (never bypasses safety) */
  autoSend?: boolean;
}

export interface ReplyRoutingInput {
  intent: IntentKey;
  intentConfidence: number;
  replyConfidence: number;
  replyRequiresHuman: boolean;
  isSpam: boolean;
  requestsHuman: boolean;
  containsThreat: boolean;
  containsSensitivePersonalInfo: boolean;
  suspectedInjection: boolean;
  unsafeOutput: boolean;
  conversationMode: 'AI' | 'HUMAN';
  /** Can this account send a reply at all (capability + account status)? */
  canReply: boolean;
  settings: ReplyRoutingSettings;
  automation?: AutomationOverrides;
}

export interface ReplyRoutingResult {
  route: ReplyRoute;
  confidence: number;
  reasons: string[];
  /** Escalation category when route = ESCALATE */
  escalationReason?: string;
}

export function decideReplyRoute(input: ReplyRoutingInput): ReplyRoutingResult {
  const s = input.settings;
  const confidence = Math.min(input.intentConfidence, input.replyConfidence);
  const reasons: string[] = [];
  const escalate = (why: string, detail?: string): ReplyRoutingResult => ({
    route: 'ESCALATE',
    confidence,
    reasons: [...reasons, detail ?? why],
    escalationReason: why,
  });

  if (input.isSpam || input.intent === 'SPAM') return { route: 'SKIP', confidence, reasons: ['Classified as spam — no reply or lead automation'] };
  if (!s.aiEnabled) return { route: 'SKIP', confidence, reasons: ['AI is disabled for this client'] };

  // Hard safety rules — independent of confidence.
  if (input.containsThreat) return escalate('THREATS', 'Message contains a threat');
  if (input.intent === 'ABUSE' && s.escalationIntents.includes('ABUSE')) return escalate('ABUSE', 'Abusive message');
  if (s.escalationIntents.includes(input.intent)) return escalate(input.intent, `Intent ${input.intent} is configured to escalate`);
  if (input.requestsHuman && s.escalationIntents.includes('HUMAN_REQUEST')) return escalate('HUMAN_REQUEST', 'Customer asked for a human');
  if (input.containsSensitivePersonalInfo) return escalate('SENSITIVE_PERSONAL_INFORMATION', 'Message contains sensitive personal information');
  if (input.unsafeOutput) return escalate('UNSAFE_OUTPUT', 'Draft reply failed the output safety check');
  if (input.automation?.escalate) return escalate('AUTOMATION_RULE', 'An automation rule requested escalation');
  if (confidence < s.approvalThreshold) return escalate('LOW_CONFIDENCE', `Confidence ${confidence.toFixed(2)} is below ${s.approvalThreshold}`);
  if (input.replyRequiresHuman) return escalate('MISSING_INFORMATION', 'The AI lacks the information to answer');

  // From here a draft exists; decide whether it may be sent automatically.
  if (!input.canReply) reasons.push('This account cannot send replies through the platform API');
  if (input.conversationMode === 'HUMAN') reasons.push('Conversation is in human mode');
  if (input.suspectedInjection) reasons.push('Possible prompt-injection attempt — human review required');
  if (confidence < s.autoReplyThreshold) reasons.push(`Confidence ${confidence.toFixed(2)} is below the auto-reply threshold ${s.autoReplyThreshold}`);
  if (!s.autoReplyEnabled) reasons.push('Automatic replies are disabled for this client');
  if (input.automation?.requireApproval) reasons.push('An automation rule requires approval');
  if (input.automation?.disableAutoReply) reasons.push('An automation rule disabled automatic replies');
  if (!s.allowedAutoIntents.includes(input.intent) && !input.automation?.autoSend) {
    reasons.push(`Intent ${input.intent} is not enabled for automatic replies`);
  }

  if (reasons.length) return { route: 'APPROVAL', confidence, reasons };
  return { route: 'AUTO_SEND', confidence, reasons: ['Eligible for automatic reply'] };
}
