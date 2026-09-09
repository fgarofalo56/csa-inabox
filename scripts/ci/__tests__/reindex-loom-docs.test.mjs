/**
 * End-to-end contract test for scripts/ci/reindex-loom-docs.sh (#2929).
 *
 * WHY A REAL SERVER AND REAL curl
 * -------------------------------
 * The decision logic is already unit-tested in classify-reindex-result.test.mjs.
 * What is NOT covered by that — and is exactly where this repo keeps getting
 * bitten — is the GLUE: a shell wrapper that computes a correct verdict and then
 * discards it. `|| true`, a missing `exit 1`, a `2>/dev/null`, a subshell that
 * eats the status. Those are invisible to a unit test of the classifier and to
 * any test that stubs curl, because a stub tends to model the code's
 * assumptions rather than the dependency's behaviour.
 *
 * So this drives the REAL script with the REAL `curl` binary against a REAL
 * `node:http` server that speaks the route's actual contract, and asserts on the
 * script's PROCESS EXIT CODE — the only thing a workflow step actually reads.
 *
 * MUTATION-PROOF: each `exit 1` expectation below goes RED if the corresponding
 * failure path in the script is softened (drop the `fail` after the classifier,
 * add `|| true` to the classifier call, or make the poll timeout a pass).
 *
 * Run: node --test scripts/ci/__tests__/reindex-loom-docs.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '..', 'reindex-loom-docs.sh');

/** A body the route would actually return for a GET poll. */
function pollBody({ freshness, job = 'running', chunks = 49593 }) {
  return {
    ok: true,
    backend: 'ai-search',
    job: { state: job, jobId: 'j-1', error: job === 'failed' ? 'AI Search upload failed: 403' : null },
    freshness: { state: freshness, indexedChunkCount: chunks },
    sourceFiles: 2453,
  };
}

/**
 * Stand up a console stub.
 *
 * A handler may return `{ destroy: true }` instead of a response to model a
 * poll that never gets an answer at all: the socket is torn down, `curl` prints
 * `000` for `%{http_code}`, and the script takes its `unreachable` branch. That
 * is the only way to reach that branch with a real curl, and it is load-bearing
 * — an unreachable poll observed NOTHING, so it may not sit inside a run of
 * polls the verdict claims a `stale`/`idle` reading for (#4373).
 *
 * @param {(n:number)=>{status:number,body:unknown}|{destroy:true}} onPost
 * @param {(n:number)=>{status:number,body:unknown}|{destroy:true}} onGet
 */
async function withServer(onPost, onGet, run) {
  let posts = 0;
  let gets = 0;
  const server = http.createServer((req, res) => {
    const isPost = req.method === 'POST';
    const handler = isPost ? onPost : onGet;
    const n = isPost ? ++posts : ++gets;
    const result = handler(n);
    if (result && result.destroy) {
      req.socket.destroy();
      return;
    }
    const { status, body } = result;
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(payload);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(url, () => ({ posts, gets }));
  } finally {
    // curl keeps the connection alive; without this `close` waits on an idle
    // socket and the test file never exits.
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

/**
 * Invoke the real script. MUST be async: the stub server above lives in THIS
 * process, so a synchronous `spawnSync` would block the event loop, the server
 * would never answer curl, and every case would deadlock rather than assert.
 *
 * ── THE POLL BUDGET IS ATTEMPTS, NOT SECONDS (#3942) ────────────────────────
 * `POLL_TIMEOUT_S: '6'` used to be the ONLY budget here, and the script checks
 * it at the top of each iteration — so how many polls fit inside it is decided
 * by how long one `sleep` + `curl` + `node` takes, i.e. by machine load. That
 * made two verdicts load-dependent. MEASURED, same tree, same assertions:
 *
 *     idle             "202 -> polls -> fresh -> exit 0"   PASS  8.8s,  2 polls
 *     24 busy workers  same test                           PASS  22.9s, 2 polls
 *     96 busy workers  same test                           FAIL  65.8s, 1 poll
 *
 * A test whose verdict moves with the scheduler is measuring the property PLUS
 * the machine. A bigger POLL_TIMEOUT_S would only relocate the threshold, so
 * the script gained a DETERMINISTIC second ceiling (`POLL_MAX_ATTEMPTS`,
 * unbounded by default so production is unchanged) and this harness drives
 * that instead: the wall clock is set far out of reach, and load can now only
 * make a case SLOWER, never flip it. The cases that assert a TIMEOUT get their
 * timeout from exhausting the attempts, which is the same refusal by the same
 * code path.
 *
 * @returns {Promise<{status:number, stdout:string, stderr:string}>}
 */
function runScript(url, env = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('bash', [SCRIPT], {
      env: {
        ...process.env,
        CONSOLE_URL: url,
        INTERNAL_TOKEN: 'test-token',
        // Deliberately unreachable: no case here may be decided by the clock.
        POLL_TIMEOUT_S: '600',
        POLL_INTERVAL_S: '1',
        POLL_MAX_ATTEMPTS: '4',
        // #3472 — the POST retry's backoff is production pacing, not behaviour
        // under test. Every 504 case here would otherwise pay it verbatim.
        POST_RETRY_DELAY_S: '0',
        GITHUB_OUTPUT: '', // never write to the real step output from a test
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

const ACCEPTED = { status: 202, body: { ok: true, accepted: true, state: 'running', jobId: 'j-1' } };

test('202 → polls → freshness fresh → exit 0', async () => {
  await withServer(
    () => ACCEPTED,
    (n) => ({ status: 200, body: pollBody({ freshness: n >= 2 ? 'fresh' : 'stale' }) }),
    async (url, counts) => {
      const res = await runScript(url);
      assert.equal(res.status, 0, res.stdout + res.stderr);
      assert.match(res.stdout, /FRESH index/i);
      assert.ok(counts().gets >= 2, 'must actually poll more than once');
    },
  );
});

/**
 * THE REGRESSION. This is byte-for-byte what the live console returned on
 * 2026-08-04 (run 30937670794): a 502 in ~160ms because the image shipped with
 * no staged Copilot corpus. It used to be swallowed as an honest "not
 * configured" gate, so the eval measured a stale index and reported per-surface
 * hit-rates as if they were fresh.
 */
test('502 "No corpus chunks discovered" → exit 1 (never tolerated)', async () => {
  await withServer(
    () => ({
      status: 502,
      body: {
        ok: false,
        backend: 'none',
        totalChunks: 0,
        uploaded: 0,
        byKind: {},
        warnings: [],
        error: 'No corpus chunks discovered — check that docs/ and PRPs/ exist relative to cwd',
      },
    }),
    () => ({ status: 200, body: pollBody({ freshness: 'fresh' }) }),
    async (url, counts) => {
      const res = await runScript(url);
      assert.equal(res.status, 1, res.stdout + res.stderr);
      assert.match(res.stdout, /NO CORPUS/i);
      assert.equal(counts().gets, 0, 'a failed POST must not be followed by polling');
    },
  );
});

/**
 * MUTATION-PROOF (load-bearing). Make the timeout branch a pass — in the script
 * or in classifyReindexPoll — and this goes RED. A timeout is a refusal:
 * proceeding measures the stale index the whole step exists to prevent.
 */
test('202 but never fresh → poll TIMEOUT → exit 1', async () => {
  await withServer(
    () => ACCEPTED,
    () => ({ status: 200, body: pollBody({ freshness: 'stale' }) }),
    async (url) => {
      const res = await runScript(url);
      assert.equal(res.status, 1, res.stdout + res.stderr);
      assert.match(res.stdout, /REFUSAL/i);
    },
  );
});

/**
 * "Fails fast" is a claim about how many times it POLLED, not about how many
 * milliseconds elapsed (#3760). This assertion used to read
 *
 *     assert.ok(Date.now() - started < 6000, 'must break on the failure, …');
 *
 * which is a wall-clock PROXY for that claim. The proxy correlates on an idle
 * machine and stops correlating under load — measured on one tree: 1755 ms
 * idle, 4066 ms at 8-way parallelism, 7908 ms under the tree-wide runner, i.e.
 * OVER the 6000 ms budget. Not a Windows artifact; a slow GitHub runner trips
 * it identically, and CI has simply been lucky. Three separate reviewers hit it
 * on three branches in one night and each correctly dismissed it as a flake —
 * which is the real cost, because a REAL failure in this file would now be
 * dismissed the same way.
 *
 * The behavioural measurement was already plumbed and thrown away: `withServer`
 * passes `() => ({ posts, gets })` as `run()`'s second argument (see :65) and
 * this case declared `async (url) => {…}`, never binding it. Counting the polls
 * is immune to machine load AND strictly stronger — the old assertion passed if
 * the script polled twice quickly, which is exactly the regression it exists to
 * catch.
 *
 * MUTATION-PROOF (load-bearing): make the script keep polling past a
 * `job.state: failed` and `gets` climbs to the cap, so this goes RED.
 */
test('202 then job.state failed → exit 1 (fails fast, no waiting out the cap)', async () => {
  await withServer(
    () => ACCEPTED,
    () => ({ status: 200, body: pollBody({ freshness: 'stale', job: 'failed' }) }),
    async (url, counts) => {
      const res = await runScript(url);
      assert.equal(res.status, 1, res.stdout + res.stderr);
      assert.match(res.stdout, /NOT refreshed/i);
      assert.equal(counts().gets, 1, 'must break on the failure, not poll to the cap');
    },
  );
});

/**
 * #3942 — THE BUDGET THIS SUITE RELIES ON IS THE ATTEMPT CAP, PROVED.
 *
 * The pair below is the control for the fix itself. Delete the
 * `POLL_MAX_ATTEMPTS` check from the loop in reindex-loom-docs.sh and both go
 * RED: the first would keep polling to the (600s) clock and see `fresh` on GET
 * #6, and the second would poll past 5. They are also the reason the harness's
 * unreachable POLL_TIMEOUT_S is safe — if the clock ever became the governing
 * ceiling again, these say so immediately rather than the whole file becoming
 * load-dependent again in silence.
 */
test('#3942 the ATTEMPT cap governs: exhausting it is the refusal, not the clock', async () => {
  await withServer(
    () => ACCEPTED,
    (n) => ({ status: 200, body: pollBody({ freshness: n >= 6 ? 'fresh' : 'stale' }) }),
    async (url, counts) => {
      const res = await runScript(url, { POLL_MAX_ATTEMPTS: '2', POLL_TIMEOUT_S: '600' });
      assert.equal(res.status, 1, res.stdout + res.stderr);
      assert.equal(counts().gets, 2, 'must stop at the attempt cap, not run to the 600s clock');
      assert.match(res.stdout, /REFUSAL/i);
      assert.match(res.stdout, /2 poll\(s\)/, 'the verdict must name the ceiling that actually tripped');
    },
  );
});

test('#3942 within the attempt cap a late `fresh` still passes — load can only slow it', async () => {
  await withServer(
    () => ACCEPTED,
    (n) => ({ status: 200, body: pollBody({ freshness: n >= 4 ? 'fresh' : 'stale' }) }),
    async (url, counts) => {
      const res = await runScript(url, { POLL_MAX_ATTEMPTS: '5', POLL_TIMEOUT_S: '600' });
      assert.equal(res.status, 0, res.stdout + res.stderr);
      assert.equal(counts().gets, 4, 'four polls were needed and four were available');
      assert.match(res.stdout, /FRESH index/i);
    },
  );
});

test('401 (token mismatch) → exit 1 — the reindex never ran', async () => {
  await withServer(
    () => ({ status: 401, body: { ok: false, error: 'unauthenticated' } }),
    () => ({ status: 200, body: pollBody({ freshness: 'fresh' }) }),
    async (url) => {
      assert.equal((await runScript(url)).status, 1);
    },
  );
});

/** A pre-#2929 console rebuilds inline and answers 200. Complete already. */
test('200 (legacy inline console) → exit 0 and does NOT poll', async () => {
  await withServer(
    () => ({
      status: 200,
      body: { ok: true, backend: 'ai-search', totalChunks: 49593, uploaded: 49593, byKind: {}, warnings: [] },
    }),
    () => ({ status: 200, body: pollBody({ freshness: 'fresh' }) }),
    async (url, counts) => {
      const res = await runScript(url);
      assert.equal(res.status, 0, res.stdout + res.stderr);
      assert.equal(counts().gets, 0);
    },
  );
});

/** An unset secret is an honest gate, not a broken index — and must not poll. */
test('no INTERNAL_TOKEN → warn + exit 0, no request at all', async () => {
  await withServer(
    () => ACCEPTED,
    () => ({ status: 200, body: pollBody({ freshness: 'fresh' }) }),
    async (url, counts) => {
      const res = await runScript(url, { INTERNAL_TOKEN: '' });
      assert.equal(res.status, 0, res.stdout + res.stderr);
      assert.match(res.stdout, /::warning::.*LOOM_INTERNAL_TOKEN/);
      assert.equal(counts().posts + counts().gets, 0);
    },
  );
});

/**
 * FATAL=false is the post-deploy bootstrap's documented non-blocking contract.
 * It may only change the EXIT CODE, and it must say so out loud — a silent
 * downgrade would be indistinguishable from a gate that cannot fail.
 */
test('FATAL=false downgrades a real failure to a loud warning (bootstrap contract)', async () => {
  await withServer(
    () => ({ status: 502, body: { ok: false, error: 'No corpus chunks discovered — …' } }),
    () => ({ status: 200, body: pollBody({ freshness: 'fresh' }) }),
    async (url) => {
      const res = await runScript(url, { FATAL: 'false' });
      assert.equal(res.status, 0, res.stdout + res.stderr);
      assert.match(res.stdout, /NO CORPUS/i, 'the real verdict is still printed');
      assert.match(res.stdout, /::warning::.*non-blocking/i);
    },
  );
});

/** FATAL defaults to fatal: a new call site cannot silently opt out. */
test('FATAL defaults to true (opt-out must be explicit)', async () => {
  await withServer(
    () => ({ status: 500, body: { ok: false, error: 'kaboom' } }),
    () => ({ status: 200, body: pollBody({ freshness: 'fresh' }) }),
    async (url) => {
      assert.equal((await runScript(url)).status, 1);
    },
  );
});

test('missing CONSOLE_URL is a hard error, not a silent skip', async () => {
  const res = await runScript('', { CONSOLE_URL: '', INTERNAL_TOKEN: 'x' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /CONSOLE_URL/);
});

// ── gateway 504 on the POST → POLL, do not guess (#3396) ─────────────────────
//
// The pair below is the whole point: the SAME edge failure resolves to pass or
// fail purely on what the durable freshness signal turns out to say. If either
// case ever stops depending on the poll, the tolerance has become a hole.

const EDGE_504 = { status: 504, body: '<!DOCTYPE html><HTML><TITLE>The request timed out.</TITLE></HTML>' };

test('504 gateway on POST → DOES poll → freshness fresh → exit 0', async () => {
  await withServer(
    () => EDGE_504,
    () => ({ status: 200, body: pollBody({ freshness: 'fresh' }) }),
    async (url, counts) => {
      const res = await runScript(url);
      assert.equal(res.status, 0);
      // The load-bearing assertion: it must actually have GONE AND LOOKED.
      assert.ok(counts().gets > 0, 'expected the 504 to fall through to the poll, but it never polled');
      assert.match(res.stdout, /UNKNOWN/);
    },
  );
});

test('504 gateway on POST → polls → never fresh → exit 1 (tolerance is not a pass)', async () => {
  await withServer(
    () => EDGE_504,
    () => ({ status: 200, body: pollBody({ freshness: 'stale' }) }),
    async (url, counts) => {
      const res = await runScript(url);
      assert.equal(res.status, 1);
      assert.ok(counts().gets > 0, 'expected it to poll before failing');
    },
  );
});

// ── #3472 — THE 904-SECOND RED THAT DESCRIBED THE WRONG THING ────────────────
//
// copilot-quality-evals run 33472611043 (2026-09-01, main): the POST got a
// gateway 504, then 57 polls over 904s each read `freshness=stale job=idle`,
// then the wall clock refused with "did not reach a fresh state within 904s".
// Two defects in one run: the trigger was never retried, and the verdict named
// the rebuild's DURATION for a rebuild that was never accepted.
//
// The fixture below replays exactly that server behaviour. Both new properties
// are asserted on the PROCESS, which is the only thing the workflow reads.
//
// WHAT THIS DELIBERATELY DOES NOT DO — AND A COUNTERFACTUAL THAT PROVES WHY.
// The first revision of this change ENDED the wait on the idle streak. Review
// of PR #4373 measured the cost with this same harness: POST always edge-504,
// GET `stale`/`idle`/unmoving for polls 1-8 then `fresh` at poll 9 — the shape
// reindex-job.ts documents for a healthy rebuild running on ANOTHER replica —
// gave exit 0 / 9 polls at head and exit 1 / 8 polls with the early exit. At
// the production POLL_INTERVAL_S=15 that fires at ~120s of a 900s budget. So
// the streak now only decides the failure's NAME, evaluated after the loop.
// `#3472 a rebuild that converges LATE still passes` below is that
// counterfactual, kept as a permanent regression test.

/** The GET body all 57 of that run's polls returned. */
const STALE_IDLE = { status: 200, body: pollBody({ freshness: 'stale', job: 'idle' }) };

test('#3472 replay of run 33472611043: retries the POST once, then renames the timeout trigger_refused', async () => {
  await withServer(
    () => EDGE_504,
    () => STALE_IDLE,
    async (url, counts) => {
      const res = await runScript(url, { REFUSED_IDLE_POLLS: '4', POLL_MAX_ATTEMPTS: '12' });
      // Fail-closed is the invariant this may NOT touch.
      assert.equal(res.status, 1, res.stdout + res.stderr);
      // (a) ONE retry — not zero (the head behaviour), not a loop. The pre-retry
      // probe costs a GET first, so GETs = 1 probe + 12 polls.
      assert.equal(counts().posts, 2, 'the indeterminate POST must be retried exactly once');
      // (b) THE WAIT IS NOT SHORTENED. The streak of 4 is reached at poll 4 and
      // the loop still runs to its 12-attempt ceiling. Re-introduce the `break`
      // and this goes RED at 5.
      assert.equal(counts().gets, 13, 'the streak names the failure; it must not end the wait');
      assert.match(res.stdout, /TRIGGER REFUSED/);
      assert.match(res.stdout, /REQUEST-PATH problem, not a slow rebuild/i);
      assert.match(res.stdout, /2 POST attempt\(s\)/);
      assert.match(res.stdout, /RENAME, not a shortcut/);
    },
  );
});

/**
 * THE COUNTERFACTUAL FROM THE #4373 REVIEW, as a permanent regression test.
 *
 * Every POST is refused at the edge and every poll reads exactly the
 * `stale`/`idle`/unmoving-chunk-count signature the early exit keyed on — for
 * EIGHT polls, the shipped default — and then the rebuild converges at poll 9.
 * That is not a hypothetical: reindex-job.ts's own "REPLICA SCOPE" banner says
 * a poll can land on a replica that never ran the job and read `idle` forever
 * while the rebuild proceeds elsewhere, and `job.state` misses a live worker
 * for 8 consecutive polls ~23% of the time at the 6-replica ceiling.
 *
 * MUTATION-PROOF: re-introduce the in-loop `OUTCOME=trigger_refused; break` and
 * this goes RED with status 1 at 8 polls (measured: exactly that, before the
 * fix). The run MUST pass, because the index did in fact converge.
 */
test('#3472 a rebuild that converges LATE still passes (no early exit on the idle streak)', async () => {
  await withServer(
    () => EDGE_504,
    // GET 1 is the pre-retry probe; polls are GETs 2..N. Fresh on the 9th POLL.
    (n) => ({ status: 200, body: pollBody({ freshness: n >= 10 ? 'fresh' : 'stale', job: 'idle' }) }),
    async (url, counts) => {
      const res = await runScript(url, { POLL_MAX_ATTEMPTS: '12' }); // DEFAULT streak of 8
      assert.equal(res.status, 0, res.stdout + res.stderr);
      assert.equal(counts().gets, 10, 'the wait must survive 8 idle polls and see the 9th');
      assert.match(res.stdout, /FRESH index/i);
      assert.doesNotMatch(res.stdout, /TRIGGER REFUSED/);
    },
  );
});

/**
 * MUTATION-PROOF (the latch). `job.state` is the ANSWERING replica's view, so
 * seeing `running` proves a rebuild exists while never seeing it proves nothing
 * — the rename must therefore be permanently disabled by a single sighting.
 * Delete the SAW_RUNNING latch and this goes RED: with REFUSED_IDLE_POLLS=2 the
 * trailing streak reaches 2 and the verdict would be renamed.
 */
test('#3472 one sighting of job=running disables the rename for the whole run', async () => {
  await withServer(
    () => EDGE_504,
    // GET 1 is the pre-retry probe (idle, so the retry proceeds); the first POLL
    // is GET 2 and that is the one that reports `running`.
    (n) => ({ status: 200, body: pollBody({ freshness: 'stale', job: n === 2 ? 'running' : 'idle' }) }),
    async (url, counts) => {
      const res = await runScript(url, { REFUSED_IDLE_POLLS: '2', POLL_MAX_ATTEMPTS: '4' });
      assert.equal(res.status, 1, res.stdout + res.stderr);
      assert.equal(counts().gets, 5, '1 pre-retry probe + the full 4-poll wait');
      assert.match(res.stdout, /REFUSAL/i);
      assert.doesNotMatch(res.stdout, /TRIGGER REFUSED/);
    },
  );
});

/**
 * MUTATION-PROOF (the precondition). A NORMAL 202 followed by slow polls is the
 * healthy long rebuild: no POST was refused, so the refused-trigger name cannot
 * apply however idle the polls look. Drop the POST_REFUSED precondition and this
 * goes RED.
 */
test('#3472 an ACCEPTED (202) POST is never named trigger_refused, however idle the polls look', async () => {
  await withServer(
    () => ACCEPTED,
    () => STALE_IDLE,
    async (url, counts) => {
      const res = await runScript(url, { REFUSED_IDLE_POLLS: '2', POLL_MAX_ATTEMPTS: '4' });
      assert.equal(res.status, 1, res.stdout + res.stderr);
      // No 504 => no retry => no pre-retry probe. GETs are polls only.
      assert.equal(counts().gets, 4, 'an accepted trigger must be given the whole budget');
      assert.doesNotMatch(res.stdout, /TRIGGER REFUSED/);
    },
  );
});

/**
 * The retry's PAYOFF, and the reason it is worth doing at all: when the first
 * POST was an edge blip the second one is answered by the console, the run
 * rejoins the normal path and PASSES. RED at head, where there is no attempt 2.
 *
 * The pre-retry probe (GET 1) must read `idle` here, or the retry is correctly
 * skipped — see the next test for that half.
 */
test('#3472 the retry recovers a one-off edge blip: 504 then 202 → fresh → exit 0', async () => {
  await withServer(
    (n) => (n === 1 ? EDGE_504 : ACCEPTED),
    (n) => ({
      status: 200,
      body: pollBody({ freshness: n >= 3 ? 'fresh' : 'stale', job: 'idle' }),
    }),
    async (url, counts) => {
      const res = await runScript(url);
      assert.equal(res.status, 0, res.stdout + res.stderr);
      assert.equal(counts().posts, 2, 'the second attempt is what turned the unknown into a 202');
      assert.match(res.stdout, /FRESH index/i);
    },
  );
});

/**
 * THE RETRY IS NOT FREE, AND THIS IS THE GUARD THAT ADMITS IT (#4373 review).
 *
 * The first revision printed "the route is idempotent-by-restart, so this cannot
 * start a second concurrent rebuild". Refuted by this repo's own sources: the
 * in-flight guard is `startReindexJob()`, which is REPLICA-SCOPED in-memory
 * state (lib/azure/reindex-job.ts "REPLICA SCOPE"), front-door.bicep sets
 * `sessionAffinityState:'Disabled'` and admin-plane/main.bicep runs minReplicas
 * 2 / maxReplicas 6 — so a retry lands on a different replica with probability
 * (r-1)/r and can start a SECOND concurrent rebuild racing the shared manifest.
 *
 * So the retry PROBES first. A visible rebuild means the extra POST buys
 * nothing the poll will not give us, and it is skipped.
 *
 * MUTATION-PROOF: delete the probe (or its skip branch) and posts becomes 2.
 */
test('#3472/#4373 a rebuild already visible on the status probe SKIPS the retry POST', async () => {
  await withServer(
    () => EDGE_504,
    (n) => ({ status: 200, body: pollBody({ freshness: n >= 3 ? 'fresh' : 'stale', job: 'running' }) }),
    async (url, counts) => {
      const res = await runScript(url, { POLL_MAX_ATTEMPTS: '6' });
      assert.equal(res.status, 0, res.stdout + res.stderr);
      assert.equal(counts().posts, 1, 'a second POST could start a second concurrent rebuild');
      assert.match(res.stdout, /NOT retrying the reindex POST/);
      assert.match(res.stdout, /FRESH index/i);
    },
  );
});

/** The corrected claim must actually be IN the log the operator reads (R7). */
test('#4373 the retry notice discloses the replica-scoped guard instead of claiming safety', async () => {
  await withServer(
    () => EDGE_504,
    () => STALE_IDLE,
    async (url) => {
      const res = await runScript(url, { POLL_MAX_ATTEMPTS: '2' });
      assert.equal(res.status, 1, res.stdout + res.stderr);
      assert.match(res.stdout, /MAY start a second concurrent rebuild/);
      assert.match(res.stdout, /replica-scoped/i);
      assert.doesNotMatch(res.stdout, /cannot start a second concurrent rebuild/);
    },
  );
});

/**
 * The DEFAULT must not be trigger-happy, and it must be PINNED — a reviewer
 * measured that the whole suite still passed with the shipped default lowered
 * from 8 to 5, i.e. the exact knob the replica-miss math is about was only
 * pinned to ">4". These two cases pin it to EXACTLY 8 from behaviour: a
 * trailing streak of 7 must NOT rename, a trailing streak of 8 must.
 */
test('#3472 the DEFAULT REFUSED_IDLE_POLLS does not rename on a streak of 7', async () => {
  await withServer(
    () => EDGE_504,
    () => STALE_IDLE,
    async (url, counts) => {
      const res = await runScript(url, { POLL_MAX_ATTEMPTS: '7' }); // no REFUSED_IDLE_POLLS
      assert.equal(res.status, 1, res.stdout + res.stderr);
      assert.equal(counts().gets, 8, '1 pre-retry probe + 7 polls');
      assert.doesNotMatch(res.stdout, /TRIGGER REFUSED/);
    },
  );
});

test('#3472 the DEFAULT REFUSED_IDLE_POLLS renames on a streak of exactly 8', async () => {
  await withServer(
    () => EDGE_504,
    () => STALE_IDLE,
    async (url, counts) => {
      const res = await runScript(url, { POLL_MAX_ATTEMPTS: '8' }); // no REFUSED_IDLE_POLLS
      assert.equal(res.status, 1, res.stdout + res.stderr);
      assert.equal(counts().gets, 9, '1 pre-retry probe + 8 polls');
      assert.match(res.stdout, /TRIGGER REFUSED/);
    },
  );
});

/**
 * The chunk-count clause. It is the weakest of the three conditions (the corpus
 * manifest is written only at the END of a rebuild, so the count does not move
 * mid-run either way) — but a count that DOES move means something is writing,
 * and that must restart the streak. Delete the comparison and this goes RED.
 */
test('#3472 a MOVING indexedChunkCount restarts the streak', async () => {
  await withServer(
    () => EDGE_504,
    (n) => ({ status: 200, body: pollBody({ freshness: 'stale', job: 'idle', chunks: 49593 + n }) }),
    async (url, counts) => {
      const res = await runScript(url, { REFUSED_IDLE_POLLS: '2', POLL_MAX_ATTEMPTS: '4' });
      assert.equal(res.status, 1, res.stdout + res.stderr);
      assert.equal(counts().gets, 5, '1 pre-retry probe + 4 polls');
      assert.doesNotMatch(res.stdout, /TRIGGER REFUSED/, 'the count moved every poll — no streak of 2 completes');
    },
  );
});

/**
 * THE STREAK MUST BE TRAILING, AND NOTHING TESTED THAT (#4373 review §3).
 *
 * `else IDLE_STREAK=0` is the ONE line that makes the streak a trailing run
 * rather than a cumulative tally. The reviewer deleted it and the whole 27-case
 * suite still passed — a guard with no test on its own defining property, which
 * is this repo's most-repeated defect shape.
 *
 * The discriminating fixture is a run where the CUMULATIVE idle count clears the
 * threshold but the TRAILING run does not: threshold 3, five idle polls in
 * total, and a non-idle poll third-from-last so only 2 idle polls trail. The
 * interrupting poll reports a body with `job.state` ABSENT (`job=unknown`) —
 * a real shape, and one that is neither `idle` (so it cannot extend the streak)
 * nor `running` (so it must not trip the SAW_RUNNING latch and mask the
 * property under test).
 *
 * MUTATION-PROOF: delete `else IDLE_STREAK=0` and the streak becomes the
 * cumulative 5, clears the threshold of 3, and this goes RED on
 * `TRIGGER REFUSED`.
 */
test('#4373 the streak must be TRAILING: 5 idle polls broken 3rd-from-last do NOT rename', async () => {
  const NO_JOB_STATE = {
    status: 200,
    body: {
      ok: true,
      backend: 'ai-search',
      job: { jobId: null, error: null },
      freshness: { state: 'stale', indexedChunkCount: 49593 },
    },
  };
  await withServer(
    () => EDGE_504,
    // GET 1 is the pre-retry probe; polls are GETs 2..7.
    // polls 1-3 idle (streak 3), poll 4 job.state absent (streak 0),
    // polls 5-6 idle (streak 2). Cumulative idle = 5, trailing = 2.
    (n) => (n === 5 ? NO_JOB_STATE : STALE_IDLE),
    async (url, counts) => {
      const res = await runScript(url, { REFUSED_IDLE_POLLS: '3', POLL_MAX_ATTEMPTS: '6' });
      assert.equal(res.status, 1, res.stdout + res.stderr);
      assert.equal(counts().gets, 7, '1 pre-retry probe + 6 polls');
      assert.doesNotMatch(
        res.stdout,
        /TRIGGER REFUSED/,
        'the trailing run is 2, below the threshold of 3 — only a CUMULATIVE tally would rename',
      );
      // And the verdict it does get is the ordinary ceiling refusal.
      assert.match(res.stdout, /did NOT reach a fresh state/);
    },
  );
});

/**
 * THE VERDICT MAY ONLY CLAIM THE POLLS THAT PRODUCED THE READING (#4373 review §2).
 *
 * The message asserts `freshness=stale job=idle with the indexed chunk count
 * unchanged`. The shell establishes that for the TRAILING streak; it was handing
 * the classifier `POLL_ATTEMPTS`, i.e. EVERY poll, including ones that read
 * something else. The reviewer measured the exact sentence at 10 claimed / 8
 * observed. `POLL_IDLE_STREAK` is now plumbed through and the message names it.
 *
 * Fixture: polls 1-2 report a body with `job.state` absent, polls 3-10 are the
 * normal `stale`/`idle`/49593. 10 polls, of which 8 trail.
 *
 * MUTATION-PROOF: stop passing POLL_IDLE_STREAK (or pass ATTEMPTS as it) and the
 * message reads "the LAST 10 of 10" / drops the number — RED either way.
 */
test('#4373 the verdict names the TRAILING streak (8), not every poll (10)', async () => {
  const NO_JOB_STATE = {
    status: 200,
    body: {
      ok: true,
      backend: 'ai-search',
      job: { jobId: null, error: null },
      freshness: { state: 'stale', indexedChunkCount: 49593 },
    },
  };
  await withServer(
    () => EDGE_504,
    // GET 1 = pre-retry probe. Polls are GETs 2..11; GETs 2-3 are the two that
    // never report a job state.
    (n) => (n <= 3 && n >= 2 ? NO_JOB_STATE : STALE_IDLE),
    async (url, counts) => {
      const res = await runScript(url, { REFUSED_IDLE_POLLS: '4', POLL_MAX_ATTEMPTS: '10' });
      assert.equal(res.status, 1, res.stdout + res.stderr);
      assert.equal(counts().gets, 11, '1 pre-retry probe + 10 polls');
      assert.match(res.stdout, /TRIGGER REFUSED/);
      assert.match(res.stdout, /Of the 10 poll\(s\) over \d+s that followed, the LAST 8 read/);
      // The refuted sentence shape: the total presented as the polls that read
      // stale/idle. This is the string the reviewer measured.
      assert.doesNotMatch(res.stdout, /10 poll\(s\) over \d+s since then read freshness=stale/);
    },
  );
});

/**
 * PER-ATTEMPT STATUS CODES (#4373 review §4). `POST_CODE` is only the LAST
 * attempt's status, and the sentence around it is plural — so a 504 then a 502
 * was reported as "All 2 POST attempt(s) were answered by the EDGE (HTTP 502…)",
 * attributing one sample to both. The shell now collects every attempt's code.
 *
 * MUTATION-PROOF: stop collecting POST_CODES and the message falls back to the
 * last code alone — no `504 then 502`.
 */
test('#4373 the verdict names EVERY POST attempt\'s status, not just the last', async () => {
  await withServer(
    (n) => (n === 1 ? EDGE_504 : { status: 502, body: '<html><title>502 Bad Gateway</title></html>' }),
    () => STALE_IDLE,
    async (url, counts) => {
      const res = await runScript(url, { REFUSED_IDLE_POLLS: '2', POLL_MAX_ATTEMPTS: '4' });
      assert.equal(res.status, 1, res.stdout + res.stderr);
      assert.equal(counts().posts, 2, 'both POSTs were indeterminate gateway answers');
      assert.match(res.stdout, /TRIGGER REFUSED/);
      assert.match(res.stdout, /HTTP 504 then 502, one per attempt/);
    },
  );
});

/**
 * AN UNREACHABLE POLL OBSERVED NOTHING, SO IT MAY NOT SIT INSIDE THE CLAIM
 * (#4373 review §2, the other half).
 *
 * The `curl 000` branch used to `continue` past the streak bookkeeping
 * entirely, so a poll that never got a body neither extended nor broke the
 * trailing run — it was simply invisible to it. The verdict then asserted
 * `freshness=stale job=idle` for a span of polls one of which read nothing at
 * all. Resetting is the honest reading: no observation breaks the run exactly
 * as a different observation does.
 *
 * MUTATION-PROOF: delete the `IDLE_STREAK=0` before that `continue` and the
 * trailing run spans the dead poll, reaching 5 against a threshold of 3 — RED
 * on `TRIGGER REFUSED`.
 */
test('#4373 an UNREACHABLE poll breaks the trailing streak (it observed nothing)', async () => {
  await withServer(
    () => EDGE_504,
    // GET 1 = pre-retry probe; polls are GETs 2..7. GET 5 (poll 4) is answered
    // by tearing down the socket, which is what a real curl 000 looks like.
    (n) => (n === 5 ? { destroy: true } : STALE_IDLE),
    async (url, counts) => {
      const res = await runScript(url, { REFUSED_IDLE_POLLS: '3', POLL_MAX_ATTEMPTS: '6' });
      assert.equal(res.status, 1, res.stdout + res.stderr);
      assert.equal(counts().gets, 7, '1 pre-retry probe + 6 polls');
      assert.match(res.stdout, /poll: unreachable \(curl 000\)/, 'the 000 branch must actually be taken');
      assert.doesNotMatch(
        res.stdout,
        /TRIGGER REFUSED/,
        'only 2 polls trail the dead one — a streak that ignored it would reach 5',
      );
    },
  );
});

/**
 * The retry is scoped to the INDETERMINATE answer only. A 401 is the console
 * ANSWERING; retrying it would only delay a verdict already given.
 */
test('#3472 a console ANSWER (401) is not retried', async () => {
  await withServer(
    () => ({ status: 401, body: { ok: false, error: 'unauthenticated' } }),
    () => STALE_IDLE,
    async (url, counts) => {
      const res = await runScript(url);
      assert.equal(res.status, 1, res.stdout + res.stderr);
      assert.equal(counts().posts, 1, 'only a gateway 5xx is indeterminate enough to re-sample');
      assert.equal(counts().gets, 0, 'and no probe either — the console already answered');
    },
  );
});

/**
 * POST_RETRIES=0 makes ONE attempt, and the verdict must say ONE. The #4373
 * review measured the first revision printing "All 1 POST attempt(s)" under a
 * comment that claimed "one refused POST is not enough evidence to stop
 * waiting" — a guard the code never had. The comment is now corrected and the
 * behaviour is pinned here: a single-attempt run is still named, and it names
 * its own evidence honestly rather than inheriting a count of 2.
 */
test('#4373 POST_RETRIES=0 makes one attempt and the verdict reports one', async () => {
  await withServer(
    () => EDGE_504,
    () => STALE_IDLE,
    async (url, counts) => {
      const res = await runScript(url, { POST_RETRIES: '0', POLL_MAX_ATTEMPTS: '8' });
      assert.equal(res.status, 1, res.stdout + res.stderr);
      assert.equal(counts().posts, 1, 'POST_RETRIES=0 disables the retry');
      assert.equal(counts().gets, 8, 'and with no retry there is no pre-retry probe either');
      assert.match(res.stdout, /All 1 POST attempt\(s\)/);
      assert.doesNotMatch(res.stdout, /All 2 POST attempt/);
    },
  );
});

/**
 * The verdict's own wording is an assertion: it says "with the indexed chunk
 * count unchanged". A console body that reports no count cannot support that
 * sentence, so the rename must not fire on one — the verdict stays `timeout`.
 * Drop the `-n "$CHUNKS"` guard and this goes RED.
 */
test('#3472 no indexedChunkCount reported → no rename (the verdict would be claiming evidence it lacks)', async () => {
  await withServer(
    () => EDGE_504,
    () => ({
      status: 200,
      body: { ok: true, backend: 'ai-search', job: { state: 'idle', jobId: null, error: null }, freshness: { state: 'stale' } },
    }),
    async (url, counts) => {
      const res = await runScript(url, { REFUSED_IDLE_POLLS: '2', POLL_MAX_ATTEMPTS: '4' });
      assert.equal(res.status, 1, res.stdout + res.stderr);
      assert.equal(counts().gets, 5, '1 pre-retry probe + 4 polls');
      assert.doesNotMatch(res.stdout, /TRIGGER REFUSED/);
    },
  );
});

/**
 * ── #4373 review, BLOCKER 1 — THE RETRY MUST NEVER ERASE THE POLL ────────────
 *
 * `POLL_ANYWAY` used to be derived from the FINAL POST attempt's classifier exit
 * code alone. Attempt 1 = the indeterminate gateway 504 (exit 75, which this
 * script's own contract says MUST fall through to the poll); attempt 2 = a curl
 * `000`, which the classifier TOLERATES on its own. Final code 0, `CODE` not
 * 202, so the script emitted `reindex_poll=not-applicable` and exited 0 having
 * polled ZERO times — the evals then measure the stale index this whole file
 * exists to prevent.
 *
 * MEASURED with this harness, same fixture, three trees:
 *   origin/main            exit 1, 1 POST, 4 real polls
 *   PR head 94e0a97        exit 0, 2 POSTs, 1 GET (the probe), NO polls
 *   with SAW_INDETERMINATE exit 1, 2 POSTs, 1 probe + 4 real polls
 *
 * `{ destroy: true }` on attempt 2 is a REAL curl 000 (the socket is torn
 * down), not a stub of one — the retry only fires when the request path is
 * already misbehaving, so a connect failure is the likeliest second sample.
 *
 * MUTATION-PROOF: delete the `SAW_INDETERMINATE` latch (or its clause in the
 * `POLL_ANYWAY` decision) and this goes RED on `status` 0 !== 1 with `gets` 1.
 */
test('#4373 a retry that never connects does NOT erase the poll (indeterminate is latched)', async () => {
  await withServer(
    (n) => (n === 1 ? EDGE_504 : { destroy: true }),
    () => STALE_IDLE,
    async (url, counts) => {
      // REFUSED_IDLE_POLLS is set BELOW the poll count on purpose. With the
      // shipped default of 8 against POLL_MAX_ATTEMPTS=4 the TRIGGER REFUSED
      // assertion below is unreachable for a reason that has nothing to do with
      // POST_REFUSED — the threshold is simply never met — so it reads as a pin
      // while pinning nothing. At 3 the rename becomes available and the
      // assertion is load-bearing: injecting POST_REFUSED=true on the
      // non-answer branch reds this test.
      const res = await runScript(url, { POLL_MAX_ATTEMPTS: '4', REFUSED_IDLE_POLLS: '3' });
      assert.equal(res.status, 1, res.stdout + res.stderr);
      assert.equal(counts().posts, 2, 'the indeterminate 504 is re-sampled');
      assert.equal(counts().gets, 5, '1 pre-retry probe + 4 REAL polls — not the probe alone');
      assert.match(res.stdout, /did NOT settle attempt 1's gateway answer/);
      assert.match(res.stdout, /did NOT reach a fresh state/);
      assert.doesNotMatch(
        res.stdout,
        /not-applicable/,
        'a tolerated non-answer must not discharge the indeterminate observation',
      );
      // POST_REFUSED requires EVERY attempt to have been an edge refusal, and
      // attempt 2 was not one. The rename must therefore be unavailable here.
      assert.doesNotMatch(res.stdout, /TRIGGER REFUSED/);
    },
  );
});

/**
 * ...AND THE LATCH IS SCOPED TO A NON-ANSWER, DELIBERATELY.
 *
 * A retry the CONSOLE answered RESOLVES the unknown rather than discarding it.
 * An honest not-configured 5xx means the backing infra is not provisioned, so
 * no rebuild can be in flight on any replica and `fresh` will never arrive:
 * polling it to the ceiling would convert today's honest gate (exit 0 + a loud
 * warning, per no-vaporware.md) into a false red — the same class of defect
 * round 2 of this review blocked when it measured the early exit turning a pass
 * into a fail.
 *
 * MUTATION-PROOF IN THE OTHER DIRECTION: widen the latch to `SAW_INDETERMINATE`
 * regardless of the final code and this goes RED (exit 1, 4 polls).
 */
test('#4373 an honest not-configured retry answer is NOT polled to a red', async () => {
  await withServer(
    (n) =>
      n === 1
        ? EDGE_504
        : { status: 502, body: { ok: false, error: 'LOOM_AI_SEARCH_SERVICE is not configured' } },
    () => STALE_IDLE,
    async (url, counts) => {
      const res = await runScript(url, { POLL_MAX_ATTEMPTS: '4' });
      assert.equal(res.status, 0, res.stdout + res.stderr);
      assert.equal(counts().posts, 2);
      assert.equal(counts().gets, 1, 'the pre-retry probe only — the console ANSWERED, so nothing is unresolved');
      assert.match(res.stdout, /honest-gated/);
    },
  );
});

/**
 * ── #4373 review §S1 — THE BODY FILE IS TRUNCATED PER ATTEMPT ────────────────
 *
 * `curl -o` does not empty the file when the transfer fails, so before the fix
 * the retry's log read, verbatim:
 *
 *     reindex POST http://…/api/help-copilot/reindex -> HTTP 000
 *     <!DOCTYPE html><HTML><TITLE>The request timed out.</TITLE></HTML>
 *
 * i.e. attempt 1's gateway body printed under attempt 2's status, and the same
 * stale body handed to the classifier as `RESP_BODY`.
 *
 * MUTATION-PROOF: remove `: > "$POST_BODY_FILE"` from `do_post` and this reds.
 */
test('#4373 a retry that never connects does not print the PREVIOUS attempt\'s body', async () => {
  await withServer(
    (n) => (n === 1 ? EDGE_504 : { destroy: true }),
    () => STALE_IDLE,
    async (url) => {
      const res = await runScript(url, { POLL_MAX_ATTEMPTS: '1' });
      assert.match(res.stdout, /-> HTTP 000/, 'the retry must actually have failed to connect');
      assert.doesNotMatch(
        res.stdout,
        /-> HTTP 000\r?\n\s*<!DOCTYPE/,
        "attempt 1's gateway body was attributed to attempt 2",
      );
    },
  );
});

/**
 * ── #4373 review §S2 — THE PROBE'S SAW_RUNNING SEED IS WHAT KEEPS THE ────────
 * ── RENAME HONEST WHEN EVERY LATER POLL READS idle ──────────────────────────
 *
 * The `trigger_refused` verdict asserts the rebuild "was never OBSERVED to be
 * accepted or running". The pre-retry probe is an observation like any other,
 * so a `running` sighting there must disable the rename for the whole run —
 * even though every subsequent poll reads `stale`/`idle` and the trailing
 * streak clears the threshold. Until now that seeding was only exercised
 * through the skip branch, on a run that then went `fresh` anyway.
 *
 * Here the probe sees `running` (retry skipped) and then every poll reads
 * `stale`/`idle`/49593 forever: the streak reaches 4 against a threshold of 3,
 * and the verdict must still be the ordinary ceiling refusal.
 *
 * MUTATION-PROOF: delete the probe's `SAW_RUNNING=true` and `TRIGGER REFUSED`
 * is printed instead — a sentence refuted by a line in the same log.
 */
test('#4373 a probe sighting of job=running blocks the rename even if every poll then reads idle', async () => {
  await withServer(
    () => EDGE_504,
    (n) => (n === 1 ? { status: 200, body: pollBody({ freshness: 'stale', job: 'running' }) } : STALE_IDLE),
    async (url, counts) => {
      const res = await runScript(url, { REFUSED_IDLE_POLLS: '3', POLL_MAX_ATTEMPTS: '4' });
      assert.equal(res.status, 1, res.stdout + res.stderr);
      assert.equal(counts().posts, 1, 'the probe saw a rebuild, so the retry is skipped');
      assert.equal(counts().gets, 5, '1 pre-retry probe + 4 polls');
      assert.match(res.stdout, /pre-retry probe: HTTP 200 freshness=stale job=running/);
      assert.doesNotMatch(
        res.stdout,
        /TRIGGER REFUSED/,
        'a rebuild WAS observed running — on the probe — so "never observed" would be false',
      );
      assert.match(res.stdout, /did NOT reach a fresh state/);
    },
  );
});

/**
 * ── #4373 review §S3 — PIN THE READING OF A MOVED CHUNK COUNT ────────────────
 *
 * When the count moves, the poll that moved it is itself a `stale`/`idle`
 * observation and it establishes the new baseline, so the streak RESTARTS AT 1
 * rather than 0. The review noted both readings are defensible and that the
 * existing `MOVING indexedChunkCount` fixture passes either way (its count
 * moves on every poll, so the streak never accumulates under either rule).
 * This is the discriminating fixture: threshold 3, four polls, the count moves
 * exactly once on poll 2.
 *
 *   IDLE_STREAK=1 on the move (shipped):  1, 1, 2, 3  -> renames
 *   IDLE_STREAK=0 on the move:            1, 0, 1, 2  -> does not
 *
 * MUTATION-PROOF: change that `IDLE_STREAK=1` to `IDLE_STREAK=0` and this reds.
 */
test('#4373 the poll that MOVED the chunk count restarts the streak at 1, not 0', async () => {
  await withServer(
    () => EDGE_504,
    // GET 1 = pre-retry probe; polls are GETs 2..5. The count moves once, on
    // poll 2 (GET 3), and then holds.
    (n) => ({
      status: 200,
      body: pollBody({ freshness: 'stale', job: 'idle', chunks: n <= 2 ? 100 : 200 }),
    }),
    async (url, counts) => {
      const res = await runScript(url, { REFUSED_IDLE_POLLS: '3', POLL_MAX_ATTEMPTS: '4' });
      assert.equal(res.status, 1, res.stdout + res.stderr);
      assert.equal(counts().gets, 5, '1 pre-retry probe + 4 polls');
      assert.match(res.stdout, /TRIGGER REFUSED/, 'the trailing streak is 3 (polls 2,3,4), not 2');
      assert.match(res.stdout, /the LAST 3/, 'and the verdict names that streak, not the 4 polls');
    },
  );
});
