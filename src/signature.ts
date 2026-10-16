import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * OmniConva's HMAC-SHA256 signatures, header format `t=<unix>,v1=<hex>`.
 *
 * Requests from OmniConva to your routes sign `<t>.<METHOD>.<path?query>.<body>`;
 * webhooks you send to OmniConva sign `<t>.<body>`.
 */

export const SIGNATURE_HEADER = 'x-omniconva-signature';
export const DEFAULT_TOLERANCE_SECONDS = 300;

const now = () => Math.floor(Date.now() / 1000);

function hmac(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function signWebhook(secret: string, body: string, timestamp = now()): string {
  return `t=${timestamp},v1=${hmac(secret, `${timestamp}.${body}`)}`;
}

export function signRequest(
  secret: string,
  method: string,
  pathAndQuery: string,
  body: string,
  timestamp = now(),
): string {
  return `t=${timestamp},v1=${hmac(secret, `${timestamp}.${method.toUpperCase()}.${pathAndQuery}.${body}`)}`;
}

/**
 * Whether a signature header is well-formed and its timestamp is within
 * tolerance — everything that can be checked before the body has been read.
 * A request that fails this is refused without buffering its body.
 */
export function signatureLooksCurrent(
  header: string | null | undefined,
  options: { tolerance?: number; now?: number } = {},
): boolean {
  if (!header) return false;
  const match = /(?:^|,)\s*t=(\d+)\s*(?:,|$)/.exec(header);
  const v1 = /(?:^|,)\s*v1=([0-9a-f]+)\s*(?:,|$)/i.test(header);
  if (!match || !v1) return false;
  return Math.abs((options.now ?? now()) - Number(match[1])) <= (options.tolerance ?? DEFAULT_TOLERANCE_SECONDS);
}

export function verifyRequest(
  secret: string,
  header: string | null | undefined,
  method: string,
  pathAndQuery: string,
  body: string,
  options: { tolerance?: number; now?: number } = {},
): boolean {
  if (!secret || !header) return false;
  const parts = new Map<string, string>();
  for (const segment of header.split(',')) {
    const index = segment.indexOf('=');
    if (index > 0) parts.set(segment.slice(0, index).trim(), segment.slice(index + 1).trim());
  }
  const t = parts.get('t');
  const provided = parts.get('v1');
  if (!t || !provided || !/^\d+$/.test(t)) return false;
  const timestamp = Number(t);
  if (Math.abs((options.now ?? now()) - timestamp) > (options.tolerance ?? DEFAULT_TOLERANCE_SECONDS)) {
    return false;
  }
  const expected = Buffer.from(
    hmac(secret, `${timestamp}.${method.toUpperCase()}.${pathAndQuery}.${body}`),
    'utf8',
  );
  const given = Buffer.from(provided, 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
