#!/usr/bin/env node
/**
 * deploy-copilot-function preflight — MUTATION PROOFS. (refs #3429)
 *
 * ── WHY THIS RUNS THE REAL BASH ────────────────────────────────────────────
 * Same reason as sc1-verify-gate.test.mjs: this repo has a recorded failure
 * class of tests that model the CODE instead of the shipped thing. So this
 * harness EXTRACTS the step's `run:` body from the workflow verbatim and
 * executes it with `az` and `curl` stubbed on PATH. It also DERIVES the step's
 * declared `env:` keys and asserts it supplies every one — the exact drift that
 * broke #3422, where a newly-added `env:` key made the extracted script abort
 * under `set -u` and the suite exited non-zero having emitted no failed
 * assertion at all.
 *
 * Three things the harness supplies that the workflow does not declare, each
 * for a reason:
 *
 *   `bash -e`  — GitHub runs every `run:` under it, and the step's own comment
 *     turns on that fact ("`set -uo pipefail` does NOT clear it, so every
 *     capture uses the `if ! VAR=$(...)` form"). Running plain `bash` here
 *     would test a shell the estate never uses and could not catch an errexit
 *     abort at all.
 *
 *   `GITHUB_OUTPUT` — runner-provided, read under `set -u`, and NOT inherited
 *     from the parent process. Inheriting it made this suite behave one way on
 *     a runner and another way on a workstation, which is how a stale
 *     expectation survives review. Each run now gets its own file and the
 *     harness READS IT BACK, so the verdict is asserted rather than assumed.
 *     That matters more than it looks: `steps.preflight.outputs.verdict` is
 *     what gates the provisioning step, so a branch that writes no verdict, or
 *     the wrong one, either silently provisions nothing or provisions into a
 *     subscription that does not hold the estate.
 *
 *   a stubbed `curl` — the liveness probe is a real unauthenticated GET to
 *     azurewebsites.net. Left unstubbed the suite depends on the public
 *     internet and on the app being up, and cannot assert the one thing the
 *     probe exists for: that the message QUOTES the status code this run
 *     measured instead of asserting a hard-coded "answers 200" (R7).
 *
 * ── WHAT THIS PROVES ───────────────────────────────────────────────────────
 * That the preflight's verdicts are DISTINGUISHABLE, that each says only what
 * it established, and that each one writes the verdict the next step branches
 * on. The bug being fixed is an error message that asserted "Resource ...
 * doesn't exist" when the truth was "I could not see it from the subscription I
 * was given" — the app was up and serving 200 the whole time
 * (deploy-integrity.md R7).
 *
 * Run: node --test scripts/ci/__tests__/copilot-function-preflight.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'deploy-copilot-function.yml');
const STEP_NAME = 'Preflight — resolve the Function App and say what was ACTUALLY established';

/** Pull a step's `run:` block out of the workflow, verbatim. */
function extractRunBlock(src, stepName) {
  const lines = String(src).split(/\r?\n/);
  const at = lines.findIndex((l) => l.includes(`- name: ${stepName}`));
  assert.ok(at >= 0, `step not found in the workflow: ${stepName}`);
  const runAt = lines.findIndex((l, i) => i > at && /^\s*run: \|\s*$/.test(l));
  assert.ok(runAt > at, `no \`run: |\` after step: ${stepName}`);
  const indent = (lines[runAt + 1].match(/^ */) || [''])[0].length;
  const body = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') { body.push(''); continue; }
    if (!l.startsWith(' '.repeat(indent))) break;
    body.push(l.slice(indent));
  }
  return body.join('\n');
}

/**
 * The env keys the JOB declares. This step inherits them, and the extracted
 * script runs under `set -u`, so an unsupplied key aborts it before the first
 * assertion — silently, with no `not ok` and no TAP footer (#3422).
 */
function extractJobEnv(src) {
  const lines = String(src).split(/\r?\n/);
  const at = lines.findIndex((l) => /^\s{4}env:\s*$/.test(l));
  assert.ok(at >= 0, 'no job-level env: block found');
  const keys = [];
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') continue;
    const indent = (l.match(/^ */) || [''])[0].length;
    if (indent <= 4) break;
    if (/^\s*#/.test(l)) continue;
    const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*):/);
    assert.ok(m, `unparsed line in the job env: block — the harness must not guess:\n${l}`);
    keys.push(m[1]);
  }
  return keys;
}

/**
 * @param {object} o
 * @param {boolean} [o.accountReadable]   `az account show` succeeds
 * @param {boolean} [o.appInExpectedRg]   `az functionapp show` succeeds
 * @param {boolean} [o.rgCheckReadable]   `az group exists` succeeds
 * @param {boolean} [o.subScanReadable]   `az resource list` succeeds
 * @param {string}  [o.rgExists]          'true' | 'false'
 * @param {string}  [o.foundInRg]         a DIFFERENT rg where the app is visible
 * @param {boolean} [o.probeReachable]    `curl` reaches the public endpoint
 * @param {string}  [o.probeCode]         the HTTP status the probe measures
 * @returns {{code:number, out:string, verdict:string|null}}
 */
function runPreflight({
  accountReadable = true,
  appInExpectedRg = false,
  rgCheckReadable = true,
  subScanReadable = true,
  rgExists = 'true',
  foundInRg = '',
  probeReachable = true,
  probeCode = '200',
} = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cfp-'));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);

  writeFileSync(
    path.join(bin, 'az'),
    `#!/usr/bin/env bash
case "$1 $2" in
  "account show")
    if [ "$STUB_ACCOUNT_READABLE" != "1" ]; then echo "Please run 'az login'" >&2; exit 1; fi
    echo "FedCiv ATU FFL - DLZ"; exit 0 ;;
  "functionapp show")
    if [ "$STUB_APP_IN_RG" != "1" ]; then
      echo "ResourceNotFound: The Resource 'Microsoft.Web/sites/x' under resource group 'y' was not found." >&2
      exit 1
    fi
    echo "Running"; exit 0 ;;
  "group exists")
    if [ "$STUB_RG_CHECK_READABLE" != "1" ]; then echo "AuthorizationFailed" >&2; exit 1; fi
    echo "$STUB_RG_EXISTS"; exit 0 ;;
  "resource list")
    if [ "$STUB_SUB_SCAN_READABLE" != "1" ]; then
      echo "AuthorizationFailed: does not have authorization to perform action 'Microsoft.Resources/subscriptions/resources/read'" >&2
      exit 1
    fi
    if [ -n "$STUB_FOUND_IN_RG" ]; then echo "$STUB_FOUND_IN_RG"; exit 0; fi
    exit 0 ;;
esac
exit 0
`,
    { mode: 0o755 },
  );

  // The liveness probe. `-o /dev/null -w '%{http_code}'` means the status code
  // is the only thing on stdout, so the stub prints exactly that.
  writeFileSync(
    path.join(bin, 'curl'),
    `#!/usr/bin/env bash
if [ "$STUB_PROBE_REACHABLE" != "1" ]; then
  echo "curl: (6) Could not resolve host: ${'${FUNCTION_APP_NAME}'}.azurewebsites.net" >&2
  exit 6
fi
printf '%s' "$STUB_PROBE_CODE"
exit 0
`,
    { mode: 0o755 },
  );

  const script = path.join(dir, 'preflight.sh');
  writeFileSync(script, extractRunBlock(readFileSync(WORKFLOW, 'utf8'), STEP_NAME));

  const outFile = path.join(dir, 'github_output');
  writeFileSync(outFile, '');

  const childEnv = {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    FUNCTION_APP_NAME: 'func-csa-inabox-copilot-fg',
    FUNCTION_APP_RG: 'rg-dlz-aiml-stack-dev',
    FUNCTION_PATH: 'azure-functions/copilot-chat',
    PYTHON_VERSION: '3.12',
    // Runner-provided, and NOT inherited: see the header. The step writes its
    // verdict here under `set -u`.
    GITHUB_OUTPUT: outFile,
    STUB_ACCOUNT_READABLE: accountReadable ? '1' : '0',
    STUB_APP_IN_RG: appInExpectedRg ? '1' : '0',
    STUB_RG_CHECK_READABLE: rgCheckReadable ? '1' : '0',
    STUB_SUB_SCAN_READABLE: subScanReadable ? '1' : '0',
    STUB_RG_EXISTS: rgExists,
    STUB_FOUND_IN_RG: foundInRg,
    STUB_PROBE_REACHABLE: probeReachable ? '1' : '0',
    STUB_PROBE_CODE: probeCode,
  };

  // DERIVED coverage: every job env key must be supplied here explicitly.
  const declared = extractJobEnv(readFileSync(WORKFLOW, 'utf8'));
  const uncovered = declared.filter((k) => !(k in childEnv));
  assert.deepEqual(
    uncovered,
    [],
    `the job declares env key(s) this harness does not supply: ${uncovered.join(', ')}. ` +
      'The extracted script runs under `set -u`, so an unsupplied key aborts it before any ' +
      'assertion runs — which surfaces as a suite that exits non-zero having reported no failure ' +
      `at all (#3422). declared: ${declared.join(', ')}`,
  );

  let code = 0;
  let out = '';
  try {
    // `bash -e` — the shell GitHub actually runs a `run:` block under.
    out = execFileSync('bash', ['-e', script], {
      cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...childEnv },
    });
  } catch (e) {
    code = e.status ?? 1;
    out = `${e.stdout || ''}${e.stderr || ''}`;
  }

  const written = readFileSync(outFile, 'utf8');
  const hits = [...written.matchAll(/^verdict=(.*)$/gm)].map((m) => m[1].trim());
  assert.ok(hits.length <= 1, `the step wrote ${hits.length} verdicts; exactly one is a verdict:\n${written}`);
  return { code, out, verdict: hits[0] ?? null };
}

// ── every state writes the verdict the NEXT step branches on ────────────────

test('the app is where it should be → preflight PASSES and names the state', () => {
  const r = runPreflight({ appInExpectedRg: true });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.verdict, 'found');
  assert.match(r.out, /preflight OK/);
  assert.match(r.out, /state: Running/);
});

test('the subscription itself is unreadable → claims NOTHING about the app', () => {
  const r = runPreflight({ accountReadable: false });
  assert.equal(r.code, 1);
  assert.equal(r.verdict, 'unknown');
  assert.match(r.out, /NOTHING about the Function App has been established/);
  // Must not assert absence it never tested.
  assert.ok(!/does NOT exist/.test(r.out), `claimed absence without testing it:\n${r.out}`);
});

test('app absent from the expected RG but present elsewhere in the sub → names the real RG', () => {
  const r = runPreflight({ foundInRg: 'rg-somewhere-else' });
  assert.equal(r.code, 1);
  assert.equal(r.verdict, 'wrong-resource-group');
  assert.match(r.out, /EXISTS in subscription/);
  assert.match(r.out, /rg-somewhere-else/);
  assert.match(r.out, /set FUNCTION_APP_RG/);
});

test('RG exists, app not in it → ABSENT-HERE, and the lane goes on to provision it', () => {
  // The contract this step now carries. It used to exit 1 here with "two causes
  // remain and this run cannot separate them", which was an honest message and
  // a dead end: the app had no producer anywhere in the tree, so the only exit
  // from that state was a hand-run `az functionapp create`
  // (auto-bind-by-default.md §5). The ambiguity is now resolved by ASKING ARM
  // in the provisioning step rather than by guessing here, so this state has to
  // exit 0 and hand it `absent-here` — an ::error:: would fail the job and the
  // gated step would never run.
  const r = runPreflight({ rgExists: 'true' });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.verdict, 'absent-here');
  assert.match(r.out, /Provisioning it from bicep/);
  assert.doesNotMatch(r.out, /::error::/, 'an error here would skip the provisioning step it hands off to');
  // R7, unchanged in force: the group is readable and the app is not in it —
  // that is ALL this run established. It must not upgrade "not in this group"
  // into "not in this subscription", which is the false claim the whole step
  // exists to stop.
  assert.ok(
    !/doesn't exist|does not exist in/.test(r.out),
    `asserted non-existence the read does not support:\n${r.out}`,
  );
});

test('RG does not exist → WRONG SUBSCRIPTION, and NOTHING is provisioned', () => {
  const r = runPreflight({ rgExists: 'false' });
  assert.equal(r.code, 1);
  assert.equal(r.verdict, 'wrong-subscription');
  assert.match(r.out, /pointed at the wrong subscription/);
  assert.match(r.out, /Repoint the secret rather than re-creating the app/);
  // The non-obvious half: this state exits 1 ON PURPOSE so the provisioning
  // step cannot run. Building the app here would put a second estate beside the
  // real one — which has already happened to this app once.
  assert.match(r.out, /NOTHING is provisioned in this state/);
  assert.notEqual(r.verdict, 'absent-here');
});

test('the RG check itself fails → UNKNOWN, explicitly not disproven', () => {
  const r = runPreflight({ rgCheckReadable: false });
  assert.equal(r.code, 1);
  assert.equal(r.verdict, 'unknown');
  assert.match(r.out, /UNKNOWN, not disproven/);
});

test('the subscription-wide lookup fails → UNKNOWN, and it does NOT fall through to provisioning', () => {
  // The `2>/dev/null` that used to end this capture discarded the failure and
  // fell through to ELSEWHERE="" — indistinguishable from "the app is nowhere
  // else in this subscription". That swallow decided only an error string once;
  // it now decides whether the next step WRITES, so "I could not look" turning
  // into "it is not there" would provision a second copy beside a live one.
  // Nothing covered this branch before.
  const r = runPreflight({ subScanReadable: false });
  assert.equal(r.code, 1);
  assert.equal(r.verdict, 'unknown');
  assert.match(r.out, /its location is UNKNOWN, not established/);
  assert.match(r.out, /could build a second copy beside a live one/);
  assert.notEqual(r.verdict, 'absent-here', 'fail-closed: an unreadable scan must not authorise a write');
});

// ── R7: the liveness clause must quote what this run measured ───────────────

test('the liveness clause quotes the status code the probe actually got', () => {
  // It used to be the hard-coded sentence "The app IS live: …/api/health answers
  // 200", printed by branches that had run no probe at all. A present-tense fact
  // the code never established is the R7 defect this step was written to remove,
  // so it must not reappear as a literal.
  const r = runPreflight({ rgExists: 'true', probeCode: '503' });
  assert.equal(r.verdict, 'absent-here');
  assert.match(r.out, /answered HTTP 503 when this run asked/);
  assert.doesNotMatch(r.out, /answers 200/);
});

test('an unreachable probe says the PROBE failed, not that the app is absent', () => {
  const r = runPreflight({ rgExists: 'false', probeReachable: false });
  assert.equal(r.code, 1);
  assert.equal(r.verdict, 'wrong-subscription');
  assert.match(r.out, /could NOT be reached by this run/);
  assert.match(r.out, /establishes only that the probe failed, NOT that the app is absent/);
  // A failed probe must not be silently upgraded into a status code.
  assert.doesNotMatch(r.out, /answered HTTP/);
});

// ── the non-weakening control ───────────────────────────────────────────────

test('every reachable state is DISTINGUISHABLE, in message AND in verdict', () => {
  // Causes that used to collapse into one false sentence must produce different
  // sentences. The verdict half is the newer and the more load-bearing one:
  // `found` and `absent-here` BOTH exit 0, so exit status alone can no longer
  // tell the provisioning step whether to write. If those two ever produced the
  // same verdict the lane would either skip a real provision or re-apply a full
  // siteConfig over a live app.
  const states = [
    ['unknown/account', runPreflight({ accountReadable: false })],
    ['unknown/rg', runPreflight({ rgCheckReadable: false })],
    ['unknown/sub-scan', runPreflight({ subScanReadable: false })],
    ['wrong-resource-group', runPreflight({ foundInRg: 'rg-elsewhere' })],
    ['absent-here', runPreflight({ rgExists: 'true' })],
    ['wrong-subscription', runPreflight({ rgExists: 'false' })],
    ['found', runPreflight({ appInExpectedRg: true })],
  ];

  const messages = states.map(([, r]) => r.out.replace(/\s+/g, ' ').trim());
  assert.equal(
    new Set(messages).size,
    states.length,
    `two causes produced the same message:\n${messages.join('\n---\n')}`,
  );

  // Every state writes a verdict. A branch that writes none leaves
  // steps.preflight.outputs.verdict empty and the gated step silently no-ops.
  for (const [name, r] of states) {
    assert.ok(r.verdict, `${name} wrote no verdict — the provisioning gate would read empty`);
  }

  // Exactly one state may authorise the write.
  const authorising = states.filter(([, r]) => r.verdict === 'absent-here');
  assert.equal(authorising.length, 1, 'exactly one state may hand the provisioning step its go-ahead');
  assert.equal(authorising[0][0], 'absent-here');

  // The two exit-0 states must not be confusable.
  const zeroExit = states.filter(([, r]) => r.code === 0).map(([, r]) => r.verdict);
  assert.deepEqual([...zeroExit].sort(), ['absent-here', 'found']);
});
