import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';

export const QUEUE_NAMES = {
  publish: 'publish',
  webhook: 'webhook',
  aiReply: 'ai-reply',
  knowledge: 'knowledge',
  analytics: 'analytics',
  notifications: 'notifications',
  maintenance: 'maintenance',
  contentGeneration: 'content-generation',
  outbound: 'outbound',
  agent: 'agent',
} as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export interface JobPayloads {
  publish: { scheduledPostId: string };
  webhook: { webhookEventId: string };
  'ai-reply': { messageId: string };
  knowledge: { sourceId: string };
  analytics: { socialAccountId: string; from: string; to: string } | { sweep: true };
  notifications: { notificationId: string };
  maintenance: { task: 'refresh-tokens' | 'sweep-scheduled' | 'cleanup' };
  'content-generation': { contentId: string };
  outbound: { webhookId: string; event: 'lead.created' | 'lead.updated' | 'lead.status_changed'; leadId: string };
  agent: { runId: string };
}

export function createRedis(url: string, forWorker = false): Redis {
  return new Redis(url, {
    // BullMQ workers require maxRetriesPerRequest=null (blocking commands).
    maxRetriesPerRequest: forWorker ? null : 3,
    enableReadyCheck: true,
    lazyConnect: false,
  });
}

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  removeOnComplete: { age: 7 * 24 * 3600, count: 5000 },
  removeOnFail: { age: 30 * 24 * 3600 },
};

/** Lazily-created BullMQ queues sharing one connection. */
export class Queues {
  private readonly queues = new Map<QueueName, Queue>();

  constructor(private readonly connection: Redis) {}

  get<N extends QueueName>(name: N): Queue<JobPayloads[N]> {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
      this.queues.set(name, q);
    }
    return q as Queue<JobPayloads[N]>;
  }

  async add<N extends QueueName>(name: N, payload: JobPayloads[N], opts: JobsOptions = {}): Promise<string | undefined> {
    // BullMQ's generic job-name typing is awkward across a union of payloads; the payload type is enforced above.
    const queue = this.get(name) as unknown as Queue;
    const job = await queue.add(name, payload, opts);
    return job.id;
  }

  all(): Queue[] {
    return Object.values(QUEUE_NAMES).map((n) => this.get(n) as unknown as Queue);
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}
