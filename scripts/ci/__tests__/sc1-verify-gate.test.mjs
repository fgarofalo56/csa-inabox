#!/usr/bin/env node
/**
 * SC1 verify-before-roll gate — MUTATION PROOFS. (refs #3035)
 *
 * ── WHY THIS RUNS THE REAL BASH ────────────────────────────────────────────
 * The gate is inline bash in full-app-deploy-commercial.yml, and this repo has
 * a recorded failure class of tests that model the CODE instead of reality (an
 * `az` stub that emitted a tab row for a LIST query, which real `az` never
 * does, let a deploy-breaking bug ship past its own guard). So this harness
 * does NOT re-implement the gate. It EXTRACTS the step's `run:` block from the
 * workflow verbatim, substitutes only the GitHub `${{ … }}` expressions — and
 * fails loudly if any expression it does not know about survives — and executes
 * that text with `az` and `cosign` stubbed on PATH. Everything load-bearing
 * (the loop, the R7 absent/unproven classification, the real
 * `node scripts/ci/deploy-classify.mjs` call, the real
 * `node scripts/ci/deploy-image-roles.mjs` derivation, the failure aggregation
 * and the exit codes) is the shipped text, not a model of it.
 *
 * ── WHAT IS AND IS NOT PROVEN HERE ─────────────────────────────────────────
 * PROVEN: which images the gate verifies, and whether it exits non-zero — i.e.
 * whether the roll is blocked, since `redeploy-with-apps` requires
 * `needs.verify-images.result == 'success'`.
 * NOT PROVEN: real ACR responses, real Sigstore verification, and the job-level
 * `if:` wiring. Those need a live run of the workflow.
 *
 * Run: node --test scripts/ci/__tests__/sc1-verify-gate.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const WORKFLOW = path.join(
  REPO_ROOT,
  '.github',
  'workflows',
  'full-app-deploy-commercial.yml',
);
const STEP_NAME = 'Verify every image the roll ships is signed by a trusted workflow';

/**
 * Pull a step's `run:` block out of the workflow, verbatim.
 * @param {string} src
 * @param {string} stepName
 * @returns {string}
 */
export function extractRunBlock(src, stepName) {
  const lines = String(src).split(/\r?\n/);
  const at = lines.findIndex((l) => l.includes(`- name: ${stepName}`));
  assert.ok(at >= 0, `step not found in the workflow: ${stepName}`);
  const runAt = lines.findIndex((l, i) => i > at && /^\s*run: \|\s*$/.test(l));
  assert.ok(runAt > at, `no \`run: |\` after step: ${stepName}`);
  const indent = (lines[runAt + 1].match(/^ */) || [''])[0].length;
  const body = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') {
      body.push('');
      continue;
    }
    if (!l.startsWith(' '.repeat(indent))) break;
    body.push(l.slice(indent));
  }
  return body.join('\n');
}

/** GitHub expressions this harness knows how to stand in for. */
const SUBSTITUTIONS = [
  [/\$\{\{ inputs\.skip_supply_chain \}\}/g, 'false'],
  [/\$\{\{ needs\.resolve\.outputs\.acr_name \}\}/g, 'acrtest'],
  [/\$\{\{ needs\.resolve\.outputs\.acr_login_server \}\}/g, 'acrtest.azurecr.io'],
  [/\$\{\{ inputs\.tag \|\| 'v0\.1' \}\}/g, 'v0.1'],
  [/\$\{\{ github\.repository \}\}/g, 'Azure/csa-inabox'],
];

function renderScript() {
  let src = extractRunBlock(readFileSync(WORKFLOW, 'utf8'), STEP_NAME);
  for (const [re, val] of SUBSTITUTIONS) src = src.replace(re, val);
  // An unhandled expression must FAIL, not silently become a literal that makes
  // the harness measure something other than the shipped gate.
  assert.ok(
    !src.includes('${{'),
    `unhandled GitHub expression in the extracted step:\n${src.split('\n').filter((l) => l.includes('${{')).join('\n')}`,
  );
  return src;
}

/**
 * Run the shipped gate with stubbed `az` / `cosign`.
 *
 * @param {object} o
 * @param {string[]} [o.absent]     apps for which the registry ANSWERS "tag does not exist"
 * @param {string[]} [o.unreadable] apps for which the registry DENIES the read (R7: unproven)
 * @param {string[]} [o.unsigned]   apps for which `cosign verify` fails
 * @param {string}  [o.contractRefs]
 * @returns {{code:number, out:string}}
 */
function runGate({ absent = [], unreadable = [], unsigned = [], contractRefs } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sc1-gate-'));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);

  // `az acr repository show --name X --image <app>:<tag> --query digest -o tsv`
  writeFileSync(
    path.join(bin, 'az'),
    `#!/usr/bin/env bash
if [ "$2" = "login" ]; then exit 0; fi
APP=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--image" ]; then APP="\${2%%:*}"; fi
  shift
done
for a in $STUB_ABSENT; do
  if [ "$a" = "$APP" ]; then
    echo "ERROR: The specified tag does not exist in the repository $APP" >&2
    exit 1
  fi
done
for a in $STUB_UNREADABLE; do
  if [ "$a" = "$APP" ]; then
    echo "denied: requested access to the resource is denied" >&2
    exit 1
  fi
done
echo "sha256:$(printf '%s' "$APP" | cksum | cut -d' ' -f1)"
exit 0
`,
    { mode: 0o755 },
  );

  // `cosign verify <acr>/<app>@<digest> --certificate-… --output text`
  writeFileSync(
    path.join(bin, 'cosign'),
    `#!/usr/bin/env bash
REF="$2"
APP="\${REF#*/}"; APP="\${APP%%@*}"
for a in $STUB_UNSIGNED; do
  if [ "$a" = "$APP" ]; then
    echo "no matching signatures for $REF" >&2
    exit 1
  fi
done
echo "Verified OK"
exit 0
`,
    { mode: 0o755 },
  );
  chmodSync(path.join(bin, 'az'), 0o755);
  chmodSync(path.join(bin, 'cosign'), 0o755);

  const script = path.join(dir, 'gate.sh');
  writeFileSync(script, renderScript());

  const refs =
    contractRefs ??
    execFileSync(
      process.execPath,
      [
        path.join(REPO_ROOT, 'scripts', 'ci', 'resolve-image-preflight-refs.mjs'),
        '--param-file',
        path.join(REPO_ROOT, 'platform', 'fiab', 'bicep', 'params', 'commercial.bicepparam'),
        '--boundary',
        'commercial',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
      .trim()
      .split('\n')
      .join(' ');

  try {
    const out = execFileSync('bash', [script], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        CONTRACT_REFS: refs,
        STUB_ABSENT: absent.join(' '),
        STUB_UNREADABLE: unreadable.join(' '),
        STUB_UNSIGNED: unsigned.join(' '),
      },
    });
    return verbose({ code: 0, out }, { absent, unreadable, unsigned });
  } catch (e) {
    return verbose(
      { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` },
      { absent, unreadable, unsigned },
    );
  }
}

/**
 * `SC1_GATE_VERBOSE=1 node --test …` prints the gate's REAL output per
 * scenario. The mutation receipts in a PR body have to be pasted output, not a
 * green tick — a guard nobody has seen speak is a guard nobody has seen work.
 */
function verbose(result, scenario) {
  if (process.env.SC1_GATE_VERBOSE) {
    const label = Object.entries(scenario)
      .filter(([, v]) => v.length)
      .map(([k, v]) => `${k}=${v.join(',')}`)
      .join(' ');
    console.log(`\n───── SCENARIO ${label || '(all present + signed)'} → exit ${result.code}`);
    console.log(result.out.trimEnd());
  }
  return result;
}

test('(d) every image present + signed → gate PASSES', () => {
  const r = runGate({});
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /SC1 supply-chain gate PASSED/);
});

test('the derived verify set is the roll ∪ contract images, and EXCLUDES loom-uat', () => {
  const r = runGate({});
  const m = r.out.match(/SC1 verify set \((\d+) images\): (.*)/);
  assert.ok(m, `no verify-set notice in output:\n${r.out}`);
  const apps = m[2].trim().split(/\s+/);
  assert.equal(apps.length, 17);
  assert.ok(!apps.includes('loom-uat'), 'loom-uat must not be roll-blocking');
  // Non-weakening: every app the roll actually ships is still in the set.
  for (const app of [
    'loom-console',
    'loom-mcp',
    'loom-setup-orchestrator',
    'loom-activator',
    'loom-mirroring',
    'loom-direct-lake-shim',
  ]) {
    assert.ok(apps.includes(app), `${app} is ROLLED and must be verified`);
  }
});

test('(b) a ROLLED app (loom-console) unsigned → gate FAILS and the roll is BLOCKED', () => {
  const r = runGate({ unsigned: ['loom-console'] });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /unsigned image\(s\): loom-console/);
  assert.match(r.out, /The roll job is BLOCKED/);
});

test('a CONTRACT-only app (loom-mcp-bridge) unsigned → gate STILL FAILS', () => {
  // Proves the fix did not narrow the gate to the six rolled apps: every image
  // the apps-enabled deploy pulls is still roll-blocking.
  const r = runGate({ unsigned: ['loom-mcp-bridge'] });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /unsigned image\(s\): loom-mcp-bridge/);
});

test('(c) loom-uat unsigned → gate PASSES; the roll is NOT blocked', () => {
  const r = runGate({ unsigned: ['loom-uat'] });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /SC1 supply-chain gate PASSED/);
  assert.ok(!/loom-uat/.test(r.out.replace(/NOT ROLL-BLOCKING[\s\S]*?\n/g, '')));
});

test('(c) loom-uat absent from the registry → gate PASSES; the roll is NOT blocked', () => {
  // The 2026-08-05 shape exactly: loom-uat's build leg failed, so no signature.
  const r = runGate({ absent: ['loom-uat'], unsigned: ['loom-uat'] });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /SC1 supply-chain gate PASSED/);
});

test('R7 preserved — an UNREADABLE registry is never rendered as absence', () => {
  const r = runGate({ unreadable: ['loom-console'] });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /UNPROVEN/);
  assert.match(r.out, /could not READ the registry for: loom-console/);
});

test('an EMPTY deploy contract fails closed rather than verifying a narrowed set', () => {
  const r = runGate({ contractRefs: '' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /no deploy contract/);
});
