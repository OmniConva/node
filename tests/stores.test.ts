import { describe, expect, it } from 'vitest';
import { createOmniConva, memoryIdempotencyStore, redisIdempotencyStore } from '../src/index';

describe('redis idempotency store', () => {
  // A wrapper that answers "not set" and then "nothing stored" every time
  // (a broken client, a replica) used to send claim() into an endless loop.
  it('gives up after one retry against a client that never stores', async () => {
    let calls = 0;
    const store = redisIdempotencyStore({
      setIfAbsent: async () => (calls++, false),
      set: async () => undefined,
      get: async () => null,
      del: async () => undefined,
    });
    expect(await store.claim('k')).toEqual({ state: 'busy' });
    expect(calls).toBe(2);
  });

  it('honours a longer stale window', async () => {
    const ttls: number[] = [];
    const store = redisIdempotencyStore(
      { setIfAbsent: async (_k, _v, ttl) => (ttls.push(ttl), true), set: async () => undefined, get: async () => null, del: async () => undefined },
      'p:',
      { staleClaimMs: 15 * 60 * 1000 },
    );
    await store.claim('k');
    expect(ttls).toEqual([15 * 60 * 1000]);
  });
});

describe('memory idempotency store', () => {
  it('honours a longer stale window', async () => {
    const store = memoryIdempotencyStore({ staleClaimMs: 60_000 });
    expect(await store.claim('k')).toEqual({ state: 'claimed' });
    expect(await store.claim('k')).toEqual({ state: 'busy' });
  });
});

describe('delivery URLs', () => {
  it('refuses a plain-http webhook URL except on localhost', () => {
    expect(() => createOmniConva({ webhookUrl: 'http://api.example.com/hook', webhookToken: 't', signingSecret: 's' })).toThrow(/https/);
    expect(() => createOmniConva({ webhookUrl: 'http://localhost:4700/hook', webhookToken: 't', signingSecret: 's' })).not.toThrow();
    expect(() => createOmniConva({ webhookUrl: 'http://127.0.0.2:4700/hook', webhookToken: 't', signingSecret: 's' })).not.toThrow();
    expect(() =>
      createOmniConva({ webhookUrl: 'http://api:4700/hook', webhookToken: 't', signingSecret: 's', allowInsecureUrls: true }),
    ).not.toThrow();
  });

  it('escapes the API URL in the widget script tag and refuses plain http', () => {
    const client = createOmniConva({ widget: { siteKey: 'pk_x', apiUrl: 'https://api.example.com/"><img src=x onerror=alert(1)>' } });
    const html = client.chatWidgetHtml();
    expect(html).not.toContain('"><img');
    expect(html).toContain('src="https://api.example.com/&quot;&gt;&lt;img src=x onerror=alert(1)&gt;/static/widget.min.js"');
    const insecure = createOmniConva({ widget: { siteKey: 'pk_x', apiUrl: 'http://api.example.com' } });
    expect(() => insecure.chatWidgetHtml()).toThrow(/https/);
  });
});
