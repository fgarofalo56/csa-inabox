#!/usr/bin/env node
/**
 * deploy-copilot-function preflight — MUTATION PROOFS. (refs #3429)
 *
 * ── WHY THIS RUNS THE REAL BASH ────────────────────────────────────────────
 * Same reason as sc1-verify-gate.test.mjs: this repo has a recorded failure
 * class of tests that model the CODE instead of the shipped thing. So this
 * harness EXTRACTS the step's `run:` body from the workflow verbatim and
 * executes it with `az` stubbed on PATH. It also DERIVES the step's declared
 * `env:` keys and asserts it supplies every one — the exact drift that broke
 * #3422 today, where a newly-added `env:` key made the extracted script abort
 * under `set -u` and the suite exited non-zero having emitted no failed
 * assertion at all.
 *
 * ── WHAT THIS PROVES ───────────────────────────────────────────────────────
 * That the preflight's four verdicts are DISTINGUISHABLE and each says only
 * what it established. The bug being fixed is an error message that asserted
 * "Resource ... doesn't exist" when the truth was "I could not see it from the
 * subscription I was given" — the app was up and serving 200 the whole time
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
 * @param {boolean} [o.accountReadable]  `az account show` succeeds
 * @param {boolean} [o.appInExpectedRg]  `az functionapp show` succeeds
 * @param {boolean} [o.rgCheckReadable]  `az group exists` succeeds
 * @param {string}  [o.rgExists]         'true' | 'false'
 * @param {string}  [o.foundInRg]        a DIFFERENT rg where the app is visible
 */
function runPreflight({
  accountReadable = true,
  appInExpectedRg = false,
  rgCheckReadable = true,
  rgExists = 'true',
  foundInRg = '',
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
    if [ -n "$STUB_FOUND_IN_RG" ]; then echo "$STUB_FOUND_IN_RG"; exit 0; fi
    exit 0 ;;
esac
exit 0
`,
    { mode: 0o755 },
  );

  const script = path.join(dir, 'preflight.sh');
  writeFileSync(script, extractRunBlock(readFileSync(WORKFLOW, 'utf8'), STEP_NAME));

  const childEnv = {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    FUNCTION_APP_NAME: 'func-csa-inabox-copilot-fg',
    FUNCTION_APP_RG: 'rg-dlz-aiml-stack-dev',
    FUNCTION_PATH: 'azure-functions/copilot-chat',
    PYTHON_VERSION: '3.12',
    STUB_ACCOUNT_READABLE: accountReadable ? '1' : '0',
    STUB_APP_IN_RG: appInExpectedRg ? '1' : '0',
    STUB_RG_CHECK_READABLE: rgCheckReadable ? '1' : '0',
    STUB_RG_EXISTS: rgExists,
    STUB_FOUND_IN_RG: foundInRg,
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

  try {
    const out = execFileSync('bash', [script], {
      cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...childEnv },
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

test('the app is where it should be → preflight PASSES and names the state', () => {
  const r = runPreflight({ appInExpectedRg: true });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /preflight OK/);
  assert.match(r.out, /state: Running/);
});

test('the subscription itself is unreadable → claims NOTHING about the app', () => {
  const r = runPreflight({ accountReadable: false });
  assert.equal(r.code, 1);
  assert.match(r.out, /NOTHING about the Function App has been established/);
  // Must not assert absence it never tested.
  assert.ok(!/does NOT exist/.test(r.out), `claimed absence without testing it:\n${r.out}`);
});

test('app absent from the expected RG but present elsewhere in the sub → names the real RG', () => {
  const r = runPreflight({ foundInRg: 'rg-somewhere-else' });
  assert.equal(r.code, 1);
  assert.match(r.out, /EXISTS in subscription/);
  assert.match(r.out, /rg-somewhere-else/);
  assert.match(r.out, /set FUNCTION_APP_RG/);
});

test('RG exists, app not readable in it → says the two causes it CANNOT separate', () => {
  const r = runPreflight({ rgExists: 'true' });
  assert.equal(r.code, 1);
  assert.match(r.out, /this run cannot separate them/);
  assert.match(r.out, /Website Contributor/);
  // R7: it must not say the app doesn't exist — it is demonstrably serving.
  assert.ok(
    !/doesn't exist|does not exist in/.test(r.out),
    `asserted non-existence the read does not support:\n${r.out}`,
  );
});

test('RG does not exist → says WRONG SUBSCRIPTION, not "app missing"', () => {
  const r = runPreflight({ rgExists: 'false' });
  assert.equal(r.code, 1);
  assert.match(r.out, /pointed at the wrong subscription/);
  assert.match(r.out, /Repoint the secret rather than re-creating the app/);
});

test('the RG check itself fails → UNKNOWN, explicitly not disproven', () => {
  const r = runPreflight({ rgCheckReadable: false });
  assert.equal(r.code, 1);
  assert.match(r.out, /UNKNOWN, not disproven/);
});

test('the four failure verdicts are DISTINGUISHABLE from one another', () => {
  // Non-weakening control. Four causes that used to collapse into one false
  // sentence must now produce four different sentences; if any two matched,
  // the preflight would be no better than the message it replaces.
  const verdicts = [
    runPreflight({ accountReadable: false }).out,
    runPreflight({ foundInRg: 'rg-elsewhere' }).out,
    runPreflight({ rgExists: 'true' }).out,
    runPreflight({ rgExists: 'false' }).out,
  ].map((o) => o.replace(/\s+/g, ' ').trim());
  const uniq = new Set(verdicts);
  assert.equal(uniq.size, 4, `two causes produced the same message:\n${verdicts.join('\n---\n')}`);
});
