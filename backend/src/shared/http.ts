/**
 * Small HTTP helpers shared by every function: consistent JSON responses,
 * a typed error you can `throw` from anywhere, and a body parser.
 */
import { HttpHandler, HttpRequest, HttpResponseInit } from '@azure/functions';

/** Standard JSON success/response. */
export function json(status: number, body: unknown): HttpResponseInit {
  return { status, jsonBody: body };
}

/** A consistent error envelope: { error: { message, code? } }. */
export function error(status: number, message: string, code?: string): HttpResponseInit {
  return { status, jsonBody: { error: { message, ...(code ? { code } : {}) } } };
}

/**
 * Throwable application error. Functions catch it (via `handle`) and turn it
 * into a clean HTTP response instead of a 500.
 */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

/** Parse and return a JSON request body, or throw a 400 on malformed input. */
export async function readJson<T = Record<string, unknown>>(request: HttpRequest): Promise<T> {
  try {
    const text = await request.text();
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }
}

/**
 * Wrap a handler so any thrown `HttpError` becomes its intended response and
 * any other error becomes a generic 500 (without leaking internals).
 */
export function handle(fn: HttpHandler): HttpHandler {
  return async (request, context) => {
    try {
      return await fn(request, context);
    } catch (err) {
      if (err instanceof HttpError) {
        return error(err.status, err.message, err.code);
      }
      // eslint-disable-next-line no-console
      console.error('Unhandled error:', err);
      return error(500, 'Internal server error');
    }
  };
}

/** Best-effort client IP for audit records. */
export function clientIp(request: HttpRequest): string | null {
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return request.headers.get('x-client-ip') ?? null;
}
