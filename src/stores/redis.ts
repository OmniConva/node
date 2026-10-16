import {
  DONE_TTL_MS,
  STALE_CLAIM_MS,
  type IdempotencyClaim,
  type IdempotencyStore,
  type IdempotencyStoreOptions,
} from './types';

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
export function redisIdempotencyStore(
  redis: RedisLike,
  prefix = 'omniconva:idempotency:',
  options: IdempotencyStoreOptions = {},
): IdempotencyStore {
  const staleClaimMs = options.staleClaimMs ?? STALE_CLAIM_MS;
  // The pending key simply expires after staleClaimMs, which is what lets a
  // retry take over a crashed request's claim.
  async function claim(key: string, attempt = 0): Promise<IdempotencyClaim> {
    const redisKey = prefix + key;
    if (await redis.setIfAbsent(redisKey, JSON.stringify({ state: 'pending' }), staleClaimMs)) {
      return { state: 'claimed' };
    }
    const stored = await redis.get(redisKey);
    if (stored === null) {
      // The key expired between the two commands. Once is a race; twice is a
      // Redis that answers "not set" without keeping anything, so stop
      // rather than loop.
      return attempt === 0 ? claim(key, attempt + 1) : { state: 'busy' };
    }
    const entry = JSON.parse(stored) as { state: string; response?: Record<string, unknown> };
    return entry.state === 'done' ? { state: 'done', response: entry.response ?? {} } : { state: 'busy' };
  }
  return {
    claim: (key) => claim(key),
    async complete(key, response) {
      await redis.set(prefix + key, JSON.stringify({ state: 'done', response }), DONE_TTL_MS);
    },
    async release(key) {
      await redis.del(prefix + key);
    },
  };
}
