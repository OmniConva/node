import { describe, expect, it } from 'vitest';
import { signRequest, signWebhook, verifyRequest } from '../src/index';

// Produced by OmniConva's own signer (api: common/webhooks/timestamped-signature.ts).
const VECTORS: [string, string, string, string][] = [
  ['GET', '/omniconva/products?page=2&per_page=50&updated_since=2026-10-01T00%3A00%3A00.000Z', '', 't=1700000000,v1=3d8daff9f24c7e62ec493c7666f0fda64f8843d71494a7ba4d57274623451616'],
  ['POST', '/omniconva/orders', '{"id":"abc"}', 't=1700000000,v1=2e74a27c3283a4e23a68ec029d6faf8cdd1d52b8130590d1f368c62ac154f712'],
];

describe('signatures', () => {
  it.each(VECTORS)('signs %s %s exactly like OmniConva', (method, path, body, expected) => {
    expect(signRequest('test-secret', method, path, body, 1700000000)).toBe(expected);
    expect(verifyRequest('test-secret', expected, method, path, body, { now: 1700000100 })).toBe(true);
  });

  it('signs webhooks exactly like OmniConva verifies them', () => {
    expect(signWebhook('test-secret', '{"id":"1"}', 1700000000)).toBe(
      't=1700000000,v1=9fe0764af9e888d6648e4fb2ad331add3f30860b2a000745d00c316d5399e953',
    );
  });

  it('rejects tampering, other secrets, old timestamps and junk', () => {
    const header = signRequest('test-secret', 'POST', '/omniconva/orders', '{"id":"abc"}', 1700000000);
    const at = { now: 1700000000 };
    expect(verifyRequest('test-secret', header, 'POST', '/omniconva/orders', '{"id":"x"}', at)).toBe(false);
    expect(verifyRequest('test-secret', header, 'GET', '/omniconva/orders', '{"id":"abc"}', at)).toBe(false);
    expect(verifyRequest('other', header, 'POST', '/omniconva/orders', '{"id":"abc"}', at)).toBe(false);
    expect(verifyRequest('test-secret', header, 'POST', '/omniconva/orders', '{"id":"abc"}', { now: 1700000400 })).toBe(false);
    expect(verifyRequest('test-secret', null, 'GET', '/', '', at)).toBe(false);
    expect(verifyRequest('test-secret', 'garbage', 'GET', '/', '', at)).toBe(false);
    expect(verifyRequest('', header, 'POST', '/omniconva/orders', '{"id":"abc"}', at)).toBe(false);
  });
});
