/**
 * service-health-verdict.sh tests (refs #2860).
 *
 * The defect was a live-validation step whose verdict was scraped out of the
 * probe's own log with
 *
 *     FAILS=$(grep -oE '[0-9]+ fail' log | head -1 | grep -oE '[0-9]+' || echo 0)
 *
 * so the only thing worth pinning is the EXIT STATUS per input shape. Three
 * states must stay apart, and the fix is only correct if all three do:
 *   BROKEN            → exit 1  (probe crashed / no summary / hard FAILs)
 *   HEALTHY-WITH-GATES→ exit 0  (honest not-configured NOTEs beside a PASS —
 *                                the tolerance the workflow was built around,
 *                                which must NOT start failing)
 *   HEALTHY           → exit 0
 *
 * MUTATION-PROVEN (counts in the PR body):
 *   - restore the old `grep … | head -1 … || echo 0` parse → the prose-collision
 *     and no-summary tests go RED, the CONTROLs stay green.
 *   - make the script `exit 0` unconditionally → every BROKEN test goes RED.
 *   - make it `exit 1` unconditionally → every CONTROL goes RED. Neither
 *     direction can hide.
 *
 * Run: node --test scripts/ci/__tests__/service-health-verdict.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '..', 'service-health-verdict.sh');

/** Write a probe log to a temp file and run the verdict over it. */
function verdict({ log, rc = '0', omitLog = false, omitRc = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-health-'));
  const file = path.join(dir, 'health.txt');
  if (log !== undefined) fs.writeFileSync(file, log);
  const env = { PATH: process.env.PATH };
  if (!omitLog) env.SH_LOG = log === undefined ? path.join(dir, 'missing.txt') : file;
  if (!omitRc) env.SH_RC = rc;
  const r = spawnSync('bash', [SCRIPT], { encoding: 'utf8', env });
  if (r.error) throw r.error;
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** A realistic probe log. */
const logWith = ({ pass, note, fail, total, rows = '' }) =>
  [
    '',
    '=== CSA Loom service health — https://console.invalid ===',
    '',
    'Family            | Path                                          | Status | Result',
    '------------------+-----------------------------------------------+--------+----------',
    rows,
    '',
    `=== ${pass} pass · ${note} not-configured · ${fail} fail (of ${total}) ===`,
    '',
    'Per family:',
    `  Cosmos               ${fail ? 'PARTIAL' : 'GREEN'}            (pass=${pass} fail=${fail} note=${note})`,
    '',
  ].join('\n');

// ── BROKEN ─────────────────────────────────────────────────────────────────
// Each of these reported GREEN under the old scrape.

test('BROKEN: a hard-failure count in the summary fails the job', () => {
  const r = verdict({ log: logWith({ pass: 4, note: 1, fail: 6, total: 11 }) });
  assert.equal(r.code, 1);
  assert.match(r.out, /::error::CSA Loom live validation found 6 hard failure/);
});

test('BROKEN: an error body that LOOKS like a counter cannot shadow the summary', () => {
  // The exact green-when-broken shape: the per-probe result column carries the
  // backend's own error text, is printed BEFORE the summary, and `head -1`
  // matched it. "0 failed tasks" → FAILS=0 → green with six real failures.
  const rows = 'Synapse           | /api/x                                        | 500    | FAIL — Job aborted: 0 failed tasks, retry';
  const r = verdict({ log: logWith({ pass: 4, note: 1, fail: 6, total: 11, rows }) });
  assert.equal(r.code, 1, 'the verdict must come from the summary line, not from probe prose');
  assert.match(r.out, /found 6 hard failure/);
});

test('BROKEN: the probe crashed (non-zero exit) even though the log looks clean', () => {
  const r = verdict({ log: logWith({ pass: 9, note: 2, fail: 0, total: 11 }), rc: '1' });
  assert.equal(r.code, 1);
  assert.match(r.out, /exited 1 — it CRASHED/);
});

test('BROKEN: no summary line at all is NOT zero failures', () => {
  const r = verdict({ log: '\n=== CSA Loom service health ===\n\nFamily | Path\n' });
  assert.equal(r.code, 1);
  assert.match(r.out, /NO summary line/);
});

test('BROKEN: an empty log (probe died before writing anything)', () => {
  const r = verdict({ log: '' });
  assert.equal(r.code, 1);
  assert.match(r.out, /NO summary line/);
});

test('BROKEN: the log file does not exist', () => {
  const r = verdict({ log: undefined });
  assert.equal(r.code, 1);
  assert.match(r.out, /is missing/);
});

test('BROKEN: the caller did not capture the probe exit status', () => {
  // SH_RC unset means the pipeline masked it again. Refuse, do not assume 0.
  const r = verdict({ log: logWith({ pass: 9, note: 2, fail: 0, total: 11 }), omitRc: true });
  assert.equal(r.code, 1);
  assert.match(r.out, /SH_RC was not supplied/);
});

test('BROKEN: zero probes ran — a validation that validated nothing', () => {
  const r = verdict({ log: logWith({ pass: 0, note: 0, fail: 0, total: 0 }) });
  assert.equal(r.code, 1);
  assert.match(r.out, /ZERO probes ran/);
});

test('BROKEN: every probe was not-configured — nothing returned real data', () => {
  const r = verdict({ log: logWith({ pass: 0, note: 11, fail: 0, total: 11 }) });
  assert.equal(r.code, 1);
  assert.match(r.out, /NOT ONE returned real data/);
});

test('BROKEN: a LATER summary wins over an earlier one', () => {
  // Two runs concatenated into one log; the verdict must be the last run's.
  const log = logWith({ pass: 11, note: 0, fail: 0, total: 11 }) + logWith({ pass: 5, note: 0, fail: 6, total: 11 });
  const r = verdict({ log });
  assert.equal(r.code, 1);
  assert.match(r.out, /found 6 hard failure/);
});

// ── CONTROLS — pass BOTH before and after. An over-broad "just make it fail"
//    fix breaks these, so the tightening cannot hide either. These assert the
//    EXIT STATUS only, deliberately: the status is the whole contract, and a
//    control that also pins wording would go red on a mutation it is supposed
//    to survive, which would blur what the mutation counts mean.
// ───────────────────────────────────────────────────────────────────────────

test('CONTROL: a fully green run passes', () => {
  const r = verdict({ log: logWith({ pass: 11, note: 0, fail: 0, total: 11 }) });
  assert.equal(r.code, 0, r.out);
});

test('reports the pass ratio on success', () => {
  const r = verdict({ log: logWith({ pass: 11, note: 0, fail: 0, total: 11 }) });
  assert.match(r.out, /\[service-health\] OK — 11\/11/);
});

test('CONTROL: honest not-configured NOTEs beside real passes still pass', () => {
  // This tolerance is the entire reason the step did not just `exit $?`.
  // Removing the mask must not start failing it.
  const r = verdict({ log: logWith({ pass: 7, note: 4, fail: 0, total: 11 }) });
  assert.equal(r.code, 0, r.out);
});

test('CONTROL: a probe row containing the word "fail" does not fail a green run', () => {
  // The mirror image of the prose-collision test: the old parse would also
  // INVENT failures from prose ("1 failure"), so anchoring must not do that
  // either.
  const rows = 'ADF               | /api/adf/linked-services                      | 200    | PASS — 3 items, 1 failure retried upstream';
  const r = verdict({ log: logWith({ pass: 11, note: 0, fail: 0, total: 11, rows }) });
  assert.equal(r.code, 0, r.out);
});

test('CONTROL: a single-probe green run passes', () => {
  const r = verdict({ log: logWith({ pass: 1, note: 0, fail: 0, total: 1 }) });
  assert.equal(r.code, 0, r.out);
});
