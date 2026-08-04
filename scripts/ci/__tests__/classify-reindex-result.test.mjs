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
