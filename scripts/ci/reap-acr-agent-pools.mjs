#!/usr/bin/env node
/**
 * reap-acr-agent-pools.mjs — scale an IDLE ACR Tasks agent pool back to 0.
 *
 * ── THE LEAK THIS CLOSES ───────────────────────────────────────────────────
 * The build workflows scale a dedicated pool 0 -> 1 before `az acr build` and
 * back to 0 afterwards (full-app-deploy-commercial.yml `scale_down_pool`,
 * console-bluegreen-roll.yml, build-fiab-images-acr-tasks.yml). The scale-down
 * is a line in the SAME shell as the build, so a run that is CANCELLED, hits
 * `timeout-minutes`, or `exit 1`s before that line never reaches it, and
 * nothing ever comes back for the pool. Allocation is what bills; an idle S3
 * instance bills exactly like a busy one.
 *
 * Measured 2026-10-19: `loombuild` and `loombuild2` on acrloomk6mvh5sm6z7do
 * were both S3 at count=1 with nothing queued, at $1,037 EACH over 30 days —
 * the single largest line in the Commercial estate's bill.
 *
 * ── THE RULE (fail-safe: any doubt keeps the pool) ─────────────────────────
 * A pool is reaped ONLY when every one of these is ESTABLISHED:
 *   1. count > 0                                  (else nothing to do)
 *   2. provisioningState is Succeeded             (a Failed/wedged pool, #2706,
 *                                                  is reported, never mutated)
 *   3. its queue holds 0 runs
 *   4. 0 runs on THIS pool are Queued/Started/Running
 *   5. the pool was last MODIFIED > idle minutes ago — closes the race where a
 *      workflow has just scaled it 0 -> 1 and has not yet submitted its build
 *   6. the newest run on this pool FINISHED > idle minutes ago
 * A read that fails yields `unknown`, which is reported and never scales.
 *
 * Usage: node reap-acr-agent-pools.mjs --acr <name> [--subscription <id>] [--idle-minutes 30] [--dry-run]
 * Exit:  0 every pool decided (reaped / kept / noop)
 *        1 a read or the scale-down itself failed — the pool was left as-is
 *        2 usage
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ACTIVE_RUN_STATES = ['Queued', 'Started', 'Running'];

/**
 * Pure decision. Every input is either a measured value or `null` meaning
 * "could not be read" — and `null` anywhere that matters yields `unknown`.
 *
 * @returns {{ action: 'reap'|'keep'|'noop'|'unknown', reason: string }}
 */
export function decideReap(p, nowMs, idleMinutes) {
  if (p.count === null || p.count === undefined) {
    return { action: 'unknown', reason: 'its instance count could not be read' };
  }
  if (p.count === 0) return { action: 'noop', reason: 'already at 0 instances' };
  if (p.provisioningState !== 'Succeeded') {
    return {
      action: 'keep',
      reason: `provisioningState is '${p.provisioningState ?? 'unreadable'}', not Succeeded — a pool in that state is reported, never mutated (#2706)`,
    };
  }
  if (p.queueCount === null || p.activeRuns === null || p.lastModifiedMs === null || p.runsReadable !== true) {
    return { action: 'unknown', reason: 'its queue, run history or last-modified time could not be read' };
  }
  if (p.queueCount > 0) return { action: 'keep', reason: `${p.queueCount} run(s) queued` };
  if (p.activeRuns > 0) return { action: 'keep', reason: `${p.activeRuns} run(s) active on it` };
  const idleMs = idleMinutes * 60_000;
  const sinceModified = nowMs - p.lastModifiedMs;
  if (sinceModified < idleMs) {
    return { action: 'keep', reason: `scaled ${Math.round(sinceModified / 60_000)} min ago — a build may be about to submit` };
  }
  if (p.lastRunFinishMs !== null && p.lastRunFinishMs !== undefined && nowMs - p.lastRunFinishMs < idleMs) {
    return { action: 'keep', reason: `last run finished ${Math.round((nowMs - p.lastRunFinishMs) / 60_000)} min ago` };
  }
  return {
    action: 'reap',
    reason: `count=${p.count}, nothing queued or active, idle >= ${idleMinutes} min`,
  };
}

/**
 * #5102 — dead-pool prune (dispatch only, `--prune-failed`). A pool is DELETED
 * only when all three are ESTABLISHED: provisioningState is Failed, count is 0,
 * and its queue holds 0. An unreadable value yields `unknown`, which deletes
 * nothing. Distinct from decideReap, which never mutates a Failed pool.
 *
 * @returns {{ action: 'prune'|'keep'|'unknown', reason: string }}
 */
export function decidePrune(p) {
  if (p.count === null || p.count === undefined || !p.provisioningState) {
    return { action: 'unknown', reason: 'its count or provisioning state could not be read' };
  }
  if (p.provisioningState !== 'Failed') {
    return { action: 'keep', reason: `provisioningState is '${p.provisioningState}', not Failed` };
  }
  if (p.count !== 0) return { action: 'keep', reason: `Failed but count=${p.count}, not 0` };
  if (p.queueCount === null || p.queueCount === undefined) {
    return { action: 'unknown', reason: 'Failed at count 0 but its queue could not be read, so it is not proven empty' };
  }
  if (p.queueCount !== 0) return { action: 'keep', reason: `Failed at count 0 but ${p.queueCount} run(s) queued` };
  return { action: 'prune', reason: 'Failed, count=0, queue=0' };
}

let SUBSCRIPTION = '';
function az(args) {
  if (SUBSCRIPTION) args = [...args, '--subscription', SUBSCRIPTION];
  const r = spawnSync('az', [...args, '-o', 'json'], { encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.status !== 0) return { ok: false, err: (r.stderr || '').trim().split('\n').slice(-3).join(' | ') };
  try {
    return { ok: true, value: JSON.parse(r.stdout || 'null') };
  } catch {
    return { ok: false, err: `unparseable az output: ${(r.stdout || '').slice(0, 200)}` };
  }
}

const ms = (iso) => (iso ? Date.parse(iso) : NaN);

function readPool(acr, pool) {
  const show = az(['acr', 'agentpool', 'show', '-r', acr, '-n', pool.name]);
  const queue = az(['acr', 'agentpool', 'show', '-r', acr, '-n', pool.name, '--queue-count']);
  let activeRuns = 0;
  let activeErr = '';
  for (const status of ACTIVE_RUN_STATES) {
    const runs = az(['acr', 'task', 'list-runs', '-r', acr, '--run-status', status, '--top', '100']);
    if (!runs.ok) { activeErr = runs.err; activeRuns = null; break; }
    activeRuns += (runs.value || []).filter((x) => x.agentPoolName === pool.name).length;
  }
  const recent = az(['acr', 'task', 'list-runs', '-r', acr, '--top', '100']);
  const mine = recent.ok ? (recent.value || []).filter((x) => x.agentPoolName === pool.name) : [];
  const finishes = mine.map((x) => ms(x.finishTime)).filter(Number.isFinite);
  const modified = show.ok ? ms(show.value?.systemData?.lastModifiedAt) : NaN;
  const queueCount = queue.ok ? Number(queue.value?.count ?? queue.value) : NaN;
  return {
    name: pool.name,
    count: show.ok ? show.value?.count ?? null : null,
    provisioningState: show.ok ? show.value?.provisioningState ?? null : null,
    queueCount: Number.isFinite(queueCount) ? queueCount : null,
    activeRuns,
    lastModifiedMs: Number.isFinite(modified) ? modified : null,
    // null = no run on this pool in the window; an UNREADABLE list is
    // runsReadable=false, which decideReap turns into `unknown`.
    runsReadable: recent.ok,
    lastRunFinishMs: finishes.length ? Math.max(...finishes) : null,
    readErrors: [show.ok ? '' : `show: ${show.err}`, queue.ok ? '' : `queue: ${queue.err}`,
      activeErr ? `runs: ${activeErr}` : '', recent.ok ? '' : `recent runs: ${recent.err}`].filter(Boolean),
  };
}

function main(argv) {
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const acr = arg('--acr');
  const idle = Number(arg('--idle-minutes') ?? 30);
  const dryRun = argv.includes('--dry-run');
  const prune = argv.includes('--prune-failed');
  SUBSCRIPTION = arg('--subscription') ?? '';
  if (!acr || !Number.isFinite(idle) || idle < 5) {
    console.error('usage: reap-acr-agent-pools.mjs --acr <name> [--idle-minutes >=5] [--dry-run] [--prune-failed]');
    return 2;
  }
  const list = az(['acr', 'agentpool', 'list', '-r', acr]);
  if (!list.ok) {
    console.log(`::error::Could not list agent pools on ${acr}: ${list.err}. Nothing was changed.`);
    return 1;
  }
  const summary = [`### ACR agent-pool reaper — ${acr}${dryRun ? ' (DRY RUN)' : ''}`, '', '| pool | count | decision | why |', '|---|---|---|---|'];
  let failed = 0;
  for (const pool of list.value || []) {
    const p = readPool(acr, pool);
    const d = decideReap(p, Date.now(), idle);
    for (const e of p.readErrors) console.log(`::warning::${acr}/${p.name} read failed (${e}).`);
    let outcome = d.action;
    const pr = prune ? decidePrune(p) : null;
    if (pr && pr.action === 'prune') {
      if (dryRun) {
        outcome = 'would prune';
      } else {
        const del = az(['acr', 'agentpool', 'delete', '-r', acr, '-n', p.name, '--yes']);
        const after = del.ok ? az(['acr', 'agentpool', 'list', '-r', acr]) : del;
        const gone = after.ok && !(after.value || []).some((x) => x.name === p.name);
        if (gone) {
          outcome = 'pruned';
          console.log(`::notice::${acr}/${p.name} deleted (${pr.reason}); read-back list no longer contains it.`);
        } else {
          outcome = 'prune FAILED';
          failed += 1;
          console.log(`::error::${acr}/${p.name} delete was NOT confirmed (${del.ok ? 'still listed after delete' : del.err}).`);
        }
      }
      summary.push(`| ${p.name} | ${p.count ?? '?'} | ${outcome} | ${pr.reason} |`);
      continue;
    }
    if (pr && pr.action === 'unknown') {
      console.log(`::warning::${acr}/${p.name}: prune NOT attempted - ${pr.reason}.`);
    }
    if (d.action === 'reap' && !dryRun) {
      const up = az(['acr', 'agentpool', 'update', '-r', acr, '-n', p.name, '--count', '0']);
      const back = up.ok ? az(['acr', 'agentpool', 'show', '-r', acr, '-n', p.name]) : up;
      if (up.ok && back.ok && back.value?.count === 0) {
        outcome = 'reaped';
        console.log(`::notice::${acr}/${p.name} scaled to 0 (${d.reason}); read-back count=0.`);
      } else {
        outcome = 'reap FAILED';
        failed += 1;
        console.log(`::error::${acr}/${p.name} was idle but the scale-down was NOT confirmed (${up.ok ? `read-back count=${back.value?.count}` : up.err}). It is still billing.`);
      }
    } else if (d.action === 'unknown') {
      failed += 1;
      console.log(`::error::${acr}/${p.name}: ${d.reason}, so whether it is idle was NOT established. Left as-is.`);
    } else {
      console.log(`${acr}/${p.name}: ${d.action} — ${d.reason}`);
    }
    summary.push(`| ${p.name} | ${p.count ?? '?'} | ${outcome} | ${d.reason} |`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n');
  return failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
