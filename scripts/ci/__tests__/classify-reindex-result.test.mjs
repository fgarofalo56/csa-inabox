/**
 * classify-reindex-result self-test (#2929, freshness half).
 *
 * The reindex step exists to stop copilot-quality-evals measuring a STALE
 * index. Its pass/warn/FAIL decision therefore has to be fail-LOUD and pinned,
 * not a bash `case` nobody exercises — a classifier that cannot fail is the same
 * "measures nothing" defect the repo's guards exist to catch.
 *
 * MUTATION-PROVEN: flip the 401 branch to 'tolerate' and the "401 fails loud"
 * test goes RED; flip the 000 branch to 'fail' and the "unreachable is
 * tolerated" test goes RED. So neither an over-loud nor an over-lax classifier
 * survives.
 *
 * Run: node --test scripts/ci/__tests__/classify-reindex-result.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyReindexResult, classifyReindexPoll } from '../classify-reindex-result.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '..', 'classify-reindex-result.mjs');

test('200 ok:true (AI Search) → ok, exit 0', () => {
  const r = classifyReindexResult({
    code: 200,
    body: JSON.stringify({ ok: true, backend: 'ai-search', totalChunks: 49593, uploaded: 49593, mode: 'full' }),
  });
  assert.equal(r.verdict, 'ok');
  assert.match(r.message, /backend=ai-search/);
});

test('200 ok:true on the Cosmos fallback (no AI Search) → ok, honest-gate note', () => {
  const r = classifyReindexResult({
    code: 200,
    body: JSON.stringify({
      ok: true,
      backend: 'cosmos',
      totalChunks: 100,
      uploaded: 100,
      warnings: ['LOOM_AI_SEARCH_SERVICE not set — using Cosmos substring fallback.'],
    }),
  });
  assert.equal(r.verdict, 'ok');
  assert.match(r.message, /AI Search not configured/i);
});

test('401 (token missing/mismatched) → fail loud (the stale-index bug)', () => {
  const r = classifyReindexResult({ code: 401, body: JSON.stringify({ ok: false, error: 'unauthenticated' }) });
  assert.equal(r.verdict, 'fail');
  assert.equal(r.level, 'error');
  assert.match(r.message, /LOOM_INTERNAL_TOKEN/);
});

test('403 → fail loud', () => {
  assert.equal(classifyReindexResult({ code: 403, body: '' }).verdict, 'fail');
});

test('502 real reindex failure → fail loud', () => {
  const r = classifyReindexResult({
    code: 502,
    body: JSON.stringify({ ok: false, backend: 'ai-search', error: 'Upload batch 0: 503 service busy' }),
  });
  assert.equal(r.verdict, 'fail');
  assert.match(r.message, /NOT refreshed/i);
});

test('5xx honest "not configured" gate → tolerate (warning), exit 0', () => {
  const r = classifyReindexResult({
    code: 503,
    body: JSON.stringify({ ok: false, error: 'AI Search not provisioned in this deployment' }),
  });
  assert.equal(r.verdict, 'tolerate');
  assert.equal(r.level, 'warning');
});

test('000 unreachable over Front Door → tolerate (transient), exit 0', () => {
  const r = classifyReindexResult({ code: '000', body: '' });
  assert.equal(r.verdict, 'tolerate');
  assert.match(r.message, /internal network|TRANSIENT/i);
});

test('2xx but ok:false is a contract violation → fail', () => {
  assert.equal(classifyReindexResult({ code: 200, body: JSON.stringify({ ok: false }) }).verdict, 'fail');
});

test('404 (route absent / wrong URL) → fail loud', () => {
  assert.equal(classifyReindexResult({ code: 404, body: 'Not Found' }).verdict, 'fail');
});

test('CLI exit codes: fail → 1, ok/tolerate → 0', () => {
  const fail = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, HTTP_CODE: '401', RESP_BODY: '{"ok":false}' },
  });
  assert.equal(fail.status, 1);
  assert.match(fail.stdout, /::error::/);

  const ok = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, HTTP_CODE: '200', RESP_BODY: '{"ok":true,"backend":"ai-search","totalChunks":10,"uploaded":10}' },
  });
  assert.equal(ok.status, 0);

  const transient = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, HTTP_CODE: '000', RESP_BODY: '' },
  });
  assert.equal(transient.status, 0);
  assert.match(transient.stdout, /::warning::/);
});

// ─────────────────────────────────────────────────────────────────────────────
// #2929, 2026-08-04 — the empty-corpus 502 and the async 202 + poll contract.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE REGRESSION THIS PINS. copilot-quality-evals run 30937670794 got
 * HTTP 502 `{"ok":false,"backend":"none","totalChunks":0,…,"error":"No corpus
 * chunks discovered — check that docs/ and PRPs/ exist relative to cwd"}` back
 * in ~160ms — a hard failure (the console image shipped without its staged
 * corpus), not a timeout and not an infra gate. But `no corpus chunks` was in
 * NOT_CONFIGURED_RE, so the classifier called it an honest gate, exited 0, and
 * the eval measured a STALE index while reporting hit-rates as if fresh.
 *
 * MUTATION-PROOF: put `|no corpus chunks` back into NOT_CONFIGURED_RE (or drop
 * the NO_CORPUS_RE branch that precedes it) and this test goes RED.
 */
test('empty corpus (502) is a REAL failure, never an honest gate', () => {
  const r = classifyReindexResult({
    code: 502,
    body: JSON.stringify({
      ok: false,
      backend: 'none',
      totalChunks: 0,
      uploaded: 0,
      byKind: {},
      warnings: [],
      error: 'No corpus chunks discovered — check that docs/ and PRPs/ exist relative to cwd',
    }),
  });
  assert.equal(r.verdict, 'fail');
  assert.equal(r.level, 'error');
  assert.match(r.message, /NO CORPUS/i);
  assert.match(r.message, /stage-copilot-corpus\.sh/);
});

test('empty corpus fails via the CLI too (exit 1)', () => {
  const res = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HTTP_CODE: '502',
      RESP_BODY: '{"ok":false,"backend":"none","totalChunks":0,"error":"No corpus chunks discovered — check that docs/ and PRPs/ exist relative to cwd"}',
    },
  });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /::error::/);
});

test('202 Accepted is NOT a completion — verdict "accepted", exit 0', () => {
  const r = classifyReindexResult({
    code: 202,
    body: JSON.stringify({ ok: true, accepted: true, jobId: 'abc-123', state: 'running' }),
  });
  assert.equal(r.verdict, 'accepted');
  assert.notEqual(r.verdict, 'ok'); // must not be mistaken for a finished refresh
  assert.match(r.message, /poll/i);
});

test('202 with ok:false is a contract violation → fail', () => {
  assert.equal(
    classifyReindexResult({ code: 202, body: JSON.stringify({ ok: false, error: 'nope' }) }).verdict,
    'fail',
  );
});

const POLL_FRESH = JSON.stringify({
  ok: true,
  backend: 'ai-search',
  job: { state: 'succeeded' },
  freshness: { state: 'fresh', indexedChunkCount: 49593 },
});

test('poll: freshness fresh → ok', () => {
  const r = classifyReindexPoll({ outcome: 'fresh', body: POLL_FRESH });
  assert.equal(r.verdict, 'ok');
  assert.match(r.message, /FRESH index/i);
});

test('poll: job failed → fail loud', () => {
  const r = classifyReindexPoll({
    outcome: 'failed',
    body: JSON.stringify({ ok: true, job: { state: 'failed', error: 'AI Search upload failed: 403' }, freshness: { state: 'stale' } }),
  });
  assert.equal(r.verdict, 'fail');
  assert.match(r.message, /NOT refreshed/i);
});

/**
 * MUTATION-PROOF (the load-bearing one). Make the poller treat a timeout as
 * success — i.e. change the 'timeout' branch to `verdict:'ok'` (or to
 * 'tolerate') — and this test goes RED. A timeout is a refusal: silently
 * proceeding is precisely how the eval ends up measuring the stale index this
 * whole step exists to prevent.
 */
test('poll: timeout is a REFUSAL, never a pass', () => {
  const r = classifyReindexPoll({
    outcome: 'timeout',
    waitedSeconds: 600,
    body: JSON.stringify({ ok: true, job: { state: 'running' }, freshness: { state: 'stale' } }),
  });
  assert.equal(r.verdict, 'fail');
  assert.equal(r.level, 'error');
  assert.match(r.message, /600s/);
  assert.match(r.message, /REFUSAL/i);
});

test('poll: unreachable over Front Door → tolerate (transient)', () => {
  const r = classifyReindexPoll({ outcome: 'unreachable', body: '' });
  assert.equal(r.verdict, 'tolerate');
  assert.match(r.message, /internal network|TRANSIENT/i);
});

/** An outcome the poll loop never emits must not silently pass. */
test('poll: unknown outcome → fail (no assumed success)', () => {
  assert.equal(classifyReindexPoll({ outcome: 'maybe?', body: '' }).verdict, 'fail');
  assert.equal(classifyReindexPoll({ outcome: '', body: '' }).verdict, 'fail');
});

test('poll CLI: MODE=poll routes to the poll classifier and exits 1 on timeout', () => {
  const timeout = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, MODE: 'poll', POLL_OUTCOME: 'timeout', POLL_WAITED_S: '900', POLL_BODY: '{}' },
  });
  assert.equal(timeout.status, 1);
  assert.match(timeout.stdout, /::error::/);

  const fresh = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, MODE: 'poll', POLL_OUTCOME: 'fresh', POLL_BODY: POLL_FRESH },
  });
  assert.equal(fresh.status, 0);
  assert.match(fresh.stdout, /FRESH index/i);
});

// ── gateway 5xx: INDETERMINATE, not a verdict (#3396) ────────────────────────
//
// Measured on copilot-quality-evals 2026-08-13: 4 of 12 runs red on
// `reindex POST … -> HTTP 504` with a Front Door HTML body, ~30s in — including
// on `push` to main. The POST handler cannot be the slow party: it does an auth
// check, a stat-only corpus count, fires the job and returns 202. So the edge
// answered for the console and we do NOT know whether a replica saw the request.
// Failing asserts it did not; tolerating asserts it did. Neither was measured.

/** A real Front Door edge error page — HTML, not the console's JSON. */
const FD_EDGE_HTML =
  '<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN"' +
  '"http://www.w3.org/TR/html4/strict.dtd">\n<HTML><HEAD><TITLE>The request timed out.</TITLE>';

test('504 with a gateway HTML body → poll (indeterminate), never a bare pass', () => {
  const r = classifyReindexResult({ code: 504, body: FD_EDGE_HTML });
  assert.equal(r.verdict, 'poll');
  assert.equal(r.level, 'warning');
  // R7: it must say it does not know, not assert an outcome in either direction.
  assert.match(r.message, /UNKNOWN/);
  assert.match(r.message, /not asserting either way/i);
  assert.doesNotMatch(r.message, /index (was|is) refreshed/i);
});

test('502 and 503 gateway bodies poll too (same edge class)', () => {
  for (const code of [502, 503]) {
    assert.equal(classifyReindexResult({ code, body: '<html>edge</html>' }).verdict, 'poll');
  }
});

// The narrowing that keeps this from becoming a hole. If the CONSOLE answered,
// its answer IS the measurement — polling past it would let the app fail quietly.
test('a 5xx the CONSOLE answered (parseable JSON) still fails loud', () => {
  const r = classifyReindexResult({ code: 502, body: JSON.stringify({ ok: false, error: 'kaboom' }) });
  assert.equal(r.verdict, 'fail');
  assert.match(r.message, /NOT refreshed/i);
});

test('500 is NEVER indeterminate — it is the app’s own code', () => {
  assert.equal(classifyReindexResult({ code: 500, body: '<html>whatever</html>' }).verdict, 'fail');
});

test('the empty-corpus 502 outranks the gateway branch even with an HTML-ish body', () => {
  const r = classifyReindexResult({ code: 502, body: '<html>No corpus chunks discovered</html>' });
  assert.equal(r.verdict, 'fail');
  assert.match(r.message, /NO CORPUS/);
});

test('CLI exit code for the indeterminate verdict is 75, distinct from 0 and 1', () => {
  const gw = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, MODE: 'post', HTTP_CODE: '504', RESP_BODY: FD_EDGE_HTML },
  });
  // 0 would skip the poll and pass silently; 1 would fail on an unmeasured
  // premise. Both are the bugs this exit code exists to avoid.
  assert.equal(gw.status, 75);
  assert.match(gw.stdout, /::warning::/);
});

// ── trigger_refused: a REFUSED trigger is not a SLOW rebuild (#3472) ─────────
//
// Measured on copilot-quality-evals run 33472611043 (2026-09-01): a gateway 504
// on the POST, then 57 polls over 904s every one of which read
// `freshness=stale job=idle`, then a red whose message was "did not reach a
// fresh state within 904s". That message is true and useless — it describes the
// rebuild's duration when the rebuild was never accepted. The poll loop now
// recognises that shape and hands the classifier its own outcome.
//
// It is a RENAME of `timeout` applied after the same ceiling, not an early
// exit: the first revision of this change DID end the wait on the streak, and a
// real-server counterfactual showed that turning a run which exits 0 at head
// (fresh at poll 9) into exit 1 at poll 8. Nothing here may imply the wait was
// shortened.

/** The body every one of those 57 polls returned. */
const POLL_STALE_IDLE = JSON.stringify({
  ok: true,
  backend: 'ai-search',
  job: { state: 'idle', jobId: null, error: null },
  freshness: { state: 'stale', indexedChunkCount: 49593 },
});

test('poll: trigger_refused is a FAIL, and names the request path — not the rebuild', () => {
  const r = classifyReindexPoll({
    outcome: 'trigger_refused',
    body: POLL_STALE_IDLE,
    waitedSeconds: 128,
    attempts: 8,
    postCode: 504,
    postAttempts: 2,
  });
  assert.equal(r.verdict, 'fail');
  assert.equal(r.level, 'error');
  assert.match(r.message, /TRIGGER REFUSED/);
  // The whole point of the separate verdict: a reader must be pointed at the
  // edge/origin path, not told the rebuild was slow.
  assert.match(r.message, /REQUEST-PATH problem, not a slow rebuild/i);
  assert.match(r.message, /originResponseTimeoutSeconds/);
  // It must report the evidence it actually had.
  assert.match(r.message, /2 POST attempt\(s\)/);
  assert.match(r.message, /HTTP 504/);
  assert.match(r.message, /8 poll\(s\) over 128s/);
});

/**
 * MUTATION-PROOF, and the reason this verdict is allowed to exist at all
 * (deploy-integrity R7). `job.state` is the ANSWERING REPLICA's view and the
 * corpus manifest is written only at the END of a rebuild, so neither "idle"
 * nor "chunk count unchanged" proves that nothing ran. Delete either caveat
 * from the message and this goes RED: the verdict would then be asserting two
 * things the poll loop cannot observe.
 */
test('poll: trigger_refused states its CAVEATS and never claims "no job ran"', () => {
  const r = classifyReindexPoll({
    outcome: 'trigger_refused',
    body: POLL_STALE_IDLE,
    waitedSeconds: 128,
    attempts: 8,
    postCode: 504,
    postAttempts: 2,
  });
  assert.match(r.message, /ANSWERING replica/i, 'must disclose the replica-scope caveat');
  assert.match(r.message, /does not prove no job started anywhere/i);
  assert.match(r.message, /written only at the END of a rebuild/i, 'must disclose the manifest caveat');
  // The claims it may NOT make.
  assert.doesNotMatch(r.message, /no (job|rebuild) (ran|started)\b(?! anywhere)/i);
  assert.doesNotMatch(r.message, /nothing ran/i);
  assert.match(r.message, /never OBSERVED/i, 'the positive claim must be scoped to observation');
});

/** A RENAME of `timeout`, produced after the same ceiling. It must never soften
 *  the EXIT CODE, and it must not claim it shortened anything. */
test('poll CLI: trigger_refused exits 1 (fail-closed intact)', () => {
  const res = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MODE: 'poll',
      POLL_OUTCOME: 'trigger_refused',
      POLL_BODY: POLL_STALE_IDLE,
      POLL_WAITED_S: '128',
      POLL_ATTEMPTS: '8',
      POST_CODE: '504',
      POST_ATTEMPTS: '2',
    },
  });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /::error::/);
  assert.match(res.stdout, /TRIGGER REFUSED/);
  assert.match(res.stdout, /RENAME, not a shortcut/);
});

/**
 * R7 on the message's own inputs. With no POST_CODE plumbed through, the message
 * may not invent one.
 */
test('poll: trigger_refused with no postCode does not invent a status code', () => {
  const r = classifyReindexPoll({ outcome: 'trigger_refused', body: POLL_STALE_IDLE, attempts: 8 });
  assert.match(r.message, /no application body/);
  assert.doesNotMatch(r.message, /HTTP \d/);
});

/**
 * R7 on the message's own inputs, second half — and a defect the reviewer of
 * PR #4373 MEASURED at the first revision of this file: with no POST_ATTEMPTS
 * the message read "All 2 POST attempt(s) were answered by the EDGE" over a run
 * whose attempt count was never handed over. Two is not a floor either — the
 * shell makes ONE attempt when POST_RETRIES=0 or when its pre-retry probe skips
 * the retry. An invented count is a measurement claim that was not measured.
 *
 * MUTATION-PROOF: restore the `: 2` fallback and this goes RED.
 */
test('poll: trigger_refused with no postAttempts does not invent an attempt COUNT', () => {
  const r = classifyReindexPoll({ outcome: 'trigger_refused', body: POLL_STALE_IDLE, attempts: 8 });
  assert.doesNotMatch(r.message, /All \d+ POST attempt/);
  assert.match(r.message, /Every POST attempt\(s\) were answered by the EDGE/);
});

/** A ONE-attempt run says one. The count is evidence, so it must be the real one. */
test('poll: trigger_refused reports a SINGLE POST attempt as 1, not 2', () => {
  const r = classifyReindexPoll({
    outcome: 'trigger_refused',
    body: POLL_STALE_IDLE,
    attempts: 8,
    postCode: 504,
    postAttempts: 1,
  });
  assert.match(r.message, /All 1 POST attempt\(s\)/);
  assert.doesNotMatch(r.message, /All 2 POST attempt/);
});

/**
 * R7 on the POLL count — the #4373 review's second blocking finding, MEASURED
 * against the real harness at 10 claimed / 8 observed.
 *
 * The clause asserts a `freshness=stale job=idle` reading with an unchanged
 * chunk count. Only the TRAILING streak established that; `attempts` is every
 * poll the loop made, including unreachable ones and any that read something
 * else before the streak began. The two numbers must not be conflated.
 *
 * MUTATION-PROOF: make the message print `attempts` where it prints `idleStreak`
 * and the first assertion goes RED (it would read "the LAST 10 of 10").
 */
test('poll: trigger_refused claims the TRAILING streak, not every poll', () => {
  const r = classifyReindexPoll({
    outcome: 'trigger_refused',
    body: POLL_STALE_IDLE,
    waitedSeconds: 128,
    attempts: 10,
    idleStreak: 8,
    postCode: 504,
    postAttempts: 2,
  });
  assert.match(r.message, /Of the 10 poll\(s\) over 128s that followed, the LAST 8 read freshness=stale/);
  // The refuted sentence: the total presented as the polls that did the reading.
  assert.doesNotMatch(r.message, /10 poll\(s\) over 128s since then read freshness=stale/);
  assert.doesNotMatch(r.message, /the LAST 10/);
});

/**
 * Same rule as the attempt count: with no streak handed over, do not invent one.
 * The message drops the number and says "the TRAILING" instead.
 */
test('poll: trigger_refused with no idleStreak does not invent a poll COUNT for the reading', () => {
  const r = classifyReindexPoll({
    outcome: 'trigger_refused',
    body: POLL_STALE_IDLE,
    waitedSeconds: 128,
    attempts: 10,
    postCode: 504,
    postAttempts: 2,
  });
  assert.match(r.message, /the TRAILING ones read freshness=stale/);
  assert.doesNotMatch(r.message, /the LAST \d+ read/);
});

/**
 * PER-ATTEMPT STATUS CODES (#4373 review §4). `postCode` is the LAST attempt's
 * status and the sentence is plural, so naming it alone attributed one sample to
 * every attempt: "All 2 POST attempt(s) were answered by the EDGE (HTTP 502…)"
 * when attempt 1 was a 504. With `postCodes` the message names each in order.
 *
 * MUTATION-PROOF: drop the `postCodes` branch and this reads "(HTTP 502 on the
 * LAST attempt…)" — RED on the first assertion.
 */
test('poll: trigger_refused names EVERY attempt\'s status when it has them', () => {
  const r = classifyReindexPoll({
    outcome: 'trigger_refused',
    body: POLL_STALE_IDLE,
    waitedSeconds: 128,
    attempts: 8,
    idleStreak: 8,
    postCode: 502,
    postCodes: '504,502',
    postAttempts: 2,
  });
  assert.match(r.message, /HTTP 504 then 502, one per attempt, no application body/);
  assert.doesNotMatch(r.message, /\(HTTP 502, no application body\)/);
});

/**
 * And with only the LAST code available it must SAY that is what it is, rather
 * than letting the plural sentence imply it covered them all.
 */
test('poll: trigger_refused with only postCode scopes it to the LAST attempt', () => {
  const r = classifyReindexPoll({
    outcome: 'trigger_refused',
    body: POLL_STALE_IDLE,
    waitedSeconds: 128,
    attempts: 8,
    idleStreak: 8,
    postCode: 502,
    postAttempts: 2,
  });
  assert.match(r.message, /HTTP 502 on the LAST attempt, no application body/);
});

/** One attempt, one code: no "then", no "LAST attempt" hedge — it IS all of them. */
test('poll: trigger_refused with a single collected code names it plainly', () => {
  const r = classifyReindexPoll({
    outcome: 'trigger_refused',
    body: POLL_STALE_IDLE,
    waitedSeconds: 128,
    attempts: 8,
    idleStreak: 8,
    postCodes: '504',
    postAttempts: 1,
  });
  assert.match(r.message, /\(HTTP 504, no application body\)/);
  assert.doesNotMatch(r.message, /HTTP 504 then/);
  assert.doesNotMatch(r.message, /LAST attempt/);
});

/*
 * ── POST_CODE / POST_CODES ARE WHITELISTED AT THE ENV BOUNDARY ──────────────
 *
 * Both are read from the environment and interpolated into a message written to
 * stdout, which CodeQL flags as `js/clear-text-logging` (alerts 1034/1035). The
 * values the caller actually produces are `curl -w '%{http_code}'` outputs, so
 * the alert is a false positive on them — but that is a claim about a producer
 * this script cannot see. `statusCodesOnly` makes it true at the boundary
 * instead of merely likely.
 *
 * These drive the CLI rather than the exported function, because the whitelist
 * IS the env boundary: testing the function would step over the thing under
 * test. The first case is the CONTROL — it proves the assertion can see a code
 * at all, so the "dropped" cases below are not passing vacuously.
 */
test('poll CLI: real curl status codes pass through the whitelist untouched', () => {
  const res = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MODE: 'poll',
      POLL_OUTCOME: 'trigger_refused',
      POLL_BODY: POLL_STALE_IDLE,
      POLL_WAITED_S: '128',
      POLL_ATTEMPTS: '8',
      POST_CODES: '504,502',
      POST_ATTEMPTS: '2',
    },
  });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /HTTP 504 then 502, one per attempt/);
});

test('poll CLI: a POST_CODE that is not a status code is dropped, not echoed', () => {
  const res = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MODE: 'poll',
      POLL_OUTCOME: 'trigger_refused',
      POLL_BODY: POLL_STALE_IDLE,
      POLL_WAITED_S: '128',
      POLL_ATTEMPTS: '8',
      POST_CODE: 'NOT-A-CODE-9f2a',
      POST_ATTEMPTS: '2',
    },
  });
  assert.equal(res.status, 1);
  assert.doesNotMatch(res.stdout, /NOT-A-CODE-9f2a/);
  // R7: having dropped it, the message must not invent a code either.
  assert.match(res.stdout, /\(no application body\)/);
  assert.doesNotMatch(res.stdout, /LAST attempt/);
});

test('poll CLI: a malformed POST_CODES list is dropped whole, not partially echoed', () => {
  const res = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MODE: 'poll',
      POLL_OUTCOME: 'trigger_refused',
      POLL_BODY: POLL_STALE_IDLE,
      POLL_WAITED_S: '128',
      POLL_ATTEMPTS: '8',
      POST_CODES: '504,NOT-A-CODE-9f2a',
      POST_ATTEMPTS: '2',
    },
  });
  assert.equal(res.status, 1);
  assert.doesNotMatch(res.stdout, /NOT-A-CODE-9f2a/);
  // Whitelisting is all-or-nothing on the list: a partially-valid list is not
  // silently trimmed to its valid prefix, which would report FEWER attempts
  // than were made and understate the failure.
  assert.doesNotMatch(res.stdout, /HTTP 504, no application body/);
  assert.match(res.stdout, /\(no application body\)/);
});
