import { describe, expect, it } from 'vitest';
import { VERSION, signRequest } from '../src/index';
import { makeClient, orderPayload, signedRequest } from './helpers';

const call = async (client: ReturnType<typeof makeClient>['client'], request: Request) => {
  const response = await client.fetch(request);
  return { status: response.status, headers: response.headers, body: (await response.json()) as Record<string, any> };
};

describe('requests from OmniConva', () => {
  it('refuses unsigned, wrongly signed and stale requests', async () => {
    const { client } = makeClient();
    expect((await call(client, new Request('http://shop.test/omniconva/products'))).status).toBe(401);
    expect((await call(client, signedRequest('/omniconva/products', { secret: 'wrong' }))).status).toBe(401);
    const stale = new Request('http://shop.test/omniconva/products', {
      headers: { 'x-omniconva-signature': signRequest('test-secret', 'GET', '/omniconva/products', '', 1700000000) },
    });
    expect((await call(client, stale)).status).toBe(401);
  });

  it('serves products page by page in the standard format', async () => {
    const { client } = makeClient();
    const first = await call(client, signedRequest('/omniconva/products?page=1&per_page=2'));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ page: 1, per_page: 2, total: 3, has_more: true });
    expect(first.body.products[0]).toMatchObject({ id: '1', title: 'Classic Tee', price: '650.00', sale_price: '590.00', currency: 'BDT' });
    expect(first.body.products[0].variants[0].options).toEqual({ Size: 'S' });

    const second = await call(client, signedRequest('/omniconva/products?page=2&per_page=2'));
    expect(second.body).toMatchObject({ has_more: false });
    expect(second.body.products).toHaveLength(1);
  });

  it('passes the paging and "since" to your source', async () => {
    let seen: unknown;
    const { client } = makeClient({
      products: { list: (query) => ((seen = query), { products: [] }), get: () => null },
    });
    await call(client, signedRequest('/omniconva/products?page=3&per_page=500&updated_since=2026-10-01T00%3A00%3A00.000Z'));
    expect(seen).toEqual({ page: 3, perPage: 100, since: new Date('2026-10-01T00:00:00.000Z') });
  });

  it('serves one product, or 404', async () => {
    const { client } = makeClient();
    expect((await call(client, signedRequest('/omniconva/products/2'))).body).toMatchObject({ id: '2', title: 'Mug 1' });
    expect((await call(client, signedRequest('/omniconva/products/999'))).status).toBe(404);
  });

  it('answers the health check', async () => {
    const { client } = makeClient();
    const health = await call(client, signedRequest('/omniconva/health'));
    expect(health.body).toMatchObject({ package: '@omniconva/node', version: VERSION });
    expect(health.body.framework).toMatch(/^Node\.js v/);
  });

  it('creates an order once per idempotency key', async () => {
    const { client, created } = makeClient();
    const body = JSON.stringify(orderPayload());
    const headers = { 'idempotency-key': orderPayload().id };
    const first = await call(client, signedRequest('/omniconva/orders', { method: 'POST', body, headers }));
    const again = await call(client, signedRequest('/omniconva/orders', { method: 'POST', body, headers }));
    expect(first).toMatchObject({ status: 201, body: { order_id: 'W-1001', order_number: '5001' } });
    expect(again).toMatchObject({ status: 200, body: { order_id: 'W-1001', order_number: '5001' } });
    expect(created).toHaveLength(1);
  });

  it('tells OmniConva to retry while the same order is still being created', async () => {
    let release: () => void = () => {};
    const { client } = makeClient({
      orders: { create: () => new Promise((resolve) => (release = () => resolve({ orderId: 'W-1' }))) },
    });
    const body = JSON.stringify(orderPayload());
    const first = client.fetch(signedRequest('/omniconva/orders', { method: 'POST', body }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const busy = await call(client, signedRequest('/omniconva/orders', { method: 'POST', body }));
    expect(busy.status).toBe(503);
    expect(busy.headers.get('retry-after')).toBe('30');
    release();
    expect((await first).status).toBe(201);
  });

  it('reports a refused order and lets a retry try again', async () => {
    const errors: unknown[] = [];
    const { client, created } = makeClient({ onError: (error) => errors.push(error) });
    const refused = await call(client, signedRequest('/omniconva/orders', {
      method: 'POST',
      body: JSON.stringify(orderPayload({ customer: { name: 'Refuse Me', phone: '017' } })),
    }));
    expect(refused).toMatchObject({ status: 422, body: { message: 'Out of delivery area' } });
    expect(errors).toHaveLength(1);
    const retry = await call(client, signedRequest('/omniconva/orders', { method: 'POST', body: JSON.stringify(orderPayload()) }));
    expect(retry.status).toBe(201);
    expect(created).toHaveLength(1);
  });

  // Only an OrderRefusedError's words reach OmniConva's logs; a crash in
  // the handler (SQL, hosts, customer data in its message) does not.
  it('keeps the details of a failed handler out of the response', async () => {
    const errors: unknown[] = [];
    const { client } = makeClient({ onError: (error) => errors.push(error) });
    const failed = await call(client, signedRequest('/omniconva/orders', {
      method: 'POST',
      body: JSON.stringify(orderPayload({ customer: { name: 'Break Me', phone: '017' } })),
    }));
    expect(failed).toMatchObject({ status: 500, body: { message: 'The order could not be created' } });
    expect(JSON.stringify(failed.body)).not.toContain('10.0.0.5');
    expect(errors).toHaveLength(1);
  });

  it('refuses an oversized or unsigned body before reading it', async () => {
    const { client } = makeClient({ maxBodyBytes: 1024 });
    const big = JSON.stringify(orderPayload({ note: 'x'.repeat(2048) }));
    expect((await call(client, signedRequest('/omniconva/orders', { method: 'POST', body: big }))).status).toBe(413);
    const unsigned = new Request('http://shop.test/omniconva/orders', { method: 'POST', body: big });
    expect((await call(client, unsigned)).status).toBe(401);
    const small = JSON.stringify(orderPayload());
    expect((await call(client, signedRequest('/omniconva/orders', { method: 'POST', body: small }))).status).toBe(201);
  });

  it('answers 404 for a product id that is not valid percent-encoding', async () => {
    const { client } = makeClient();
    expect((await call(client, signedRequest('/omniconva/products/%E0%A4%A'))).status).toBe(404);
  });

  it('answers test orders without calling your handler, unless told to', async () => {
    const { client, created } = makeClient();
    const test = await call(client, signedRequest('/omniconva/orders', { method: 'POST', body: JSON.stringify(orderPayload({ test: true })) }));
    expect(test).toMatchObject({ status: 201, body: { test: true } });
    expect(created).toHaveLength(0);

    const passing = makeClient({ passTestOrders: true });
    await call(passing.client, signedRequest('/omniconva/orders', { method: 'POST', body: JSON.stringify(orderPayload({ test: true })) }));
    expect(passing.created).toHaveLength(1);
  });

  it('refuses an order body it cannot read', async () => {
    const { client } = makeClient();
    expect((await call(client, signedRequest('/omniconva/orders', { method: 'POST', body: 'not json' }))).status).toBe(422);
    const empty = await call(client, signedRequest('/omniconva/orders', { method: 'POST', body: JSON.stringify({ id: 'x', items: [] }) }));
    expect(empty).toMatchObject({ status: 422, body: { message: 'The order has no items' } });
  });

  it('honours a custom prefix and ignores other paths', async () => {
    const { client } = makeClient({ prefix: 'api/omni/' });
    expect(client.prefix).toBe('/api/omni');
    expect((await call(client, signedRequest('/api/omni/health'))).status).toBe(200);
    expect(await client.handleCall({ method: 'GET', pathAndQuery: '/other', body: '', header: () => null })).toBeNull();
  });
});
