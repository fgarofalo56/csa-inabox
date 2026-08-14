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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'release-please.yml');
const SHA = '3a21f6e08f77f82aef6ac62d218cb63d577c14f2';
const STEP_NAME = 'Run the required checks for real on every open release PR';

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
  mkdirSync(bin);
  writeFileSync(path.join(dir, 'fixtures.json'), JSON.stringify(fixtures));

  const gh = [
    '#!/usr/bin/env bash',
    '# Stub for `gh`. Answers by URL/argv shape from fixtures.json; every call',
    '# it does not recognise is a hard error, so a step that starts making a new',
    '# API call cannot silently get an empty string back and read it as "none".',
    'F="$FIXTURE_FILE"',
    'ARGS="$*"',
    'echo "$ARGS" >> "$GH_CALL_LOG"',
    '# Windows jq emits CRLF; the ubuntu runner emits LF. Model the runner.',
    'emit() { tr -d "\\r"; }',
    'case "$ARGS" in',
    '  "pr list"*)      jq -c ".pr_list" "$F" | emit ;;',
    '  *"/files"*)      jq -r ".files[]" "$F" | emit ;;',
    '  *"/check-runs"*) jq -r \'.check_runs[] | [.name,.status,(.conclusion // ""),"http://run"] | @tsv\' "$F" | emit ;;',
    // The pre-fix code queried actions/runs twice with different --jq shapes.
    // Serving both lets the historical step body run unmodified below.
    '  *"actions/runs"*) if [ "$ARGS" = "${ARGS%.status*}" ]; then jq -r ".dispatch_run_paths[]" "$F" | emit; else jq -r \'.legacy_run_rows[] | [.path,.status,(.conclusion // ""),"http://run"] | @tsv\' "$F" | emit; fi ;;',
    '  *"statuses/"*)   echo "{}" ;;',
    '  "workflow run"*) if [ "$(jq -r ".dispatch_ok" "$F" | emit)" = "true" ]; then exit 0; else echo "dispatch refused" >&2; exit 1; fi ;;',
    // head.sha is served from a SEQUENCE so a test can model the head moving
    // mid-flight, which is the SHA-churn case the step must not misreport.
    '  *head.sha*)      n=$(cat "$GH_SHA_SEQ"); echo $((n+1)) > "$GH_SHA_SEQ"; len=$(jq -r ".head_sha_seq|length" "$F" | emit); if [ "$n" -ge "$len" ]; then n=$((len-1)); fi; jq -r ".head_sha_seq[$n]" "$F" | emit ;;',
    '  *head.ref*)      jq -r ".branch" "$F" | emit ;;',
    '  *mergeStateStatus*) jq -r ".merge_state" "$F" | emit ;;',
    '  *statusCheckRollup*) jq -c ".rollup" "$F" | emit ;;',
    '  *reviewDecision*) jq -r ".review_decision" "$F" | emit ;;',
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
      FIXTURE_FILE: path.join(dir, 'fixtures.json'),
      GH_CALL_LOG: callLog,
      GH_SHA_SEQ: shaSeq,
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_RUN_ID: '1',
      RP_POLL_SLEEP: '0',
      RP_WAIT_POLLS: '6',
      RP_DISPATCH_POLLS: '2',
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
  assert.match(r.out, /requires an approving review/, 'the permanent review gate must still be named, not guessed at');
});

test('NON-WEAKENING CONTROL: no success status is ever posted for an ungraded context', () => {
  // Across every not-green scenario, `state=success` must appear zero times.
  for (const f of [
    fixtures({ check_runs: [], dispatch_run_paths: dispatchPaths }),
    fixtures({
      check_runs: [{ name: 'Some Other Job', status: 'completed', conclusion: 'success' }],
      dispatch_run_paths: dispatchPaths,
    }),
    fixtures({ check_runs: [], dispatch_run_paths: dispatchPaths, head_sha_now: 'deadbeef' }),
  ]) {
    const r = runStep(f);
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

test('HISTORICAL REPRODUCTION: the code that shipped in 22f7fa1b deadlocks on this same state', () => {
  // Not a synthetic mutation — the ACTUAL pre-fix step body, read out of git,
  // run against the ACTUAL incident fixtures. If this ever stops deadlocking,
  // the fixtures no longer model #3447 and the regression test above proves
  // nothing.
  let oldWf;
  try {
    oldWf = execFileSync('git', ['show', '22f7fa1b:.github/workflows/release-please.yml'], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (err) {
    assert.fail(
      `could not read the pre-fix workflow from git (${err.message}). This control cannot be silently skipped — a skipped control is not a passing one.`,
    );
  }
  const oldSrc = extractStep(oldWf, STEP_NAME);
  assert.ok(
    oldSrc.includes('runs_for_sha'),
    'the historical body should contain the workflow-run probe; if it does not, the wrong commit was read',
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

  // And the fix, on the identical fixtures, does the opposite.
  const fixed = runStepSource(STEP_SRC, fixtures({ check_runs: [], dispatch_run_paths: dispatchPaths }));
  assert.match(fixed.out, /> dispatching/, 'the current body dispatches instead');
  assert.doesNotMatch(fixed.out, /REQUIRED_CHECKS mapping defect/, 'and does not invent a mapping defect');
});
