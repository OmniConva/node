# Changelog

## 1.0.2 — 2026-10-16

Security hardening, from a review of the package.

- Requests are refused before their body is read when the signature header
  is missing, malformed or stale, and bodies over `maxBodyBytes` (default
  1 MB) get 413 — an unauthenticated flood can no longer fill memory. With
  Express this also closes the gap left by mounting before `express.json()`.
- `nodeHandler` only claims paths under the prefix (`/omniconva-x` is yours
  again, body intact).
- Only an `OrderRefusedError` thrown from `orders.create()` is relayed to
  OmniConva; any other error is answered with a generic 500 and passed to
  `onError`, so SQL text, paths and customer data stay in your logs.
- `OMNICONVA_WEBHOOK_URL` and `OMNICONVA_API_URL` must be https (http only
  for localhost); the widget script URL is attribute-escaped.
- Idempotency stores take `{ staleClaimMs }`; the Redis store no longer
  retries without bound against a misbehaving client.
- `npx omniconva-test --offline` no longer treats `--offline` as the URL.
- A malformed product id answers 404 instead of 500.
- Published build without source maps; CI actions pinned by commit.

## 1.0.1 — 2026-10-16

- README: how releases are published (staged on npm through trusted
  publishing, then approved with 2FA)
- First release published from GitHub Actions, with npm provenance

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
