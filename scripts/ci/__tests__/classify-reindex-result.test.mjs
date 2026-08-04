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
import { classifyReindexResult } from '../classify-reindex-result.mjs';

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
