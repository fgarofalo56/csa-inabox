/**
 * ui-verify-gate-verdict.sh + loom-ui-verify wiring tests (refs #2871).
 *
 * THE DEFECT BEING FIXED
 * ----------------------
 * #2837 gave the login-health preflight teeth. But the preflight is an early
 * step, so once it could fail it ABORTED THE JOB before Playwright ran: with a
 * live AADSTS7000215 signal on the estate there was no obtainable browser-E2E
 * receipt for main at all, for any change. One true signal masked another.
 *
 * The fix is ORDERING, not tolerance — no skip input, no re-added
 * continue-on-error. The preflight records its verdict, the suite runs, and a
 * final `if: always()` step turns a BROKEN verdict back into a red run. So the
 * two properties worth pinning are:
 *
 *   1. the gate still FAILS on every blocking cause (it would be trivial to
 *      "fix" the masking by simply never failing — that is the #2837 defect
 *      returning), and
 *   2. an UNKNOWN verdict still PASSES (the original, legitimate tolerance;
 *      an over-broad fix that failed on "could not check" would be just as
 *      wrong, in the other direction).
 *
 * MUTATION-PROVEN (counts in the PR body):
 *   - gate script `exit 1` → `exit 0` (the mask returning): 6 tests RED, and
 *     every CONTROL stays green.
 *   - deleting the `Enforce login-health verdict…` step from the workflow:
 *     4 wiring tests RED.
 *   - `unknown` folded into the failing branch (an over-broad fix): the
 *     UNKNOWN + CONTROL tests go RED. So neither direction can hide.
 *
 * Run: node --test scripts/ci/__tests__/ui-verify-gate.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = resolve(HERE, '..', 'ui-verify-gate-verdict.sh');
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/loom-ui-verify.yml');
const WORKFLOW = readFileSync(WORKFLOW_PATH, 'utf8');

const GATE_STEP_NAME = 'Enforce login-health verdict + blocking suite results';
const PREFLIGHT_STEP_NAME = 'Login-health preflight (MSAL secret expiry + callback errors)';

function run(env = {}) {
  const r = spawnSync('bash', [GATE], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  });
  if (r.error) throw r.error;
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** Count the blocking causes the gate listed in its trailer. */
const causeCount = (out) =>
  out.split(/\r?\n/).filter((l) => /^ {2}- /.test(l)).length;

// ---------------------------------------------------------------------------
// THE MATRIX. Every row states the job outcome it must produce.
// ---------------------------------------------------------------------------

test('MATRIX: preflight BROKEN + suite green → job FAILS', () => {
  // The core of the fix: the suite got to run and passed, and the run is still
  // red for the sign-in outage. Identical outcome to the old early-abort.
  const r = run({
    UVG_PREFLIGHT_OUTCOME: 'success',
    UVG_VERDICT: 'broken',
    UVG_RC: '1',
    UVG_BLOCKING: 'verify=success,extra-projects=skipped',
  });
  assert.equal(r.code, 1, 'a broken sign-in path must still fail the run');
  assert.match(r.out, /::error::LOGIN-HEALTH BROKEN/);
  assert.equal(causeCount(r.out), 1);
});

test('MATRIX: preflight OK + suite red → job FAILS', () => {
  const r = run({
    UVG_PREFLIGHT_OUTCOME: 'success',
    UVG_VERDICT: 'ok',
    UVG_RC: '0',
    UVG_BLOCKING: 'verify=failure,extra-projects=skipped',
  });
  assert.equal(r.code, 1, 'a healthy login must not excuse a red browser suite');
  assert.match(r.out, /::error::the 'verify' step FAILED/);
  assert.equal(causeCount(r.out), 1);
});

test('MATRIX: both red → job FAILS and BOTH causes are visible', () => {
  // The explicit anti-swallow assertion. A gate that reported only the first
  // cause would send someone to fix half the problem.
  const r = run({
    UVG_PREFLIGHT_OUTCOME: 'success',
    UVG_VERDICT: 'broken',
    UVG_RC: '1',
    UVG_BLOCKING: 'verify=failure,extra-projects=failure',
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /::error::LOGIN-HEALTH BROKEN/);
  assert.match(r.out, /::error::the 'verify' step FAILED/);
  assert.match(r.out, /::error::the 'extra-projects' step FAILED/);
  assert.equal(causeCount(r.out), 3, 'every cause must reach the summary, not just the first');
});

test('MATRIX: preflight UNKNOWN + suite green → job PASSES, with a warning', () => {
  // The tolerance continue-on-error originally (and legitimately) existed for.
  // Removing the mask must NOT start failing "could not check".
  const r = run({
    UVG_PREFLIGHT_OUTCOME: 'success',
    UVG_VERDICT: 'unknown',
    UVG_RC: '0',
    UVG_BLOCKING: 'verify=success,extra-projects=skipped',
  });
  assert.equal(r.code, 0, 'unknown is not broken — it must never become a false failure');
  assert.match(r.out, /::warning::login-health is INDETERMINATE/);
  assert.doesNotMatch(r.out, /::error::/);
});

// ---------------------------------------------------------------------------
// MATRIX for `unproven` (#3498). It sits between `unknown` and `broken` and is
// neither: hits ARE in hand (unlike unknown, so it blocks) and their recency was
// never established (unlike broken, so it must not say sign-in is down).
// ---------------------------------------------------------------------------

test('MATRIX #3498: preflight UNPROVEN + suite green → job FAILS', () => {
  // An unreadable timestamp must NEVER silently pass. This is the row that
  // proves the fix did not weaken the gate.
  const r = run({
    UVG_PREFLIGHT_OUTCOME: 'success',
    UVG_VERDICT: 'unproven',
    UVG_RC: '1',
    UVG_BLOCKING: 'verify=success,extra-projects=skipped',
  });
  assert.equal(r.code, 1, 'an unestablished recency must fail closed');
  assert.match(r.out, /::error::LOGIN-HEALTH UNPROVEN/);
  assert.equal(causeCount(r.out), 1);
});

test('MATRIX #3498: UNPROVEN does not assert that sign-in is down (deploy-integrity R7)', () => {
  // Folded into `broken`, this run\'s summary read "the preflight found evidence
  // that sign-in is down" when what happened was that a query returned no
  // timestamp — and that sent two investigations at a freshly rotated credential.
  const r = run({
    UVG_PREFLIGHT_OUTCOME: 'success',
    UVG_VERDICT: 'unproven',
    UVG_RC: '1',
    UVG_BLOCKING: 'verify=success',
  });
  assert.doesNotMatch(r.out, /found evidence that sign-in is down/);
  assert.match(r.out, /NOT a finding that sign-in is down/);
  assert.match(r.out, /could NOT establish whether any of them postdates/);
});

test('MATRIX #3498: UNPROVEN recorded against rc=0 is a contradiction, and fails twice over', () => {
  // The two signals are recorded independently precisely so drift between them
  // is loud. `unproven` with a zero exit means something stopped failing closed.
  const r = run({
    UVG_PREFLIGHT_OUTCOME: 'success',
    UVG_VERDICT: 'unproven',
    UVG_RC: '0',
    UVG_BLOCKING: 'verify=success',
  });
  assert.equal(r.code, 1);
  assert.equal(causeCount(r.out), 2, 'the verdict AND the disagreement must both be reported');
  assert.match(r.out, /the two recorded signals disagree|signals disagree/i);
});

test('MATRIX #3498: UNPROVEN is distinguishable from UNKNOWN in the outcome, not just the prose', () => {
  // The mutation receipt for this gate: change ONLY the token and the exit
  // status must move. A gate that returns 0 for both is the defect restated.
  const base = { UVG_PREFLIGHT_OUTCOME: 'success', UVG_RC: '0', UVG_BLOCKING: 'verify=success' };
  const unknown = run({ ...base, UVG_VERDICT: 'unknown' });
  const unproven = run({ ...base, UVG_VERDICT: 'unproven', UVG_RC: '1' });
  assert.equal(unknown.code, 0);
  assert.equal(unproven.code, 1);
});

// ---------------------------------------------------------------------------
// MATRIX for the two labels added by #2875. Before that change the gate was fed
// `verify` and `extra-projects` only, and the comment above it blessed
// publish-version and the receipt as "deliberate continue-on-error tolerance" —
// which is precisely how run 30824614880 concluded green over a failed
// Playwright test. These rows pin the four corners for the new labels.
// ---------------------------------------------------------------------------

test('MATRIX #2875: publish-version FAILED + everything else green → job FAILS', () => {
  const r = run({
    UVG_PREFLIGHT_OUTCOME: 'success',
    UVG_VERDICT: 'ok',
    UVG_RC: '0',
    UVG_BLOCKING: 'verify=success,extra-projects=skipped,publish-version=failure,receipt=skipped',
  });
  assert.equal(r.code, 1, 'a red publish-version suite must fail the run — this is the #2875 defect');
  assert.match(r.out, /::error::the 'publish-version' step FAILED/);
  assert.equal(causeCount(r.out), 1);
});

test('MATRIX #2875: publish-version FLAKY-but-passed-on-retry → job PASSES', () => {
  // Playwright exits 0 when a test fails then passes within `retries`, so the
  // step outcome is `success`. The retries added to the project are what makes
  // this row distinguishable from the one above; without them every hiccup
  // would land in the FAILED row and the tolerance flag would come straight
  // back.
  const r = run({
    UVG_PREFLIGHT_OUTCOME: 'success',
    UVG_VERDICT: 'ok',
    UVG_RC: '0',
    UVG_BLOCKING: 'verify=success,extra-projects=skipped,publish-version=success,receipt=skipped',
  });
  assert.equal(r.code, 0, 'a flaky-then-passing suite must not fail the run');
  assert.doesNotMatch(r.out, /::error::/);
});

test('MATRIX #2875: the optional receipt FAILED → job FAILS', () => {
  // e2e-receipt.mjs exits 2 on UNREACHABLE and 3 on SESSION REJECTED. A route
  // the operator explicitly asked to receipt failing to load is the finding,
  // not noise.
  const r = run({
    UVG_PREFLIGHT_OUTCOME: 'success',
    UVG_VERDICT: 'ok',
    UVG_RC: '0',
    UVG_BLOCKING: 'verify=success,extra-projects=skipped,publish-version=success,receipt=failure',
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /::error::the 'receipt' step FAILED/);
});

test('MATRIX #2875: a not-dispatched receipt (skipped) is NOT a failure', () => {
  // The receipt only runs when target_route is set; a blank dispatch must stay
  // green or every routine verify goes red.
  const r = run({
    UVG_PREFLIGHT_OUTCOME: 'success',
    UVG_VERDICT: 'ok',
    UVG_RC: '0',
    UVG_BLOCKING: 'verify=success,extra-projects=skipped,publish-version=success,receipt=skipped',
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /receipt: skipped \(not a blocking result\)/);
});

test('MATRIX #2875: preflight BROKEN + publish-version FAILED → BOTH causes visible', () => {
  const r = run({
    UVG_PREFLIGHT_OUTCOME: 'success',
    UVG_VERDICT: 'broken',
    UVG_RC: '1',
    UVG_BLOCKING: 'verify=success,extra-projects=skipped,publish-version=failure,receipt=failure',
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /::error::LOGIN-HEALTH BROKEN/);
  assert.match(r.out, /::error::the 'publish-version' step FAILED/);
  assert.match(r.out, /::error::the 'receipt' step FAILED/);
  assert.equal(causeCount(r.out), 3);
});

// ---------------------------------------------------------------------------
// FAIL-CLOSED — a gate that reads absence as health is #2837 in a new place.
// ---------------------------------------------------------------------------

test('the preflight RAN but recorded no verdict → FAILS closed', () => {
  const r = run({
    UVG_PREFLIGHT_OUTCOME: 'success',
    UVG_VERDICT: '',
    UVG_RC: '0',
    UVG_BLOCKING: 'verify=success,extra-projects=skipped',
  });
  assert.equal(r.code, 1, 'a missing verdict is not a healthy one');
  assert.match(r.out, /recorded no usable verdict/);
});

test('an unrecognised verdict string → FAILS closed', () => {
  const r = run({
    UVG_PREFLIGHT_OUTCOME: 'success',
    UVG_VERDICT: 'probably-fine',
    UVG_RC: '0',
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /recorded no usable verdict/);
});

test('verdict says ok but the preflight exited non-zero → FAILS on the disagreement', () => {
  // Two independent signals are recorded so drift is loud. Resolving a
  // contradiction in favour of the cheerful signal is how gates rot.
  const r = run({
    UVG_PREFLIGHT_OUTCOME: 'success',
    UVG_VERDICT: 'ok',
    UVG_RC: '1',
    UVG_BLOCKING: 'verify=success',
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /the two recorded signals disagree|signals disagree/i);
});

test('a preflight that never ran does NOT invent a failure', () => {
  // outcome '' / skipped only happens when an earlier step already failed the
  // job (or it was cancelled). Nothing is being masked, and a second red
  // annotation would only obscure the real cause.
  for (const outcome of ['', 'skipped', 'cancelled']) {
    const r = run({
      UVG_PREFLIGHT_OUTCOME: outcome,
      UVG_VERDICT: '',
      UVG_RC: '',
      UVG_BLOCKING: 'verify=success,extra-projects=skipped',
    });
    assert.equal(r.code, 0, `outcome='${outcome}' must not fail the gate by itself`);
    assert.match(r.out, /did not run/);
  }
});

test('a preflight that never ran still lets a red suite through to failure', () => {
  // The "did not run" branch must not become an early return that skips the
  // suite check — that would be the masking bug rebuilt inside the gate.
  const r = run({
    UVG_PREFLIGHT_OUTCOME: 'skipped',
    UVG_VERDICT: '',
    UVG_RC: '',
    UVG_BLOCKING: 'verify=failure',
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /::error::the 'verify' step FAILED/);
});

// ---------------------------------------------------------------------------
// CONTROL — green BOTH ways. These fail if the fix is over-broad (fail-always),
// which is the other way to "solve" this badly.
// ---------------------------------------------------------------------------

test('CONTROL: everything healthy → exit 0, no error annotations', () => {
  const r = run({
    UVG_PREFLIGHT_OUTCOME: 'success',
    UVG_VERDICT: 'ok',
    UVG_RC: '0',
    UVG_BLOCKING: 'verify=success,extra-projects=success',
  });
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /::error::/);
  assert.match(r.out, /\[ui-verify-gate\] OK/);
});

test('CONTROL: a skipped optional project is not a failure', () => {
  const r = run({
    UVG_PREFLIGHT_OUTCOME: 'success',
    UVG_VERDICT: 'ok',
    UVG_RC: '0',
    UVG_BLOCKING: 'verify=success,extra-projects=skipped',
  });
  assert.equal(r.code, 0);
});

test('CONTROL: no blocking list declared at all still passes on a healthy verdict', () => {
  const r = run({ UVG_PREFLIGHT_OUTCOME: 'success', UVG_VERDICT: 'ok', UVG_RC: '0' });
  assert.equal(r.code, 0);
  assert.match(r.out, /\(none declared\)/);
});

test('CONTROL: verdict ok with NO recorded rc warns but does not fail', () => {
  // An absent rc is not a contradiction; only a present, non-zero one is.
  const r = run({ UVG_PREFLIGHT_OUTCOME: 'success', UVG_VERDICT: 'ok', UVG_RC: '' });
  assert.equal(r.code, 0);
  assert.match(r.out, /no exit status/);
});

test('whitespace around the blocking pairs is tolerated', () => {
  // Guards against a YAML folded-scalar edit silently turning `verify=failure`
  // into ` verify=failure` and thus into an unmatched, ignored outcome.
  const r = run({
    UVG_PREFLIGHT_OUTCOME: 'success',
    UVG_VERDICT: 'ok',
    UVG_RC: '0',
    UVG_BLOCKING: ' verify=failure , extra-projects=success ',
  });
  assert.equal(r.code, 1, 'a padded pair must still be read as a failure');
  assert.match(r.out, /::error::the 'verify' step FAILED/);
});

// ---------------------------------------------------------------------------
// THE WIRING — the gate only helps if the workflow actually calls it, last,
// unconditionally, and without tolerance. Prose in a comment is not a control.
// ---------------------------------------------------------------------------

/** Slice the lines belonging to one named step out of the workflow. */
function stepByName(yaml, name) {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  if (start < 0) return null;
  const indent = lines[start].match(/^(\s*)/)[1].length;
  for (let j = start + 1; j < lines.length; j++) {
    if (lines[j].trim() === '') continue;
    const ind = lines[j].match(/^(\s*)/)[1].length;
    if (ind < indent || (ind === indent && /^\s*-\s+\S/.test(lines[j]))) {
      return lines.slice(start, j).join('\n');
    }
  }
  return lines.slice(start).join('\n');
}

/** Line indices of every step in the job, in order. */
function stepStarts(yaml) {
  return yaml
    .split(/\r?\n/)
    .map((l, i) => (/^\s{6}-\s+name:/.test(l) ? i : -1))
    .filter((i) => i >= 0);
}

test('WIRING: the enforcing step exists and invokes the gate script', () => {
  const step = stepByName(WORKFLOW, GATE_STEP_NAME);
  assert.ok(step, `loom-ui-verify.yml has no "${GATE_STEP_NAME}" step — #2837 is re-opened`);
  assert.match(step, /run:\s*bash scripts\/ci\/ui-verify-gate-verdict\.sh/);
});

test('WIRING: the enforcing step runs with if: always()', () => {
  // Without this it is skipped whenever an earlier step fails — which is the
  // masking bug moved one step later rather than fixed.
  const step = stepByName(WORKFLOW, GATE_STEP_NAME);
  assert.match(step, /^\s*if:\s*always\(\)\s*$/m);
});

test('WIRING: the enforcing step has NO continue-on-error', () => {
  const step = stepByName(WORKFLOW, GATE_STEP_NAME);
  assert.doesNotMatch(step, /continue-on-error/, 'tolerating the gate defeats the gate');
});

test('WIRING: the enforcing step is the LAST step in the job', () => {
  const lines = WORKFLOW.split(/\r?\n/);
  const starts = stepStarts(WORKFLOW);
  const gateIdx = lines.findIndex((l) => l.trim() === `- name: ${GATE_STEP_NAME}`);
  assert.ok(gateIdx > 0);
  assert.equal(
    starts[starts.length - 1],
    gateIdx,
    'the gate must stay last so every blocking step has already reported',
  );
});

test('WIRING: the gate is fed the ids of steps that actually exist', () => {
  // A typo'd id silently evaluates to the empty string, which this gate treats
  // as "did not run" — i.e. it would pass. Pin the ids to real declarations.
  const gate = stepByName(WORKFLOW, GATE_STEP_NAME);
  const referenced = [...gate.matchAll(/steps\.([A-Za-z0-9_-]+)\./g)].map((m) => m[1]);
  assert.ok(referenced.length >= 3, `expected the gate to read several step outputs, saw ${referenced.length}`);
  for (const id of new Set(referenced)) {
    assert.match(
      WORKFLOW,
      new RegExp(`^\\s*id:\\s*${id}\\s*$`, 'm'),
      `the gate reads steps.${id}.* but no step declares id: ${id}`,
    );
  }
});

test('WIRING: the preflight records a verdict and no longer aborts the job', () => {
  const step = stepByName(WORKFLOW, PREFLIGHT_STEP_NAME);
  assert.ok(step, 'the login-health preflight step is gone');
  assert.match(step, /^\s*id:\s*login_health\s*$/m, 'the gate cannot read a verdict from an id-less step');
  assert.match(step, /bash scripts\/ci\/login-health-verdict\.sh/, 'the preflight must still run the verdict script');
  assert.match(step, /rc=\$rc" >> "\$GITHUB_OUTPUT/, 'the raw exit status must be recorded for the cross-check');
});

test('WIRING: the preflight did NOT get continue-on-error back (#2837 must stay closed)', () => {
  // The forbidden "fix". The preflight is allowed to defer enforcement; it is
  // not allowed to have its result discarded.
  const step = stepByName(WORKFLOW, PREFLIGHT_STEP_NAME);
  assert.doesNotMatch(step, /continue-on-error/);
});

test('WIRING: no skip/bypass input was added to the workflow', () => {
  // The other forbidden shortcut. A `skip_login_health`-shaped input would make
  // the gate optional at dispatch time, which is tolerance by another name.
  assert.doesNotMatch(WORKFLOW, /skip[_-]?(login|preflight|health)/i);
});

test('WIRING: login-health-verdict.sh records the verdict it now promises', () => {
  // The workflow relies on the script writing `verdict=` to $GITHUB_OUTPUT. If
  // that write is ever removed the gate fails closed rather than passing, but
  // it would fail on EVERY run — pin the contract at its source instead.
  const src = readFileSync(resolve(HERE, '..', 'login-health-verdict.sh'), 'utf8');
  assert.match(src, /verdict=\$\{VERDICT\}" >> "\$GITHUB_OUTPUT/);
});

// ── #3498 WIRING: the recency read must survive as ONE query ────────────────
// The verdict script has been able to order the hits against the credential
// since #3160. It was never given the timestamp to do it with: the preflight ran
// TWO `az monitor log-analytics query` calls, the count returned 4 and the
// timestamp returned EMPTY, and the gate failed closed on `last-hit=<unread>`
// from 2026-08-10 until this fix — blocking every G1 browser receipt in the repo.
// These pin the shape that makes that state unreachable from a working query.

test('WIRING #3498: the preflight reads the count and the timestamp from ONE query', () => {
  const step = stepConfigById('login_health');
  const queries = [...step.matchAll(/--analytics-query/g)].length;
  assert.equal(
    queries,
    1,
    'two reads of the same population can disagree about whether they ran; one row from one query cannot',
  );
  assert.match(
    step,
    /summarize hits\s*=\s*count\(\),\s*newest\s*=\s*max\(TimeGenerated\)/,
    'the count alone cannot order the errors against the credential rotation (#3160)',
  );
  assert.match(step, /LH_HITS_ROW="\$HITS_ROW"/, 'the row must reach the verdict script');
});

test('WIRING #3498: the hits query keeps its container scope', () => {
  // check-containerlog-query-scope.mjs exists because this exact query once
  // counted the Actions runner echoing its own annotation back into the table.
  const step = stepConfigById('login_health');
  assert.match(step, /where ContainerAppName_s == 'loom-console'/);
});

test('WIRING #3498: the hits query still has NO `|| echo 0` fallback', () => {
  // An empty result means the query did not run. Mapping it to a clean zero is
  // the second half of #2837 and would make this gate pass by failing to read.
  const step = stepConfigById('login_health');
  assert.doesNotMatch(step, /\|\|\s*echo\s+0/);
});

test('WIRING #3498: the reads that feed the verdict no longer discard stderr', () => {
  // `2>/dev/null` is why #3498 was undiagnosable: the query failed, the reason
  // went to the void, and `<unread>` with no cause attached pointed two
  // investigations at a credential that had just been rotated correctly.
  const step = stepConfigById('login_health');
  const lines = step.split('\n').filter((l) => /az (monitor log-analytics query|ad app credential list)/.test(l));
  assert.ok(lines.length >= 3, `expected the hits + credential reads, saw ${lines.length}`);
  for (const l of lines) {
    assert.doesNotMatch(l, /2>\/dev\/null/, `this read still discards its own diagnosis: ${l.trim()}`);
  }
  assert.match(step, /LH_HITS_ERR="\$HITS_ERR"/);
  assert.match(step, /LH_CRED_ERR="\$CRED_ERR"/);
});


/**
 * Extract one `- name: …` step block from the workflow by its `id:`.
 * Deliberately string-based, like the rest of this file: it must fail if the
 * step is renamed or its id removed, not silently match nothing.
 *
 * COMMENTS ARE STRIPPED. This file's steps carry long comment blocks that QUOTE
 * the very strings under test — the publish-version step's comment says
 * `continue-on-error: true` four times while describing the #2875 defect it
 * fixed. A naive substring check reads that prose as configuration and fails on
 * a correct file. (It did, on the first version of this helper.)
 */
function stepBlockById(id) {
  const steps = WORKFLOW.split(/^      - name: /m).slice(1);
  const found = steps.find((b) => new RegExp(`^\\s*id:\\s*${id}\\s*$`, 'm').test(b));
  assert.ok(found, `no step with \`id: ${id}\` found in loom-ui-verify.yml`);
  return found;
}

/** The same block with comment-only lines removed — prose is not configuration. */
function stepConfigById(id) {
  return stepBlockById(id)
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

test('WIRING: the independent suites are not SKIPPED by a base-suite failure (F1)', () => {
  // `verify` is the base smoke suite. On run 31229730356 a single unrelated
  // probe in it flaked ("MIP sensitivity labels -> 503", while the other three
  // governance probes returned 200). That failed the step — and GitHub then
  // SKIPPED every later step, so the `external-engine-federation` receipt the
  // run had been dispatched to collect never executed at all.
  //
  // Each independent suite must therefore carry `!cancelled()`, so an unrelated
  // failure upstream cannot make its result unobtainable. That is ORDERING, not
  // tolerance — the companion test below pins the difference.
  for (const stepId of ['extra_projects', 'publish_version', 'receipt']) {
    const block = stepConfigById(stepId);
    assert.ok(
      /if:\s*\$\{\{[^}]*!\s*cancelled\(\)/.test(block),
      `step '${stepId}' must carry \`if: \${{ !cancelled() && ... }}\` so a failure in the `
        + `base verify suite cannot SKIP it. Without that, one unrelated flake makes an `
        + `independent receipt unobtainable for every change.`,
    );
  }
});

test('WIRING: !cancelled() did NOT become continue-on-error (tolerance stays out)', () => {
  // The distinction that matters, and the one this file exists to defend.
  // `!cancelled()` makes a step RUN after an earlier failure; `continue-on-error`
  // makes its OWN failure invisible. The first adds signal, the second destroys
  // it (#2787, #2875). Only the first is permitted, and every browser step must
  // still reach the always() gate.
  for (const stepId of ['verify_project', 'extra_projects', 'publish_version', 'receipt']) {
    assert.doesNotMatch(
      stepConfigById(stepId),
      /continue-on-error:\s*(true|'true'|"true")/,
      `step '${stepId}' must NOT carry continue-on-error — its failure has to reach the job conclusion.`,
    );
    assert.match(
      WORKFLOW,
      new RegExp(`steps\\.${stepId}\\.outcome`),
      `the always() gate must still consume steps.${stepId}.outcome, or '${stepId}' stops blocking.`,
    );
  }
});
