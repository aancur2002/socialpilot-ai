import type { GenerationLogger } from '@socialpilot/ai';
import type { Prisma } from '@socialpilot/database';
import { requirePermission, tenantWhere, type ServiceContext } from '../context';
import { getInfra } from '../infra';

/**
 * Persists AI generation metadata for traceability (provider, model, prompt
 * version, latency, tokens, status). The prompt itself and raw customer input
 * are not stored; only the validated structured output is.
 */
export function generationLogger(scope: { organizationId: string; clientId?: string | null; userId?: string | null }): GenerationLogger {
  return async (log) => {
    try {
      const row = await getInfra().db.aiGeneration.create({
        data: {
          organizationId: scope.organizationId,
          clientId: scope.clientId ?? null,
          userId: scope.userId ?? null,
          provider: log.provider,
          model: log.model,
          agent: log.agent,
          promptVersion: log.promptVersion,
          inputType: log.inputType,
          output: log.output === null || log.output === undefined ? undefined : (log.output as Prisma.InputJsonValue),
          latencyMs: log.latencyMs,
          inputTokens: log.inputTokens,
          outputTokens: log.outputTokens,
          status: log.status,
          error: log.error,
        },
      });
      return row.id;
    } catch (error) {
      getInfra().logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'failed to persist AI generation log');
      return undefined;
    }
  };
}

export async function aiUsageSummary(ctx: ServiceContext, query: { clientId?: string; from: Date; to: Date }) {
  requirePermission(ctx, 'analytics:view');
  const where = { ...tenantWhere(ctx, query.clientId), createdAt: { gte: query.from, lte: query.to } };
  const rows = await getInfra().db.aiGeneration.groupBy({
    by: ['agent', 'status'],
    where,
    _count: { _all: true },
    _sum: { inputTokens: true, outputTokens: true },
    _avg: { latencyMs: true },
  });
  return rows.map((r) => ({ agent: r.agent, status: r.status, count: r._count._all, inputTokens: r._sum.inputTokens ?? 0, outputTokens: r._sum.outputTokens ?? 0, avgLatencyMs: Math.round(r._avg.latencyMs ?? 0) }));
}
