import { OmniConva, type OmniConvaOptions } from './client';
import { fetchHandler } from './adapters/fetch';
import { expressMiddleware, nodeHandler } from './adapters/node';

/**
 * The OmniConva client with its framework handlers attached:
 *
 *   const omniconva = createOmniConva({ products, orders });
 *   app.use(omniconva.express());                       // Express / NestJS
 *   export const { GET, POST } = omniconva.nextjs();    // Next.js route handler
 *   app.all('/omniconva/*', (c) => omniconva.fetch(c.req.raw)); // Hono, Bun…
 */
export class OmniConvaClient extends OmniConva {
  /** Fetch API handler (Request → Response). */
  readonly fetch = fetchHandler(this);

  /** Express / NestJS middleware; mount before body parsers. */
  express() {
    return expressMiddleware(this);
  }

  /** `node:http` handler; resolves false for paths outside the prefix. */
  node() {
    return nodeHandler(this);
  }

  /** For app/omniconva/[...path]/route.ts in Next.js. */
  nextjs() {
    return { GET: this.fetch, POST: this.fetch };
  }
}

/** Creates the OmniConva client. Options default to the OMNICONVA_* environment variables. */
export function createOmniConva(options: OmniConvaOptions = {}): OmniConvaClient {
  return new OmniConvaClient(options);
}

export { OmniConva, OmniConvaError, OrderRefusedError, BodyTooLargeError, DEFAULT_MAX_BODY_BYTES } from './client';
export type { IncomingCall, OmniConvaOptions, OutgoingResponse } from './client';
export { fetchHandler } from './adapters/fetch';
export { expressMiddleware, nodeHandler } from './adapters/node';
export { parseOrder, toStandardProduct, OrderPayloadError } from './format';
export { signRequest, signWebhook, verifyRequest, SIGNATURE_HEADER } from './signature';
export { memoryIdempotencyStore } from './stores/memory';
export { redisIdempotencyStore, type RedisLike } from './stores/redis';
export type { IdempotencyClaim, IdempotencyStore, IdempotencyStoreOptions } from './stores/types';
export type {
  Order,
  OrderHandler,
  OrderItem,
  OrderResult,
  ProductInput,
  ProductListQuery,
  ProductListResult,
  ProductSource,
  Tracking,
  VariantInput,
} from './types';
export { VERSION } from './version';
