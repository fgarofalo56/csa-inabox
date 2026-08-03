/**
 * service-health-classify tests (refs #2860).
 *
 * The defect: the live-validation probe scored ANY 2xx as PASS, including a
 * 200 carrying `{ok:false, error:"…"}` — the Loom BFF envelope's own way of
 * saying the operation failed. It even rendered the error into the result
 * column and counted it a pass, so a console whose backends were erroring
 * could report `0 fail` and the workflow went green.
 *
 * MUTATION-PROVEN (counts in the PR body):
 *   - drop the `json?.ok === false` branch (the original behaviour): the
 *     ok:false tests go RED; every CONTROL stays green.
 *   - score every non-2xx AND every ok:false as FAIL, i.e. delete the 503/404
 *     NOTE branch (an over-broad "make it stricter"): the not-configured
 *     CONTROLs go RED. Neither direction can hide.
 *
 * Run: node --test apps/fiab-console/tests/service-health-classify.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { classify } from './service-health-classify.mjs';

// ── the defect ─────────────────────────────────────────────────────────────

test('200 with ok:false is a FAIL, not a PASS', () => {
  const r = classify({ status: 200, json: { ok: false, error: 'ManagedIdentityCredential authentication failed' }, text: '{}' });
  assert.equal(r.kind, 'FAIL');
  assert.match(r.result, /ok:false/);
  assert.match(r.result, /ManagedIdentityCredential/);
});

test('any 2xx with ok:false fails, not just 200', () => {
  for (const status of [200, 201, 202, 204]) {
    assert.equal(classify({ status, json: { ok: false, error: 'nope' }, text: '' }).kind, 'FAIL', `status ${status}`);
  }
});

test('ok:false with no error string still fails (and does not throw)', () => {
  const r = classify({ status: 200, json: { ok: false }, text: '{"ok":false}' });
  assert.equal(r.kind, 'FAIL');
});

// ── CONTROLS — the behaviour that must survive the tightening ──────────────

test('CONTROL: 200 with ok:true and a list is a PASS reporting the count', () => {
  const r = classify({ status: 200, json: { ok: true, items: [1, 2, 3] }, text: '' });
  assert.equal(r.kind, 'PASS');
  assert.equal(r.result, '3 items');
});

test('CONTROL: 200 with a bare payload (no ok field) is still a PASS', () => {
  // Not every probe target returns the envelope; absence of `ok` is not
  // `ok:false`, and treating it as a failure would be the over-broad fix.
  assert.equal(classify({ status: 200, json: { name: 'me' }, text: '' }).kind, 'PASS');
  assert.equal(classify({ status: 200, json: null, text: 'plain text' }).kind, 'PASS');
});

test('CONTROL: each list-shaped key is still counted', () => {
  for (const key of ['items', 'workspaces', 'entries', 'hits', 'resources']) {
    const r = classify({ status: 200, json: { [key]: [1, 2] }, text: '' });
    assert.equal(r.result, '2 items', key);
  }
});

test('CONTROL: an empty list is a PASS with 0 items (a real answer)', () => {
  const r = classify({ status: 200, json: { ok: true, items: [] }, text: '' });
  assert.equal(r.kind, 'PASS');
  assert.equal(r.result, '0 items');
});

test('CONTROL: 503 remains an honest not-configured NOTE', () => {
  const r = classify({ status: 503, json: { error: 'AI Search not provisioned; set LOOM_AI_SEARCH_SERVICE' }, text: '' });
  assert.equal(r.kind, 'NOTE');
  assert.match(r.result, /not configured/);
});

test('CONTROL: 404 is a NOTE only for probes marked optional', () => {
  assert.equal(classify({ status: 404, json: null, text: 'nope', optional: true }).kind, 'NOTE');
  assert.equal(classify({ status: 404, json: null, text: 'nope' }).kind, 'FAIL');
});

test('CONTROL: 401/403/500 are FAILs carrying the error body', () => {
  for (const status of [401, 403, 500]) {
    const r = classify({ status, json: { error: 'boom' }, text: '' });
    assert.equal(r.kind, 'FAIL', `status ${status}`);
    assert.equal(r.result, 'boom');
  }
});

test('CONTROL: a non-JSON error body falls back to the raw text', () => {
  const r = classify({ status: 500, json: null, text: '<html>gateway error</html>' });
  assert.equal(r.kind, 'FAIL');
  assert.match(r.result, /gateway error/);
});
