/**
 * Self-test for scripts/ci/loom-aca-queue-watchdog.mjs (#5483).
 *
 * `gh` and `az` are replaced by an in-memory fake GitHub + fake Container Apps
 * Job, and every call is COUNTED. The clock and `sleep` are injected: nothing
 * here waits on the wall clock. The pause tests drive the REAL register
 * classifier (estate-pause-declared.mjs `decide`) over a fixture register,
 * so a stand-down cannot be faked by a stub that answers `declared: true`.
 *
 * Every test names, in a comment, the value that would turn it red
 * (.claude/rules/assertion-design.md).
 *
 * Run: node --test scripts/ci/__tests__/loom-aca-queue-watchdog.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWatchdog, EXIT, validateConfig, DEFAULTS } from '../loom-aca-queue-watchdog.mjs';
import { decide as decidePause } from '../estate-pause-declared.mjs';

const NOW = Date.parse('2026-11-25T12:00:00Z');
const minsAgo = (m) => new Date(NOW - m * 60_000).toISOString();
const REPO = 'acme/loom';

const NOT_PAUSED = () => ({ declared: false, lines: ['[pause-declaration] fixture: not paused'] });

/**
 * Fake world.
 * runs: [{ id, status, created_at, name, inQueuedIndex?, inRecent? , jobs: [...] }]
 *   inQueuedIndex defaults to status==='queued'; set false to model the
 *   index distrust case (a queued run the filtered index does not return).
 *   inRecent defaults to true.
 * executions: [{ name, properties: { status, startTime } }]
 */
function world({ runs = [], executions = [], ghFail = 0, ghAlwaysFail = false, azListFail = false, startResult, pause = NOT_PAUSED } = {}) {
  const calls = { gh: [], az: [], starts: 0, sleeps: [] };
  let ghFailuresLeft = ghFail;
  const gh = async (p) => {
    calls.gh.push(p);
    if (ghAlwaysFail || ghFailuresLeft > 0) {
      ghFailuresLeft -= 1;
      return { ok: false, code: 1, stdout: '', stderr: 'HTTP 502: Bad Gateway' };
    }
    const page = Number(/[?&]page=(\d+)/.exec(p)?.[1] ?? '1');
    const jobsM = new RegExp(`^repos/${REPO}/actions/runs/(\\d+)/jobs`).exec(p);
    if (jobsM) {
      const run = runs.find((r) => r.id === Number(jobsM[1]));
      const jobs = page === 1 ? (run?.jobs ?? []) : [];
      return { ok: true, code: 0, stdout: JSON.stringify({ total_count: jobs.length, jobs }), stderr: '' };
    }
    const statusM = /[?&]status=(\w+)/.exec(p);
    let list;
    if (statusM) {
      list = runs.filter((r) => r.status === statusM[1] && (statusM[1] !== 'queued' || r.inQueuedIndex !== false));
    } else {
      assert.match(p, /created=%3E%3D/, 'the unfiltered page must carry the created>= window');
      list = runs.filter((r) => r.inRecent !== false);
    }
    if (page > 1) list = [];
    const strip = list.map(({ jobs, inQueuedIndex, inRecent, ...r }) => r);
    return { ok: true, code: 0, stdout: JSON.stringify({ total_count: strip.length, workflow_runs: strip }), stderr: '' };
  };
  const az = async (args) => {
    calls.az.push(args.join(' '));
    if (args[2] === 'execution' && args[3] === 'list') {
      if (azListFail) return { ok: false, code: 1, stdout: '', stderr: '(AuthorizationFailed) The client does not have authorization to perform action' };
      return { ok: true, code: 0, stdout: JSON.stringify(executions), stderr: '' };
    }
    if (args[2] === 'start') {
      calls.starts += 1;
      if (startResult) return startResult;
      return { ok: true, code: 0, stdout: JSON.stringify({ name: `gh-aca-runner-kick${calls.starts}`, id: '/x' }), stderr: '' };
    }
    throw new Error(`unexpected az call: ${args.join(' ')}`);
  };
  const deps = {
    gh,
    az,
    now: () => NOW,
    sleep: async (ms) => { calls.sleeps.push(ms); },
    pause,
  };
  return { deps, calls };
}

const cfg = (over = {}) => ({ repo: REPO, subscription: '00000000-0000-0000-0000-000000000000', ...over });
const acaJob = (id, ageMin, extra = {}) => ({ id, name: `job-${id}`, status: 'queued', labels: ['self-hosted', 'loom-aca'], created_at: minsAgo(ageMin), html_url: `https://x/job/${id}`, ...extra });
const queuedRun = (id, jobs, extra = {}) => ({ id, status: 'queued', name: `wf-${id}`, created_at: minsAgo(30), jobs, ...extra });

test('a stale loom-aca job kicks EXACTLY once per tick, even with two stale jobs', async () => {
  // Breaks if: the kick threshold compare is inverted/raised above 12 min
  // (starts=0), or the per-tick cap is removed (two stale jobs -> starts=2).
  const { deps, calls } = world({ runs: [queuedRun(1, [acaJob(11, 12)]), queuedRun(2, [acaJob(21, 14)])] });
  const r = await runWatchdog(cfg(), deps);
  assert.equal(calls.starts, 1, `expected exactly one start, got ${calls.starts}`);
  assert.equal(r.outcome, 'kicked');
  assert.equal(r.exitCode, EXIT.ok);
  assert.equal(r.kick.name, 'gh-aca-runner-kick1');
  // The OLDEST stale job (21, 14 min) is the one named.
  assert.ok(r.lines.some((l) => l.startsWith('::warning::KICKED') && l.includes("execution 'gh-aca-runner-kick1'") && l.includes('(id 21)')), r.lines.join('\n'));
});

test('a fresh job does NOT kick, and age comes from the JOB created_at, not the run', async () => {
  // Breaks if: kickAfter drops to <= 5 min, or age is taken from the RUN's
  // created_at (60 min here, which would kick AND go red).
  const { deps, calls } = world({ runs: [queuedRun(1, [acaJob(11, 5)], { created_at: minsAgo(60) })] });
  const r = await runWatchdog(cfg(), deps);
  assert.equal(calls.starts, 0);
  assert.equal(r.outcome, 'clean');
  assert.equal(r.exitCode, EXIT.ok);
  // Positive half: the job WAS seen, so "clean" is not "saw nothing".
  assert.ok(r.lines.some((l) => l.includes('queued loom-aca jobs: 1')), r.lines.join('\n'));
});

test('a zero-job queued run is ignored and COUNTED as a zombie, never kicked for', async () => {
  // Breaks if: zero-job runs stop being counted (no ::notice:: naming 43097708136),
  // or one is treated as a stale job (starts=1). The zombie is 14 days old, so
  // any path that aged the RUN would also go red here.
  const zombie = { id: 43097708136, status: 'queued', name: 'deploy-staleness', created_at: '2026-11-11T08:00:00Z', jobs: [], inRecent: false };
  const { deps, calls } = world({ runs: [zombie] });
  const r = await runWatchdog(cfg(), deps);
  assert.equal(calls.starts, 0);
  assert.equal(r.exitCode, EXIT.ok);
  assert.equal(r.outcome, 'clean');
  const notice = r.lines.find((l) => l.startsWith('::notice::1 non-completed run(s) list ZERO jobs'));
  assert.ok(notice && notice.includes('43097708136'), r.lines.join('\n'));
});

test('a queued loom-aca job inside an IN_PROGRESS run is detected and kicked', async () => {
  // Breaks if: the ?status=in_progress list is dropped from the union. The run
  // is 30 h old (outside the recent page) and not `queued`, so it is reachable
  // ONLY through that list.
  const run = { id: 7, status: 'in_progress', name: 'wf-7', created_at: minsAgo(30 * 60), inRecent: false, jobs: [
    { id: 70, name: 'build', status: 'completed', labels: ['ubuntu-latest'], created_at: minsAgo(30 * 60) },
    acaJob(71, 12),
  ] };
  const { deps, calls } = world({ runs: [run] });
  const r = await runWatchdog(cfg(), deps);
  assert.equal(calls.starts, 1, r.lines.join('\n'));
  assert.equal(r.outcome, 'kicked');
});

test('a queued run MISSING from the filtered index is still found via the recent page', async () => {
  // Breaks if: the unfiltered recent-runs page is dropped (index distrust).
  const { deps, calls } = world({ runs: [queuedRun(9, [acaJob(91, 12)], { inQueuedIndex: false })] });
  const r = await runWatchdog(cfg(), deps);
  assert.equal(calls.starts, 1, r.lines.join('\n'));
});

test('a queued job with OTHER labels is ignored, while a loom-aca job beside it is not', async () => {
  // Breaks if: the label filter is removed — the 40-min ubuntu job would then
  // be counted and push the outcome to stale-red (exit 1). The loom-aca job
  // (12 min) is the positive control: it must still kick.
  const { deps, calls } = world({ runs: [queuedRun(1, [
    { id: 10, name: 'hosted', status: 'queued', labels: ['ubuntu-latest'], created_at: minsAgo(40) },
    acaJob(11, 12),
  ])] });
  const r = await runWatchdog(cfg(), deps);
  assert.equal(r.exitCode, EXIT.ok, r.lines.join('\n'));
  assert.equal(r.outcome, 'kicked');
  assert.equal(calls.starts, 1);
  assert.ok(!r.lines.some((l) => l.includes('(id 10)')), 'the hosted job must never be named');
});

test('a YOUNGER Running execution suppresses the kick; an OLDER one does not', async () => {
  // Breaks if: the in-flight check is removed (starts=1 in the first arm), or
  // it ignores startTime (the second arm, an execution started BEFORE the job
  // was queued, would then wrongly suppress -> starts=0).
  const younger = world({
    runs: [queuedRun(1, [acaJob(11, 12)])],
    executions: [{ name: 'gh-aca-runner-young', properties: { status: 'Running', startTime: minsAgo(3) } }],
  });
  const a = await runWatchdog(cfg(), younger.deps);
  assert.equal(younger.calls.starts, 0, a.lines.join('\n'));
  assert.equal(a.outcome, 'suppressed');
  assert.ok(a.lines.some((l) => l.includes('kick SUPPRESSED') && l.includes('gh-aca-runner-young')));

  const older = world({
    runs: [queuedRun(1, [acaJob(11, 12)])],
    executions: [{ name: 'gh-aca-runner-busy', properties: { status: 'Running', startTime: minsAgo(20) } }],
  });
  const b = await runWatchdog(cfg(), older.deps);
  assert.equal(older.calls.starts, 1, b.lines.join('\n'));
  assert.equal(b.outcome, 'kicked');
});

test('the two halves of "younger" are each load-bearing', async () => {
  // With the DEFAULTS (cold start 6 < kick 9) an execution started before a
  // >= 9-min-old job is always outside the 6-min window, so the started-after-
  // the-job clause cannot be told apart from the window there (an equivalent
  // mutant under defaults, measured). A 30-min window separates them.
  //
  // Arm A breaks if the started-after-the-job clause is removed: the execution
  // started 20 min ago, BEFORE the 12-min-old job, inside a 30-min window.
  const a = world({
    runs: [queuedRun(1, [acaJob(11, 12)])],
    executions: [{ name: 'gh-aca-runner-busy', properties: { status: 'Processing', startTime: minsAgo(20) } }],
  });
  const ra = await runWatchdog(cfg({ coldStartMinutes: 30 }), a.deps);
  assert.equal(a.calls.starts, 1, ra.lines.join('\n'));

  // Arm B breaks if the cold-start window is removed: the execution started 8
  // min ago, AFTER the job, but outside the 6-min window — it did not take it.
  const b = world({
    runs: [queuedRun(1, [acaJob(11, 12)])],
    executions: [{ name: 'gh-aca-runner-late', properties: { status: 'Running', startTime: minsAgo(8) } }],
  });
  const rb = await runWatchdog(cfg(), b.deps);
  assert.equal(b.calls.starts, 1, rb.lines.join('\n'));

  // Positive control: a Processing execution 2 min old DOES suppress.
  const c = world({
    runs: [queuedRun(1, [acaJob(11, 12)])],
    executions: [{ name: 'gh-aca-runner-boot', properties: { status: 'Processing', startTime: minsAgo(2) } }],
  });
  const rc = await runWatchdog(cfg(), c.deps);
  assert.equal(c.calls.starts, 0, rc.lines.join('\n'));
  assert.equal(rc.outcome, 'suppressed');
});

test('past the red threshold the run exits non-zero and NAMES the job, its age and the kick', async () => {
  // Breaks if: the red threshold is not applied (exit 0), or the message drops
  // the job id / age / execution name.
  const { deps, calls } = world({ runs: [queuedRun(1, [acaJob(11, 30)])] });
  const r = await runWatchdog(cfg(), deps);
  assert.equal(r.exitCode, EXIT.stale);
  assert.equal(r.outcome, 'stale-red');
  assert.equal(calls.starts, 1, 'a red job still gets this tick\'s kick');
  const err = r.lines.find((l) => l.startsWith('::error::loom-aca job'));
  assert.ok(err, r.lines.join('\n'));
  assert.match(err, /\(id 11\)/);
  assert.match(err, /QUEUED 30\.0 min/);
  assert.match(err, /execution 'gh-aca-runner-kick1'/);
});

test('a job between the kick and red thresholds is NOT red (24 min)', async () => {
  // Breaks if: redAfter is lowered to <= 24, or red keys on kickAfter.
  const { deps } = world({ runs: [queuedRun(1, [acaJob(11, 24)])] });
  const r = await runWatchdog(cfg(), deps);
  assert.equal(r.exitCode, EXIT.ok);
  assert.equal(r.outcome, 'kicked');
});

test('a GitHub API failure FAILS CLOSED after bounded retries, with no kick', async () => {
  // Breaks if: a gh failure is treated as "no runs" (exit 0), retries are
  // unbounded, or the watchdog kicks on an unread state.
  const { deps, calls } = world({ ghAlwaysFail: true, runs: [queuedRun(1, [acaJob(11, 30)])] });
  const r = await runWatchdog(cfg(), deps);
  assert.equal(r.exitCode, EXIT.apiUnreadable);
  assert.equal(r.outcome, 'api-unreadable');
  assert.equal(calls.gh.length, DEFAULTS.apiAttempts);
  assert.equal(calls.sleeps.length, DEFAULTS.apiAttempts - 1);
  assert.equal(calls.starts, 0);
  assert.ok(r.lines.some((l) => l.startsWith('::error::') && l.includes('FAILS CLOSED')));
});

test('a TRANSIENT GitHub failure that recovers within the bound proceeds normally', async () => {
  // Positive control for the retry: breaks if a single failure is fatal.
  const { deps, calls } = world({ ghFail: 1, runs: [queuedRun(1, [acaJob(11, 12)])] });
  const r = await runWatchdog(cfg(), deps);
  assert.equal(r.outcome, 'kicked', r.lines.join('\n'));
  assert.equal(calls.sleeps.length, 1);
});

test('an unreadable execution list FAILS CLOSED and does not kick', async () => {
  // Breaks if: an az read failure is read as "no executions in flight" and the
  // watchdog kicks anyway (starts=1) or exits 0.
  const { deps, calls } = world({ azListFail: true, runs: [queuedRun(1, [acaJob(11, 12)])] });
  const r = await runWatchdog(cfg(), deps);
  assert.equal(r.exitCode, EXIT.apiUnreadable);
  assert.equal(calls.starts, 0);
  assert.ok(r.lines.some((l) => l.includes('class=denied')), r.lines.join('\n'));
});

test('an unparseable payload is its OWN outcome (exit 3), not "nothing queued"', async () => {
  // Breaks if: a parse failure collapses to clean (exit 0) or to api-unreadable (2).
  const { deps } = world();
  deps.gh = async () => ({ ok: true, code: 0, stdout: '<html>rate limited</html>', stderr: '' });
  const r = await runWatchdog(cfg(), deps);
  assert.equal(r.exitCode, EXIT.parseFailure);
  assert.equal(r.outcome, 'parse-failure');
});

test('a failed kick exits 4 and is never retried within the tick', async () => {
  // Breaks if: a start failure is swallowed (exit 0) or retried (starts=2).
  const { deps, calls } = world({
    runs: [queuedRun(1, [acaJob(11, 12)])],
    startResult: { ok: false, code: 1, stdout: '', stderr: 'ServiceUnavailable 503' },
  });
  const r = await runWatchdog(cfg(), deps);
  assert.equal(r.exitCode, EXIT.kickFailed);
  assert.equal(calls.starts, 1);
});

test('a start that exits 0 but names no execution is NOT reported as a kick', async () => {
  // Breaks if: exit 0 alone is taken as "kicked" (R7 — the execution is unestablished).
  const { deps } = world({ runs: [queuedRun(1, [acaJob(11, 12)])], startResult: { ok: true, code: 0, stdout: '', stderr: '' } });
  const r = await runWatchdog(cfg(), deps);
  assert.equal(r.exitCode, EXIT.kickFailed);
  assert.ok(!r.lines.some((l) => l.includes('KICKED')));
});

const REGISTER = (reviewBy) => ({ paused: [{
  boundary: 'Commercial',
  owner: 'fixture-owner',
  declaredOn: '2026-11-20',
  reason: 'Fixture: the Commercial estate is stopped for a measured reason that is at least sixty characters long.',
  reviewBy,
}] });
const realPause = (register) => (today) => decidePause({ register, readError: null, boundary: 'Commercial', today });

test('a DECLARED pause stands down loudly, reads nothing and kicks nothing', async () => {
  // Breaks if: the pause is ignored (gh/az get called, a kick is made), or the
  // stand-down is silent (no ::warning:: saying UNMEASURED).
  const { deps, calls } = world({ runs: [queuedRun(1, [acaJob(11, 30)])], pause: realPause(REGISTER('2026-12-31')) });
  const r = await runWatchdog(cfg(), deps);
  assert.equal(r.outcome, 'paused');
  assert.equal(r.exitCode, EXIT.ok);
  assert.equal(calls.gh.length, 0);
  assert.equal(calls.az.length, 0);
  assert.ok(r.lines.some((l) => l.startsWith('::warning::') && l.includes('STANDING DOWN') && l.includes('UNMEASURED')));
});

test('an EXPIRED pause declaration does not stand down (control for the pause test)', async () => {
  // Breaks if: the watchdog keys on the register's mere presence rather than
  // the classifier's verdict (reviewBy 2026-11-24 < today 2026-11-25).
  const { deps, calls } = world({ runs: [queuedRun(1, [acaJob(11, 30)])], pause: realPause(REGISTER('2026-11-24')) });
  const r = await runWatchdog(cfg(), deps);
  assert.equal(r.outcome, 'stale-red');
  assert.equal(calls.starts, 1);
});

test('KICK=false observes only', async () => {
  // Breaks if: the dry-run flag is ignored (starts=1).
  const { deps, calls } = world({ runs: [queuedRun(1, [acaJob(11, 12)])] });
  const r = await runWatchdog(cfg({ kick: false }), deps);
  assert.equal(calls.starts, 0);
  assert.ok(r.lines.some((l) => l.includes('KICK=false')));
});

test('config: red must exceed kick, and a missing subscription is a usage error', async () => {
  // Breaks if: either inconsistency is accepted.
  assert.match(validateConfig({ ...DEFAULTS, repo: REPO, subscription: 's', redAfterMinutes: 9 }), /must exceed/);
  assert.match(validateConfig({ ...DEFAULTS, repo: REPO, subscription: '' }), /LOOM_ACA_SUBSCRIPTION/);
  assert.equal(validateConfig({ ...DEFAULTS, repo: REPO, subscription: 's' }), null);
  const { deps, calls } = world();
  const r = await runWatchdog({ repo: REPO, subscription: '' }, deps);
  assert.equal(r.exitCode, EXIT.usage);
  assert.equal(calls.gh.length, 0);
});
