#!/usr/bin/env node
/**
 * C17 access-governance sweeper entrypoint — the thin runner the scheduled
 * `loom-access-sweep` / `loom-access-review-sweep` / `loom-access-group-sync`
 * Container App Jobs execute
 * (modules/admin-plane/access-governance-sweeper-job.bicep) in-VNet, as the
 * console UAMI, once per schedule.
 *
 * ── Why this replaces a Function ───────────────────────────────────────────
 * `azure-functions/access-governance-sweeper` was a Y1 Linux Consumption
 * Function with three timer triggers. Y1 is structurally broken on this estate
 * (Azure Policy seals storage data-planes, so the multitenant Y1 runtime cannot
 * take timer leases or mint host keys) — and, measured 2026-08-08, that Function
 * was never in platform bicep at all and its `LOOM_SWEEPER_TOKEN` was set
 * nowhere. So the schedule never ran: expiry auto-revoke was admin-button-only
 * and access that should have expired stayed live. Per the estate standard
 * (docs/fiab/functions-to-aca-jobs.md) scheduled compute is an in-VNet ACA Job.
 *
 * This runner does NO governance work itself — it POSTs the in-VNet console with
 * the shared internal token; the console process runs the REAL revoke
 * (revokeStructuredGrant + revokeAccessGrant), the REAL Cosmos ledger write and
 * the REAL Graph reconcile — the exact same handlers the admin "Run sweep"
 * button hits, so there is ONE implementation of each.
 *
 * Env (wired by the bicep job):
 *   LOOM_URL             — in-VNet console URL (http://loom-console) or Front Door.
 *   LOOM_INTERNAL_TOKEN  — shared VNet-internal trust token (secretRef).
 *   ACCESS_SWEEP_MODE    — expiry | reviews | group-sync | all  (default: expiry)
 *   ACCESS_SWEEP_DRY_RUN — '1' to report without revoking (default: off)
 *
 * Exit code: 0 when every selected pass completed — INCLUDING an honest config
 * gate (e.g. group-sync returning {gated:true} because
 * LOOM_GRAPH_GROUP_SYNC_ENABLED is off); that is a documented state, not a code
 * failure. Non-zero ONLY when a POST itself fails (unreachable console, bad
 * token, HTTP >= 400), so a Failed execution always means a real regression.
 */

const base = (process.env.LOOM_URL || 'http://loom-console').replace(/\/$/, '');
const token = process.env.LOOM_INTERNAL_TOKEN || '';
const dryRun = process.env.ACCESS_SWEEP_DRY_RUN === '1';

/** Mode → the console routes that mode drives, in order. */
const PASSES = {
  expiry: [{ name: 'expiry', path: '/api/access-governance/sweep' }],
  reviews: [{ name: 'reviews', path: '/api/access-governance/reviews/sweep' }],
  'group-sync': [{ name: 'group-sync', path: '/api/access-governance/group-sync' }],
};
PASSES.all = [...PASSES.expiry, ...PASSES.reviews, ...PASSES['group-sync']];

const mode = process.env.ACCESS_SWEEP_MODE || 'expiry';
const passes = PASSES[mode];

async function runPass(pass) {
  const url = `${base}${pass.path}${dryRun ? '?dryRun=1' : ''}`;
  console.log(`[access-sweep] POST ${url}`);
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
    console.error(`[access-sweep] ${pass.name}: request failed: ${e?.message || e}`);
    return false;
  }

  const text = await res.text();
  if (!res.ok) {
    // A 401/403 here means the token the deploy wired is not the one the console
    // holds — a real regression, never a silent no-op.
    console.error(`[access-sweep] ${pass.name}: HTTP ${res.status}: ${text.slice(0, 400)}`);
    return false;
  }

  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* non-JSON body is reported verbatim below */
  }

  if (data && data.gated) {
    // Honest, documented gate (e.g. graph-group-sync opt-in). Not a failure.
    console.log(`[access-sweep] ${pass.name}: gated — ${data.remediation || data.error || 'see gate registry'}`);
    return true;
  }
  if (data && data.ok) {
    const detail =
      pass.name === 'expiry'
        ? `candidates=${data.candidates ?? 0} expired=${data.expired ?? 0}`
        : pass.name === 'reviews'
          ? `closed=${data.closed ?? 0} revoked=${data.revoked ?? 0}`
          : `packages=${data.groupTargetedPackages ?? 0} granted=${data.granted ?? 0} revoked=${data.revoked ?? 0}`;
    console.log(`[access-sweep] ${pass.name}: ok — ${detail}${dryRun ? ' (dryRun)' : ''}`);
    return true;
  }
  console.log(`[access-sweep] ${pass.name}: response ${text.slice(0, 400)}`);
  return true;
}

async function main() {
  if (!passes) {
    console.error(
      `[access-sweep] ACCESS_SWEEP_MODE="${mode}" is not one of: ${Object.keys(PASSES).join(', ')}. Exiting 1.`,
    );
    process.exit(1);
  }
  if (!token) {
    console.error('[access-sweep] LOOM_INTERNAL_TOKEN unset — cannot authenticate the internal call. Exiting 1.');
    process.exit(1);
  }

  let allOk = true;
  for (const pass of passes) {
    // Every selected pass runs even if an earlier one failed, so one broken leg
    // never silently suppresses the others; the exit code still reflects any
    // failure.
    const ok = await runPass(pass);
    allOk = allOk && ok;
  }

  if (!allOk) {
    console.error(`[access-sweep] mode=${mode}: at least one pass failed. Exiting 1.`);
    process.exit(1);
  }
  console.log(`[access-sweep] mode=${mode}: all ${passes.length} pass(es) completed.`);
  process.exit(0);
}

main();
