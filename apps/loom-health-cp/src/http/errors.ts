// Errors that map to a client-visible status. Anything that is NOT an HttpError
// is treated as an internal fault and rendered as a generic 500: messages from
// the SDKs may carry endpoints or ids and must never reach the caller.

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string): HttpError => new HttpError(400, 'bad_request', message);
export const unauthorized = (): HttpError => new HttpError(401, 'unauthorized', 'authentication required');
export const forbidden = (): HttpError => new HttpError(403, 'forbidden', 'caller is not permitted');
export const notFound = (what: string): HttpError => new HttpError(404, 'not_found', `${what} not found`);
export const conflict = (message: string): HttpError => new HttpError(409, 'conflict', message);

/** Thrown by a DocumentStore when create() hits an existing id or replace() loses an etag race. */
export class StoreConflictError extends Error {}
