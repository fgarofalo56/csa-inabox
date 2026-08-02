/**
 * Exception → PUBLIC message sanitizer for the MCP bridge's HTTP/SSE surface.
 *
 * WHY THIS EXISTS (CodeQL js/stack-trace-exposure #505):
 *   Every handler in server.mjs used to answer a failure with
 *   `String(e?.message || e)`. The exceptions reaching those handlers are not
 *   ours to publish: they come from `StdioMcpClient`, i.e. from `npx`/`uvx`
 *   child processes we spawn inside the container. Their text carries container
 *   filesystem paths, argv, package versions, and whatever the upstream MCP
 *   server chose to print — and on a Node spawn failure, a full stack.
 *
 * THE CONTRACT (mirrors apps/fiab-console/lib/api/respond.ts `apiServerError`,
 * the console's sanctioned helper, which this bridge could not import because
 * it is a separate package with no path alias into the Next app):
 *   - The caller supplies the public message as a LITERAL at the catch site —
 *     the site that knows what was being attempted. That literal is what the
 *     client sees.
 *   - The caught value NEVER contributes to the returned string. Not its
 *     `.message`, not its `.stack`, not `String(e)`. There is deliberately no
 *     "pass this one through" branch: a passthrough branch is exactly how a
 *     sanitizer stops sanitizing, and it would keep the taint path alive.
 *   - The full detail is logged server-side against a short correlation ref
 *     which IS returned, so an operator can join the client-visible message to
 *     the container log line.
 *
 * Honest gates (no-vaporware.md) are preserved by passing the gate text as the
 * `publicMessage` literal — see the call sites in server.mjs.
 */
import { randomUUID } from 'node:crypto';

const LOG_PREFIX = '[mcp-bridge]';

/**
 * Log `err` in full server-side and return a client-safe message.
 *
 * @param {unknown} err            the caught value — never read into the result
 * @param {string}  publicMessage  literal, site-specific text the client sees
 * @returns {string} `${publicMessage} (ref: <8 hex>)`
 */
export function publicErrorMessage(err, publicMessage = 'internal error') {
  const ref = randomUUID().slice(0, 8);
  const detail = err instanceof Error ? err.stack || err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(`${LOG_PREFIX} internal error [ref=${ref}]:`, detail);
  return `${publicMessage} (ref: ${ref})`;
}

/**
 * JSON-RPC error object for a failed bridged call. `code` stays the fixed
 * -32000 (server error) it has always been — only the message is sanitized.
 *
 * @param {unknown} err
 * @param {string}  publicMessage
 */
export function publicRpcError(err, publicMessage = 'MCP server call failed') {
  return { code: -32000, message: publicErrorMessage(err, publicMessage) };
}
