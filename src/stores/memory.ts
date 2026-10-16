import { DONE_TTL_MS, STALE_CLAIM_MS, type IdempotencyClaim, type IdempotencyStore } from './types';

interface Entry {
  state: 'pending' | 'done';
  response?: Record<string, unknown>;
  at: number;
}

/** In-process store: fine for a single server process. */
export function memoryIdempotencyStore(): IdempotencyStore {
  const entries = new Map<string, Entry>();
  const prune = () => {
    const cutoff = Date.now() - DONE_TTL_MS;
    for (const [key, entry] of entries) if (entry.at < cutoff) entries.delete(key);
  };
  return {
    async claim(key): Promise<IdempotencyClaim> {
      prune();
      const entry = entries.get(key);
      if (entry?.state === 'done') return { state: 'done', response: entry.response ?? {} };
      if (entry && Date.now() - entry.at < STALE_CLAIM_MS) return { state: 'busy' };
      entries.set(key, { state: 'pending', at: Date.now() });
      return { state: 'claimed' };
    },
    async complete(key, response) {
      entries.set(key, { state: 'done', response, at: Date.now() });
    },
    async release(key) {
      if (entries.get(key)?.state === 'pending') entries.delete(key);
    },
  };
}
