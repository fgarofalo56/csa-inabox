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
 * Built with new RegExp from an ASCII-only string ON PURPOSE. The console
 * original (lib/util/log-safe.ts) writes this class with LITERAL control
 * characters in the source, which are invisible in every editor and diff --
 * one careless copy/paste and the class silently becomes something else while
 * the code still compiles and the sanitizer still returns a string. This form
 * cannot be mangled unseen.
 */
const CONTROL_CHARS = new RegExp('[\u0000-\u001F\u007F]+', 'g');

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
  const flat = raw.replace(CONTROL_CHARS, ' ').trim();
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
