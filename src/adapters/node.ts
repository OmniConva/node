import type { IncomingMessage, ServerResponse } from 'node:http';
import { BodyTooLargeError, type OmniConva, type OutgoingResponse } from '../client';

/** The client went away before the body arrived; there is nothing to answer. */
export class RequestAbortedError extends Error {
  constructor() {
    super('The request was aborted before its body arrived');
    this.name = 'RequestAbortedError';
  }
}

/**
 * Reads the raw body of a Node request (once), giving up as soon as it
 * passes `maxBytes` so an oversized post is dropped instead of buffered. A
 * client that disconnects mid-body rejects with RequestAbortedError rather
 * than hanging or surfacing a socket error.
 */
export function readBody(request: IncomingMessage, maxBytes = Infinity): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      fn();
    };
    request.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) {
        // Stop reading; the caller answers 413 and then closes the socket.
        request.pause();
        request.removeAllListeners('data');
        finish(() => reject(new BodyTooLargeError(maxBytes)));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => finish(() => resolve(Buffer.concat(chunks).toString('utf8'))));
    request.on('error', () => finish(() => reject(new RequestAbortedError())));
    request.on('aborted', () => finish(() => reject(new RequestAbortedError())));
    request.on('close', () => finish(() => reject(new RequestAbortedError())));
  });
}

// Answers an over-long body: the 413 goes out with `connection: close`, then
// the socket is dropped so the rest of the upload is never read.
function refuseBody(request: IncomingMessage, response: ServerResponse, error: BodyTooLargeError): void {
  const result = error.response();
  response.writeHead(result.status, { ...result.headers, connection: 'close' });
  response.end(result.body, () => request.destroy());
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
    const method = request.method ?? 'GET';
    const header = headerOf(request);
    // Nothing is read off the socket until the path is ours and the request
    // carries a signature worth checking.
    const early = omniconva.preflight({ method, pathAndQuery, header });
    if (early === null) return false;
    if (early) {
      writeResponse(response, early);
      return true;
    }
    let body = '';
    if (method !== 'GET' && method !== 'HEAD') {
      try {
        body = await readBody(request, omniconva.maxBodyBytes);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          refuseBody(request, response, error);
          return true;
        }
        // The client is gone (or the socket failed): nothing to send, and
        // nothing for the server's own handler to do either.
        response.destroy();
        return true;
      }
    }
    const result = await omniconva.handleCall({ method, pathAndQuery, body, header });
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
      const method = request.method ?? 'GET';
      const header = headerOf(request);
      const early = omniconva.preflight({ method, pathAndQuery, header });
      if (early === null) {
        next();
        return;
      }
      if (early) {
        writeResponse(response, early);
        return;
      }
      let body = '';
      if (method !== 'GET' && method !== 'HEAD') {
        if (request.rawBody !== undefined) {
          body = request.rawBody.toString();
          if (Buffer.byteLength(body) > omniconva.maxBodyBytes) {
            refuseBody(request, response, new BodyTooLargeError(omniconva.maxBodyBytes));
            return;
          }
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
          try {
            body = await readBody(request, omniconva.maxBodyBytes);
          } catch (error) {
            if (error instanceof BodyTooLargeError) {
              refuseBody(request, response, error);
              return;
            }
            if (error instanceof RequestAbortedError) {
              response.destroy();
              return;
            }
            throw error;
          }
        }
      }
      const result = await omniconva.handleCall({ method, pathAndQuery, body, header });
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
