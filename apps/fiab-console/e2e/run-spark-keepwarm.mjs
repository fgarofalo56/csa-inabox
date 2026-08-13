#!/usr/bin/env node
/**
 * Spark keep-warm heartbeat entrypoint — the thin runner the scheduled
 * `loom-spark-keepwarm` Container App Job executes
 * (modules/admin-plane/spark-keepwarm-job.bicep) in-VNet, as the console UAMI,
 * once per cron tick.
 *
 * ── Why this replaces the GitHub `schedule:` heartbeat (#3226) ─────────────
 * `.github/workflows/csa-loom-spark-keepwarm.yml` declared an every-5-minutes
 * cron. Measured over 200 consecutive scheduled runs (2026-08-04 -> 2026-08-13,
 * 231.9 h): median gap 56.9 min, min 22.0 min, max 349.9 min — 200 runs
 * delivered against 2782 declared ticks, a 7.19% delivery rate. GitHub delays
 * and drops high-frequency schedules on busy repositories, so the heartbeat
 * NEVER once beat the 15-minute warm-session idle TTL
 * (LOOM_SPARK_POOL_IDLE_TTL default 900s) — 199 of 199 intervals exceeded it.
 * A heartbeat that cannot beat the TTL keeps nothing warm.
 *
 * Azure's own scheduler honours the cron: a Container Apps Job Schedule trigger
 * supports minute granularity (Learn documents an every-1-minute cron as a valid
 * cronExpression), and the job runs inside the console's VNet-integrated CAE as
 * the console UAMI with zero GitHub dependency — the same reasoning that put
 * loom-synthetic-monitor and the three loom-access-* sweeps on ACA jobs.
 *
 * This runner does NO Spark work itself — it POSTs the in-VNet console with the
 * shared internal token; the console process runs the REAL work (start the
 * sweeper after a replica recycle, re-adopt cross-replica warm sessions,
 * reconcile warming slots against live Livy state, top the pool back up to
 * `min`, and drive the A11 faulted-pool auto-recovery tick). One implementation,
 * hit by both this job and the admin surface.
 *
 * Env (wired by the bicep job):
 *   LOOM_URL             — in-VNet console URL (http://loom-console) or Front Door.
 *   LOOM_INTERNAL_TOKEN  — shared VNet-internal trust token (secretRef).
 *
 * ── Exit codes (honest, per deploy-integrity.md R7) ────────────────────────
 *   0  the console reported keptWarm — the pool was actually topped up.
 *   1  the POST failed (unreachable console, bad token, HTTP >= 400) OR the
 *      console reported `skipped` — i.e. the heartbeat ran and warmed NOTHING.
 *
 * The `skipped` case is deliberately a FAILURE, not a pass. Measured on the live
 * Commercial estate 2026-08-13T20:22:48Z, the endpoint returned
 *   {"ok":true,"skipped":true,"reason":"warm pool disabled (LOOM_SPARK_POOL_ENABLED=false)"}
 * and the GitHub workflow printed "warm pool topped up" for it, because it
 * mapped HTTP 200 straight to success. A green tick over a no-op is exactly the
 * failure `.claude/rules/no-vaporware.md` exists to stop. If this job is
 * deployed at all the pool is enabled (bicep gates it on `sparkPoolEnabled`), so
 * a skip here means the console's view and the deploy's view have diverged —
 * a real regression that must be visible as a Failed execution.
 */
const base = (process.env.LOOM_URL || 'http://loom-console').replace(/\/$/, '');
const token = process.env.LOOM_INTERNAL_TOKEN || '';
const path = '/api/internal/spark/keep-warm';

async function main() {
  if (!token) {
    console.error('[spark-keepwarm] LOOM_INTERNAL_TOKEN unset — cannot authenticate the internal call. Exiting 1.');
    process.exit(1);
  }

  const url = `${base}${path}`;
  console.log(`[spark-keepwarm] POST ${url}`);

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
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    // R7: say what we actually know. We could not complete the request; we do
    // NOT know whether the console is down, the DNS name is wrong, or the call
    // timed out mid-warm.
    console.error(`[spark-keepwarm] request to ${url} did not complete: ${e?.message || e}`);
    process.exit(1);
  }

  const text = await res.text();
  if (!res.ok) {
    // 401/403 => the token the deploy wired is not the one the console holds.
    console.error(`[spark-keepwarm] HTTP ${res.status}: ${text.slice(0, 400)}`);
    process.exit(1);
  }

  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    console.error(`[spark-keepwarm] HTTP 200 but the body is not JSON — cannot confirm the pool was warmed: ${text.slice(0, 400)}`);
    process.exit(1);
  }

  if (data?.skipped) {
    console.error(
      `[spark-keepwarm] the console SKIPPED the warm-up — nothing was warmed. reason: ${data.reason || '(none given)'}`,
    );
    console.error(
      '[spark-keepwarm] this job is only deployed when sparkPoolEnabled=true, so a skip means the console env and the deploy have diverged. ' +
        'Check LOOM_SPARK_POOL_ENABLED on loom-console and the Spark backend env (LOOM_SYNAPSE_* / LOOM_DATABRICKS_*).',
    );
    process.exit(1);
  }

  if (data?.keptWarm) {
    const t = data.totals || {};
    const rec = data.reconciled || {};
    console.log(
      `[spark-keepwarm] ok — min=${data.min ?? '?'} warm=${t.warm ?? '?'} warming=${t.warming ?? '?'} leased=${t.leased ?? '?'} ` +
        `promoted=${rec.promoted ?? 0} died=${rec.died ?? 0} stillWarming=${rec.stillWarming ?? 0}` +
        (data.recovery ? ` recovery=${JSON.stringify(data.recovery).slice(0, 200)}` : ''),
    );
    process.exit(0);
  }

  // Neither skipped nor keptWarm: the contract changed under us. Do not guess.
  console.error(`[spark-keepwarm] HTTP 200 with an unrecognised body — cannot confirm the pool was warmed: ${text.slice(0, 400)}`);
  process.exit(1);
}

main();
