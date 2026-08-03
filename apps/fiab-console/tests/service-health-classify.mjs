/**
 * service-health-classify — how one probe response is scored (refs #2860).
 *
 * Split out of tests/service-health.mjs so the classification can be unit-
 * tested: the probe's module body mints a session cookie and `process.exit(2)`s
 * without SESSION_SECRET, so importing IT is not an option.
 *
 * WHY IT CHANGED
 * --------------
 * The original scored ANY 2xx as PASS:
 *
 *     if (status >= 200 && status < 300) {
 *       const hint = json?.ok === false ? `ok:false (…)` : …;
 *       result = hint; kind = 'PASS'; SUMMARY.pass++;
 *     }
 *
 * It even formatted the failure — "ok:false (<the error>)" — into the result
 * column and then counted it as a pass. Every Loom BFF route returns the
 * `{ ok, data, error }` envelope, and `ok:false` is that envelope saying the
 * operation failed; several routes return it on a 200. So a live console whose
 * backends were erroring could report `0 fail` and the workflow would go green.
 * Same defect class as the log-scraping verdict this was found alongside: the
 * control ran, and what it measured was not what it claimed to measure.
 *
 * NOT-CONFIGURED STAYS A NOTE. An honest infra gate is a 503 by convention
 * (no-vaporware.md), and 404 counts too for probes marked `optional`. Those are
 * unchanged — they are the tolerance the workflow was built around. A route
 * that answers 200 + ok:false for a gate is mis-signalling and should be fixed
 * to return 503; surfacing that is the correct outcome, not a false alarm.
 */

/**
 * @param {{status:number, json:any, text:string, optional?:boolean}} r
 * @returns {{kind:'PASS'|'NOTE'|'FAIL', result:string}}
 */
export function classify({ status, json, text, optional }) {
  const body = typeof text === 'string' ? text : '';

  if (status >= 200 && status < 300) {
    if (json?.ok === false) {
      // The envelope itself reports failure. 2xx is the transport; `ok` is the
      // operation.
      return { kind: 'FAIL', result: `HTTP ${status} but ok:false — ${String(json.error ?? '').slice(0, 80)}` };
    }
    const list = json?.items || json?.workspaces || json?.entries || json?.hits || json?.resources;
    if (Array.isArray(list)) return { kind: 'PASS', result: `${list.length} items` };
    return { kind: 'PASS', result: 'OK' };
  }

  if (status === 503 || (status === 404 && optional)) {
    return { kind: 'NOTE', result: `not configured: ${json?.error || body.slice(0, 60)}` };
  }

  return { kind: 'FAIL', result: `${json?.error || body.slice(0, 80)}` };
}
