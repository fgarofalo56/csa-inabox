#!/usr/bin/env node
/**
 * acr-build-pool.mjs - helpers for the ACR Tasks build agent pool used by
 * build-fiab-images-acr-tasks.yml.
 *
 *   clamp <n>                      print the pool size to scale UP to: integer,
 *                                  clamped to [1,4]; junk/empty -> DEFAULT (never 0,
 *                                  never unbounded - a typo must not multiply spend)
 *   release --acr A --pool P [--subscription S]
 *                                  scale pool P to 0 and READ BACK the count.
 *
 * release is the guaranteed scale-down (final `if: always()` job). It does NOT
 * kill in-flight work: if the pool queue or any Queued/Started/Running ACR run
 * on that pool is non-zero, it leaves the pool alone (the hourly
 * acr-agentpool-reaper.yml collects it once idle). Any read that fails is
 * `unknown`, which exits 1 - it never reports a pool released that it did not
 * read back as 0.
 *
 * Exit: 0 pool is 0, absent, or deliberately left for in-flight work (said so)
 *       1 a read failed or the read-back count is not 0 (still billing)
 *       2 usage
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MIN_COUNT = 1;
export const MAX_COUNT = 4;
export const DEFAULT_COUNT = 2;
export const ACTIVE_RUN_STATES = ['Queued', 'Started', 'Running'];

export function clampCount(raw, fallback = DEFAULT_COUNT) {
  const n = Number.parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_COUNT, Math.max(MIN_COUNT, n));
}

/**
 * Pure decision over measured values; `null` = could not be read.
 * @returns {{action:'noop'|'leave'|'scale'|'unknown', reason:string}}
 */
export function decideRelease(p) {
  if (p.exists === false) return { action: 'noop', reason: 'pool does not exist' };
  if (p.count === null || p.queueCount === null || p.activeRuns === null) {
    return { action: 'unknown', reason: 'count, queue or active runs could not be read' };
  }
  if (p.count === 0) return { action: 'noop', reason: 'already at 0' };
  if (p.queueCount > 0) return { action: 'leave', reason: `${p.queueCount} run(s) queued on it` };
  if (p.activeRuns > 0) return { action: 'leave', reason: `${p.activeRuns} run(s) active on it` };
  return { action: 'scale', reason: `count=${p.count}, nothing queued or active` };
}

function realAz(args, subscription) {
  const a = subscription ? [...args, '--subscription', subscription] : args;
  const r = spawnSync('az', [...a, '-o', 'json'], { encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.status !== 0) return { ok: false, err: (r.stderr || '').trim().split('\n').slice(-3).join(' | ') };
  try { return { ok: true, value: JSON.parse(r.stdout || 'null') }; }
  catch { return { ok: false, err: 'unparseable az output' }; }
}

/** @param {(args:string[])=>{ok:boolean,value?:any,err?:string}} az */
export function release(acr, pool, az) {
  const list = az(['acr', 'agentpool', 'list', '-r', acr]);
  if (!list.ok) return { code: 1, msg: `could not list pools on ${acr}: ${list.err}. Pool left as-is.` };
  const found = (list.value || []).find((x) => x.name === pool);
  if (!found) return { code: 0, msg: `${acr}/${pool} does not exist; nothing to release.` };
  const queue = az(['acr', 'agentpool', 'show', '-r', acr, '-n', pool, '--queue-count']);
  let activeRuns = 0;
  for (const st of ACTIVE_RUN_STATES) {
    const runs = az(['acr', 'task', 'list-runs', '-r', acr, '--run-status', st, '--top', '100']);
    if (!runs.ok) { activeRuns = null; break; }
    activeRuns += (runs.value || []).filter((x) => x.agentPoolName === pool).length;
  }
  const qn = queue.ok ? Number(queue.value?.count ?? queue.value) : NaN;
  const d = decideRelease({
    exists: true,
    count: typeof found.count === 'number' ? found.count : null,
    queueCount: Number.isFinite(qn) ? qn : null,
    activeRuns,
  });
  if (d.action === 'unknown') return { code: 1, msg: `${acr}/${pool}: ${d.reason}; whether it is idle was NOT established. Left as-is - the reaper retries hourly.` };
  if (d.action !== 'scale') return { code: 0, msg: `${acr}/${pool}: ${d.action} - ${d.reason}.` };
  const up = az(['acr', 'agentpool', 'update', '-r', acr, '-n', pool, '--count', '0']);
  const back = up.ok ? az(['acr', 'agentpool', 'show', '-r', acr, '-n', pool]) : up;
  if (up.ok && back.ok && back.value?.count === 0) return { code: 0, msg: `${acr}/${pool} scaled to 0; read-back count=0.` };
  return { code: 1, msg: `${acr}/${pool} scale-down NOT confirmed (${up.ok ? `read-back count=${back.value?.count}` : up.err}). It is still billing.` };
}

function main(argv) {
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv[0] === 'clamp') {
    console.log(String(clampCount(argv[1])));
    return 0;
  }
  if (argv[0] === 'release') {
    const acr = arg('--acr');
    const pool = arg('--pool');
    if (!acr || !pool) { console.error('usage: acr-build-pool.mjs release --acr A --pool P [--subscription S]'); return 2; }
    const sub = arg('--subscription') ?? '';
    const r = release(acr, pool, (a) => realAz(a, sub));
    console.log(r.code ? `::error::${r.msg}` : r.msg);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ACR build pool release\n\n${r.msg}\n`);
    return r.code;
  }
  console.error('usage: acr-build-pool.mjs clamp <n> | release --acr A --pool P');
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
