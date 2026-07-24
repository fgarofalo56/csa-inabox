#!/usr/bin/env node
/**
 * N5 asset-reconciler entrypoint — the thin runner the scheduled
 * `loom-asset-reconciler` Container App Job executes
 * (modules/admin-plane/asset-reconciler-job.bicep) in-VNet, as the console
 * UAMI, once per schedule (default every 15 minutes).
 *
 * Per the estate constraint (Y1 Linux Consumption Functions are structurally
 * broken on this estate — policy seals the storage data-plane, so host keys /
 * timer leases fail) the scheduled compute is an ACA Job, NOT a Function. This
 * runner does NO reconciliation itself — it POSTs the in-VNet console's
 * /api/internal/assets/reconcile with the shared internal token; the console
 * process runs the real lineage derivation, the real Delta `_delta_log` /
 * Capture watermark reads, the pure decision engine (with its cooldown /
 * in-flight / backoff thrash guards), the real Synapse / Databricks / SQLMesh
 * dispatch, and the shared-action-group alerts — the exact code path the
 * /assets UI shows, so there is one source of truth.
 *
 * Env (wired by the bicep job):
 *   LOOM_URL            — the in-VNet console URL (http://loom-console) or the
 *                         Front Door URL; the target of the POST.
 *   LOOM_INTERNAL_TOKEN — the shared VNet-internal trust token (secretRef).
 *   LOOM_ASSET_MAX_TRIGGERS — optional per-pass dispatch bound override.
 *
 * Exit code: 0 on a successful pass (including a pass that dispatched nothing,
 * or one where a materializer is honestly gated — neither is a code failure).
 * Non-zero ONLY when the POST itself fails (unreachable console / bad token),
 * so a Failed execution is a real regression the shared action group alerts on.
 */

const base = (process.env.LOOM_URL || 'http://loom-console').replace(/\/$/, '');
const token = process.env.LOOM_INTERNAL_TOKEN || '';
const maxTriggers = Number(process.env.LOOM_ASSET_MAX_TRIGGERS || '');
const url = `${base}/api/internal/assets/reconcile`;

async function main() {
  if (!token) {
    console.error('[asset-reconciler] LOOM_INTERNAL_TOKEN unset — cannot authenticate the internal call. Exiting 1.');
    process.exit(1);
  }
  console.log(`[asset-reconciler] POST ${url}`);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-loom-internal-token': token,
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        trigger: 'scheduled',
        ...(Number.isFinite(maxTriggers) && maxTriggers > 0 ? { maxTriggers } : {}),
      }),
    });
  } catch (e) {
    console.error(`[asset-reconciler] request failed: ${e?.message || e}. Exiting 1.`);
    process.exit(1);
  }

  const text = await res.text();
  if (!res.ok) {
    console.error(`[asset-reconciler] HTTP ${res.status}: ${text.slice(0, 400)}. Exiting 1.`);
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (data && data.ok) {
    if (data.enabled === false) {
      console.log('[asset-reconciler] pass skipped: the n5-asset-reconciler runtime flag is OFF.');
      process.exit(0);
    }
    console.log(
      `[asset-reconciler] pass ok: ${data.tenants} tenant(s), dispatched ${data.dispatched}, alerted ${data.alerted}`,
    );
    for (const r of data.receipts || []) {
      console.log(
        `[asset-reconciler]   ${r.tenantId}: ${r.assets} assets, ${r.observed} observed, ` +
          `${r.changed} changed, ${r.dispatched} dispatched, ${r.deferred} deferred, ${r.failures} failed`,
      );
      for (const note of r.notes || []) console.log(`[asset-reconciler]     note: ${note}`);
    }
  } else {
    console.log(`[asset-reconciler] pass response: ${text.slice(0, 400)}`);
  }
  process.exit(0);
}

main();
