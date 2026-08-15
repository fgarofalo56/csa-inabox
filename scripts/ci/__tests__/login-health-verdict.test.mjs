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
//
// Each carries RECENCY inputs that establish a LIVE outage (a hit that postdates
// the newest credential). Before #3498 they passed with no timestamps at all,
// which meant they were really exercising the fail-closed-on-unknown path and
// nothing in this file proved the demonstrated-outage path independently.
// ---------------------------------------------------------------------------
/** Timestamps that make the hits a LIVE outage: the last hit survived the reset. */
const LIVE = { LH_HITS_LAST: '2026-08-15T18:30:00Z', LH_CRED_NEWEST: '2026-08-15T17:44:37Z' };

test('BROKEN: invalid_client hits that postdate the newest credential → exit 1', () => {
  const r = run({ LH_LAW: 'ws-guid', LH_HITS_RAW: '3', ...LIVE, LH_MIN_END: daysOut(400) });
  assert.equal(r.code, 1, 'a live sign-in outage must fail the step');
  assert.match(r.out, /::error::LOGIN BROKEN — 3 auth\/callback invalid_client/);
});

test('BROKEN: a single hit is enough → exit 1', () => {
  const r = run({ LH_LAW: 'ws-guid', LH_HITS_RAW: '1', ...LIVE, LH_MIN_END: daysOut(400) });
  assert.equal(r.code, 1);
});

test('BROKEN: already-expired MSAL credential → exit 1', () => {
  const r = run({ LH_LAW: 'ws-guid', LH_HITS_RAW: '0', LH_MIN_END: daysOut(-5) });
  assert.equal(r.code, 1, 'AADSTS7000215 — sign-in is down');
  assert.match(r.out, /::error::MSAL secret is EXPIRED/);
});

test('BROKEN: both signals at once → exit 1, and both errors are reported', () => {
  const r = run({ LH_LAW: 'ws-guid', LH_HITS_RAW: '7', ...LIVE, LH_MIN_END: daysOut(-1) });
  assert.equal(r.code, 1);
  assert.match(r.out, /::error::LOGIN BROKEN/);
  assert.match(r.out, /::error::MSAL secret is EXPIRED/);
});

test('BROKEN: the error names the rotation command (an annotation without the fix is a scramble)', () => {
  const r = run({ LH_LAW: 'ws-guid', LH_HITS_RAW: '2', ...LIVE, LH_MIN_END: daysOut(400) });
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
  const r = run({ LH_LAW: 'ws-guid', LH_HITS_RAW: '41', ...LIVE, LH_MIN_END: daysOut(400) });
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
  const r = run({ LH_LAW: 'ws-guid', LH_HITS_RAW: '3', ...LIVE, LH_MIN_END: '' });
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
    ...LIVE,
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

// ── RECENCY (#3160) ─────────────────────────────────────────────────────────
// A 7-day count with no recency test cannot tell "sign-in is down" from
// "sign-in WAS down and someone fixed it". Both produced byte-identical output,
// so a rotation that worked still failed this gate for a week — and an operator
// who has seen it cry wolf twice stops believing the third one.
//
// Measured on loom-ui-verify run 31465529808 (2026-08-11), which reported BOTH:
//     LOGIN BROKEN — 4 auth/callback invalid_client errors in the last 7d
//     soonest MSAL secret expiry: 2028-08-09T13:46:44Z (729d)  OK
// Those are only simultaneously true if the hits predate the credentials — or
// if the console presents a secret the app does not hold. The gate could not
// say which.

test('#3160 — hits that PREDATE the newest credential are historical, not a current outage', () => {
  const r = run({
    LH_LAW: 'ws-guid',
    LH_HITS_RAW: '4',
    LH_HITS_LAST: '2026-08-09T10:00:00Z',
    LH_CRED_NEWEST: '2026-08-09T16:21:19Z',
    LH_MIN_END: daysOut(400),
  });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /login-health-verdict=ok/);
  assert.match(r.out, /PREDATES the newest MSAL credential/);
  // It must still SAY the hits exist — silently dropping them would hide a real
  // outage that was fixed by luck rather than by the rotation.
  assert.match(r.out, /4 auth\/callback invalid_client error\(s\)/);
});

test('#3160 — a hit NEWER than the newest credential is a current outage and still fails', () => {
  const r = run({
    LH_LAW: 'ws-guid',
    LH_HITS_RAW: '4',
    LH_HITS_LAST: '2026-08-10T10:00:00Z',
    LH_CRED_NEWEST: '2026-08-09T16:21:19Z',
    LH_MIN_END: daysOut(400),
  });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /login-health-verdict=broken/);
  assert.match(r.out, /NEWER than the newest MSAL credential/);
  assert.match(r.out, /a rotation has not fixed it/);
});

test('#3160 — UNREADABLE timestamps fail CLOSED; recency is never assumed', () => {
  const r = run({
    LH_LAW: 'ws-guid',
    LH_HITS_RAW: '4',
    LH_HITS_LAST: '',
    LH_CRED_NEWEST: '',
    LH_MIN_END: daysOut(400),
  });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /login-health-verdict=unproven/);
  assert.match(r.out, /could not read the last-hit timestamp/);
  assert.match(r.out, /fails closed because assuming 'historical'/);
});

test('#3160 — ONE unreadable timestamp is still unestablished recency, not a pass', () => {
  // The half-known case is the one a naive `[ -n "$a" ] || [ -n "$b" ]` would
  // get wrong. Knowing when the last failure was, without knowing when the
  // credential was minted, establishes nothing about which came first.
  for (const half of [
    { LH_HITS_LAST: '2026-08-09T10:00:00Z', LH_CRED_NEWEST: '' },
    { LH_HITS_LAST: '', LH_CRED_NEWEST: '2026-08-09T16:21:19Z' },
  ]) {
    const r = run({ LH_LAW: 'ws-guid', LH_HITS_RAW: '4', LH_MIN_END: daysOut(400), ...half });
    assert.equal(r.code, 1, `half-known recency must fail closed: ${JSON.stringify(half)}\n${r.out}`);
    assert.equal(token(r.out), 'unproven');
  }
});

// ── #3498 — THE RECENCY READ ITSELF ─────────────────────────────────────────
// #3160 (above) could order the hits against the credential. It was never given
// the timestamp to do it with: the workflow read the count and the timestamp
// with TWO separate `az monitor log-analytics query` calls, the count returned 4
// and the timestamp returned EMPTY on every run, and `2>/dev/null` threw away
// the reason. Verbatim from run 31907509457 (main, 2026-08-15):
//
//     LOGIN BROKEN — 4 auth/callback invalid_client errors in the last 7d
//     (AADSTS7000215). Recency could NOT be established
//     (last-hit=<unread>, newest-credential=2026-08-15T17:44:37Z) …
//
// That credential was minted INSIDE that day's Commercial deploy window, i.e.
// about three hours before the check ran — and the gate still could not say
// whether sign-in worked. loom-ui-verify's last green run was 2026-08-10, and
// while it is red no G1 browser receipt is obtainable for any surface.
//
// Two changes, and the tests below pin both:
//   1. ONE query, TWO columns. LH_HITS_ROW carries "<count>\t<newest-hit>" from
//      one row, so a readable count implies a readable timestamp.
//   2. The unreadable case keeps failing closed but STOPS SAYING "LOGIN BROKEN".
//      Per deploy-integrity.md R7 the old string asserted a conclusion the same
//      sentence disclaimed two lines later.
//
// FIXTURE: today's run. newest-credential 2026-08-15T17:44:37Z, 4 errors.
const CRED_TODAY = '2026-08-15T17:44:37Z';
const row = (count, last = null) => (last === null ? String(count) : `${count}\t${last}`);

test('#3498 HISTORICAL — a hit BEFORE the rotation passes, and both timestamps are recorded', () => {
  const r = run({
    LH_LAW: 'ws-guid',
    LH_HITS_ROW: row(4, '2026-08-15T10:00:00Z'),
    LH_CRED_NEWEST: CRED_TODAY,
    LH_MIN_END: daysOut(400),
  });
  assert.equal(r.code, 0, r.out);
  assert.equal(token(r.out), 'ok');
  assert.match(r.out, /PREDATES the newest MSAL credential/);
  // "Recorded in the note" is the acceptance wording in #3498: the claim has to
  // be re-checkable from the log alone, without re-running the query.
  assert.match(r.out, /recency ESTABLISHED: last-hit 2026-08-15T10:00:00Z <= newest-credential 2026-08-15T17:44:37Z/);
  // It must still SAY the hits exist — silently dropping them would hide a real
  // outage that was fixed by luck rather than by the rotation.
  assert.match(r.out, /4 auth\/callback invalid_client error\(s\)/);
  assert.doesNotMatch(r.out, /::error::/);
});

test('#3498 LIVE — a hit AFTER the rotation fails loudly, and keeps the rotation command', () => {
  const r = run({
    LH_LAW: 'ws-guid',
    LH_HITS_ROW: row(4, '2026-08-15T18:30:00Z'),
    LH_CRED_NEWEST: CRED_TODAY,
    LH_MIN_END: daysOut(400),
  });
  assert.equal(r.code, 1, r.out);
  assert.equal(token(r.out), 'broken');
  assert.match(r.out, /::error::LOGIN BROKEN/);
  assert.match(r.out, /is NEWER than the newest MSAL credential/);
  assert.match(r.out, /az containerapp secret set -n loom-console/);
});

test('#3498 UNPROVEN — a count with no timestamp column fails CLOSED and does NOT claim "LOGIN BROKEN"', () => {
  // The live state of run 31907509457, reproduced: the count came back, the
  // timestamp did not.
  const r = run({
    LH_LAW: 'ws-guid',
    LH_HITS_ROW: row(4),
    LH_CRED_NEWEST: CRED_TODAY,
    LH_MIN_END: daysOut(400),
  });
  assert.equal(r.code, 1, 'an unreadable timestamp must NEVER silently pass');
  assert.equal(token(r.out), 'unproven', 'unknown-shaped evidence must not be recorded as a proven outage');
  assert.match(r.out, /::error::LOGIN HEALTH UNPROVEN/);
  assert.match(r.out, /NOT a finding that sign-in is down/);
  // R7: the message must not assert the conclusion it disclaims.
  assert.doesNotMatch(r.out, /::error::LOGIN BROKEN/);
  // It names WHICH read failed — `<unread>` alone is what cost four days.
  assert.match(r.out, /NO timestamp column/);
  assert.match(r.out, new RegExp(`newest-credential=${CRED_TODAY}`));
});

test('#3498 UNPROVEN — an EMPTY timestamp column reads differently from a MISSING one', () => {
  // Same verdict, different diagnosis: "the query has the wrong shape" and "the
  // query has the right shape and returned nothing" are different bugs.
  const r = run({
    LH_LAW: 'ws-guid',
    LH_HITS_ROW: row(4, ''),
    LH_CRED_NEWEST: CRED_TODAY,
    LH_MIN_END: daysOut(400),
  });
  assert.equal(r.code, 1);
  assert.equal(token(r.out), 'unproven');
  assert.match(r.out, /returned its timestamp column EMPTY/);
  assert.doesNotMatch(r.out, /NO timestamp column/);
});

test('#3498 UNPROVEN — an unparseable timestamp is reported as unparseable, not as unread', () => {
  const r = run({
    LH_LAW: 'ws-guid',
    LH_HITS_ROW: row(4, 'last=2026-08-15'),
    LH_CRED_NEWEST: CRED_TODAY,
    LH_MIN_END: daysOut(400),
  });
  assert.equal(r.code, 1);
  assert.equal(token(r.out), 'unproven');
  assert.match(r.out, /'last=2026-08-15' <unparseable as a date>/);
});

test('#3498 UNPROVEN — the query error is quoted back, so the next occurrence names its own cause', () => {
  // `2>/dev/null` is why this defect was undiagnosable: the read failed, the
  // reason vanished, and `<unread>` with no cause pointed the investigation at a
  // credential that had just been rotated correctly.
  const r = run({
    LH_LAW: 'ws-guid',
    LH_HITS_ROW: row(4),
    LH_HITS_RC: '1',
    LH_HITS_ERR: '(AuthorizationFailed) does not have Log Analytics Reader',
    LH_CRED_NEWEST: CRED_TODAY,
    LH_MIN_END: daysOut(400),
  });
  assert.match(r.out, /hits query FAILED \(az exited 1\): \[\(AuthorizationFailed\) does not have Log Analytics Reader\]/);
});

test('#3498 — the EXIT CODE decides whether a read failed, never stderr being non-empty', () => {
  // The az log-analytics extension banners to stderr on every SUCCESSFUL call,
  // so an emptiness test reports a good query as failed — measured on run
  // 31351602478 at the sibling call site in loom-synthetic-monitor.yml. An rc of
  // 0 next to an unusable value is itself the finding: the problem is the SHAPE
  // of the output, not a permission.
  const r = run({
    LH_LAW: 'ws-guid',
    LH_HITS_ROW: row(4),
    LH_HITS_RC: '0',
    LH_HITS_ERR: 'WARNING: This command is from the following extension: log-analytics',
    LH_CRED_NEWEST: CRED_TODAY,
    LH_MIN_END: daysOut(400),
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /hits query itself exited 0/);
  assert.doesNotMatch(r.out, /hits query FAILED/, 'a success banner is not an error');
  assert.doesNotMatch(r.out, /This command is from the following extension/, 'do not quote a banner as a cause');
});

test('#3498 — a read with NO recorded exit status says so rather than implying success', () => {
  const r = run({
    LH_LAW: 'ws-guid',
    LH_HITS_ROW: row(4),
    LH_CRED_NEWEST: CRED_TODAY,
    LH_MIN_END: daysOut(400),
  });
  assert.match(r.out, /hits query reported no exit status, so even its success is unknown/);
});

test('#3498 — the diagnosis names only the read that FAILED, not the one that worked', () => {
  // The credential read is fine here; only the timestamp is missing. A note
  // about the healthy read is noise on an annotation people already skim.
  const r = run({
    LH_LAW: 'ws-guid',
    LH_HITS_ROW: row(4),
    LH_HITS_RC: '3',
    LH_CRED_NEWEST: CRED_TODAY,
    LH_CRED_RC: '0',
    LH_MIN_END: daysOut(400),
  });
  assert.match(r.out, /hits query FAILED \(az exited 3\)/);
  assert.doesNotMatch(r.out, /credential read itself exited 0/);
});

test('#3498 QUERY-DID-NOT-RUN — an empty row is still unknown, exit 0, and never a clean zero', () => {
  // Unchanged behaviour, pinned: the second half of #2837 must survive the
  // re-plumbing. An unread timestamp and a genuinely-absent hit are different
  // states, and so is a query that never ran.
  const r = run({
    LH_LAW: 'ws-guid',
    LH_HITS_ROW: '',
    LH_CRED_NEWEST: CRED_TODAY,
    LH_MIN_END: daysOut(400),
  });
  assert.equal(r.code, 0, 'unknown is not broken and must not fail the verify');
  assert.equal(token(r.out), 'unknown');
  assert.match(r.out, /could NOT read the invalid_client count/);
  assert.doesNotMatch(r.out, /OK — no invalid_client callback errors/);
  assert.doesNotMatch(r.out, /::error::/);
});

test('#3498 ZERO — a query that RAN and found nothing is OK, and never consults recency', () => {
  // `0\t` (count zero, null timestamp) is the healthy shape of the new query. It
  // must not be confused with the unread state that shares an empty timestamp.
  const r = run({
    LH_LAW: 'ws-guid',
    LH_HITS_ROW: row(0, ''),
    LH_CRED_NEWEST: CRED_TODAY,
    LH_MIN_END: daysOut(400),
  });
  assert.equal(r.code, 0);
  assert.equal(token(r.out), 'ok');
  assert.match(r.out, /OK — no invalid_client callback errors in the last 7d/);
  assert.doesNotMatch(r.out, /UNPROVEN/);
});

test('#3498 PRECEDENCE — a demonstrated outage outranks an unprovable one', () => {
  // An expired credential is evidence in hand; an unorderable hit is not. If
  // `unproven` won, the job summary would soften a proven outage.
  const r = run({
    LH_LAW: 'ws-guid',
    LH_HITS_ROW: row(4),
    LH_CRED_NEWEST: CRED_TODAY,
    LH_MIN_END: daysOut(-5),
  });
  assert.equal(r.code, 1);
  assert.equal(token(r.out), 'broken');
});

test('#3498 PRECEDENCE — unproven outranks unknown, because only one of them blocks', () => {
  const r = run({
    LH_LAW: 'ws-guid',
    LH_HITS_ROW: row(4),
    LH_CRED_NEWEST: CRED_TODAY,
    LH_MIN_END: '', // (b) cannot be evaluated → unknown
  });
  assert.equal(r.code, 1);
  assert.equal(token(r.out), 'unproven');
});

test('#3498 — LH_HITS_ROW is authoritative; the split inputs cannot contradict it', () => {
  // The whole point of one query: two inputs that can disagree about whether the
  // read happened are how `<unread>` became reachable from a healthy estate.
  const r = run({
    LH_LAW: 'ws-guid',
    LH_HITS_ROW: row(4, '2026-08-15T10:00:00Z'),
    LH_HITS_RAW: '99',
    LH_HITS_LAST: '',
    LH_CRED_NEWEST: CRED_TODAY,
    LH_MIN_END: daysOut(400),
  });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /4 auth\/callback invalid_client error\(s\)/);
  assert.doesNotMatch(r.out, /99/);
});

// ---------------------------------------------------------------------------
// MUTATION RECEIPTS — each verdict must MOVE when its input moves. A recency
// function that returns the same thing for a hit at T-10d and a hit at T+1m is
// the #3160/#3498 defect restated, and every assertion above would still pass.
// ---------------------------------------------------------------------------
test('MUTATION: sliding ONLY the last-hit across the rotation flips ok ↔ broken', () => {
  const base = { LH_LAW: 'ws-guid', LH_CRED_NEWEST: CRED_TODAY, LH_MIN_END: daysOut(400) };
  const before = run({ ...base, LH_HITS_ROW: row(4, '2026-08-05T17:44:37Z') }); // T-10d
  const after = run({ ...base, LH_HITS_ROW: row(4, '2026-08-15T17:45:37Z') }); // T+1m
  assert.equal(token(before.out), 'ok');
  assert.equal(token(after.out), 'broken');
  assert.notEqual(before.code, after.code, 'the exit status must move with the input, not just the prose');
});

test('MUTATION: sliding ONLY the credential across the last hit flips broken ↔ ok', () => {
  // The mirror image. If the comparison were hard-coded to one side, one of
  // these two tests would still pass and the other would not.
  const base = { LH_LAW: 'ws-guid', LH_HITS_ROW: row(4, '2026-08-15T12:00:00Z'), LH_MIN_END: daysOut(400) };
  const older = run({ ...base, LH_CRED_NEWEST: '2026-08-15T11:59:00Z' });
  const newer = run({ ...base, LH_CRED_NEWEST: '2026-08-15T12:00:01Z' });
  assert.equal(token(older.out), 'broken');
  assert.equal(token(newer.out), 'ok');
});

test('MUTATION: the boundary is inclusive on the credential side and moves by ONE second', () => {
  const base = { LH_LAW: 'ws-guid', LH_CRED_NEWEST: CRED_TODAY, LH_MIN_END: daysOut(400) };
  const equal = run({ ...base, LH_HITS_ROW: row(1, CRED_TODAY) });
  const plus1 = run({ ...base, LH_HITS_ROW: row(1, '2026-08-15T17:44:38Z') });
  assert.equal(token(equal.out), 'ok', 'a hit AT the mint instant predates nothing that came after it');
  assert.equal(token(plus1.out), 'broken');
});

test('MUTATION: removing ONLY the timestamp turns a pass into unproven, never into a pass', () => {
  const base = { LH_LAW: 'ws-guid', LH_CRED_NEWEST: CRED_TODAY, LH_MIN_END: daysOut(400) };
  const withTs = run({ ...base, LH_HITS_ROW: row(4, '2026-08-15T10:00:00Z') });
  const without = run({ ...base, LH_HITS_ROW: row(4) });
  assert.equal(withTs.code, 0);
  assert.equal(without.code, 1);
  assert.equal(token(without.out), 'unproven');
});

test('MUTATION: changing ONLY the count moves the verdict between ok and a blocking state', () => {
  const base = { LH_LAW: 'ws-guid', LH_CRED_NEWEST: CRED_TODAY, LH_MIN_END: daysOut(400) };
  assert.equal(token(run({ ...base, LH_HITS_ROW: row(0, '') }).out), 'ok');
  assert.equal(token(run({ ...base, LH_HITS_ROW: row(1) }).out), 'unproven');
  assert.equal(token(run({ ...base, LH_HITS_ROW: row(1, '2026-08-15T18:00:00Z') }).out), 'broken');
});

test('an az ERROR that happens to contain digits is unreadable, NOT a hit count', () => {
  // `grep -oE '[0-9]+' | head -1` read "ERROR: (403) Forbidden" as 403
  // invalid_client hits and would page someone for what is a missing role
  // assignment. A count is the whole field or it is nothing.
  for (const bad of ['ERROR: (403) Forbidden', '403 Forbidden', 'None', '4 rows']) {
    const r = run({ LH_LAW: 'ws-guid', LH_HITS_ROW: bad, LH_MIN_END: daysOut(400) });
    assert.equal(r.code, 0, `"${bad}" must be unreadable, not a count: ${r.out}`);
    assert.equal(token(r.out), 'unknown');
    assert.doesNotMatch(r.out, /OK — no invalid_client callback errors/);
  }
});
