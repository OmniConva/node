import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { signRequest } from '../src/index';
import { makeClient, orderPayload } from './helpers';

let server: Server | undefined;
afterEach(() => server?.close());

async function listen(app: Parameters<typeof createServer>[1] | ReturnType<typeof express>) {
  server = createServer(app as Parameters<typeof createServer>[1]);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

const signed = (method: string, path: string, body = '') => ({
  method,
  body: method === 'GET' ? undefined : body,
  headers: { 'content-type': 'application/json', 'x-omniconva-signature': signRequest('test-secret', method, path, body) },
});

describe('Express', () => {
  it('serves the routes and leaves everything else to your app', async () => {
    const { client, created } = makeClient();
    const app = express();
    app.use(client.express());
    app.use(express.json());
    app.get('/', (_req, res) => {
      res.send('home');
    });
    const base = await listen(app);

    const products = await fetch(`${base}/omniconva/products?page=1&per_page=1`, signed('GET', '/omniconva/products?page=1&per_page=1'));
    expect(products.status).toBe(200);
    expect(((await products.json()) as { products: unknown[] }).products).toHaveLength(1);

    const body = JSON.stringify(orderPayload());
    const order = await fetch(`${base}/omniconva/orders`, signed('POST', '/omniconva/orders', body));
    expect(order.status).toBe(201);
    expect(created).toHaveLength(1);

    expect(await (await fetch(`${base}/`)).text()).toBe('home');
  });

  it('explains when a body parser ran first', async () => {
    const { client } = makeClient();
    const app = express();
    app.use(express.json());
    app.use(client.express());
    const base = await listen(app);
    const body = JSON.stringify(orderPayload());
    const response = await fetch(`${base}/omniconva/orders`, signed('POST', '/omniconva/orders', body));
    expect(response.status).toBe(500);
    expect(((await response.json()) as { message: string }).message).toContain('before express.json()');
  });

  it('works with a raw body kept by the parser', async () => {
    const { client } = makeClient();
    const app = express();
    app.use(express.json({ verify: (req, _res, buf) => ((req as unknown as { rawBody: Buffer }).rawBody = buf) }));
    app.use(client.express());
    const base = await listen(app);
    const body = JSON.stringify(orderPayload());
    expect((await fetch(`${base}/omniconva/orders`, signed('POST', '/omniconva/orders', body))).status).toBe(201);
  });
});

describe('node:http', () => {
  it('answers its routes and resolves false for others', async () => {
    const { client } = makeClient();
    const handle = client.node();
    const base = await listen(async (req: IncomingMessage, res: ServerResponse) => {
      if (!(await handle(req, res))) res.end('mine');
    });
    expect((await fetch(`${base}/omniconva/health`, signed('GET', '/omniconva/health'))).status).toBe(200);
    expect(await (await fetch(`${base}/elsewhere`)).text()).toBe('mine');
  });
});

describe('node:http prefix', () => {
  // `/omniconva-newsletter` is the merchant's own route: the handler must
  // neither answer it nor consume its body.
  it('leaves a look-alike path, body and all, to your server', async () => {
    const { client } = makeClient();
    const handle = client.node();
    let seen = '';
    const base = await listen(async (req: IncomingMessage, res: ServerResponse) => {
      if (await handle(req, res)) return;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      seen = Buffer.concat(chunks).toString();
      res.end('mine');
    });
    const response = await fetch(`${base}/omniconva-newsletter`, { method: 'POST', body: 'email=a@b.c' });
    expect(await response.text()).toBe('mine');
    expect(seen).toBe('email=a@b.c');
  });
});

describe('Next.js', () => {
  it('exposes GET and POST route handlers', async () => {
    const { client } = makeClient();
    const { GET, POST } = client.nextjs();
    const response = await GET(new Request('http://shop.test/omniconva/health', signed('GET', '/omniconva/health')));
    expect(response.status).toBe(200);
    expect(POST).toBe(GET);
  });
});
