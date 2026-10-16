import { describe, expect, it, vi } from 'vitest';
import { OmniConvaError, signWebhook, redisIdempotencyStore, type RedisLike } from '../src/index';
import { SECRET, TOKEN, WEBHOOK_URL, makeClient } from './helpers';

function recorder(...responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift() ?? new Response('{"ok":true}', { status: 200 });
    if (next instanceof Error) throw next;
    return next;
  });
  return { calls, fetch: fetchMock as unknown as typeof fetch };
}

function expectSigned(call: { url: string; init: RequestInit }, topic: string) {
  const headers = call.init.headers as Record<string, string>;
  expect(call.url).toBe(WEBHOOK_URL);
  expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
  expect(headers['x-webhook-topic']).toBe(topic);
  const t = Number(/t=(\d+)/.exec(headers['x-omniconva-signature']!)![1]);
  expect(headers['x-omniconva-signature']).toBe(signWebhook(SECRET, String(call.init.body), t));
  return JSON.parse(String(call.init.body)) as Record<string, any>;
}

describe('webhooks to OmniConva', () => {
  it('sends product.updated in the standard format', async () => {
    const http = recorder();
    const { client } = makeClient({ fetch: http.fetch });
    await client.productUpdated({ id: 7, title: 'Mug', price: 300, stockQuantity: 4 });
    expect(expectSigned(http.calls[0]!, 'product.updated')).toMatchObject({ id: '7', price: '300.00', stock_quantity: 4, currency: 'BDT' });
  });

  it('sends product.deleted and order.updated', async () => {
    const http = recorder();
    const { client } = makeClient({ fetch: http.fetch });
    await client.productDeleted(7);
    await client.orderUpdated('W-1001', 'shipped', { number: 'TRK1', carrier: 'Pathao' }, 'Rider assigned');
    expect(expectSigned(http.calls[0]!, 'product.deleted')).toEqual({ id: '7' });
    expect(expectSigned(http.calls[1]!, 'order.updated')).toMatchObject({
      order_id: 'W-1001',
      status: 'shipped',
      tracking: { number: 'TRK1', carrier: 'Pathao', url: null },
      note: 'Rider assigned',
    });
  });

  it('retries network errors and 5xx, then succeeds', async () => {
    const http = recorder(new Error('ECONNRESET'), new Response('{"message":"down"}', { status: 503 }));
    const { client } = makeClient({ fetch: http.fetch });
    await client.productDeleted(1);
    expect(http.calls).toHaveLength(3);
  });

  it('gives up at once on a refusal, and after the last retry otherwise', async () => {
    const refused = recorder(new Response('{"message":["bad id"]}', { status: 400 }));
    await expect(makeClient({ fetch: refused.fetch }).client.productDeleted(1)).rejects.toThrow(/HTTP 400.*bad id/);
    expect(refused.calls).toHaveLength(1);

    const down = recorder(...[1, 2, 3].map(() => new Response('{}', { status: 502 })));
    await expect(makeClient({ fetch: down.fetch }).client.productDeleted(1)).rejects.toBeInstanceOf(OmniConvaError);
    expect(down.calls).toHaveLength(3);
  });

  it('does nothing until the credentials are set', async () => {
    const http = recorder();
    const { client } = makeClient({ fetch: http.fetch, webhookToken: '' });
    await client.productUpdated({ id: 1, title: 'A' });
    expect(http.calls).toHaveLength(0);
    await expect(client.ping()).rejects.toThrow(/OMNICONVA_WEBHOOK_TOKEN/);
  });

  it('pings OmniConva', async () => {
    const ok = recorder(new Response('{"ok":true,"store":"s1"}'));
    expect(await makeClient({ fetch: ok.fetch }).client.ping()).toEqual({ ok: true, store: 's1' });
    expectSigned(ok.calls[0]!, 'ping');
    const bad = recorder(new Response('{"message":"Invalid webhook token"}', { status: 401 }));
    await expect(makeClient({ fetch: bad.fetch }).client.ping()).rejects.toThrow('Invalid webhook token');
  });
});

describe('chat widget', () => {
  it('renders nothing without a site key', () => {
    expect(makeClient().client.chatWidgetHtml()).toBe('');
  });

  it('renders the widget, with a signed customer when an identity secret is set', () => {
    const { client } = makeClient({ widget: { siteKey: 'pk_1', identitySecret: 'idsecret' } });
    const html = client.chatWidgetHtml({ customer: { id: 42, name: '</script><b>', email: null } });
    expect(html).toContain('"siteKey":"pk_1"');
    expect(html).toContain('src="https://api.omniconva.com/static/widget.min.js"');
    expect(html).toContain(`"hash":"${client.customerHash(42)}"`);
    expect(html).not.toContain('</script><b>');
    expect(html).not.toContain('"email"');
    expect(makeClient({ widget: { siteKey: 'pk_1' } }).client.chatWidgetHtml({ customer: { id: 42 } })).not.toContain('customer');
  });
});

describe('redisIdempotencyStore', () => {
  it('claims once, answers done, and releases', async () => {
    const data = new Map<string, string>();
    const redis: RedisLike = {
      async setIfAbsent(key, value) {
        if (data.has(key)) return false;
        data.set(key, value);
        return true;
      },
      async set(key, value) {
        data.set(key, value);
      },
      async get(key) {
        return data.get(key) ?? null;
      },
      async del(key) {
        data.delete(key);
      },
    };
    const store = redisIdempotencyStore(redis);
    expect(await store.claim('k')).toEqual({ state: 'claimed' });
    expect(await store.claim('k')).toEqual({ state: 'busy' });
    await store.release('k');
    expect(await store.claim('k')).toEqual({ state: 'claimed' });
    await store.complete('k', { order_id: '1' });
    expect(await store.claim('k')).toEqual({ state: 'done', response: { order_id: '1' } });
  });
});
