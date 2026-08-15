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
 * The log-forging vector, spelled out: a CR or LF inside a request-derived
 * value starts what looks like a new, attacker-authored record.
 *
 * Kept as its own literal rather than folded into the C0 range below, because
 * naming the vector is clearer than burying it in a range.
 *
 * IT IS NOT WHAT CLOSES THE ALERT, and the note that used to sit here said it
 * was. That note claimed CodeQL "does not resolve backslash-u escapes inside a
 * character RANGE" — true of OTHER_CONTROLS, irrelevant here (`[\r\n]` carries
 * no \u escape and no range) — and it is why js/log-injection #762 was raised
 * against this file on 2026-08-04, two days AFTER #2849 believed it had fixed
 * it. The real rule, read off LogInjectionQuery.qll rather than inferred:
 *
 *     class StringReplaceSanitizer extends Sanitizer {
 *       StringReplaceSanitizer() {
 *         exists(string s | this.(StringReplaceCall).replaces(s, "") and
 *                           s.regexpMatch("\\n"))
 *       }
 *     }
 *
 * The replaced string must be exactly "\n" AND the replacement must be the
 * EMPTY string. This line replaces with a SPACE, so it satisfies neither half
 * and the whole helper stays invisible to the scanner. See the `.replaceAll` in
 * logSafe() below for the construct that IS modelled — the same one
 * apps/fiab-console/lib/util/log-safe.ts carries, and which this file copied the
 * SEMANTICS of without copying the SHAPE.
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

/** Max characters kept from the logged detail (a stack, so larger than a field). */
const MAX_LOG_DETAIL = 2000;

/**
 * Log-injection defence — a local mirror of apps/fiab-console/lib/util/log-safe.ts
 * (`logSafe`), which this package cannot import.
 *
 * WHY IT IS NEEDED HERE SPECIFICALLY: concentrating the logging inside this
 * module also concentrated the SINK. CodeQL js/log-injection traced a path from
 * `readBody(req)` → `parsed` → `client.rpc(parsed)` → `message.method` →
 * `new Error(\`timeout after ...ms calling ${method}\`)` → here. A caller who
 * names their JSON-RPC method with an embedded CR/LF forges log records.
 *
 * Strips the C0 controls that break line framing and bounds the length. It does
 * NOT redact — an opaque log is a dishonest log (no-vaporware.md), and this
 * detail is the only remaining record of the failure. It removes the ability to
 * fabricate structure, nothing else.
 */
export function logSafe(value, max = MAX_LOG_DETAIL) {
  if (value === null || value === undefined) return '';
  const raw = typeof value === 'string' ? value : String(value);
  const flat = raw
    // 1) READABILITY. Collapse each run of framing/control characters to ONE
    //    space, so "a\n\n\nb" reads "a b" and two tokens never silently fuse.
    .replace(LINE_BREAKS, ' ')
    .replace(OTHER_CONTROLS, ' ')
    // 2) FRAMING, belt-and-braces — and the ONLY construct CodeQL models
    //    (StringReplaceSanitizer: replaced string exactly "\n", replacement the
    //    EMPTY string). After (1) there is no LF left, so at runtime this is a
    //    no-op — and that is precisely the point: it still holds if (1) is ever
    //    edited, reformatted, or narrowed. Do NOT delete it as dead code:
    //    without it the scanner sees NO sanitizer and every console.* call site
    //    in this package is re-flagged, which is exactly what #762 was.
    //    apps/fiab-mcp-bridge/tests/safe-error.test.mjs fails if it goes away.
    .replaceAll('\n', '')
    .trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

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
  console.error(`${LOG_PREFIX} internal error [ref=${ref}]:`, logSafe(detail));
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
