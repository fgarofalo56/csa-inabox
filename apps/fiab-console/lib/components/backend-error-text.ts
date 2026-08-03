/**
 * Presentation-side cleanup for backend error strings (#2895).
 *
 * WHY THIS EXISTS
 * ---------------
 * Azure clients in `lib/azure/*` deliberately throw with the VERBATIM response
 * body so the server log carries the full ARM receipt, e.g.
 *
 *   getPipeline(ingest_orders) failed 404: {"code":"NotFound","message":"The
 *   pipeline 'ingest_orders' does not exist.","target":"/subscriptions/<guid>/
 *   resourceGroups/<rg>/providers/Microsoft.DataFactory/factories/<factory>/
 *   pipelines/ingest_orders"}
 *
 * That is right for a log and wrong for a UI. Editors piped it straight into a
 * red MessageBar, so the operator saw a stringified response body — which
 * `no-vaporware.md` forbids ("a genuine failure must be a styled MessageBar
 * naming the exact remediation, not a stringified response body") — and which
 * additionally puts subscription / resource-group / resource names on screen.
 *
 * `humanizeBackendError` runs at the render boundary (inside BackendStateBar),
 * so EVERY editor that reports a backend error gets the same treatment and no
 * caller has to remember to opt in.
 *
 * It does NOT suppress errors. A genuine failure still surfaces, with its real
 * code and message — only the machine framing and the ARM path are dropped.
 */

/** A full ARM resource id, or the tail of one, wherever it appears in text. */
const ARM_ID_RE = /\/subscriptions\/[^\s"'`,;)\]}]*/gi;

/** Longest prefix we keep from a "<label> failed <status>: <body>" wrapper. */
const MAX_LEN = 400;

/** Pull `message` / `error.message` (and the code) out of an ARM-shaped body. */
function fromJsonBody(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const o = body as Record<string, any>;
  const inner = (o.error && typeof o.error === 'object') ? o.error : o;
  const message = typeof inner.message === 'string' ? inner.message.trim() : '';
  const code = typeof inner.code === 'string' ? inner.code.trim() : '';
  if (message && code) return `${message} (${code})`;
  if (message) return message;
  if (code) return code;
  return null;
}

/**
 * Replace ARM resource ids with a neutral placeholder. Keeps the sentence
 * readable — the operator does not need the estate path to act on the error,
 * and the console is screenshotted into public issues.
 */
export function stripArmResourceIds(text: string): string {
  return text.replace(ARM_ID_RE, '<resource>');
}

/**
 * Turn a raw backend error string into something worth showing a human.
 *
 * - `"getPipeline(x) failed 404: {json}"` → the JSON body's `message` (+ code).
 * - A bare JSON body                      → its `message` (+ code).
 * - Anything else                         → passed through unchanged.
 *
 * In every branch ARM resource ids are stripped and the result is capped.
 */
export function humanizeBackendError(raw: string | null | undefined): string {
  if (!raw) return '';
  const text = String(raw).trim();

  // Find the first plausible JSON object and try to parse from there. The
  // wrapper prefix ("getPipeline(x) failed 404: ") is machine framing; the body
  // holds the sentence a human can act on.
  const brace = text.indexOf('{');
  if (brace >= 0) {
    const candidate = text.slice(brace);
    let parsed: unknown = null;
    try { parsed = JSON.parse(candidate); } catch { parsed = null; }
    const humanized = fromJsonBody(parsed);
    if (humanized) return stripArmResourceIds(humanized).slice(0, MAX_LEN);
    // Unparseable body (truncated ARM response, HTML snippet, …): keep the
    // human-written prefix and drop the blob rather than printing it raw.
    const prefix = text.slice(0, brace).replace(/[:\s]+$/, '').trim();
    if (prefix) return stripArmResourceIds(prefix).slice(0, MAX_LEN);
  }

  return stripArmResourceIds(text).slice(0, MAX_LEN);
}
