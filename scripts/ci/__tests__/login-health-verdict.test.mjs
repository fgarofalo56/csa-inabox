/**
 * login-health-verdict.sh tests (#2837).
 *
 * The bug was a control that PRINTED "::error::LOGIN BROKEN" and then exited 0,
 * so the only thing worth pinning is the EXIT STATUS per verdict — the
 * annotation was never the part that was missing.
 *
 * Three states must stay apart, and the fix is only correct if all three do:
 *   BROKEN        → exit 1   (evidence in hand: invalid_client hits / expired)
 *   COULD NOT CHECK → exit 0 (no workspace, no permission, unparseable) — this
 *                     is the legitimate reason continue-on-error was added, and
 *                     removing the mask must NOT start failing these
 *   HEALTHY       → exit 0
 *
 * MUTATION-PROVEN (counts in the PR body):
 *   - `exit "$RC"` → `exit 0` (the original defect): the BROKEN tests go RED,
 *     every CONTROL test stays green.
 *   - `exit "$RC"` → `exit 1` (an over-broad "just make it fail"): the CONTROL
 *     tests go RED. So neither direction can hide.
 *
 * Run: node --test scripts/ci/__tests__/login-health-verdict.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '..', 'login-health-verdict.sh');

/** Fixed clock so expiry maths is deterministic: 2026-08-02T00:00:00Z. */
const NOW = 1785974400;
const daysOut = (d) => new Date((NOW + d * 86400) * 1000).toISOString();

function run(env = {}) {
  const r = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      LH_NOW_EPOCH: String(NOW),
      LH_APP_ID: 'app-under-test',
      LH_CONSOLE_RG: 'rg-under-test',
      ...env,
    },
  });
  if (r.error) throw r.error;
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

// ---------------------------------------------------------------------------
// BROKEN — these are the tests that go RED if the `exit 0` mask comes back
// ---------------------------------------------------------------------------
test('BROKEN: invalid_client hits in the window → exit 1', () => {
  const r = run({ LH_LAW: 'ws-guid', LH_HITS_RAW: '3', LH_MIN_END: daysOut(400) });
  assert.equal(r.code, 1, 'a live sign-in outage must fail the step');
  assert.match(r.out, /::error::LOGIN BROKEN — 3 auth\/callback invalid_client/);
});

test('BROKEN: a single hit is enough → exit 1', () => {
  const r = run({ LH_LAW: 'ws-guid', LH_HITS_RAW: '1', LH_MIN_END: daysOut(400) });
  assert.equal(r.code, 1);
});

test('BROKEN: already-expired MSAL credential → exit 1', () => {
  const r = run({ LH_LAW: 'ws-guid', LH_HITS_RAW: '0', LH_MIN_END: daysOut(-5) });
  assert.equal(r.code, 1, 'AADSTS7000215 — sign-in is down');
  assert.match(r.out, /::error::MSAL secret is EXPIRED/);
});

test('BROKEN: both signals at once → exit 1, and both errors are reported', () => {
  const r = run({ LH_LAW: 'ws-guid', LH_HITS_RAW: '7', LH_MIN_END: daysOut(-1) });
  assert.equal(r.code, 1);
  assert.match(r.out, /::error::LOGIN BROKEN/);
  assert.match(r.out, /::error::MSAL secret is EXPIRED/);
});

test('BROKEN: the error names the rotation command (an annotation without the fix is a scramble)', () => {
  const r = run({ LH_LAW: 'ws-guid', LH_HITS_RAW: '2', LH_MIN_END: daysOut(400) });
  assert.match(r.out, /az containerapp secret set -n loom-console -g rg-under-test/);
  assert.match(r.out, /az ad app credential reset --id app-under-test/);
});

// ---------------------------------------------------------------------------
// CONTROL — green BOTH ways. These fail if the fix is over-broad (fail-always).
// This is the behaviour continue-on-error was originally protecting, and it
// must survive the mask's removal untouched.
// ---------------------------------------------------------------------------
test('CONTROL: workspace unresolvable + credential list empty → exit 0', () => {
  const r = run({ LH_LAW: '', LH_HITS_RAW: '', LH_MIN_END: '' });
  assert.equal(r.code, 0, '"could not check" is not "broken" — it must never fail the verify');
  assert.doesNotMatch(r.out, /::error::/);
  assert.match(r.out, /::warning::could not resolve the console Log Analytics workspace/);
  assert.match(r.out, /::warning::could not read MSAL app/);
});

test('CONTROL: az returned the literal "None" for credentials → exit 0, warning only', () => {
  const r = run({ LH_LAW: '', LH_HITS_RAW: '', LH_MIN_END: 'None' });
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /::error::/);
});

test('CONTROL: fully healthy estate → exit 0, no annotations at all', () => {
  const r = run({ LH_LAW: 'ws-guid', LH_HITS_RAW: '0', LH_MIN_END: daysOut(400) });
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /::error::/);
  assert.doesNotMatch(r.out, /::warning::/);
  assert.match(r.out, /OK — no invalid_client callback errors/);
});

test('CONTROL: credential expiring soon warns but does NOT fail → exit 0', () => {
  const r = run({ LH_LAW: 'ws-guid', LH_HITS_RAW: '0', LH_MIN_END: daysOut(10) });
  assert.equal(r.code, 0, 'runway is a warning; it is not an outage');
  assert.match(r.out, /::warning::MSAL secret expires in 10d/);
  assert.doesNotMatch(r.out, /::error::/);
});

test('CONTROL: exactly at the 30-day boundary is still a warning, not a failure', () => {
  const r = run({ LH_LAW: 'ws-guid', LH_HITS_RAW: '0', LH_MIN_END: daysOut(29) });
  assert.equal(r.code, 0);
  assert.match(r.out, /::warning::MSAL secret expires in 29d/);
});

// ---------------------------------------------------------------------------
// "UNREADABLE IS NOT ZERO" — the second half of #2837. The old step did
// `${HITS:-0}` and printed OK when the query had not run at all.
// ---------------------------------------------------------------------------
test('workspace resolved but the count is unreadable → exit 0 AND must not claim OK', () => {
  const r = run({ LH_LAW: 'ws-guid', LH_HITS_RAW: '', LH_MIN_END: daysOut(400) });
  assert.equal(r.code, 0, 'unknown is not broken');
  assert.match(r.out, /::warning::resolved the workspace but could NOT read the invalid_client count/);
  assert.doesNotMatch(
    r.out,
    /OK — no invalid_client callback errors/,
    'a query that did not run must never be reported as a clean zero',
  );
});

test('a non-numeric count is unreadable, not zero', () => {
  const r = run({ LH_LAW: 'ws-guid', LH_HITS_RAW: 'ERROR: forbidden', LH_MIN_END: daysOut(400) });
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /OK — no invalid_client callback errors/);
});

test('an unparseable expiry is unknown, not "0 days of runway"', () => {
  const r = run({ LH_LAW: 'ws-guid', LH_HITS_RAW: '0', LH_MIN_END: 'not-a-date' });
  assert.equal(r.code, 0);
  assert.match(r.out, /::warning::could not parse the MSAL credential expiry/);
  assert.doesNotMatch(r.out, /::error::/);
});

// ---------------------------------------------------------------------------
// THE RECORDED VERDICT (refs #2871). The exit status alone cannot tell the
// enforcing step apart "checked, healthy" from "could not check" — both are 0,
// deliberately. loom-ui-verify now runs the browser suite even when the
// preflight is broken and enforces the verdict at the END of the job, so that
// distinction has to survive as DATA, not just as log prose.
//
// Recorded as an EXPLICIT token at the point each branch is taken, never
// inferred later from the presence of a ::warning:: — that would also match the
// benign "expires in 12d" runway warning and mislabel a healthy estate as
// indeterminate. Classifying the wrong population is how a gate quietly stops
// measuring what it claims to.
// ---------------------------------------------------------------------------

/** The machine-readable token, or null when the script emitted none. */
const token = (out) => out.match(/^login-health-verdict=(\S+)$/m)?.[1] ?? null;

test('verdict token: healthy estate records "ok"', () => {
  const r = run({ LH_LAW: 'ws-guid', LH_HITS_RAW: '0', LH_MIN_END: daysOut(400) });
  assert.equal(token(r.out), 'ok');
  assert.equal(r.code, 0);
});

test('verdict token: invalid_client hits record "broken"', () => {
  const r = run({ LH_LAW: 'ws-guid', LH_HITS_RAW: '41', LH_MIN_END: daysOut(400) });
  assert.equal(token(r.out), 'broken');
  assert.equal(r.code, 1, 'the exit contract is unchanged by the recording');
});

test('verdict token: an expired credential records "broken"', () => {
  const r = run({ LH_LAW: 'ws-guid', LH_HITS_RAW: '0', LH_MIN_END: daysOut(-5) });
  assert.equal(token(r.out), 'broken');
});

test('verdict token: nothing checkable records "unknown", NOT "ok"', () => {
  // The whole point. An unreadable estate must not be recorded as health.
  const r = run({ LH_LAW: '', LH_HITS_RAW: '', LH_MIN_END: '' });
  assert.equal(token(r.out), 'unknown');
  assert.equal(r.code, 0, 'unknown still must not fail');
});

test('verdict token: a half-readable estate records "unknown"', () => {
  // Workspace resolved, count unreadable, expiry fine. One check ran, one did
  // not — that is not a clean bill of health.
  const r = run({ LH_LAW: 'ws-guid', LH_HITS_RAW: '', LH_MIN_END: daysOut(400) });
  assert.equal(token(r.out), 'unknown');
});

test('verdict token: BROKEN outranks an unevaluated sibling check', () => {
  // Evidence of breakage beats "the other half was unreadable". Recording this
  // as unknown would let the enforcing step pass a live outage.
  const r = run({ LH_LAW: 'ws-guid', LH_HITS_RAW: '3', LH_MIN_END: '' });
  assert.equal(token(r.out), 'broken');
  assert.equal(r.code, 1);
});

test('verdict token: a near-expiry WARNING is still "ok", not "unknown"', () => {
  // The inferred-from-::warning:: implementation would get exactly this wrong:
  // the estate was fully checked and is healthy, it just needs a rotation soon.
  const r = run({ LH_LAW: 'ws-guid', LH_HITS_RAW: '0', LH_MIN_END: daysOut(10) });
  assert.match(r.out, /::warning::MSAL secret expires in 10d/);
  assert.equal(token(r.out), 'ok');
});

test('verdict token: written to $GITHUB_OUTPUT as `verdict=` when running under Actions', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'lh-out-')), 'out.txt');
  writeFileSync(file, '');
  const r = run({
    LH_LAW: 'ws-guid',
    LH_HITS_RAW: '2',
    LH_MIN_END: daysOut(400),
    GITHUB_OUTPUT: file,
  });
  assert.equal(r.code, 1);
  assert.equal(readFileSync(file, 'utf8').trim(), 'verdict=broken');
});

test('CONTROL: with no $GITHUB_OUTPUT set the script still works and exits normally', () => {
  // It runs outside Actions in these very tests; the recording must be additive.
  const r = run({ LH_LAW: 'ws-guid', LH_HITS_RAW: '0', LH_MIN_END: daysOut(400) });
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /::error::/);
});
