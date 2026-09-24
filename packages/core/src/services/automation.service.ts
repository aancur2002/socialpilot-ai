import type { AutomationTrigger, Platform, Prisma } from '@socialpilot/database';
import {
  automationActionsSchema,
  automationConditionsSchema,
  type AutomationAction,
  type AutomationCondition,
  type CreateAutomationRuleInput,
} from '@socialpilot/validation';
import { requirePermission, type AuthContext, type ServiceContext } from '../context';
import { badRequest, notFound } from '../errors';
import { getInfra } from '../infra';
import { audit } from './audit.service';
import { getClient } from './client.service';

export interface AutomationFacts {
  intent?: string;
  confidence?: number;
  platform?: string;
  isSpam?: boolean;
  text?: string;
  priority?: string;
  withinBusinessHours?: boolean;
  conversationType?: string;
  leadDetected?: boolean;
}

// ── Pure evaluation (unit-tested) ────────────────────────────────────────

export function evaluateCondition(condition: AutomationCondition, facts: AutomationFacts): boolean {
  const actual = facts[condition.field as keyof AutomationFacts];
  switch (condition.op) {
    case 'eq':
      return actual === condition.value;
    case 'neq':
      return actual !== condition.value;
    case 'in':
      return typeof actual === 'string' && condition.value.includes(actual);
    case 'not_in':
      return typeof actual !== 'string' || !condition.value.includes(actual);
    case 'gte':
      return typeof actual === 'number' && actual >= condition.value;
    case 'lte':
      return typeof actual === 'number' && actual <= condition.value;
    case 'gt':
      return typeof actual === 'number' && actual > condition.value;
    case 'lt':
      return typeof actual === 'number' && actual < condition.value;
    case 'contains':
      return typeof actual === 'string' && actual.toLowerCase().includes(condition.value.toLowerCase());
  }
}

export interface RuleLike {
  id: string;
  priority: number;
  platforms: string[];
  conditions: unknown;
  actions: unknown;
  stopProcessing: boolean;
}

export interface RuleEvaluation {
  ruleId: string;
  matched: boolean;
  actions: AutomationAction[];
}

/** Evaluates rules in priority order (lowest first); all conditions must match (AND). */
export function evaluateRules(rules: RuleLike[], facts: AutomationFacts): { evaluations: RuleEvaluation[]; actions: AutomationAction[] } {
  const evaluations: RuleEvaluation[] = [];
  const actions: AutomationAction[] = [];
  for (const rule of [...rules].sort((a, b) => a.priority - b.priority)) {
    if (rule.platforms.length && (!facts.platform || !rule.platforms.includes(facts.platform))) continue;
    const conditions = automationConditionsSchema.safeParse(rule.conditions);
    const ruleActions = automationActionsSchema.safeParse(rule.actions);
    if (!conditions.success || !ruleActions.success) continue; // invalid stored rule never fires
    const matched = conditions.data.every((c) => evaluateCondition(c, facts));
    evaluations.push({ ruleId: rule.id, matched, actions: matched ? ruleActions.data : [] });
    if (matched) {
      actions.push(...ruleActions.data);
      if (rule.stopProcessing) break;
    }
  }
  return { evaluations, actions };
}

// ── Runtime ─────────────────────────────────────────────────────────────

export async function runAutomationForEvent(event: {
  trigger: AutomationTrigger;
  organizationId: string;
  clientId: string;
  resourceType: string;
  resourceId: string;
  facts: AutomationFacts;
}): Promise<AutomationAction[]> {
  const { db } = getInfra();
  const rules = await db.automationRule.findMany({
    where: { organizationId: event.organizationId, trigger: event.trigger, enabled: true, OR: [{ clientId: event.clientId }, { clientId: null }] },
  });
  if (!rules.length) return [];
  const { evaluations, actions } = evaluateRules(rules, event.facts);
  const matched = evaluations.filter((e) => e.matched);
  if (matched.length) {
    await db.automationExecution.createMany({
      data: matched.map((e) => ({
        organizationId: event.organizationId,
        clientId: event.clientId,
        ruleId: e.ruleId,
        trigger: event.trigger,
        resourceType: event.resourceType,
        resourceId: event.resourceId,
        matched: true,
        actions: e.actions as unknown as Prisma.InputJsonValue,
      })),
    });
  }
  return actions;
}

// ── CRUD ────────────────────────────────────────────────────────────────

export async function listAutomationRules(ctx: ServiceContext, clientId?: string) {
  requirePermission(ctx, 'automation:view');
  if (clientId) await getClient(ctx, clientId);
  const scoped = ctx.kind === 'user' && ctx.clientIds !== null;
  return getInfra().db.automationRule.findMany({
    where: {
      organizationId: ctx.organizationId,
      ...(clientId ? { OR: [{ clientId }, { clientId: null }] } : scoped ? { OR: [{ clientId: { in: [...(ctx as AuthContext).clientIds!] } }, { clientId: null }] } : {}),
    },
    include: { _count: { select: { executions: true } } },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
  });
}

async function assertRuleScope(ctx: AuthContext, clientId: string | null | undefined) {
  if (clientId) await getClient(ctx, clientId);
  // Organization-wide rules affect every client; only members who see all clients may manage them.
  else if (ctx.clientIds !== null) throw badRequest('Organization-wide rules require access to all clients');
}

export async function createAutomationRule(ctx: AuthContext, input: CreateAutomationRuleInput) {
  requirePermission(ctx, 'automation:manage');
  await assertRuleScope(ctx, input.clientId);
  const rule = await getInfra().db.automationRule.create({
    data: {
      organizationId: ctx.organizationId,
      clientId: input.clientId ?? null,
      name: input.name,
      description: input.description ?? null,
      enabled: input.enabled,
      priority: input.priority,
      trigger: input.trigger,
      platforms: input.platforms as Platform[],
      conditions: input.conditions as unknown as Prisma.InputJsonValue,
      actions: input.actions as unknown as Prisma.InputJsonValue,
      stopProcessing: input.stopProcessing,
      createdById: ctx.userId,
    },
  });
  await audit(ctx, { action: 'automation.rule_created', resourceType: 'AutomationRule', resourceId: rule.id, clientId: rule.clientId, after: input });
  return rule;
}

export async function updateAutomationRule(ctx: AuthContext, id: string, input: Partial<CreateAutomationRuleInput>) {
  requirePermission(ctx, 'automation:manage');
  const { db } = getInfra();
  const before = await db.automationRule.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!before) throw notFound('Automation rule');
  await assertRuleScope(ctx, before.clientId);
  if (input.clientId !== undefined) await assertRuleScope(ctx, input.clientId);
  const rule = await db.automationRule.update({
    where: { id },
    data: {
      ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
      name: input.name,
      description: input.description,
      enabled: input.enabled,
      priority: input.priority,
      trigger: input.trigger,
      platforms: input.platforms as Platform[] | undefined,
      conditions: input.conditions as unknown as Prisma.InputJsonValue | undefined,
      actions: input.actions as unknown as Prisma.InputJsonValue | undefined,
      stopProcessing: input.stopProcessing,
    },
  });
  await audit(ctx, { action: 'automation.rule_updated', resourceType: 'AutomationRule', resourceId: id, clientId: rule.clientId, before, after: rule });
  return rule;
}

export async function deleteAutomationRule(ctx: AuthContext, id: string) {
  requirePermission(ctx, 'automation:manage');
  const { db } = getInfra();
  const rule = await db.automationRule.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!rule) throw notFound('Automation rule');
  await assertRuleScope(ctx, rule.clientId);
  await db.automationRule.delete({ where: { id } });
  await audit(ctx, { action: 'automation.rule_deleted', resourceType: 'AutomationRule', resourceId: id, clientId: rule.clientId, before: rule });
}

export async function listAutomationExecutions(ctx: ServiceContext, ruleId: string) {
  requirePermission(ctx, 'automation:view');
  const rule = await getInfra().db.automationRule.findFirst({ where: { id: ruleId, organizationId: ctx.organizationId } });
  if (!rule) throw notFound('Automation rule');
  if (rule.clientId) await getClient(ctx, rule.clientId);
  return getInfra().db.automationExecution.findMany({ where: { ruleId }, orderBy: { createdAt: 'desc' }, take: 100 });
}
