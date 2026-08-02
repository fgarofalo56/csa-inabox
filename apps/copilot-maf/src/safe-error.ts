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
 *     client sees, so an honest infra gate ("set LOOM_AOAI_ENDPOINT …") is
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
  console.error(`${LOG_PREFIX} internal error [ref=${ref}]:`, detail);
  return `${publicMessage} (ref: ${ref})`;
}
