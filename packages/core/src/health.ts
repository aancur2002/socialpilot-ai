import { getInfra } from './infra';

export const WORKER_HEARTBEAT_KEY = 'socialpilot:worker:heartbeat';

export interface HealthReport {
  status: 'ok' | 'degraded' | 'down';
  checks: Record<string, { ok: boolean; latencyMs?: number; detail?: string }>;
}

async function timed(fn: () => Promise<unknown>): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
  const started = Date.now();
  try {
    await Promise.race([fn(), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))]);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Readiness: database, redis, storage and a live worker heartbeat. */
export async function readinessReport(): Promise<HealthReport> {
  const { db, redis, storage } = getInfra();
  const [database, cache, objectStorage, worker] = await Promise.all([
    timed(() => db.$queryRaw`SELECT 1`),
    timed(() => redis.ping()),
    timed(async () => {
      if (!(await storage.healthCheck())) throw new Error('storage unavailable');
    }),
    timed(async () => {
      const beat = await redis.get(WORKER_HEARTBEAT_KEY);
      if (!beat || Date.now() - Number(beat) > 60_000) throw new Error('no worker heartbeat in the last 60s');
    }),
  ]);
  const checks = { database, redis: cache, storage: objectStorage, worker };
  const critical = database.ok && cache.ok;
  return { status: critical ? (objectStorage.ok && worker.ok ? 'ok' : 'degraded') : 'down', checks };
}
