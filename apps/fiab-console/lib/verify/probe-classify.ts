/**
 * The probe-response classifier used by `admin-verify.spec.ts`.
 *
 * Extracted from the spec (F1) so it can be unit-tested WITHOUT a live console.
 * It could not be before, and that is precisely why its defect survived: the
 * only way to exercise it was a full in-VNet Playwright run against the estate,
 * where a misclassification looked like a genuine endpoint failure rather than a
 * classifier bug.
 *
 * The distinction it draws is load-bearing for the whole verification program:
 *
 *   pass — 2xx.
 *   gate — 404/503 carrying a STRUCTURED honest-gate envelope. `no-vaporware.md`
 *          explicitly allows this state: infrastructure that is not deployed,
 *          reported with the exact env var / role / resource to provision. It is
 *          a documented configuration state, not a defect, and must not fail a
 *          smoke run.
 *   fail — anything else, INCLUDING a 503 that is not structured JSON. An
 *          upstream HTML error page is a real outage and must stay red.
 */

/** One probe verdict. */
export type ProbeResult =
  | { kind: 'pass'; status: number }
  | { kind: 'gate'; status: number; body: string }
  | { kind: 'fail'; status: number; body: string };

/** How much of a body is carried into the log line. Display only — never parsed. */
export const BODY_DISPLAY_LIMIT = 400;

/**
 * Classify one probe response.
 *
 * `readBody` is injected rather than taking an `APIResponse` so this is testable
 * with the real bodies the live console returns.
 *
 * THE BUG THIS SIGNATURE PREVENTS: the parsed text and the displayed text used
 * to be the same truncated string. `JSON.parse(body.slice(0, 400))` throws on
 * every gate whose envelope is larger than the display limit — so the endpoints
 * with the MOST actionable remediation were the ones reported as hard failures.
 * Live, that meant `/api/admin/security/mip/labels` (a ~1.2 kB gate naming
 * LOOM_MIP_ENABLED, its bicep module, two Graph AppRoles and the consent step)
 * failed the `verify` project on every single run — which failed the job, which
 * SKIPPED every later step, which made browser receipts unobtainable for the
 * whole program. Here the full text is parsed and only the copy kept for logging
 * is cut.
 */
export async function classifyProbeResponse(
  status: number,
  readBody: () => Promise<string>,
): Promise<ProbeResult> {
  if (status >= 200 && status < 300) return { kind: 'pass', status };

  let raw = '';
  try { raw = await readBody(); } catch { /* body unreadable — falls through to fail */ }
  const body = raw.slice(0, BODY_DISPLAY_LIMIT);

  if (status === 404 || status === 503) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (
        parsed.ok === false ||
        parsed.gate === true ||
        typeof parsed.message === 'string' ||
        typeof parsed.error === 'string'
      ) {
        return { kind: 'gate', status, body };
      }
    } catch { /* not JSON — a real outage, not a gate */ }
  }

  return { kind: 'fail', status, body };
}
