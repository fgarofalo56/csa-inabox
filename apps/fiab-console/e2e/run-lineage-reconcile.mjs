#!/usr/bin/env node
/**
 * LIN-GC-2 lineage garbage-collection entrypoint — the thin runner the scheduled
 * `loom-lineage-gc` Container App Job executes
 * (modules/admin-plane/lineage-gc-job.bicep) in-VNet, as the console UAMI, once
 * per schedule (default daily 04:30 UTC).
 *
 * Per the estate constraint (Y1 Linux Consumption Functions are structurally
 * broken here) the scheduled compute is an ACA Job, NOT a Function. This runner
 * does NO reconciliation itself — it POSTs the in-VNet console's
 * /api/internal/lineage/reconcile with the shared internal token, and the
 * console process runs the same `lib/azure/lineage-gc.ts` functions the
 * Governance → Lineage → Reconcile dialog calls, so there is one source of truth
 * rather than a second implementation that can drift.
 *
 * SCAN-ONLY BY DEFAULT. The route reports orphans and deletes nothing unless an
 * operator has explicitly set LOOM_LINEAGE_GC_PURGE. An unattended purge would
 * delete metadata for an item whose absence might be a READ failure rather than
 * a real deletion, and that is not recoverable — so the schedule makes debris
 * VISIBLE and a human still authorises removal.
 *
 * Env (wired by the bicep job):
 *   LOOM_URL            — the in-VNet console URL (http://loom-console) or the
 *                         Front Door URL; the target of the POST.
 *   LOOM_INTERNAL_TOKEN — the shared VNet-internal trust token (secretRef).
 *
 * Exit code: 0 on a successful scan, INCLUDING a scan that finds orphans —
 * finding debris is this job working, not failing. Non-zero ONLY when the POST
 * itself fails (unreachable console / bad token), so a Failed execution is a
 * real regression the shared action group can alert on and is never just "the
 * estate has orphans".
 */

const base = (process.env.LOOM_URL || 'http://loom-console').replace(/\/$/, '');
const token = process.env.LOOM_INTERNAL_TOKEN || '';
const url = `${base}/api/internal/lineage/reconcile`;

async function main() {
  if (!token) {
    console.error('[lineage-gc] LOOM_INTERNAL_TOKEN unset — cannot authenticate the internal call. Exiting 1.');
    process.exit(1);
  }
  console.log(`[lineage-gc] POST ${url}`);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-loom-internal-token': token,
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ trigger: 'scheduled' }),
    });
  } catch (e) {
    console.error(`[lineage-gc] request failed: ${e?.message || e}. Exiting 1.`);
    process.exit(1);
  }

  const text = await res.text();
  if (!res.ok) {
    console.error(`[lineage-gc] HTTP ${res.status}: ${text.slice(0, 400)}. Exiting 1.`);
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (data && data.ok) {
    const d = data.data || data;
    // Report the two facts separately and always. "0 found" and "found but not
    // purged" are different states, and collapsing them is how a scan that is
    // working reads as a scan that found nothing.
    console.log(
      `[lineage-gc] scan ok: ${d.found ?? 0} orphan(s) across lineage/thread/access planes; `
        + `purged=${d.purged === true ? 'yes' : 'no (scan-only)'}`
        + (d.purviewConfigured === false ? '; Purview unconfigured — that plane was skipped' : ''),
    );
    if ((d.found ?? 0) > 0 && d.purged !== true) {
      console.log('[lineage-gc] these are REPORTED, not deleted. Purge from Governance → Lineage → Reconcile.');
    }
  } else {
    console.log(`[lineage-gc] response: ${text.slice(0, 400)}`);
  }
  process.exit(0);
}

main();
