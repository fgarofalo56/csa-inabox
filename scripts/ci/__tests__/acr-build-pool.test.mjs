/**
 * Tests for scripts/ci/acr-build-pool.mjs and the pool wiring in
 * .github/workflows/build-fiab-images-acr-tasks.yml.
 *
 * The repo has no node YAML parser, so the workflow is sliced into top-level
 * jobs by indentation (same technique as the other workflow guards). Every
 * assertion below names, in its message, the input that turns it red.
 *
 * Run: node --test scripts/ci/__tests__/acr-build-pool.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clampCount, decideRelease, release, acquire, resolvePoolApps } from '../acr-build-pool.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WF = (process.env.ACR_POOL_TEST_WF
  ?? join(ROOT, '.github', 'workflows', 'build-fiab-images-acr-tasks.yml'));
const text = readFileSync(WF, 'utf8').replace(/\r\n/g, '\n');

/** Map job-id -> body, from the `jobs:` section (2-space-indented keys). */
function jobs() {
  const body = text.slice(text.indexOf('\njobs:\n') + 6);
  const out = {};
  let cur = null;
  for (const line of body.split('\n')) {
    const m = /^  ([a-z0-9_-]+):\s*$/.exec(line);
    if (m) { cur = m[1]; out[cur] = ''; continue; }
    if (cur) out[cur] += line + '\n';
  }
  return out;
}
const J = jobs();

// ---- clamp ---------------------------------------------------------------
test('clampCount: 0 and negatives clamp UP to 1 (a 0 would starve the build)', () => {
  assert.equal(clampCount('0'), 1, 'input "0" must not yield 0');
  assert.equal(clampCount('-3'), 1);
});
test('clampCount: 99 clamps DOWN to 4 (a typo must not multiply spend)', () => {
  assert.equal(clampCount('99'), 4, 'input "99" must be capped at 4');
  assert.equal(clampCount('4'), 4);
  assert.equal(clampCount('2'), 2);
});
test('clampCount: blank/junk falls back to the default 2', () => {
  assert.equal(clampCount(''), 2);
  assert.equal(clampCount('abc'), 2);
  assert.equal(clampCount(undefined), 2);
});

// ---- release decision ----------------------------------------------------
const base = { exists: true, count: 2, queueCount: 0, activeRuns: 0 };
test('decideRelease: scales only when count>0 AND queue=0 AND active=0', () => {
  assert.equal(decideRelease(base).action, 'scale');
  assert.equal(decideRelease({ ...base, queueCount: 1 }).action, 'leave', 'queueCount=1 must NOT scale');
  assert.equal(decideRelease({ ...base, activeRuns: 1 }).action, 'leave', 'activeRuns=1 must NOT scale');
  assert.equal(decideRelease({ ...base, activeRuns: null }).action, 'unknown', 'unreadable runs must NOT scale');
  assert.equal(decideRelease({ ...base, queueCount: null }).action, 'unknown');
  assert.equal(decideRelease({ ...base, count: 0 }).action, 'noop');
});

/** Fake az keyed on the verb; records calls. */
function fakeAz({ pools = [{ name: 'p', count: 2 }], queue = 0, runs = [], failRuns = false, failList = false, afterCount = 0, failUpdate = false }) {
  const calls = [];
  const az = (args) => {
    calls.push(args.join(' '));
    const j = args.join(' ');
    if (j.startsWith('acr agentpool list')) return failList ? { ok: false, err: 'boom' } : { ok: true, value: pools };
    if (j.includes('--queue-count')) return { ok: true, value: { count: queue } };
    if (j.startsWith('acr task list-runs')) return failRuns ? { ok: false, err: 'denied' } : { ok: true, value: runs };
    if (j.startsWith('acr agentpool update')) return failUpdate ? { ok: false, err: 'conflict' } : { ok: true, value: {} };
    if (j.startsWith('acr agentpool show')) return { ok: true, value: { count: afterCount } };
    return { ok: false, err: 'unexpected ' + j };
  };
  return { az, calls };
}
const updated = (calls) => calls.some((c) => c.startsWith('acr agentpool update'));

test('release: scales to 0 and reads back when idle', () => {
  const f = fakeAz({});
  const r = release('acr', 'p', f.az);
  assert.equal(r.code, 0);
  assert.ok(updated(f.calls), 'an idle pool at count 2 must be updated');
  assert.match(r.msg, /read-back count=0/);
});
test('release: FAILS when the read-back count is not 0 (afterCount=1)', () => {
  const r = release('acr', 'p', fakeAz({ afterCount: 1 }).az);
  assert.equal(r.code, 1, 'read-back count=1 must exit 1, not report success');
  assert.match(r.msg, /still billing/);
});
test('release: FAILS when the update itself errors', () => {
  assert.equal(release('acr', 'p', fakeAz({ failUpdate: true }).az).code, 1);
});
test('release: does NOT scale while a run is active on the pool (kill-in-flight guard)', () => {
  const f = fakeAz({ runs: [{ agentPoolName: 'p' }] });
  const r = release('acr', 'p', f.az);
  assert.equal(r.code, 0);
  assert.equal(updated(f.calls), false, 'an active run on pool p must prevent any update');
  // positive pair: the same run on a DIFFERENT pool does not block.
  const g = fakeAz({ runs: [{ agentPoolName: 'other' }] });
  release('acr', 'p', g.az);
  assert.equal(updated(g.calls), true, 'a run on another pool must not block the release');
});
test('release: does NOT scale while the queue is non-empty (queue=2)', () => {
  const f = fakeAz({ queue: 2 });
  release('acr', 'p', f.az);
  assert.equal(updated(f.calls), false);
});
test('release: fails closed when runs cannot be listed (failRuns)', () => {
  const f = fakeAz({ failRuns: true });
  const r = release('acr', 'p', f.az);
  assert.equal(r.code, 1, 'unlistable runs must exit 1');
  assert.equal(updated(f.calls), false, 'and must not scale');
});
test('release: fails closed when pools cannot be listed', () => {
  const f = fakeAz({ failList: true });
  assert.equal(release('acr', 'p', f.az).code, 1);
  assert.equal(updated(f.calls), false);
});
test('release: absent pool is a clean no-op (fresh registry, no console build)', () => {
  const f = fakeAz({ pools: [] });
  assert.equal(release('acr', 'p', f.az).code, 0);
  assert.equal(updated(f.calls), false);
});

// ---- workflow wiring -----------------------------------------------------
test('workflow: pool_release exists, is if: always(), and needs resolve+acr_enable+build', () => {
  assert.ok(J.pool_release, 'a pool_release job must exist (missing job turns this red)');
  assert.match(J.pool_release, /^ {4}if: always\(\)\s*$/m, 'dropping `if: always()` lets a failed build skip the scale-down');
  const needs = /^ {4}needs: \[([^\]]*)\]/m.exec(J.pool_release);
  assert.ok(needs, 'pool_release must declare needs');
  const set = needs[1].split(',').map((x) => x.trim());
  for (const j of Object.keys(J).filter((k) => ['resolve', 'acr_enable', 'pool_acquire', 'build'].includes(k))) {
    assert.ok(set.includes(j), `pool_release must need ${j}; adding a build job without listing it turns this red`);
  }
  assert.match(J.pool_release, /acr-build-pool\.mjs release /, 'must call the read-back release script');
  assert.match(J.pool_release, /timeout-minutes: \d+/, 'release job needs its own timeout');
});
test('workflow: every job that runs `az acr build` is a need of pool_release', () => {
  const needs = /^ {4}needs: \[([^\]]*)\]/m.exec(J.pool_release)[1].split(',').map((x) => x.trim());
  const builders = Object.keys(J).filter((k) => /az acr build/.test(J[k]));
  assert.ok(builders.length >= 1, 'positive control: at least one job builds');
  for (const b of builders) assert.ok(needs.includes(b), `builder job ${b} is not in pool_release needs`);
});
test('workflow: build jobs have a hard timeout-minutes', () => {
  const t = /^ {4}timeout-minutes: (\d+)\s*$/m.exec(J.build);
  assert.ok(t, 'build job must set timeout-minutes (removing it lets a hang hold the pool for 6h)');
  assert.ok(Number(t[1]) <= 180, `timeout ${t[1]} is above 180`);
});
test('workflow: scale-up uses the clamped shared count, never a literal --count 1', () => {
  assert.match(J.pool_acquire, /acr-build-pool\.mjs clamp "\$POOL_AGENT_COUNT"/, 'scale-up must go through the clamp');
  assert.match(J.pool_acquire, /acquire --acr "\$ACR" --pool "\$BUILD_POOL_NAME" --count "\$WANT"/, 'acquire must use the clamped value');
  for (const j of ['build', 'pool_acquire']) {
    assert.doesNotMatch(J[j], /agentpool update/, `${j}: no direct az scale; the scripted acquire/release own every scale call`);
  }
});
test('workflow: POOL_AGENT_COUNT defaults 2 for Commercial and 1 for Gov', () => {
  const line = /^ {2}POOL_AGENT_COUNT: (.*)$/m.exec(text);
  assert.ok(line, 'env POOL_AGENT_COUNT must exist');
  assert.match(line[1], /'GCC-High'/);
  assert.match(line[1], /'IL5'/);
  assert.match(line[1], /&& '1' \|\| '2'/, 'Gov -> 1, otherwise 2');
});

// ---- routing: exactly the declared heavy images use the pool -------------
const HEAVY = ['loom-console', 'loom-directlake'];
const poolApps = () => {
  const m = /^ {2}POOL_APPS_DEFAULT: (.*)$/m.exec(text);
  assert.ok(m, 'env POOL_APPS_DEFAULT must exist');
  return m[1].trim().split(',').map((x) => x.trim());
};
test('routing: POOL_APPS is exactly console + directlake', () => {
  assert.deepEqual(poolApps(), HEAVY, 'adding or dropping an app in POOL_APPS changes which builds hit the pool');
});
test('routing: every POOL_APPS name is a real matrix app, and the other apps are NOT routed', () => {
  const names = [...text.matchAll(/\{"name":"([a-z0-9-]+)","ctx"/g)].map((x) => x[1]);
  const all = [...new Set(names)];
  assert.ok(all.length >= 13, `positive control: parsed ${all.length} apps from the default matrix`);
  for (const h of HEAVY) assert.ok(all.includes(h), `${h} is not in the matrix: a typo routes nothing`);
  const routed = all.filter((n) => poolApps().includes(n));
  const unrouted = all.filter((n) => !poolApps().includes(n));
  assert.deepEqual([...routed].sort(), [...HEAVY].sort());
  assert.equal(unrouted.length, all.length - HEAVY.length, 'every non-heavy app must stay on default agents');
  for (const n of ['loom-unity', 'loom-trino', 'loom-migrate']) assert.ok(unrouted.includes(n), `${n} must stay on default agents`);
});
test('routing: --agent-pool is applied only through the POOL_APPS case gate', () => {
  const step = J.build;
  assert.match(step, /case ",\$POOL_APPS," in \*",\$\{\{ matrix\.name \}\},"\*\)/, 'the gate must test the exact matrix name against POOL_APPS');
  const lits = step.split('\n').filter((l) => /--agent-pool/.test(l) && !/^\s*#/.test(l));
  assert.deepEqual(lits.map((l) => l.trim()), ['POOL_ARGS="--agent-pool $POOL"'], 'a second non-comment --agent-pool site would route an app outside the gate');
  assert.doesNotMatch(step, /matrix\.name \}\}" = "loom-console"/, 'a hard-coded console-only gate bypasses POOL_APPS');
});

// ---- acquire (single scale-up, tolerant of a concurrent update) ----------
/** az fake whose `show` returns the next count in `counts` (last repeats). */
function acquireAz({ counts, updateFails = false, pools = [{ name: 'p' }] }) {
  const calls = [];
  let i = 0;
  const az = (args) => {
    const j = args.join(' ');
    calls.push(j);
    if (j.startsWith('acr agentpool list')) return { ok: true, value: pools };
    if (j.startsWith('acr agentpool create')) return { ok: true, value: {} };
    if (j.startsWith('acr agentpool update')) return updateFails ? { ok: false, err: 'Conflict: operation in progress' } : { ok: true, value: {} };
    if (j.startsWith('acr agentpool show')) { const c = counts[Math.min(i, counts.length - 1)]; i += 1; return { ok: true, value: { count: c } }; }
    return { ok: false, err: 'unexpected ' + j };
  };
  return { az, calls };
}
test('acquire: scales 0 -> 2 and reads back', () => {
  const f = acquireAz({ counts: [0, 2] });
  const r = acquire('acr', 'p', 2, f.az);
  assert.equal(r.code, 0);
  assert.ok(f.calls.some((c) => c.includes('--count 2')), 'a pool at 0 must be updated to 2');
});
test('acquire: a CONCURRENT update (our update 409s) is tolerated when the re-read shows count >= want', () => {
  const f = acquireAz({ counts: [0, 2], updateFails: true });
  const r = acquire('acr', 'p', 2, f.az, { attempts: 3 });
  assert.equal(r.code, 0, 'update error + re-read count=2 must proceed');
});
test('acquire: FAILS when count stays below want after all attempts (count 1 < 2)', () => {
  const f = acquireAz({ counts: [0, 1, 1, 1, 1, 1, 1], updateFails: true });
  const slept = [];
  const r = acquire('acr', 'p', 2, f.az, { attempts: 3, sleep: (ms) => slept.push(ms) });
  assert.equal(r.code, 1, 'count=1 < want=2 must fail loudly');
  assert.match(r.msg, /did NOT reach count 2/);
  assert.equal(slept.length, 2, 'bounded: attempts=3 sleeps exactly twice');
  assert.equal(f.calls.filter((c) => c.startsWith('acr agentpool update')).length, 3);
});
test('acquire: a pool already above want is accepted without an update', () => {
  const f = acquireAz({ counts: [3] });
  assert.equal(acquire('acr', 'p', 2, f.az).code, 0);
  assert.equal(f.calls.some((c) => c.startsWith('acr agentpool update')), false);
});
test('acquire: creates the pool when absent', () => {
  const f = acquireAz({ counts: [2], pools: [] });
  assert.equal(acquire('acr', 'p', 2, f.az).code, 0);
  assert.ok(f.calls.some((c) => c.startsWith('acr agentpool create') && c.includes('--tier S3')));
});

// ---- pool_apps resolution + run-filter fail-closed -----------------------
test('resolvePoolApps: default / none / list / malformed', () => {
  assert.deepEqual(resolvePoolApps('default', 'a,b'), ['a', 'b']);
  assert.deepEqual(resolvePoolApps('', 'a,b'), ['a', 'b']);
  assert.deepEqual(resolvePoolApps('none', 'a,b'), [], '"none" must put nothing on the pool');
  assert.deepEqual(resolvePoolApps('x, y', 'a,b'), ['x', 'y']);
  assert.throws(() => resolvePoolApps('x;rm -rf', 'a'), /invalid app name/, 'a shell metachar must be rejected');
});
test('release: fails CLOSED if listed runs carry no agentPoolName key at all (renamed field)', () => {
  const f = fakeAz({ runs: [{ somethingElse: 'p' }] });
  const r = release('acr', 'p', f.az);
  assert.equal(r.code, 1, 'rows without the key must not be read as "no active runs"');
  assert.equal(updated(f.calls), false);
  // positive pair: rows WITH the key (null = default agent) are readable and do not block.
  const g = fakeAz({ runs: [{ agentPoolName: null }] });
  release('acr', 'p', g.az);
  assert.equal(updated(g.calls), true);
});
test('workflow: pool_acquire exists, build needs it but tolerates its failure, release needs it', () => {
  assert.ok(J.pool_acquire, 'pool_acquire job must exist');
  assert.match(J.pool_acquire, /^ {4}needs: \[resolve, acr_enable\]/m);
  assert.match(J.pool_acquire, /acr-build-pool\.mjs acquire /);
  assert.match(J.build, /^ {4}needs: \[[^\]]*pool_acquire[^\]]*\]/m, 'both pool legs must wait for the single scale-up');
  assert.match(J.build, /^ {4}if: \$\{\{ !cancelled\(\)/m, 'build must not require pool_acquire success (default-agent images still build); and !cancelled() not always()');
  assert.doesNotMatch(J.build, /^ {4}if: .*always\(\)/m, 'always() would start builds on a cancelled run');
  assert.match(J.build, /needs\.pool_acquire\.result \}\}" != "success"/, 'a pool leg must fail loudly when acquire did not succeed');
});
test('workflow: pool_apps input exists on dispatch and call', () => {
  assert.equal((text.match(/^ {6}pool_apps:/gm) || []).length, 2, 'workflow_dispatch and workflow_call must both declare pool_apps');
});
