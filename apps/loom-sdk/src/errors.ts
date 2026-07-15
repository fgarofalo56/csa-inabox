/**
 * Error type surfaced by every SDK call. Carries the HTTP status plus the
 * Loom envelope's stable `code` and optional remediation `hint` (honest infra
 * gates return a `hint` on 503), so callers can branch on `err.code` /
 * `err.status` rather than string-matching messages.
 */
export class LoomApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = 'LoomApiError';
  }
}

/** Type guard for {@link LoomApiError}. */
export function isLoomApiError(e: unknown): e is LoomApiError {
  return e instanceof LoomApiError;
}
