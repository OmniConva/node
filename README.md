# OmniConva for Node.js

Connect your Node.js store to [OmniConva](https://omniconva.com), the AI sales agent that answers your customers on your website, Messenger, Instagram and WhatsApp, and takes their orders.

This package does the integration work for you:

- **Products API.** OmniConva reads your catalog from routes the package serves.
- **Order API.** Orders customers confirm in chat reach your code once each, even when they're retried.
- **Webhooks.** Tell OmniConva when a product changes, or when an order ships.
- **Security.** Every request from OmniConva is signature-checked, and every webhook you send is signed.
- **Frameworks.** It works with Express, NestJS, Next.js, Hono, Bun and plain `node:http`, and has zero dependencies.

You write two functions: which products to share, and how to save an order.

**Requirements:** Node.js 18.17+ (or Bun / Deno). Both ESM and CommonJS work.

## Install

```bash
npm install @omniconva/node
```

Add your credentials to the environment:

```dotenv
OMNICONVA_WEBHOOK_URL=https://api.omniconva.com/webhooks/custom-website/...
OMNICONVA_WEBHOOK_TOKEN=...
OMNICONVA_SIGNING_SECRET=...
OMNICONVA_SITE_KEY=...          # optional, for the chat widget
```

To get them, in OmniConva open **Settings → Connection → Custom website**, choose **Node.js package**, and press **Create credentials**.

## Set up

```ts
// omniconva.ts
import { createOmniConva } from '@omniconva/node';
import { db } from './db';

export const omniconva = createOmniConva({
  // Which products OmniConva may sell, and how each one looks.
  products: {
    async list({ page, perPage, since }) {
      const where = { active: true, ...(since ? { updatedAt: { gt: since } } : {}) };
      const [rows, total] = await Promise.all([
        db.product.findMany({ where, include: { variants: true }, orderBy: { id: 'asc' }, skip: (page - 1) * perPage, take: perPage }),
        db.product.count({ where }),
      ]);
      return { products: rows.map(toOmniConva), total };
    },
    async get(id) {
      const row = await db.product.findFirst({ where: { id: Number(id), active: true }, include: { variants: true } });
      return row ? toOmniConva(row) : null;
    },
  },

  // Save an order a customer confirmed in chat (cash on delivery, unpaid).
  orders: {
    async create(order) {
      const saved = await db.order.create({
        data: {
          customerName: order.customer.name,
          phone: order.customer.phone,
          address: order.shippingAddress.address,
          city: order.shippingAddress.city,
          total: order.total,
          items: {
            create: order.items.map((item) => ({
              productId: Number(item.productId),
              variantId: item.variantId ? Number(item.variantId) : null,
              quantity: item.quantity,
              price: item.unitPrice,
            })),
          },
        },
      });
      return { orderId: saved.id, orderNumber: saved.number };
    },
  },
});

function toOmniConva(product: ProductWithVariants) {
  return {
    id: product.id,
    title: product.name,
    url: `https://yourshop.com/products/${product.slug}`,
    description: product.description,
    price: product.price,
    salePrice: product.salePrice,        // only counts when below the price
    stockQuantity: product.stock,        // or inStock: true if you don't count stock
    images: [product.imageUrl],
    categories: [product.category],
    variants: product.variants.map((variant) => ({
      id: variant.id,
      price: variant.price,
      stockQuantity: variant.stock,
      options: { Size: variant.size },
    })),
    updatedAt: product.updatedAt,
  };
}
```

**Keep these rules in mind:**
- Ids must never change. A variant's id only has to be unique within its product.
- Images must be absolute `https://` URLs.
- `status: 'draft'` keeps a product listed but stops the AI selling it.

**How orders behave:**
- **Once per order.** `create()` runs once per order. If OmniConva retries after a timeout, the package answers with the first result.
- **Refusing an order.** Throw an error to refuse an order. The message is shown to the store owner in OmniConva, and the order can be retried.
- **The id you return.** `orderId` is the reference the customer is told in chat, and the one `orderUpdated()` uses.
- **Test orders.** Test orders from the OmniConva dashboard (`order.test`) are answered without calling `create()`. Pass `passTestOrders: true` to receive them.

## Serve the routes

### Express / NestJS

```ts
import express from 'express';
import { omniconva } from './omniconva';

const app = express();
app.use(omniconva.express());   // before express.json(): the signature covers the raw body
app.use(express.json());
```

NestJS uses Express by default:

```ts
// main.ts
const app = await NestFactory.create(AppModule, { bodyParser: false });
app.use(omniconva.express());
app.use(express.json());
```

If a body parser has to run first, keep the raw body with `express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } })`.

### Next.js (App Router)

```ts
// app/omniconva/[...path]/route.ts
import { omniconva } from '@/lib/omniconva';

export const { GET, POST } = omniconva.nextjs();
```

### Hono, Bun, Deno, Cloudflare Workers

```ts
app.all('/omniconva/*', (c) => omniconva.fetch(c.req.raw));            // Hono
Bun.serve({ fetch: (request) => omniconva.fetch(request) });          // Bun
```

### Plain node:http

```ts
const handle = omniconva.node();
http.createServer(async (req, res) => {
  if (await handle(req, res)) return;   // answered an OmniConva route
  // …your routes
}).listen(3000);
```

## Keep the catalog in sync

Call these after your own writes:

```ts
await omniconva.productUpdated(toOmniConva(product));   // created or changed
await omniconva.productDeleted(product.id);             // deleted, or no longer for sale
```

Webhooks are signed. Network errors, 5xx and 429 are retried with backoff (1s, 4s, 15s) before the promise rejects. If you need them to survive a restart, call these from your job queue (BullMQ etc.).

With Prisma, an extension keeps it automatic:

```ts
const prisma = new PrismaClient().$extends({
  query: {
    product: {
      async $allOperations({ operation, args, query }) {
        const result = await query(args);
        if (['create', 'update', 'upsert'].includes(operation)) {
          const product = await prisma.product.findUnique({ where: { id: (result as any).id }, include: { variants: true } });
          if (product) void omniconva.productUpdated(toOmniConva(product)).catch(console.error);
        }
        if (operation === 'delete') void omniconva.productDeleted((result as any).id).catch(console.error);
        return result;
      },
    },
  },
});
```

## Order status (optional)

```ts
await omniconva.orderUpdated(order.id, 'shipped', { number: 'TRK123', carrier: 'Pathao', url: trackingUrl });
```

Statuses are your own words: `confirmed`, `processing`, `shipped`, `delivered`, `cancelled` and so on. OmniConva shows them on its Orders page, and the AI uses them to answer "where is my order?".

## Chat widget

In server-rendered pages:

```ts
const widget = omniconva.chatWidgetHtml({ customer: user && { id: user.id, name: user.name, phone: user.phone } });
// put `widget` before </body>
```

This is empty until `OMNICONVA_SITE_KEY` is set. With `OMNICONVA_IDENTITY_SECRET` set, the signed-in customer is sent along with an HMAC, so the AI and your agents know who they're talking to.

## More than one server process?

Order idempotency is kept in memory by default, which is fine for one process. With several (cluster, PM2, serverless, multiple servers), share it through Redis:

```ts
import Redis from 'ioredis';
import { createOmniConva, redisIdempotencyStore } from '@omniconva/node';

const redis = new Redis(process.env.REDIS_URL!);
export const omniconva = createOmniConva({
  // …products, orders
  idempotency: redisIdempotencyStore({
    setIfAbsent: async (key, value, ms) => (await redis.set(key, value, 'PX', ms, 'NX')) === 'OK',
    set: async (key, value, ms) => void (await redis.set(key, value, 'PX', ms)),
    get: (key) => redis.get(key),
    del: async (key) => void (await redis.del(key)),
  }),
});
```

You can also implement the `IdempotencyStore` interface (`claim`, `complete`, `release`) over your database.

## Check it

```bash
npx omniconva-test --url http://localhost:3000/omniconva
```

This makes signed requests to your health and products routes, then pings OmniConva with your token and secret. It reads `OMNICONVA_*` from the environment or `.env`. Then, in OmniConva, press **Check package**, then **Test products**, then **Connect website**.

## Routes

The package serves these routes, all of which require a valid `X-OmniConva-Signature`:

| Method | Path | |
|---|---|---|
| GET | `/omniconva/products?page=&per_page=&updated_since=` | Your catalog, page by page |
| GET | `/omniconva/products/{id}` | One product (404 when gone) |
| POST | `/omniconva/orders` | Create an order |
| GET | `/omniconva/health` | Package and Node version, for OmniConva's **Check package** |

To move them, pass `prefix` (or set `OMNICONVA_ROUTE_PREFIX`) and change the **Route prefix** in OmniConva to match.

## Options

| Option | Default |
|---|---|
| `webhookUrl`, `webhookToken`, `signingSecret` | `OMNICONVA_WEBHOOK_URL`, `OMNICONVA_WEBHOOK_TOKEN`, `OMNICONVA_SIGNING_SECRET` |
| `products`, `orders` | — |
| `currency` | `OMNICONVA_CURRENCY`, else `"BDT"` |
| `prefix` | `"/omniconva"` |
| `idempotency` | in memory |
| `passTestOrders` | `false` |
| `signatureTolerance` | `300` seconds |
| `webhookTimeoutMs` / `webhookRetryDelaysMs` | `10000` / `[1000, 4000, 15000]` |
| `widget` | `{ siteKey: OMNICONVA_SITE_KEY, apiUrl: OMNICONVA_API_URL, identitySecret: OMNICONVA_IDENTITY_SECRET }` |
| `onError` | — (called with errors from your handlers) |

## How it's secured

- **Requests from OmniConva** carry `X-OmniConva-Signature: t=<unix>,v1=<hex>`, an HMAC-SHA256 of `"<t>.<METHOD>.<path?query>.<body>"` made with your signing secret. Requests with a missing or wrong signature, or one older than 5 minutes, get `401`.
- **Webhooks you send** carry `Authorization: Bearer <token>` and an HMAC of `"<t>.<body>"`.
- **Keep the token and secret out of version control.** If one leaks, rotate it in OmniConva and update your environment.

## License

MIT. See [LICENSE](LICENSE).
