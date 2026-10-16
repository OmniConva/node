import { DONE_TTL_MS, STALE_CLAIM_MS, type IdempotencyClaim, type IdempotencyStore } from './types';

/**
 * The few Redis commands the store needs, in the shape both ioredis and
 * node-redis v4+ can satisfy with a one-line wrapper (see the README).
 */
export interface RedisLike {
  /** SET key value PX ttlMs NX; resolves true when the key was set. */
  setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<void>;
}

/** Shared store for several processes or servers. */
export function redisIdempotencyStore(redis: RedisLike, prefix = 'omniconva:idempotency:'): IdempotencyStore {
  return {
    async claim(key): Promise<IdempotencyClaim> {
      const redisKey = prefix + key;
      if (await redis.setIfAbsent(redisKey, JSON.stringify({ state: 'pending' }), STALE_CLAIM_MS)) {
        return { state: 'claimed' };
      }
      const stored = await redis.get(redisKey);
      if (stored === null) return this.claim(key);
      const entry = JSON.parse(stored) as { state: string; response?: Record<string, unknown> };
      return entry.state === 'done' ? { state: 'done', response: entry.response ?? {} } : { state: 'busy' };
    },
    async complete(key, response) {
      await redis.set(prefix + key, JSON.stringify({ state: 'done', response }), DONE_TTL_MS);
    },
    async release(key) {
      await redis.del(prefix + key);
    },
  };
}
