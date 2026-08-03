/**
 * Exception → PUBLIC message sanitizer for the copilot-maf HTTP surface.
 *
 * WHY THIS EXISTS (CodeQL js/stack-trace-exposure #591):
 *   `handleOrchestrate` / `handleAgentRun` and the agent loop answered every
 *   failure with `e?.message || String(e)`. The exceptions reaching them are
 *   AOAI HTTP failures — `AOAI chat-completions failed ${status}: ${body}`,
 *   carrying up to 400 chars of the upstream response (Entra error codes,
 *   correlation ids, resource names) — and `@azure/identity` credential
 *   failures, whose text names the IMDS endpoint and client id and whose
 *   `.stack` was one `String(e)` away.
 *
 * THE CONTRACT (mirrors apps/fiab-console/lib/api/respond.ts `apiServerError`;
 * copied rather than imported because copilot-maf is a separate package with
 * no path alias into the Next app, and respond.ts imports `next/server`):
 *   - The caller supplies the public message as a LITERAL at the catch site —
 *     the site that knows what was being attempted. That literal is what the
 *     client sees, so an honest infra gate ("set LOOM_AOAI_ENDPOINT ...") is
 *     preserved verbatim per no-vaporware.md.
 *   - The caught value NEVER contributes to the returned string. Not its
 *     `.message`, not its `.stack`, not `String(e)`. There is deliberately no
 *     "pass this one through" branch: that is how a sanitizer stops
 *     sanitizing, and it would keep the taint path alive.
 *   - Full detail is logged server-side against a short correlation ref which
 *     IS returned, so an operator can join the client-visible message to the
 *     container log line.
 */
import { randomUUID } from 'node:crypto';

const LOG_PREFIX = '[copilot-maf]';

/** Max characters kept from the logged detail (a stack, so larger than a field). */
const MAX_LOG_DETAIL = 2000;

/**
 * C0 control characters (CR, LF, TAB, NUL ...) plus DEL.
 *
 * Written as a regex LITERAL with backslash-u escapes, never with literal
 * control characters. A literal is what CodeQL js/log-injection can read as a
 * sanitizer (a RegExp built from a string is opaque to it, and the alert
 * survived a sanitizer that demonstrably worked). The escapes matter too: the
 * console original uses LITERAL control characters, which are invisible in
 * every editor and diff -- they were silently mangled twice while being copied
 * here, and the mangled form still compiles and still returns a string.
 */
/**
 * The log-forging vector, spelled out: a CR or LF inside a request-derived
 * value starts what looks like a new, attacker-authored record.
 *
 * Kept as its own literal rather than folded into the C0 range below. The
 * range DOES cover CR and LF, but CodeQL js/log-injection could not see that:
 * it does not resolve backslash-u escapes inside a character RANGE, so the
 * alert survived a sanitizer that demonstrably strips (mutation-proved: neuter
 * it and four tests go red). Naming the vector explicitly is both the clearer
 * source and the form the analyser reads.
 */
const LINE_BREAKS = /[\r\n]+/g;

/**
 * Defence in depth: the remaining C0 controls plus DEL. Written with
 * backslash-u ESCAPES, never literal control characters -- the console
 * original (lib/util/log-safe.ts) uses literals, which are invisible in every
 * editor and diff, and they were silently mangled twice while being copied
 * here. The mangled form still compiles and still returns a string.
 */
const OTHER_CONTROLS = /[\u0000-\u001F\u007F]+/g;

/**
 * Log-injection defence -- a local mirror of apps/fiab-console/lib/util/log-safe.ts
 * (logSafe), which this package cannot import.
 *
 * Concentrating the logging inside this module also concentrates the SINK:
 * request-derived text reaches console.error here, and a CR/LF inside it forges
 * log records. Strips the C0 controls that break line framing and bounds the
 * length. It does NOT redact -- an opaque log is a dishonest log
 * (no-vaporware.md), and this detail is the only remaining record of the
 * failure. It removes the ability to fabricate structure, nothing else.
 */
export function logSafe(value: unknown, max = MAX_LOG_DETAIL): string {
  if (value === null || value === undefined) return '';
  const raw = typeof value === 'string' ? value : String(value);
  const flat = raw.replace(LINE_BREAKS, ' ').replace(OTHER_CONTROLS, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}


/**
 * Log `err` in full server-side and return a client-safe message.
 *
 * @param err           the caught value — never read into the result
 * @param publicMessage literal, site-specific text the client sees
 * @returns `${publicMessage} (ref: <8 hex>)`
 */
export function publicErrorMessage(err: unknown, publicMessage = 'internal error'): string {
  const ref = randomUUID().slice(0, 8);
  const detail = err instanceof Error ? err.stack || err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(`${LOG_PREFIX} internal error [ref=${ref}]:`, logSafe(detail));
  return `${publicMessage} (ref: ${ref})`;
}
