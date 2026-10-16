import type { OmniConva, OutgoingResponse } from '../client';

function toResponse(result: OutgoingResponse): Response {
  return new Response(result.body, { status: result.status, headers: result.headers });
}

/**
 * A Fetch API handler: Next.js App Router route handlers, Hono, Bun, Deno,
 * Cloudflare Workers. Answers 404 for paths outside the prefix.
 */
export function fetchHandler(omniconva: OmniConva): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
    const result = await omniconva.handleCall({
      method: request.method,
      pathAndQuery: url.pathname + url.search,
      body,
      header: (name) => request.headers.get(name),
    });
    return result
      ? toResponse(result)
      : new Response(JSON.stringify({ message: 'Not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
  };
}
