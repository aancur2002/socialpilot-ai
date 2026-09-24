import type { Redis } from 'ioredis';

/**
 * Per-platform/account/operation rate limiter (fixed windows in Redis).
 * Limits are conservative defaults below documented platform quotas; when a
 * platform returns 429 its Retry-After is recorded as a cool-down.
 */
export interface RateLimitPolicy {
  limit: number;
  windowSec: number;
}

export const PLATFORM_POLICIES: Record<string, Partial<Record<RateOperation, RateLimitPolicy>>> = {
  FACEBOOK: { publish: { limit: 25, windowSec: 3600 }, reply: { limit: 200, windowSec: 3600 }, read: { limit: 180, windowSec: 3600 } },
  // Instagram: 100 API-published posts per 24h; messaging ~200/h per account
  INSTAGRAM: { publish: { limit: 25, windowSec: 86400 }, reply: { limit: 180, windowSec: 3600 }, read: { limit: 180, windowSec: 3600 } },
  WHATSAPP: { reply: { limit: 60, windowSec: 60 } },
  LINKEDIN: { publish: { limit: 100, windowSec: 86400 }, reply: { limit: 100, windowSec: 86400 }, read: { limit: 500, windowSec: 86400 } },
  TIKTOK: { publish: { limit: 6, windowSec: 60 }, read: { limit: 600, windowSec: 60 } },
};

export type RateOperation = 'publish' | 'reply' | 'read';

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterMs: number;
}

export class RateLimitService {
  constructor(private readonly redis: Redis) {}

  private key(platform: string, accountId: string, op: RateOperation, suffix: string) {
    return `rl:${platform}:${accountId}:${op}:${suffix}`;
  }

  /** Consumes one unit if available. Never blocks; callers re-queue with the returned delay. */
  async consume(platform: string, accountId: string, op: RateOperation): Promise<RateLimitDecision> {
    const cooldownTtl = await this.redis.pttl(this.key(platform, accountId, op, 'cooldown'));
    if (cooldownTtl > 0) return { allowed: false, retryAfterMs: cooldownTtl };

    const policy = PLATFORM_POLICIES[platform]?.[op];
    if (!policy) return { allowed: true, retryAfterMs: 0 };
    const window = Math.floor(Date.now() / 1000 / policy.windowSec);
    const key = this.key(platform, accountId, op, String(window));
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, policy.windowSec + 5);
    if (count > policy.limit) {
      const windowEndMs = (window + 1) * policy.windowSec * 1000;
      return { allowed: false, retryAfterMs: Math.max(1000, windowEndMs - Date.now()) };
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  /** Records a platform-imposed cool-down (e.g. from a 429 Retry-After). */
  async cooldown(platform: string, accountId: string, op: RateOperation, ms: number): Promise<void> {
    await this.redis.set(this.key(platform, accountId, op, 'cooldown'), '1', 'PX', Math.max(1000, Math.min(ms, 24 * 3600 * 1000)));
  }
}
