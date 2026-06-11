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

export { LoomApiError };
