import { getEnv } from '@socialpilot/config';
import { closeInfra, createRedis, getInfra, QUEUE_NAMES, WORKER_HEARTBEAT_KEY, type QueueName } from '@socialpilot/core';
import { Worker, type Processor } from 'bullmq';
import {
  aiReplyProcessor,
  analyticsProcessor,
  knowledgeProcessor,
  maintenanceProcessor,
  notificationProcessor,
  publishProcessor,
  webhookProcessor,
  outboundProcessor,
  agentProcessor,
} from './processors';

const env = getEnv();
const { logger, queues, redis } = getInfra();
const connection = createRedis(env.REDIS_URL, true);

const definitions: { name: QueueName; processor: Processor; concurrency: number }[] = [
  { name: QUEUE_NAMES.publish, processor: publishProcessor as Processor, concurrency: 5 },
  { name: QUEUE_NAMES.webhook, processor: webhookProcessor as Processor, concurrency: 10 },
  { name: QUEUE_NAMES.aiReply, processor: aiReplyProcessor as Processor, concurrency: 4 },
  { name: QUEUE_NAMES.knowledge, processor: knowledgeProcessor as Processor, concurrency: 2 },
  { name: QUEUE_NAMES.analytics, processor: analyticsProcessor as Processor, concurrency: 2 },
  { name: QUEUE_NAMES.notifications, processor: notificationProcessor as Processor, concurrency: 5 },
  { name: QUEUE_NAMES.maintenance, processor: maintenanceProcessor as Processor, concurrency: 1 },
  { name: QUEUE_NAMES.outbound, processor: outboundProcessor as Processor, concurrency: 5 },
  { name: QUEUE_NAMES.agent, processor: agentProcessor as Processor, concurrency: 2 },
];

const workers = definitions.map(({ name, processor, concurrency }) => {
  const worker = new Worker(name, processor, { connection, concurrency });
  worker.on('completed', (job) => logger.debug({ queue: name, jobId: job.id }, 'job completed'));
  worker.on('failed', (job, error) =>
    logger.warn({ queue: name, jobId: job?.id, attemptsMade: job?.attemptsMade, error: error.message }, 'job failed'),
  );
  worker.on('error', (error) => logger.error({ queue: name, error: error.message }, 'worker error'));
  return worker;
});

// Repeatable maintenance jobs (idempotent scheduling via fixed job ids).
await queues.get('maintenance').upsertJobScheduler('sweep-scheduled', { every: 5 * 60 * 1000 }, { name: 'maintenance', data: { task: 'sweep-scheduled' } });
await queues.get('maintenance').upsertJobScheduler('refresh-tokens', { every: 30 * 60 * 1000 }, { name: 'maintenance', data: { task: 'refresh-tokens' } });
await queues.get('maintenance').upsertJobScheduler('cleanup', { every: 24 * 3600 * 1000 }, { name: 'maintenance', data: { task: 'cleanup' } });
await queues.get('analytics').upsertJobScheduler('analytics-sweep', { every: 6 * 3600 * 1000 }, { name: 'analytics', data: { sweep: true } });

const beat = () => redis.set(WORKER_HEARTBEAT_KEY, String(Date.now()), 'EX', 120).catch(() => undefined);
await beat();
const heartbeat = setInterval(beat, 15_000);

logger.info({ queues: definitions.map((d) => d.name), mockSocial: getInfra().social.mockEnabled, aiProvider: env.AI_PROVIDER }, 'worker started');

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down worker');
  clearInterval(heartbeat);
  await Promise.all(workers.map((w) => w.close()));
  connection.disconnect();
  await closeInfra();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
