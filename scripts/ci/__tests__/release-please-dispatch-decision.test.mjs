#!/usr/bin/env node
/**
 * release-please dispatch decision — BEHAVIOURAL proof against the real step.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT A STATIC GUARD
 * ------------------------------------------------
 * #3448 shipped `check-release-please-integrity.mjs`, which asserts structural
 * properties of `release-please.yml`. Every one of those invariants PASSED on
 * the workflow that then deadlocked the release lane on 2026-08-14. A static
 * guard cannot see that two halves of a step read DIFFERENT sources of truth
 * and disagree; only running the step can.
 *
 * So this suite EXTRACTS the real `run:` body out of the workflow and EXECUTES
 * it with `gh` and `sleep` stubbed — it does not model the logic. If the shell
 * changes, this runs the changed shell.
 *
 * THE INCIDENT IT PINS (release PR #3447, head 3a21f6e0)
 * -----------------------------------------------------
 *   actions/runs?head_sha=3a21f6e0  -> 10 runs, ALL event=pull_request,
 *                                      status=completed, conclusion=action_required
 *   commits/3a21f6e0/check-runs     -> total_count = 0
 *
 * The dispatch half read the first and skipped ("a run already exists"); the
 * verdict half read the second and failed with 14 ABSENT. Deterministic skip +
 * deterministic fail = a lane that can never recover. A gate that cannot pass
 * is as broken as one that cannot fail.
 *
 * Run: node --test scripts/ci/__tests__/release-please-dispatch-decision.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'release-please.yml');
const SHA = '3a21f6e08f77f82aef6ac62d218cb63d577c14f2';
const STEP_NAME = 'Run the required checks for real on every open release PR';

/**
 * The pre-fix step body, VENDORED rather than read from git at test time.
 *
 * `git show 22f7fa1b:…` cannot work in the lane that runs this suite — the
 * `node:test suites (node 20)` job checks out with the default depth of 1, so
 * the object is simply not present. A control that cannot run in CI is not a
 * control. The fixture is pinned by digest instead, so it cannot drift
 * silently, and a byte-comparison against git still runs wherever the object
 * IS available (any full clone, including every developer's).
 */
const FIXTURE = path.join(REPO_ROOT, 'scripts', 'ci', '__fixtures__', 'release-please-step-22f7fa1b.sh');
const FIXTURE_SHA256 = '7553b2ea8b2293457100d1d6f2660387bbe41915573f16e209a36eb50a461a65';

/** The 14 required contexts, read from the workflow itself — never re-typed. */
function requiredContexts(text) {
  const out = [];
  let inside = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^REQUIRED_CHECKS=\($/.test(line)) { inside = true; continue; }
    if (!inside) continue;
    if (line === ')') break;
    const m = line.match(/^"([^"|]*)\|/);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * Pull one step's `run:` body out of the workflow YAML by name.
 * Deliberately not a YAML library: the point is to get the literal text the
 * runner would execute, and to fail loudly if it cannot be found.
 */
function extractStep(text, name) {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => l.includes(`- name: ${name}`));
  assert.ok(at >= 0, `step "${name}" not found in release-please.yml`);
  const runAt = lines.findIndex((l, i) => i > at && /^\s+run: \|\s*$/.test(l));
  assert.ok(runAt > at, `step "${name}" has no "run: |" block`);
  const indent = lines[runAt + 1].match(/^\s*/)[0].length;
  const body = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') { body.push(''); continue; }
    if (l.match(/^\s*/)[0].length < indent) break;
    body.push(l.slice(indent));
  }
  const src = body.join('\n');
  assert.ok(src.includes('REQUIRED_CHECKS=('), 'extracted body is missing the manifest — extraction drifted');
  return src;
}

const WF_TEXT = readFileSync(WORKFLOW, 'utf8');
const CONTEXTS = requiredContexts(WF_TEXT);
const STEP_SRC = extractStep(WF_TEXT, STEP_NAME);

/**
 * Run a step body with a stubbed `gh` + `sleep`.
 *
 * `fixtures` is a JSON document the stub reads to answer each API shape. The
 * stub models the GitHub API, never the step's logic — the logic under test is
 * the genuine shell.
 *
 * EVERY stub answer is funnelled through `emit`, which strips CR. That is not
 * cosmetic and it is not papering over a product bug: `jq` built for Windows
 * opens stdout in text mode and translates LF to CRLF, while the ubuntu-latest
 * runner this workflow actually executes on does not. Without the strip, the
 * FIRST thing this harness "found" was the release PR's own `CHANGELOG.md`
 * being rejected as a non-metadata file — a defect that exists only on this
 * developer's machine. A stub that does not match the runner invents bugs as
 * readily as it hides them.
 */
function runStepSource(src, fixtures) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rp-step-'));
  const bin = path.join(dir, 'bin');
  const ans = path.join(dir, 'ans');
  mkdirSync(bin);
  mkdirSync(ans);

  // Every answer is PRE-RENDERED here, in JS, so the stub costs one `cat` per
  // call instead of spawning `jq`. That is not tidiness: this suite drives the
  // real step body, which itself forks awk/cut per required context per poll,
  // and the shared `node --test` fan-out is where process cost actually bites.
  // CR is stripped at render time — Windows jq emits CRLF, the ubuntu runner
  // this workflow executes on emits LF, and the stub must model the runner. The
  // first thing this harness "found" was the release PR's own CHANGELOG.md
  // being rejected as a non-metadata file, purely from a trailing \r.
  const put = (name, text) => writeFileSync(path.join(ans, name), String(text).replace(/\r/g, ''));
  put('pr_list', JSON.stringify(fixtures.pr_list));
  put('files', fixtures.files.join('\n') + '\n');
  put(
    'check_runs',
    fixtures.check_runs.map((c) => `${c.name}\t${c.status}\t${c.conclusion ?? ''}\thttp://run`).join('\n') +
      (fixtures.check_runs.length ? '\n' : ''),
  );
  put('dispatch_paths', fixtures.dispatch_run_paths.join('\n') + (fixtures.dispatch_run_paths.length ? '\n' : ''));
  put(
    'legacy_rows',
    fixtures.legacy_run_rows.map((r) => `${r.path}\t${r.status}\t${r.conclusion ?? ''}\thttp://run`).join('\n') + '\n',
  );
  put('branch', fixtures.branch + '\n');
  put('merge_state', fixtures.merge_state + '\n');
  put('rollup', JSON.stringify(fixtures.rollup));
  put('review_decision', fixtures.review_decision + '\n');
  fixtures.head_sha_seq.forEach((s, i) => put(`sha_${i}`, s + '\n'));
  put('sha_last', String(fixtures.head_sha_seq.length - 1));

  const gh = [
    '#!/usr/bin/env bash',
    '# Stub for `gh`. Answers are pre-rendered files; every call it does not',
    '# recognise is a hard error, so a step that starts making a NEW API call',
    '# cannot silently get an empty string back and read it as "none".',
    'A="$ANS"',
    'ARGS="$*"',
    'echo "$ARGS" >> "$GH_CALL_LOG"',
    'case "$ARGS" in',
    '  "pr list"*)          cat "$A/pr_list" ;;',
    '  *"/files"*)          cat "$A/files" ;;',
    '  *"/check-runs"*)     cat "$A/check_runs" ;;',
    // The pre-fix code queried actions/runs twice with different --jq shapes.
    // Serving both lets the historical body run unmodified.
    '  *"actions/runs"*)    if [ "$ARGS" = "${ARGS%.status*}" ]; then cat "$A/dispatch_paths"; else cat "$A/legacy_rows"; fi ;;',
    '  *"statuses/"*)       echo "{}" ;;',
    '  "workflow run"*)     if [ "$DISPATCH_OK" = "true" ]; then exit 0; else echo "dispatch refused" >&2; exit 1; fi ;;',
    // head.sha walks a SEQUENCE so a test can model the head moving mid-flight.
    '  *head.sha*)          n=$(cat "$GH_SHA_SEQ"); echo $((n+1)) > "$GH_SHA_SEQ"; last=$(cat "$A/sha_last"); if [ "$n" -gt "$last" ]; then n=$last; fi; cat "$A/sha_$n" ;;',
    '  *head.ref*)          cat "$A/branch" ;;',
    '  *mergeStateStatus*)  cat "$A/merge_state" ;;',
    '  *statusCheckRollup*) cat "$A/rollup" ;;',
    '  *reviewDecision*)    cat "$A/review_decision" ;;',
    '  *) echo "STUB-GH: unhandled call: $ARGS" >&2; exit 97 ;;',
    'esac',
  ].join('\n');
  writeFileSync(path.join(bin, 'gh'), gh);
  chmodSync(path.join(bin, 'gh'), 0o755);
  writeFileSync(path.join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(path.join(bin, 'sleep'), 0o755);

  const script = path.join(dir, 'step.sh');
  writeFileSync(script, src, { encoding: 'utf8' });
  const callLog = path.join(dir, 'gh-calls.log');
  writeFileSync(callLog, '');
  const shaSeq = path.join(dir, 'sha-seq');
  writeFileSync(shaSeq, '0\n');

  const res = spawnSync('bash', [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      ANS: ans,
      GH_CALL_LOG: callLog,
      GH_SHA_SEQ: shaSeq,
      DISPATCH_OK: fixtures.dispatch_ok ? 'true' : 'false',
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_RUN_ID: '1',
      RP_POLL_SLEEP: '0',
      RP_WAIT_POLLS: '3',
      RP_DISPATCH_POLLS: '1',
    },
  });
  const calls = readFileSync(callLog, 'utf8');
  rmSync(dir, { recursive: true, force: true });
  return { code: res.status, out: `${res.stdout}\n${res.stderr}`, calls };
}

const runStep = (fixtures) => runStepSource(STEP_SRC, fixtures);

/** Fixture defaults: one release PR, metadata-only diff, nothing graded yet. */
function fixtures(over = {}) {
  return {
    pr_list: [{ number: 3447, headRefName: 'release-please--branches--main--components--csa-inabox' }],
    files: ['CHANGELOG.md', 'pyproject.toml', '.release-please-manifest.json'],
    branch: 'release-please--branches--main--components--csa-inabox',
    // Successive `.head.sha` reads walk this list; the last value repeats.
    head_sha_seq: [SHA],
    check_runs: [],
    dispatch_run_paths: [],
    // What the PRE-FIX code saw on PR #3447: ten runs, held, ungraded. Only
    // the four producing workflows matter to its probe.
    legacy_run_rows: dispatchPathsRaw.map((p) => ({
      path: p,
      status: 'completed',
      conclusion: 'action_required',
    })),
    dispatch_ok: true,
    merge_state: 'BLOCKED',
    rollup: [],
    review_decision: 'REVIEW_REQUIRED',
    ...over,
  };
}

const allGreen = () =>
  CONTEXTS.map((name) => ({ name, status: 'completed', conclusion: 'success' }));
const dispatchPathsRaw = [
  '.github/workflows/validate.yml',
  '.github/workflows/test.yml',
  '.github/workflows/loom-guardrails.yml',
  '.github/workflows/fiab-console-ci.yml',
];
const dispatchPaths = dispatchPathsRaw;

// ── the extraction itself must not silently drift ───────────────────────────

test('CONTROL: the step body and the 14 contexts really were extracted', () => {
  assert.equal(CONTEXTS.length, 14, `expected 14 required contexts, extracted ${CONTEXTS.length}`);
  assert.ok(STEP_SRC.length > 4000, `step body suspiciously short (${STEP_SRC.length} chars)`);
  assert.ok(STEP_SRC.includes('check_runs_tsv'), 'the check-run helper is missing from the extracted body');
});

test('CONTROL: the stub fails loudly on an API call it does not model', () => {
  // If unmodelled calls returned an empty string instead of erroring, every
  // assertion below could pass against a step that had stopped asking the right
  // questions — the "unknown reported as negative" class.
  const probing = `gh api "repos/o/r/some/endpoint/nobody/modelled"\n${STEP_SRC}`;
  const r = runStepSource(probing, fixtures());
  assert.notEqual(r.code, 0, 'an unmodelled call must abort the step');
  assert.match(r.out, /STUB-GH: unhandled call/);
});

// ── THE DEADLOCK ────────────────────────────────────────────────────────────

test('REGRESSION #3447: held pull_request runs on the SHA must NOT suppress dispatch', () => {
  // The precise incident state: workflow runs exist (held, ungraded), zero
  // check runs. The old probe read the former and skipped forever.
  const r = runStep(
    fixtures({
      check_runs: [],
      // Note the stub's actions/runs answer is the DISPATCH-filtered one. The
      // step must not be consulting an unfiltered run list at all; if it were,
      // it would need those held pull_request paths, which are deliberately
      // absent here.
      dispatch_run_paths: dispatchPaths,
    }),
  );
  assert.match(r.out, /> dispatching validate\.yml/, 'validate.yml must be dispatched');
  assert.match(r.out, /> dispatching test\.yml/, 'test.yml must be dispatched');
  assert.match(r.out, /> dispatching loom-guardrails\.yml/, 'loom-guardrails.yml must be dispatched');
  assert.match(r.out, /> dispatching fiab-console-ci\.yml/, 'fiab-console-ci.yml must be dispatched');
  assert.doesNotMatch(r.out, /not re-dispatching/, 'nothing may be skipped when no check run exists');
});

test('the dispatch probe queries workflow_dispatch runs ONLY — never a bare head_sha list', () => {
  // The bare list is what returns the ten held pull_request runs. Pinning the
  // event is the load-bearing half of the fix, so it is asserted on the CALLS
  // the step actually made, not on the source text.
  const r = runStep(fixtures({ dispatch_run_paths: dispatchPaths }));
  const runCalls = r.calls.split('\n').filter((l) => l.includes('actions/runs'));
  assert.ok(runCalls.length > 0, 'the step never queried actions/runs at all');
  for (const c of runCalls) {
    assert.match(c, /event=workflow_dispatch/, `unpinned actions/runs query: ${c}`);
  }
});

test('a producer whose contexts ALL already have check runs is not re-dispatched', () => {
  // The skip must still work on real evidence — otherwise the fix would just be
  // "always dispatch", which burns CI and proves nothing.
  const r = runStep(fixtures({ check_runs: allGreen(), dispatch_run_paths: dispatchPaths }));
  assert.doesNotMatch(r.out, /> dispatching/, 'nothing should be dispatched when every context is already graded');
  assert.match(r.out, /not re-dispatching/);
});

// ── the three states, said apart (R7) ───────────────────────────────────────

test('STATE 1 — zero check runs: says nothing ran, and does NOT claim a mapping defect', () => {
  const r = runStep(fixtures({ check_runs: [], dispatch_run_paths: dispatchPaths }));
  assert.notEqual(r.code, 0, 'an ungraded release PR must fail the lane');
  assert.match(r.out, /ZERO check runs exist/);
  assert.match(r.out, /NOT a REQUIRED_CHECKS mapping problem/);
  assert.doesNotMatch(
    r.out,
    /the producing workflow ran but published no check run/,
    'this is the false claim #3447 emitted — it must not be reachable here',
  );
});

test('STATE 2 — check runs exist under other names: names them and DOES call it a mapping defect', () => {
  const r = runStep(
    fixtures({
      check_runs: [
        { name: 'Some Other Job', status: 'completed', conclusion: 'success' },
        { name: 'python-lint', status: 'completed', conclusion: 'success' },
      ],
      dispatch_run_paths: dispatchPaths,
    }),
  );
  assert.notEqual(r.code, 0);
  assert.match(r.out, /REQUIRED_CHECKS mapping defect/);
  assert.match(r.out, /python-lint/, 'the names actually present must be listed');
  assert.doesNotMatch(r.out, /ZERO check runs exist/);
});

test('STATE 3 — a required context concluded failure: real red, exit 1, failure status posted', () => {
  const runs = allGreen();
  runs[0] = { name: CONTEXTS[0], status: 'completed', conclusion: 'failure' };
  const r = runStep(fixtures({ check_runs: runs, dispatch_run_paths: dispatchPaths }));
  assert.notEqual(r.code, 0, 'NON-WEAKENING CONTROL: a red required context must still block');
  assert.match(r.out, /NOT-GREEN/);
  assert.match(r.calls, /state=failure/, 'a failure status must be posted, not merely withheld');
  assert.doesNotMatch(r.out, /ZERO check runs exist/);
  assert.doesNotMatch(r.out, /mapping defect/);
});

test('SHA churn during the wait is reported as churn, not as slow CI or a mapping defect', () => {
  const r = runStep(
    fixtures({
      check_runs: [],
      dispatch_run_paths: dispatchPaths,
      // First read is the SHA the step grades; the next read finds it moved.
      head_sha_seq: [SHA, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'],
    }),
  );
  assert.notEqual(r.code, 0);
  assert.match(r.out, /SHA churn/);
  assert.doesNotMatch(r.out, /mapping defect/, 'churn must not be reported as a mapping defect');
});

// ── the happy path still works, and still bridges ───────────────────────────

test('all 14 contexts green: bridges 14 success statuses and exits 0', () => {
  const r = runStep(
    fixtures({
      check_runs: allGreen(),
      dispatch_run_paths: dispatchPaths,
      merge_state: 'BLOCKED',
      review_decision: 'REVIEW_REQUIRED',
    }),
  );
  assert.equal(r.code, 0, `expected a clean pass, got:\n${r.out}`);
  const posted = r.calls.split('\n').filter((l) => l.includes('state=success')).length;
  assert.equal(posted, 14, `expected 14 bridged statuses, saw ${posted}`);
  assert.match(r.out, /0 synthetic statuses posted/);
  assert.match(
    r.out,
    /reviewDecision is REVIEW_REQUIRED/,
    'the permanent review gate must still be named, not guessed at',
  );
});

// ── #4038 — the messages must not assert what the job did not establish ─────

test('R7: the review-gate arm no longer DENIES context drift it cannot observe', () => {
  // The old wording ended "NOT context drift." Measured 2026-09-07 with an admin
  // token: branch protection carried 15 required contexts and REQUIRED_CHECKS
  // carried 14 — so the denial was false at the moment it was being printed.
  // GITHUB_TOKEN cannot read protection at all, which is exactly why the claim
  // was never the job's to make.
  const r = runStep(
    fixtures({
      check_runs: allGreen(),
      dispatch_run_paths: dispatchPaths,
      merge_state: 'BLOCKED',
      review_decision: 'REVIEW_REQUIRED',
    }),
  );
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /NOT context drift/, 'the unestablished denial is back');
  assert.match(r.out, /did NOT establish/, 'the limit must be stated, not merely dropped');
  assert.match(r.out, /cannot read branch protection/);
});

test('R7: a CANCELLED required context is reported as NO VERDICT, not as a real red result', () => {
  // A cancelled run measured nothing — `csa_loom_cancelled_job_with_zero_steps_
  // measured_nothing`. The previous shape posted the same message for it as for
  // a genuine failure: "each of these is a REAL red result from a real run".
  const runs = allGreen();
  runs[0] = { name: CONTEXTS[0], status: 'completed', conclusion: 'cancelled' };
  const r = runStep(fixtures({ check_runs: runs, dispatch_run_paths: dispatchPaths }));
  assert.notEqual(r.code, 0, 'fail-closed must be preserved — an unmeasured context still blocks');
  assert.match(r.out, /NO-VERDICT/);
  assert.match(r.out, /ended WITHOUT a/, 'the unmeasured class must be named');
  assert.doesNotMatch(
    r.out,
    /REAL red result/,
    'a cancelled run must not be described as a real red result',
  );
  assert.match(r.calls, /state=failure/, 'it still overwrites any stale green — fail closed');
});

test('a genuinely FAILING required context is still called a real red result', () => {
  // The other direction: the split must not blunt the real verdict.
  const runs = allGreen();
  runs[0] = { name: CONTEXTS[0], status: 'completed', conclusion: 'failure' };
  const r = runStep(fixtures({ check_runs: runs, dispatch_run_paths: dispatchPaths }));
  assert.notEqual(r.code, 0);
  assert.match(r.out, /REAL-RED/);
  assert.match(r.out, /REAL red result from a/);
  assert.doesNotMatch(r.out, /ended WITHOUT a/, 'a failure is not an unmeasured context');
});

test('post-verify: a CANCELLED required context in the rollup is not reported as FAILING', () => {
  const r = runStep(
    fixtures({
      check_runs: allGreen(),
      dispatch_run_paths: dispatchPaths,
      merge_state: 'BLOCKED',
      rollup: [{ name: CONTEXTS[0], status: 'COMPLETED', conclusion: 'CANCELLED' }],
      review_decision: 'APPROVED',
    }),
  );
  assert.notEqual(r.code, 0, 'still blocks');
  assert.match(r.out, /ended WITHOUT a\s*\n?::error::verdict/);
  assert.doesNotMatch(r.out, /BLOCKED with FAILING required contexts/);
});

test('post-verify: a genuinely FAILING rollup entry is still reported as failing', () => {
  const r = runStep(
    fixtures({
      check_runs: allGreen(),
      dispatch_run_paths: dispatchPaths,
      merge_state: 'BLOCKED',
      rollup: [{ name: CONTEXTS[0], status: 'COMPLETED', conclusion: 'FAILURE' }],
      review_decision: 'APPROVED',
    }),
  );
  assert.notEqual(r.code, 0);
  assert.match(r.out, /BLOCKED with FAILING required contexts/);
});

// ── the rollup arm's FATAL SET is unchanged by the #4038 re-description ──────
//
// Review finding, 2026-09-08. The first revision of the #4038 edit also moved
// SKIPPED / ACTION_REQUIRED / STALE out of the fall-through and into the fatal
// arm. That is not a re-description, it is a new red — and it is a FALSE one.
// Measured A/B against the parent workflow at 899ea91b670 on the fixture below
// (14 required check runs green and bridged, statusCheckRollup ALSO carrying a
// duplicate entry under the same context name, reviewDecision=REVIEW_REQUIRED):
//
//   conclusion        parent exit   first-revision exit
//   SKIPPED           0             1
//   ACTION_REQUIRED   0             1
//   STALE             0             1
//   CANCELLED         1             1
//   TIMED_OUT         1             1
//   FAILURE           1             1
//
// The context in those first three rows WAS measured, and measured GREEN, by
// the check-run read in the bridge loop — which is why 14 statuses were bridged
// in every one of those runs. Blocking on a coarser second view of the same
// commit manufactures a red over a context that concluded success.
//
// These three tests pin the parent's exit code, so a future edit cannot quietly
// widen the fatal set again while describing itself as a wording change.

const dupRollup = (conclusion) => [
  ...CONTEXTS.map((name) => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' })),
  { name: CONTEXTS[0], status: 'COMPLETED', conclusion },
];

for (const conclusion of ['SKIPPED', 'ACTION_REQUIRED', 'STALE']) {
  test(`post-verify: a ${conclusion} rollup entry alongside a measured-green context does NOT block`, () => {
    const r = runStep(
      fixtures({
        check_runs: allGreen(),
        dispatch_run_paths: dispatchPaths,
        merge_state: 'BLOCKED',
        rollup: dupRollup(conclusion),
        review_decision: 'REVIEW_REQUIRED',
      }),
    );
    assert.equal(r.code, 0, `${conclusion} must not turn the release lane red — the parent exits 0 here`);
    assert.doesNotMatch(r.out, /ended WITHOUT a/, 'it must not be reported as an unmeasured BLOCKING context');
    assert.doesNotMatch(r.out, /BLOCKED with FAILING/, 'it is not a failing context either');
    // Not blocking is not the same as not being SEEN. R7 cuts both ways: the
    // state is named, and the warning says what it did not establish.
    assert.match(r.out, /measured nothing \(SKIPPED \/ ACTION_REQUIRED \/ STALE\)/);
    assert.match(r.out, /What this line does NOT establish/);
  });
}

test('post-verify: CANCELLED and TIMED_OUT still block, exactly as they did before the split', () => {
  // The other half of the parity claim. These two were ALREADY fatal in the
  // single pre-#4038 `failing` expression; only the sentence changed.
  for (const conclusion of ['CANCELLED', 'TIMED_OUT']) {
    const r = runStep(
      fixtures({
        check_runs: allGreen(),
        dispatch_run_paths: dispatchPaths,
        merge_state: 'BLOCKED',
        rollup: dupRollup(conclusion),
        review_decision: 'REVIEW_REQUIRED',
      }),
    );
    assert.notEqual(r.code, 0, `${conclusion} must still block`);
    assert.match(r.out, /ended WITHOUT a/, `${conclusion} must be named as unmeasured, not as a red result`);
  }
});

test('CONTROL: the fatal rollup set is exactly the four conclusions the pre-#4038 expression matched', () => {
  // A source-level control over the two jq programs, so the pair cannot drift
  // apart from the behavioural tests above. This is a CONTROL on the split, not
  // the proof — the proof is the exit codes asserted in the tests around it.
  const fatal = new Set();
  for (const varName of ['failing', 'unmeasured']) {
    const at = STEP_SRC.indexOf(`${varName}=$(printf`);
    assert.ok(at > 0, `the ${varName} rollup expression is missing`);
    const chunk = STEP_SRC.slice(at, STEP_SRC.indexOf("join(\", \")')", at));
    for (const m of chunk.matchAll(/==\s*"([A-Z_]+)"/g)) fatal.add(m[1]);
  }
  assert.deepEqual(
    [...fatal].sort(),
    ['CANCELLED', 'ERROR', 'FAILURE', 'TIMED_OUT'],
    'the rollup arm blocks on a different set than the pre-#4038 code did',
  );
});

test('CONTROL: the post-verify rollup arm posts NO commit status of its own', () => {
  // The PR body originally claimed "both still post a failure status". That is
  // true of the BRIDGE LOOP and false here: this arm only echoes and exits. The
  // claim is corrected; this control keeps it honest.
  const r = runStep(
    fixtures({
      check_runs: allGreen(),
      dispatch_run_paths: dispatchPaths,
      merge_state: 'BLOCKED',
      rollup: [{ name: CONTEXTS[0], status: 'COMPLETED', conclusion: 'FAILURE' }],
      review_decision: 'APPROVED',
    }),
  );
  assert.notEqual(r.code, 0);
  // 14 status POSTs, all from the bridge loop, all success — none from this arm.
  const posts = r.calls.split('\n').filter((l) => l.includes('statuses/'));
  assert.equal(posts.length, 14, `expected only the 14 bridged statuses, saw ${posts.length}`);
  assert.equal(
    posts.filter((l) => l.includes('state=failure')).length,
    0,
    'the rollup arm posted a failure status — the "both post a failure status" claim would need revisiting',
  );
});

test('post-verify names UNLISTED non-green contexts as drift CANDIDATES, without asserting they are required', () => {
  // The only drift signal this token can actually observe. It is the shape the
  // live estate is in: protection carries `changelog parser can read every
  // commit message`, REQUIRED_CHECKS does not.
  const r = runStep(
    fixtures({
      check_runs: allGreen(),
      dispatch_run_paths: dispatchPaths,
      merge_state: 'BLOCKED',
      rollup: [
        { name: 'changelog parser can read every commit message', status: 'COMPLETED', conclusion: 'PENDING' },
      ],
      review_decision: 'REVIEW_REQUIRED',
    }),
  );
  assert.match(r.out, /changelog parser can read every commit message/);
  assert.match(r.out, /MAY be a required context this mirror is missing/);
  assert.doesNotMatch(r.out, /NOT context drift/);
});

test('NON-WEAKENING CONTROL: no success status is ever posted for an ungraded context', () => {
  // Two ungraded shapes; `state=success` must appear zero times in either. The
  // third ungraded shape (check runs present under other names) is covered by
  // STATE 2 above, which exits non-zero for the same reason.
  for (const f of [
    fixtures({ check_runs: [], dispatch_run_paths: dispatchPaths }),
    fixtures({
      check_runs: [],
      dispatch_run_paths: dispatchPaths,
      head_sha_seq: [SHA, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'],
    }),
  ]) {
    const r = runStepSource(STEP_SRC, f);
    assert.doesNotMatch(r.calls, /state=success/, 'a success status leaked on an ungraded release');
  }
});

// ── the production budgets are the defaults, not the test's ─────────────────

test('the poll budgets default to the measured production values', () => {
  // The test seam must not become the shipped value.
  assert.match(WF_TEXT, /POLL_SLEEP="\$\{RP_POLL_SLEEP:-15\}"/);
  assert.match(WF_TEXT, /WAIT_POLLS="\$\{RP_WAIT_POLLS:-180\}"/, '180 x 15s = 45 min, sized from the 2083s slowest producer');
  assert.match(WF_TEXT, /DISPATCH_POLLS="\$\{RP_DISPATCH_POLLS:-12\}"/);
});

test('the vendored pre-fix body is pinned by digest, and matches git wherever git has it', () => {
  assert.ok(existsSync(FIXTURE), 'the pre-fix fixture is missing — the historical control cannot run');
  const vendored = readFileSync(FIXTURE, 'utf8').replace(/\r\n/g, '\n');
  assert.equal(
    createHash('sha256').update(vendored, 'utf8').digest('hex'),
    FIXTURE_SHA256,
    'the vendored pre-fix body changed. It is a historical artifact and must not be edited; if it genuinely needs regenerating, re-extract it from 22f7fa1b and update the digest deliberately.',
  );

  // Second layer, where it can run: byte-compare against git itself. A shallow
  // CI checkout does not have the object, so this half is opportunistic — but
  // the digest above runs everywhere, and the reproduction below no longer
  // depends on git at all.
  let fromGit = null;
  try {
    fromGit = execFileSync('git', ['show', '22f7fa1b:.github/workflows/release-please.yml'], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    fromGit = null;
  }
  if (fromGit === null) {
    console.log('    (git object 22f7fa1b not present — shallow clone; digest check alone applies here)');
    return;
  }
  assert.equal(extractStep(fromGit, STEP_NAME), vendored, 'the vendored fixture drifted from 22f7fa1b');
});

test('HISTORICAL REPRODUCTION: the code that shipped in 22f7fa1b deadlocks on this same state', () => {
  // Not a synthetic mutation — the ACTUAL pre-fix step body, run against the
  // ACTUAL incident fixtures. If this ever stops deadlocking, the fixtures no
  // longer model #3447 and the regression test above proves nothing.
  const oldSrc = readFileSync(FIXTURE, 'utf8').replace(/\r\n/g, '\n');
  assert.ok(
    oldSrc.includes('runs_for_sha'),
    'the historical body should contain the workflow-run probe; if it does not, the wrong body was vendored',
  );

  const r = runStepSource(oldSrc, fixtures({ check_runs: [], dispatch_run_paths: dispatchPaths }));
  assert.match(r.out, /not re-dispatching/, 'the old probe skipped dispatch on held runs');
  assert.doesNotMatch(r.out, /> dispatching/, 'and dispatched nothing — the deadlock');
  assert.match(r.out, /ABSENT/, 'then graded every context ABSENT');
  assert.match(
    r.out,
    /REQUIRED_CHECKS mapping defect/,
    'and asserted a cause it had not established — the R7 half of the same bug',
  );
  assert.notEqual(r.code, 0);
});
