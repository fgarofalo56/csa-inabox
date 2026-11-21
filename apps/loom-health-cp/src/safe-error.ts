/**
 * Exception -> PUBLIC message sanitizer for the loom-health-cp HTTP surface.
 *
 * Mirrors apps/copilot-maf/src/safe-error.ts (copied, not imported: separate
 * package). Contract:
 *   - The catch site supplies the public message as a LITERAL.
 *   - The caught value NEVER contributes to the returned string; the full
 *     detail is logged server-side against a short correlation ref which IS
 *     returned, so an operator can join the client message to the log line.
 *   - `authoredMessage` is the single, typed escape hatch for errors this
 *     service authors itself (HttpError, JobFailure, ConfigError). Callers
 *     must only reach it inside an `instanceof` branch for those classes.
 */
import { randomUUID } from 'node:crypto';

const MAX_LOG_DETAIL = 2000;
// Escapes, never literal control characters (they are invisible in diffs).
const LINE_BREAKS = /[\r\n]+/g;
const OTHER_CONTROLS = /[\u0000-\u001F\u007F]+/g;

/** Strip log-forging control characters and bound the length. Does not redact. */
export function logSafe(value: unknown, max = MAX_LOG_DETAIL): string {
  if (value === null || value === undefined) return '';
  const raw = typeof value === 'string' ? value : String(value);
  const flat = raw.replace(LINE_BREAKS, ' ').replace(OTHER_CONTROLS, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

/** Log `err` in full server-side; return `${publicMessage} (ref: <8 hex>)`. */
export function publicErrorMessage(err: unknown, publicMessage = 'internal error'): string {
  const ref = randomUUID().slice(0, 8);
  const detail = err instanceof Error ? err.stack || err.message : String(err);
  console.error(`[loom-health-cp] internal error [ref=${ref}]:`, logSafe(detail));
  return `${publicMessage} (ref: ${ref})`;
}

/** Message of an error this service authored (operator-safe by construction). */
export function authoredMessage(err: Error): string {
  return err.message;
}

const JWT_SHAPE = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const BEARER_SHAPE = /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

export interface ClassifiedError {
  name: string;
  /** Sanitised message: JWT/Bearer-shaped strings masked, control chars flattened, capped at 200. */
  message: string;
  /** Azure SDK / HTTP status carried by the error (RestError.statusCode), when an integer. */
  statusCode?: number;
  /** Azure SDK error code (RestError.code / Node errno string), when a short token. */
  code?: string;
}

/**
 * Operator-diagnostic classification of a caught value for a SERVER-SIDE LOG line (never for a
 * response body). This is the sanitizer-module home for reading `err.message`, so the rest of
 * the service stays free of raw exception text (bff-errors RULE 3).
 */
export function classifyError(err: unknown): ClassifiedError {
  if (!(err instanceof Error)) return { name: 'unknown', message: '' };
  const raw = err as Error & { statusCode?: unknown; code?: unknown };
  const message = logSafe(String(err.message).replace(JWT_SHAPE, '<jwt>').replace(BEARER_SHAPE, 'Bearer <redacted>'), 200);
  return {
    name: logSafe(err.name, 60),
    message,
    ...(typeof raw.statusCode === 'number' && Number.isInteger(raw.statusCode) ? { statusCode: raw.statusCode } : {}),
    ...(typeof raw.code === 'string' && /^[A-Za-z0-9_.-]{1,60}$/.test(raw.code) ? { code: raw.code } : {}),
  };
}
