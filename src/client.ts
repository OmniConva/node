import { createHmac } from 'node:crypto';
import { OrderPayloadError, parseOrder, toStandardProduct } from './format';
import { SIGNATURE_HEADER, signWebhook, verifyRequest } from './signature';
import { memoryIdempotencyStore } from './stores/memory';
import type { IdempotencyStore } from './stores/types';
import type {
  OrderHandler,
  ProductInput,
  ProductSource,
  Tracking,
} from './types';
import { VERSION } from './version';

export interface OmniConvaOptions {
  /** OMNICONVA_WEBHOOK_URL by default. */
  webhookUrl?: string;
  /** OMNICONVA_WEBHOOK_TOKEN by default. */
  webhookToken?: string;
  /** OMNICONVA_SIGNING_SECRET by default. */
  signingSecret?: string;
  /** Your catalog, for the Products API. */
  products?: ProductSource;
  /** Creates orders, for the Order API. */
  orders?: OrderHandler;
  /** For products that don't name one. OMNICONVA_CURRENCY, else "BDT". */
  currency?: string | null;
  /** Where the routes live; must match "Route prefix" in OmniConva. Default "/omniconva". */
  prefix?: string;
  /** Default: in memory (one process). Use a shared store with several. */
  idempotency?: IdempotencyStore;
  /** Pass test orders from the OmniConva dashboard to your handler. Default false. */
  passTestOrders?: boolean;
  /** Seconds a request signature may be from now. Default 300. */
  signatureTolerance?: number;
  /** Per webhook attempt. Default 10000. */
  webhookTimeoutMs?: number;
  /** Waits between webhook retries (network errors, 5xx, 429). Default [1000, 4000, 15000]. */
  webhookRetryDelaysMs?: number[];
  /** Chat widget: site key (OMNICONVA_SITE_KEY), API URL, identity secret (OMNICONVA_IDENTITY_SECRET). */
  widget?: { siteKey?: string; apiUrl?: string; identitySecret?: string };
  /** Called with errors from your handlers (refused orders, failures), e.g. to log them. */
  onError?: (error: unknown, context: { route: string }) => void;
  /** Override fetch (tests, proxies). */
  fetch?: typeof fetch;
}

/** A request in framework-neutral terms; the adapters build these. */
export interface IncomingCall {
  method: string;
  /** Exactly as received, e.g. "/omniconva/products?page=2&per_page=50". */
  pathAndQuery: string;
  /** The raw body ("" for a GET). */
  body: string;
  header(name: string): string | undefined | null;
}

export interface OutgoingResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export class OmniConvaError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'OmniConvaError';
  }
}

const env = (name: string): string | undefined =>
  typeof process !== 'undefined' ? process.env[name] || undefined : undefined;

const json = (status: number, body: unknown, headers: Record<string, string> = {}): OutgoingResponse => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class OmniConva {
  readonly prefix: string;
  private readonly webhookUrl: string | undefined;
  private readonly webhookToken: string | undefined;
  private readonly signingSecret: string | undefined;
  private readonly currency: string | null;
  private readonly idempotency: IdempotencyStore;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OmniConvaOptions = {}) {
    this.webhookUrl = options.webhookUrl ?? env('OMNICONVA_WEBHOOK_URL');
    this.webhookToken = options.webhookToken ?? env('OMNICONVA_WEBHOOK_TOKEN');
    this.signingSecret = options.signingSecret ?? env('OMNICONVA_SIGNING_SECRET');
    this.currency = options.currency !== undefined ? options.currency : (env('OMNICONVA_CURRENCY') ?? 'BDT');
    this.prefix = '/' + (options.prefix ?? env('OMNICONVA_ROUTE_PREFIX') ?? 'omniconva').replace(/^\/+|\/+$/g, '');
    this.idempotency = options.idempotency ?? memoryIdempotencyStore();
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Whether the webhook URL, token and signing secret are all set. */
  configured(): boolean {
    return Boolean(this.webhookUrl && this.webhookToken && this.signingSecret);
  }

  // --- Requests from OmniConva -------------------------------------------

  /**
   * Answers a request to your routes, or returns null when the path isn't
   * under the prefix (so a framework can pass it on). Every request must
   * carry a valid X-OmniConva-Signature.
   */
  async handleCall(call: IncomingCall): Promise<OutgoingResponse | null> {
    const [pathname = '', query = ''] = call.pathAndQuery.split('?', 2);
    if (pathname !== this.prefix && !pathname.startsWith(this.prefix + '/')) return null;
    const route = pathname.slice(this.prefix.length) || '/';

    const valid = verifyRequest(
      this.signingSecret ?? '',
      call.header(SIGNATURE_HEADER),
      call.method,
      call.pathAndQuery,
      call.body,
      { tolerance: this.options.signatureTolerance },
    );
    if (!valid) {
      return json(401, {
        message: 'Missing or invalid X-OmniConva-Signature. Check OMNICONVA_SIGNING_SECRET.',
      });
    }

    const method = call.method.toUpperCase();
    try {
      if (method === 'GET' && route === '/health') return this.health();
      if (method === 'GET' && route === '/products') return await this.listProducts(new URLSearchParams(query));
      const one = /^\/products\/(.+)$/.exec(route);
      if (method === 'GET' && one?.[1]) return await this.getProduct(decodeURIComponent(one[1]));
      if (method === 'POST' && route === '/orders') return await this.createOrder(call);
    } catch (error) {
      this.options.onError?.(error, { route });
      return json(500, { message: error instanceof Error ? error.message : 'Internal error' });
    }
    return json(404, { message: 'Not found' });
  }

  private health(): OutgoingResponse {
    return json(200, {
      package: '@omniconva/node',
      version: VERSION,
      framework: `Node.js ${typeof process !== 'undefined' ? process.version : ''}`.trim(),
    });
  }

  private requireProducts(): ProductSource {
    if (!this.options.products) throw new OmniConvaError('Pass `products` to createOmniConva().');
    return this.options.products;
  }

  private async listProducts(query: URLSearchParams): Promise<OutgoingResponse> {
    const page = Math.max(1, Math.trunc(Number(query.get('page') ?? '1')) || 1);
    const perPage = Math.min(100, Math.max(1, Math.trunc(Number(query.get('per_page') ?? '50')) || 50));
    const sinceRaw = query.get('updated_since');
    const since = sinceRaw ? new Date(sinceRaw) : null;
    if (since && Number.isNaN(since.getTime())) {
      return json(422, { message: 'updated_since must be an ISO 8601 date' });
    }
    const result = await this.requireProducts().list({ page, perPage, since });
    const total = result.total ?? null;
    const hasMore =
      result.hasMore ?? (total !== null ? page * perPage < total : result.products.length >= perPage);
    return json(200, {
      products: result.products.map((product) => toStandardProduct(product, this.currency)),
      page,
      per_page: perPage,
      total,
      has_more: hasMore,
    });
  }

  private async getProduct(id: string): Promise<OutgoingResponse> {
    const product = await this.requireProducts().get(id);
    return product
      ? json(200, toStandardProduct(product, this.currency))
      : json(404, { message: 'Product not found' });
  }

  private async createOrder(call: IncomingCall): Promise<OutgoingResponse> {
    let order;
    try {
      order = parseOrder(JSON.parse(call.body));
    } catch (error) {
      return json(422, {
        message: error instanceof OrderPayloadError ? error.message : 'The body must be a JSON object',
      });
    }
    if (!this.options.orders) throw new OmniConvaError('Pass `orders` to createOmniConva().');

    if (order.test && !this.options.passTestOrders) {
      const hash = createHmac('sha256', 'test').update(order.id).digest('hex').slice(0, 12);
      return json(201, { order_id: `test-${hash}`, order_number: null, test: true });
    }

    const key = call.header('idempotency-key') || order.id;
    const claim = await this.idempotency.claim(key);
    if (claim.state === 'done') return json(200, claim.response);
    if (claim.state === 'busy') {
      return json(503, { message: 'This order is being created; retry shortly.' }, { 'retry-after': '30' });
    }

    let response: Record<string, unknown>;
    try {
      const result = await this.options.orders.create(order);
      response = {
        order_id: String(result.orderId),
        order_number: result.orderNumber === undefined || result.orderNumber === null ? null : String(result.orderNumber),
      };
    } catch (error) {
      await this.idempotency.release(key);
      this.options.onError?.(error, { route: '/orders' });
      return json(422, {
        message: (error instanceof Error && error.message) || 'The order could not be created',
      });
    }
    await this.idempotency.complete(key, response);
    return json(201, response);
  }

  // --- Webhooks to OmniConva ----------------------------------------------

  /** Tells OmniConva a product changed (call it after you save one). */
  async productUpdated(product: ProductInput): Promise<void> {
    if (!this.configured()) return;
    await this.send('product.updated', toStandardProduct(product, this.currency));
  }

  /** Tells OmniConva a product is gone, or no longer for sale. */
  async productDeleted(id: string | number): Promise<void> {
    if (!this.configured()) return;
    await this.send('product.deleted', { id: String(id) });
  }

  /**
   * Where an order is now, so OmniConva's AI can answer "where is my
   * order?". `orderId` is what your order handler returned. Statuses are your
   * own words: pending, confirmed, processing, shipped, delivered, cancelled…
   */
  async orderUpdated(orderId: string | number, status: string, tracking?: Tracking | null, note?: string | null): Promise<void> {
    if (!this.configured()) return;
    const body: Record<string, unknown> = {
      order_id: String(orderId),
      status,
      updated_at: new Date().toISOString(),
    };
    if (tracking) {
      body.tracking = { number: tracking.number ?? null, carrier: tracking.carrier ?? null, url: tracking.url ?? null };
    }
    if (note) body.note = note;
    await this.send('order.updated', body);
  }

  /** Checks the webhook URL, token and signing secret with OmniConva. */
  async ping(): Promise<{ ok: boolean; store?: string }> {
    if (!this.configured()) {
      throw new OmniConvaError(
        'Set OMNICONVA_WEBHOOK_URL, OMNICONVA_WEBHOOK_TOKEN and OMNICONVA_SIGNING_SECRET first.',
      );
    }
    const response = await this.deliver('ping', '{}');
    if (!response.ok) throw new OmniConvaError(await errorMessage(response), response.status);
    return (await response.json()) as { ok: boolean; store?: string };
  }

  /**
   * Sends one webhook, retrying network errors, 5xx and 429 with backoff.
   * Other 4xx answers mean the payload or credentials are wrong; they throw
   * at once. Throws OmniConvaError when every attempt fails.
   */
  async send(topic: string, payload: Record<string, unknown>): Promise<void> {
    const body = JSON.stringify(payload);
    const delays = this.options.webhookRetryDelaysMs ?? [1000, 4000, 15000];
    let lastError: unknown;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt > 0) await sleep(delays[attempt - 1] ?? 0);
      try {
        const response = await this.deliver(topic, body);
        if (response.ok) return;
        const message = `OmniConva refused the ${topic} webhook (HTTP ${response.status}): ${await errorMessage(response)}`;
        if (response.status < 500 && response.status !== 429 && response.status !== 408) {
          throw new OmniConvaError(message, response.status);
        }
        lastError = new OmniConvaError(message, response.status);
      } catch (error) {
        if (error instanceof OmniConvaError && error.status !== null && error.status < 500 && error.status !== 429 && error.status !== 408) {
          throw error;
        }
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new OmniConvaError(String(lastError));
  }

  /** Posts one signed webhook now. */
  async deliver(topic: string, body: string): Promise<Response> {
    if (!this.configured()) throw new OmniConvaError('OmniConva credentials are not set.');
    return this.fetchImpl(this.webhookUrl!, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.webhookToken}`,
        'x-webhook-topic': topic,
        [SIGNATURE_HEADER]: signWebhook(this.signingSecret!, body),
        'user-agent': `omniconva-node/${VERSION}`,
      },
      body,
      signal: AbortSignal.timeout(this.options.webhookTimeoutMs ?? 10_000),
    });
  }

  // --- Chat widget --------------------------------------------------------

  /** HMAC of a signed-in customer's id, for the widget's identity check. */
  customerHash(customerId: string | number): string | null {
    const secret = this.options.widget?.identitySecret ?? env('OMNICONVA_IDENTITY_SECRET');
    return secret ? createHmac('sha256', secret).update(String(customerId)).digest('hex') : null;
  }

  /**
   * The chat widget's <script> tags, for server-rendered pages; empty until a
   * site key is set. Pass the signed-in customer to have them recognised
   * (only sent when an identity secret is set).
   */
  chatWidgetHtml(
    options: {
      customer?: { id: string | number; name?: string | null; email?: string | null; phone?: string | null; address?: string | null; avatarUrl?: string | null } | null;
      showPoweredBy?: boolean;
    } = {},
  ): string {
    const siteKey = this.options.widget?.siteKey ?? env('OMNICONVA_SITE_KEY');
    if (!siteKey) return '';
    const apiUrl = (this.options.widget?.apiUrl ?? env('OMNICONVA_API_URL') ?? 'https://api.omniconva.com').replace(/\/+$/, '');
    const config: Record<string, unknown> = { siteKey, apiBase: apiUrl };
    if (options.showPoweredBy !== undefined) config.showPoweredBy = options.showPoweredBy;
    const customer = options.customer;
    const hash = customer ? this.customerHash(customer.id) : null;
    if (customer && hash) {
      config.customer = Object.fromEntries(
        Object.entries({
          id: String(customer.id),
          name: customer.name,
          email: customer.email,
          phone: customer.phone,
          address: customer.address,
          avatar_url: customer.avatarUrl,
          hash,
        }).filter(([, value]) => value !== null && value !== undefined && value !== ''),
      );
    }
    // Escape "<" so no value can close the script tag.
    const serialized = JSON.stringify(config).replace(/</g, '\\u003c');
    return (
      `<script>window.OmniConvaChat=Object.assign(window.OmniConvaChat||{},${serialized});</script>` +
      `<script src="${apiUrl}/static/widget.min.js" defer></script>`
    );
  }
}

async function errorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    if (Array.isArray(parsed.message)) return parsed.message.join('; ');
    if (typeof parsed.message === 'string') return parsed.message;
  } catch {
    // not JSON
  }
  return text.slice(0, 300);
}
