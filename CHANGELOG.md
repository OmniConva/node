# Changelog

## 1.0.0 — 2026-10-16

First release.

- Products API (`GET {prefix}/products`, `GET {prefix}/products/{id}`) and
  Order API (`POST {prefix}/orders`) served from your `products` and `orders`
  functions, in OmniConva's standard format
- `X-OmniConva-Signature` verification on every route
- Order idempotency (in memory, or shared via `redisIdempotencyStore`), test
  orders answered without your handler, refusals reported back to OmniConva
- Handlers for Express/NestJS, Next.js App Router, Fetch API (Hono, Bun, Deno,
  Workers) and `node:http`
- `productUpdated`, `productDeleted`, `orderUpdated` and `ping` webhooks,
  signed and retried
- Chat widget snippet with signed customer identity
- `npx omniconva-test` setup checker
- Node.js 18.17+, ESM and CommonJS, no dependencies
