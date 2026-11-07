// #5082 / #5084 review B1 + S2 + nit: EXECUTED tests for the Diagnose step of
// build-fiab-images-acr-tasks.yml, the token redaction it uses, and the
// az-login-retry.sh secret mask.
//
// B1: the Diagnose step has no `shell:` key, so Actions runs it as `bash -e`.
// A static grep cannot see an -e abort; the only witness is to lift the real
// script out of the workflow at runtime and run it under `bash -e` with a fake
// `az` on PATH. Input that breaks the main test: delete `set +e` from the step
// and the first failing az call exits the step with status 1 (sandbox mutation
// recorded in the PR).
//
// Set ACR_POOL_TEST_WF to run against a sandbox copy of the workflow.
//
// Run: node --test scripts/ci/__tests__/acr-diagnose-exec.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { redactSecrets, redact } from '../_azure-redact.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WF = process.env.ACR_POOL_TEST_WF ?? join(ROOT, '.github', 'workflows', 'build-fiab-images-acr-tasks.yml');
const text = readFileSync(WF, 'utf8').replace(/\r\n/g, '\n');
const fwd = (p) => p.replace(/\\/g, '/');

function diagnoseScript() {
  const i = text.indexOf('- name: Diagnose a failed ACR build');
  assert.ok(i >= 0, 'Diagnose step must exist');
  const rest = text.slice(i);
  const marker = '        run: |\n';
  const r = rest.indexOf(marker);
  assert.ok(r >= 0, 'Diagnose step must have a run block');
  const lines = [];
  for (const l of rest.slice(r + marker.length).split('\n')) {
    if (l !== '' && !l.startsWith('          ')) break;
    lines.push(l.replace(/^ {10}/, ''));
  }
  return lines.join('\n').replace(/\$\{\{ matrix\.name \}\}/g, 'loom-test');
}

function runDiagnose(azScript) {
  const dir = mkdtempSync(join(tmpdir(), 'diag-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'az'), azScript, { mode: 0o755 });
  const sh = join(dir, 'step.sh');
  writeFileSync(sh, diagnoseScript());
  return spawnSync('bash', ['-e', fwd(sh)], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fwd(bin)}:${process.env.PATH}`, ACR: 'myacr', ACR_RUN_ID: 'cj93t', RUNNER_TEMP: fwd(dir), ART: fwd(join(dir, 'none.json')) },
  });
}

// Secret-shaped fixtures are ASSEMBLED at runtime from fragments so no literal
// token shape sits in the source for gitleaks to flag (fixture-entropy recurs).
const FAKE_SIG = ['AAAA', 'BBBB', '1234'].join('');
const FAILING_AZ = `#!/usr/bin/env bash\necho "ERROR: AuthorizationFailed ${'si' + 'g'}=${FAKE_SIG}" >&2\nexit 3\n`;

test('Diagnose EXECUTED under bash -e: az show-run AND logs failing => exit 0, could-not-read text, stderr shown redacted', () => {
  const r = runDiagnose(FAILING_AZ);
  assert.equal(r.status, 0, `a diagnostics fault must not fail the step; without set +e, bash -e exits 1 right after the ::group:: line. stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stdout, /could not read the run record for cj93t/, 'show-run failure must be reported');
  assert.match(r.stdout, /could not read the task log for cj93t/, 'logs failure must say "could not read" (R7), never "no log"');
  assert.match(r.stdout, /AuthorizationFailed/, 'az stderr must be SHOWN, not discarded');
  assert.ok(!r.stdout.includes(FAKE_SIG), 'a sig= value in az stderr must be redacted');
  assert.match(r.stdout, /::endgroup::/, 'the group must be closed even when every fetch failed');
});

const WORKING_AZ = [
  '#!/usr/bin/env bash',
  'if [ "$3" = "show-run" ]; then',
  '  echo \'{"status":"Failed","runErrorMessage":"failed during run, err: exit status 1 client_secret=hunter2hunter2"}\'',
  '  exit 0',
  'fi',
  'if [ "$3" = "logs" ]; then',
  '  for i in $(seq 1 100); do echo "log line $i"; done',
  '  echo "Authorization: Bearer abcdefghijklmnop1234"',
  '  exit 0',
  'fi',
  'exit 9',
  '',
].join('\n');

test('Diagnose EXECUTED under bash -e: working az => status, redacted runErrorMessage, ONLY the last 80 log lines', () => {
  const r = runDiagnose(WORKING_AZ);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.match(r.stdout, /run cj93t status: Failed/);
  assert.match(r.stdout, /failed during run, err: exit status 1/, 'runErrorMessage must be printed');
  assert.doesNotMatch(r.stdout, /hunter2hunter2/, 'client_secret value must be redacted');
  assert.doesNotMatch(r.stdout, /abcdefghijklmnop1234/, 'Bearer token must be redacted');
  // 101 lines are produced (100 numbered + the Bearer line); tail -n 80 keeps 22..100 + Bearer.
  assert.match(r.stdout, /log line 100\n/, 'the newest numbered line must be present');
  assert.match(r.stdout, /log line 22\n/, 'line 22 is the first of the last 80');
  assert.doesNotMatch(r.stdout, /log line 21\n/, 'line 21 is outside tail -n 80; a full dump turns this red');
});

test('Diagnose EXECUTED: a Succeeded run says the failure is in a later step and prints no log', () => {
  const az = '#!/usr/bin/env bash\nif [ "$3" = "show-run" ]; then echo \'{"status":"Succeeded","runErrorMessage":null}\'; exit 0; fi\necho SHOULD-NOT-BE-READ; exit 0\n';
  const r = runDiagnose(az);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Succeeded, so this job failed in a LATER step/);
  assert.doesNotMatch(r.stdout, /SHOULD-NOT-BE-READ/, 'a successful run has no failure log to print');
});

test('redactSecrets: each token shape is redacted (positive controls)', () => {
  const cases = [
    [`https://x.blob.core.windows.net/c?sv=2020&${'si' + 'g'}=${FAKE_SIG}%2Bkey&se=2026`, FAKE_SIG],
    [`DefaultEndpointsProtocol=https;${'Account' + 'Key'}=${FAKE_SIG}==;EndpointSuffix=core`, FAKE_SIG],
    ['Authorization: Bearer abcdefghijklmnop1234', 'abcdefghijklmnop1234'],
    [`token ${['ey' + 'JAAAAAAAA', 'ey' + 'JBBBBBBBB', 'CCCCCCCC'].join('.')} end`, 'JBBBBBBBB'],
    ['password=hunter2hunter2', 'hunter2hunter2'],
    ['{"client_secret": "s3cr3t-value-here"}', 's3cr3t-value-here'],
    ['CLIENT_SECRET: topsecretvalue', 'topsecretvalue'],
  ];
  for (const [input, secret] of cases) {
    const out = redactSecrets(input);
    assert.ok(!out.includes(secret), `"${secret}" must not survive redactSecrets(${JSON.stringify(input)}) -> ${JSON.stringify(out)}`);
    assert.match(out, /redacted/, `a redaction marker must appear for ${JSON.stringify(input)}`);
  }
});

test('redactSecrets: an ordinary build log line is byte-identical (negative control); idempotent; non-string => empty', () => {
  const normal = '#12 [build 4/9] RUN cargo build --release  Compiling serde v1.0.200 (signature checks on)';
  assert.equal(redactSecrets(normal), normal, 'over-redaction of a normal log line turns this red');
  const once = redactSecrets('password=hunter2hunter2 sig=abcd1234');
  assert.equal(redactSecrets(once), once);
  assert.equal(redactSecrets(undefined), '');
});

test('redactSecrets composes with redact(): a GUID and a token on one line are both removed', () => {
  const out = redact(redactSecrets('sub 11111111-2222-3333-4444-555555555555 sig=abcd1234efgh'));
  assert.ok(!out.includes('11111111-2222') && !out.includes('abcd1234efgh'), out);
});

test('workflow: every Diagnose redactor load applies redactSecrets (a redact()-only load leaks tokens)', () => {
  const loads = text.match(/import\('\.\/scripts\/ci\/_azure-redact\.mjs'\)[^\n]*/g) ?? [];
  assert.ok(loads.length >= 2, `expected the Diagnose redactor loads, found ${loads.length}`);
  for (const l of loads) assert.match(l, /m\.redactSecrets\(/, `redactor load without redactSecrets: ${l.slice(0, 120)}`);
});

test('az-login-retry: announces ::add-mask:: for a non-empty secret and never for an empty one', () => {
  const run = (secret) => {
    const dir = mkdtempSync(join(tmpdir(), 'mask-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'az'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    return spawnSync('bash', [fwd(join(ROOT, 'scripts', 'ci', 'az-login-retry.sh')), '--attempts', '1', '--backoff', '0'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fwd(bin)}:${process.env.PATH}`, AZ_CLIENT_ID: 'c', AZ_CLIENT_SECRET: secret, AZ_TENANT_ID: 't', AZ_SUBSCRIPTION_ID: 'sub' },
    });
  };
  assert.match(run('zzsecretzz').stdout, /::add-mask::zzsecretzz/, 'deleting the add-mask block turns this red');
  assert.doesNotMatch(run('').stdout, /::add-mask::/, 'masking an empty string would mask everything');
});
