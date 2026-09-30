/** Shared error types + type guards for the CLI. */
import { LoomApiError } from './client.js';

/** A user-facing CLI error (bad usage, missing config). Printed without a stack. */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

export function LoomApiErrorGuard(e: unknown): e is LoomApiError {
  return e instanceof LoomApiError;
}

/**
 * The lines the CLI prints for an API error: the status, code and message; the
 * wait before retrying when the server sent one; and the route's `hint`.
 */
export function formatApiError(e: LoomApiError): string {
  const lines = [`API error (${e.status}${e.code ? ` ${e.code}` : ''}): ${e.message}`];
  if (e.retryAfter) lines.push(`Try again in ${e.retryAfter} second${e.retryAfter === 1 ? '' : 's'}.`);
  if (e.hint) lines.push(`Hint: ${e.hint}`);
  return lines.join('\n') + '\n';
}

export { LoomApiError };
