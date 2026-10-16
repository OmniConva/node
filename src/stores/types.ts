export type IdempotencyClaim =
  | { state: 'claimed' }
  | { state: 'busy' }
  | { state: 'done'; response: Record<string, unknown> };

/**
 * Remembers each order by its Idempotency-Key so a retry gets the first
 * answer instead of creating the order again. The default memory store is
 * fine for one process; with several (cluster, serverless, multiple
 * servers) use a shared one such as redisIdempotencyStore().
 */
export interface IdempotencyStore {
  /** Marks the key in progress, unless it is already in progress or done. */
  claim(key: string): Promise<IdempotencyClaim>;
  /** The order was created: remember its response. */
  complete(key: string, response: Record<string, unknown>): Promise<void>;
  /** The order wasn't created: forget the key so a retry can try again. */
  release(key: string): Promise<void>;
}

export interface IdempotencyStoreOptions {
  /**
   * How long a claim may stay pending before a retry takes it over, in ms.
   * Default 5 minutes. A crashed request leaves its claim behind, and this
   * is what lets OmniConva's retry get through; but if your `create()` can
   * legitimately run longer than this (a slow ERP, a payment hold), raise
   * it — otherwise the retry creates the order a second time.
   */
  staleClaimMs?: number;
}

// A claim left pending this long (a crashed request) can be taken over.
export const STALE_CLAIM_MS = 5 * 60 * 1000;
// How long a finished order's answer is kept for retries.
export const DONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
