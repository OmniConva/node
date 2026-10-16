import type { IncomingMessage, ServerResponse } from 'node:http';
import type { OmniConva, OutgoingResponse } from '../client';

/** Reads the raw body of a Node request (once). */
export function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

export function writeResponse(response: ServerResponse, result: OutgoingResponse): void {
  response.writeHead(result.status, result.headers);
  response.end(result.body);
}

function headerOf(request: IncomingMessage) {
  return (name: string) => {
    const value = request.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  };
}

/**
 * Handles OmniConva's requests on a plain `node:http` server. Resolves
 * true when it answered, false when the path isn't under the prefix, so
 * you can route the rest yourself.
 */
export function nodeHandler(omniconva: OmniConva) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const pathAndQuery = request.url ?? '/';
    if (!pathAndQuery.startsWith(omniconva.prefix)) return false;
    const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await readBody(request);
    const result = await omniconva.handleCall({
      method: request.method ?? 'GET',
      pathAndQuery,
      body,
      header: headerOf(request),
    });
    if (!result) return false;
    writeResponse(response, result);
    return true;
  };
}

type ExpressLikeRequest = IncomingMessage & {
  originalUrl?: string;
  body?: unknown;
  rawBody?: Buffer | string;
};

/**
 * Express (and Express-based: NestJS, etc.) middleware. Mount it before
 * any body parser, or keep the raw body as `req.rawBody`: the signature
 * covers the exact bytes OmniConva sent.
 *
 *   app.use(omniconva.express());
 */
export function expressMiddleware(omniconva: OmniConva) {
  return async (
    request: ExpressLikeRequest,
    response: ServerResponse,
    next: (error?: unknown) => void,
  ): Promise<void> => {
    try {
      const pathAndQuery = request.originalUrl ?? request.url ?? '/';
      const [pathname = ''] = pathAndQuery.split('?', 1);
      if (pathname !== omniconva.prefix && !pathname.startsWith(omniconva.prefix + '/')) {
        next();
        return;
      }
      let body = '';
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        if (request.rawBody !== undefined) {
          body = request.rawBody.toString();
        } else if (request.readableEnded || (request.body !== undefined && typeof request.body === 'object')) {
          // A body parser already read the stream: the exact bytes are gone.
          writeResponse(response, {
            status: 500,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              message:
                'The OmniConva middleware must run before express.json() (or keep req.rawBody), to verify the signature.',
            }),
          });
          return;
        } else {
          body = await readBody(request);
        }
      }
      const result = await omniconva.handleCall({
        method: request.method ?? 'GET',
        pathAndQuery,
        body,
        header: headerOf(request),
      });
      if (!result) {
        next();
        return;
      }
      writeResponse(response, result);
    } catch (error) {
      next(error);
    }
  };
}
