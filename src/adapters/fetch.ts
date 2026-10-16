import { BodyTooLargeError, type OmniConva, type OutgoingResponse } from '../client';

function toResponse(result: OutgoingResponse): Response {
  return new Response(result.body, { status: result.status, headers: result.headers });
}

const notFound = () =>
  new Response(JSON.stringify({ message: 'Not found' }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });

// Reads the body while counting, so an oversized post is cancelled rather
// than held in memory; falls back to text() where the body isn't a stream.
async function readFetchBody(request: Request, maxBytes: number): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) {
    const text = await request.text();
    if (Buffer.byteLength(text) > maxBytes) throw new BodyTooLargeError(maxBytes);
    return text;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * A Fetch API handler: Next.js App Router route handlers, Hono, Bun, Deno,
 * Cloudflare Workers. Answers 404 for paths outside the prefix.
 */
export function fetchHandler(omniconva: OmniConva): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const pathAndQuery = url.pathname + url.search;
    const header = (name: string) => request.headers.get(name);
    const early = omniconva.preflight({ method: request.method, pathAndQuery, header });
    if (early === null) return notFound();
    if (early) return toResponse(early);
    let body = '';
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      try {
        body = await readFetchBody(request, omniconva.maxBodyBytes);
      } catch (error) {
        if (error instanceof BodyTooLargeError) return toResponse(error.response());
        throw error;
      }
    }
    const result = await omniconva.handleCall({ method: request.method, pathAndQuery, body, header });
    return result ? toResponse(result) : notFound();
  };
}
