#!/usr/bin/env node
/**
 * C3 cost-anomaly monitor entrypoint — the thin runner the scheduled
 * `loom-cost-anomaly-monitor` Container App Job executes
 * (modules/admin-plane/cost-anomaly-monitor-job.bicep) in-VNet, as the console
 * UAMI, once per schedule (default daily 06:00 UTC).
 *
 * Per the estate constraint (Y1 Linux Consumption Functions are structurally
 * broken on this estate) the scheduled compute is an ACA Job, NOT a Function.
 * This runner does NO detection itself — it POSTs the in-VNet console's
 * /api/internal/cost-anomaly/run with the shared internal token; the console
 * process runs the real Cost Management pull + the shared detector + the
 * loom-notifications writes + the shared-action-group alert dispatch (the exact
 * same code path the /admin/finops UI shows), so there is one source of truth.
 *
 * Env (wired by the bicep job):
 *   LOOM_URL            — the in-VNet console URL (http://loom-console) or the
 *                         Front Door URL; the target of the POST.
 *   LOOM_INTERNAL_TOKEN — the shared VNet-internal trust token (secretRef).
 *
 * Exit code: 0 on a successful evaluation (including an honest Cost-Management
 * config gate — that is not a code failure). Non-zero ONLY when the POST itself
 * fails (unreachable console / bad token), so a Failed execution is a real
 * regression the shared action group can alert on.
 */

const base = (process.env.LOOM_URL || 'http://loom-console').replace(/\/$/, '');
const token = process.env.LOOM_INTERNAL_TOKEN || '';
const url = `${base}/api/internal/cost-anomaly/run`;

async function main() {
  if (!token) {
    console.error('[cost-anomaly] LOOM_INTERNAL_TOKEN unset — cannot authenticate the internal call. Exiting 1.');
    process.exit(1);
  }
  console.log(`[cost-anomaly] POST ${url}`);
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
    console.error(`[cost-anomaly] request failed: ${e?.message || e}. Exiting 1.`);
    process.exit(1);
  }

  const text = await res.text();
  if (!res.ok) {
    console.error(`[cost-anomaly] HTTP ${res.status}: ${text.slice(0, 400)}. Exiting 1.`);
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (data && data.ok) {
    console.log(
      `[cost-anomaly] run ok: evaluated ${data.evaluated} rule(s), fired ${data.fired} anomal${data.fired === 1 ? 'y' : 'ies'}` +
        (data.configGate ? ` (gate: ${data.configGate})` : ''),
    );
  } else {
    console.log(`[cost-anomaly] run response: ${text.slice(0, 400)}`);
  }
  process.exit(0);
}

main();
