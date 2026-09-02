/**
 * A STRUCTURED record of an upstream ARM failure that a client CAUGHT and
 * degraded into a normal-looking result instead of propagating.
 *
 * Why this module exists
 * ----------------------
 * Several Loom clients deliberately do not let one resource's failure fail the
 * whole read: `monitor-client._getDiagnosticsCoverage` probes N resources in
 * parallel and, when a probe fails for a non-"unsupported" reason, keeps the row
 * and records `note: (e as Error).message`. That is the right product behaviour
 * — one throttled probe must not blank the whole Monitor surface.
 *
 * But it DESTROYED the evidence. `monitor-arm.ts`'s throw sites build their
 * message as `json?.error?.message || text || 'ARM GET failed (<status>)'`, so
 * for a real ARM 429 the note is ONLY ARM's prose sentence:
 *
 *     Number of 'read' requests for subscription '…' actor '…' exceeded.
 *     Please try again after '10' seconds.
 *
 * The HTTP status (429) and ARM's own verdict (`json.error.code` =
 * `SubscriptionRequestsThrottled`) never reach the caller. Anything downstream
 * that needs to know "was this a throttle?" is left grepping prose — which is
 * the recorded `a bare substring signal misclassifies and blocks` defect class,
 * and which measurably did NOT match on the shape production emits (PR #4271
 * review, findings 1 and 2).
 *
 * So a degrading client attaches this marker alongside its human-readable note.
 * The fields are OBSERVATIONS — the status ARM returned, the code ARM sent, the
 * Retry-After ARM asked for. A consumer reads a field instead of a sentence.
 *
 * Design constraints this file is written to:
 *
 *  - **Zero imports.** `lib/perf/read-warmer.ts` must be able to read the marker
 *    without importing `monitor-arm.ts`, which builds an `@azure/identity`
 *    credential chain at MODULE scope. The warmer avoids that edge on purpose.
 *  - **Structural, never `instanceof`.** The marker is read off plain JSON that
 *    has crossed a cache, a route boundary, or a `structuredClone`, where the
 *    prototype is long gone.
 *  - **It records only what was established.** No field is inferred. `code` and
 *    `retryAfterSeconds` are absent when ARM did not send them — never guessed,
 *    never defaulted, so a consumer can say truthfully whether ARM asked for a
 *    specific delay (deploy-integrity.md R7).
 *
 * This marker does NOT mean "this row is broken" — a degrading client may
 * attach it to a row that is otherwise perfectly usable. It means "the value
 * next to me is degraded, and here is exactly what upstream said".
 */

/**
 * The key a degrading client attaches the marker under.
 *
 * Double-underscore prefixed so it cannot collide with an Azure payload field,
 * and a literal type so it can be used as a computed property in an interface.
 */
export const SWALLOWED_ARM_ERROR = '__loomArmError' as const;

export interface SwallowedArmError {
  /** The HTTP status ARM returned. Established at the transport, never inferred. */
  status: number;
  /**
   * ARM's own error code, verbatim from `json.error.code`
   * (e.g. `SubscriptionRequestsThrottled`). Absent when ARM sent no code —
   * a 429 with an empty body is real and carries only `status`.
   */
  code?: string;
  /**
   * The `Retry-After` ARM sent, in seconds. Absent when ARM sent no header, so
   * a consumer can distinguish "ARM asked for 10s" from "ARM said nothing and
   * we are applying our own floor" without asserting the latter as ARM's word.
   */
  retryAfterSeconds?: number;
  /** ARM's message, for humans. The fields above are the signal; this is not. */
  message: string;
}

/** A payload row that may carry the marker. */
export type WithSwallowedArmError<T> = T & { [SWALLOWED_ARM_ERROR]?: SwallowedArmError };

function readNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * Numbers ONLY — no string coercion.
 *
 * `readNumber` is deliberately lenient because `describeArmError` reads a
 * FOREIGN caught error, where `status` legitimately arrives as a string from
 * some clients and `Retry-After` is a string header by definition. Reading the
 * marker back is the opposite situation: we wrote it, we wrote numbers, and a
 * JSON round-trip preserves them. Coercing there would let a node that merely
 * looks marker-shaped be read as an observation — which is exactly the property
 * this marker exists to guarantee it is not.
 */
function readStrictNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function readString(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/**
 * Build the marker from a caught error, structurally.
 *
 * Accepts anything `MonitorError`-shaped (`status` plus optionally `code` /
 * `retryAfterSeconds`) — it does not require the class, so an error that has
 * crossed a boundary, or one of the sibling ARM clients' equivalents, works too.
 *
 * Returns `null` when the error carries no usable HTTP status. That is
 * deliberate: a marker with a fabricated status would be worse than no marker,
 * because a consumer would treat it as an observation.
 */
export function describeArmError(e: unknown): SwallowedArmError | null {
  if (e === null || typeof e !== 'object') return null;
  const o = e as Record<string, unknown>;
  const status =
    readNumber(o['status'])
    ?? readNumber(o['statusCode'])
    ?? readNumber((o['response'] as Record<string, unknown> | undefined)?.['status']);
  if (status === undefined || status <= 0) return null;

  // The code ARM sent. `monitor-arm` now carries it as a field; fall back to the
  // raw body it also carries, for errors built before that field existed.
  const body = o['body'] as Record<string, unknown> | undefined;
  const bodyError = body && typeof body === 'object'
    ? (body['error'] as Record<string, unknown> | undefined)
    : undefined;
  const code = readString(o['code']) ?? (bodyError ? readString(bodyError['code']) : undefined);

  const retryAfterSeconds = readNumber(o['retryAfterSeconds']);

  return {
    status,
    ...(code ? { code } : {}),
    ...(retryAfterSeconds !== undefined && retryAfterSeconds >= 0 ? { retryAfterSeconds } : {}),
    message: readString(o['message']) ?? String(e),
  };
}

/**
 * Read the marker off an arbitrary payload node.
 *
 * Structural and defensive: a node that carries the key but not a well-formed
 * marker (a string, a number, an object whose `status` is not a positive
 * number) returns `null` rather than a half-populated observation.
 */
export function readSwallowedArmError(node: unknown): SwallowedArmError | null {
  if (node === null || typeof node !== 'object') return null;
  const marked = (node as Record<string, unknown>)[SWALLOWED_ARM_ERROR];
  if (marked === null || typeof marked !== 'object') return null;
  const m = marked as Record<string, unknown>;
  const status = readStrictNumber(m['status']);
  if (status === undefined || status <= 0) return null;
  const code = readString(m['code']);
  const retryAfterSeconds = readStrictNumber(m['retryAfterSeconds']);
  return {
    status,
    ...(code ? { code } : {}),
    ...(retryAfterSeconds !== undefined && retryAfterSeconds >= 0 ? { retryAfterSeconds } : {}),
    message: readString(m['message']) ?? '',
  };
}
