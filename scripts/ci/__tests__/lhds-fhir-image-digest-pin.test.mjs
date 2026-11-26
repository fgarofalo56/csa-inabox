/**
 * LHDS FHIR engine image digest pin (#5439).
 *
 * Defect (measured): health.bicep handed the control plane LOOM_HEALTH_CP_FHIR_IMAGE = <acr>/loom-health-fhir:<tag>, a tag that MOVES
 * on every build. The engine Deployment pulls IfNotPresent, so a node with the tag cached started new pods on the OLD jar, and existing
 * engines never rolled because the rendered revision did not change. Fix: deploy-health resolves the tag's digest BEFORE either
 * health.bicep deployment and passes it to both as fhirImageDigest; health.bicep renders <acr>/loom-health-fhir@<digest>; the control
 * plane hashes the image into the engine revision (apps/loom-health-cp, vitest), so the #5486 drift reconciler re-applies every engine.
 *
 * Methods, stated. (1) Compile health.bicep with `az bicep build` and read the ARM (a missing `az` FAILS the suite). That proves the
 * template's shape; it does NOT evaluate ARM's fail() or the digest check (no ARM evaluator runs here). (2) EXECUTE the real `run:`
 * scripts of the digest step and both deploy steps under bash with a stub `az` and a stub resolve-acr-digest.sh, so the fail-closed
 * branches and the arguments actually passed are exercised, not grepped.
 *
 * Every test names the value that breaks it (assertion-design.md). LHDS_REPO_ROOT points the suite at a sandbox copy for mutation runs.
 *
 * Run: node --test scripts/ci/__tests__/lhds-fhir-image-digest-pin.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = process.env.LHDS_REPO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'lhds-fhirpin-'));
const posix = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
const wf = readFileSync(resolve(root, '.github/workflows/deploy-health.yml'), 'utf8').replace(/\r\n/g, '\n');

const DIGEST = 'sha256:' + '3'.repeat(64);
const DIGEST_STEP = 'Resolve the FHIR engine image digest (loom-health-fhir) for the digest pin';
const PHASE1 = 'Deploy health.bicep';
const PHASE2 = 'Deploy health.bicep phase 2 (TLS listener on the issued certificate, stamp PDP)';

function stepBlock(name) {
  const start = wf.indexOf(`      - name: ${name}\n`);
  assert.ok(start >= 0, `step ${name} not found`);
  const rest = wf.slice(start + 1);
  const next = rest.search(/\n {6}- name: |\n {6}# /);
  return { start, block: next < 0 ? rest : rest.slice(0, next) };
}
function stepScript(name) {
  const m = stepBlock(name).block.match(/\n {8}run: \|\n([\s\S]*)$/);
  assert.ok(m, `step ${name} has no run block`);
  return m[1].split('\n').map((l) => l.replace(/^ {10}/, '')).join('\n');
}

// ── bicep ─────────────────────────────────────────────────────────────────────

function compileHealth() {
  const outFile = join(tmp, 'health.json');
  const r = spawnSync('az', ['bicep', 'build', '--file', resolve(root, 'platform/fiab/bicep/health.bicep'), '--outfile', outFile], { encoding: 'utf8', shell: process.platform === 'win32' });
  assert.equal(r.status, 0, `az bicep build health.bicep failed (guard cannot run): ${r.stderr}`);
  return JSON.parse(readFileSync(outFile, 'utf8'));
}
const health = compileHealth();
const resourcesOf = (arm) => (Array.isArray(arm.resources) ? arm.resources : Object.values(arm.resources));

test('bicep: fhirImageDigest is a string param, empty by default, at most 71 chars (sha256: + 64 hex)', () => {
  const p = health.parameters.fhirImageDigest;
  // Breaks if the param is removed (undefined), defaults to a value (other callers would be pinned to a stale build), or the bound drifts.
  assert.ok(p, 'fhirImageDigest param missing');
  assert.equal(p.type, 'string');
  assert.equal(p.defaultValue, '');
  assert.equal(p.maxLength, 71);
  assert.equal(('sha256:' + 'a'.repeat(64)).length, 71, 'fixture arithmetic: the bound is exactly one digest');
});

test('bicep: the control plane gets cpFhirImage: tag when no digest, <acr>/loom-health-fhir@<digest> when valid, fail() otherwise, all only with the PDP', () => {
  const cp = resourcesOf(health).find((r) => r.type === 'Microsoft.Resources/deployments' && /lhds-control-plane/.test(JSON.stringify(r.name)));
  assert.ok(cp, 'control plane module missing');
  // Breaks if the module param goes back to an inline tag expression (the digest would never reach LOOM_HEALTH_CP_FHIR_IMAGE).
  assert.deepEqual(cp.properties.parameters.fhirImage, { value: "[variables('cpFhirImage')]" });
  // Breaks if: the digest branch uses ':' (a tag-shaped ref), the empty branch is lost, the invalid branch falls back to the tag
  // instead of fail(), or the PDP gate is dropped (an image env without a PDP is refused by the control plane at startup).
  assert.equal(
    health.variables.cpFhirImage,
    "[if(not(variables('pdpDeploy')), '', if(empty(parameters('fhirImageDigest')), format('{0}/loom-health-fhir:{1}', variables('cpAcrLoginServer'), variables('cpImageTag')), if(variables('fhirDigestValid'), format('{0}/loom-health-fhir@{1}', variables('cpAcrLoginServer'), parameters('fhirImageDigest')), fail('fhirImageDigest must be sha256:<64 lowercase hex> (deploy-health.yml resolves it from loom-health-fhir:<imageTag>); refusing to deploy a malformed FHIR engine image reference'))))]",
  );
});

test('bicep: the digest check is exactly 71 chars, the sha256: prefix, and only lowercase hex after it (structure; ARM does not run here)', () => {
  // Breaks if any of the three terms is dropped (e.g. uppercase hex or a 63-char digest would pass) or the hex alphabet widens.
  assert.equal(health.variables.fhirDigestValid, "[and(and(equals(length(parameters('fhirImageDigest')), 71), startsWith(parameters('fhirImageDigest'), 'sha256:')), empty(variables('fhirDigestBadChars')))]");
  assert.equal(health.variables.fhirDigestBadChars, "[filter(map(range(0, length(variables('fhirDigestHex'))), lambda('i', substring(variables('fhirDigestHex'), lambdaVariables('i'), 1))), lambda('c', not(contains('0123456789abcdef', lambdaVariables('c')))))]");
  assert.equal(health.variables.fhirDigestHex, "[if(greater(length(parameters('fhirImageDigest')), 7), substring(parameters('fhirImageDigest'), 7), '')]");
});

test('bicep: healthControlPlaneState reports the fhirImage it gave the control plane (what deploy-health reads back)', () => {
  const v = health.outputs.healthControlPlaneState.value;
  // Breaks if the field is removed: the phase-2 read-back would see '' and fail every deploy with a PDP.
  assert.match(v, /'fhirImage', variables\('cpFhirImage'\)/);
});

// ── workflow: order and wiring ────────────────────────────────────────────────

test('workflow: the digest step runs BEFORE both health.bicep deployments, and both pass the digest from it', () => {
  const d = stepBlock(DIGEST_STEP);
  const p1 = stepBlock(PHASE1);
  const p2 = stepBlock(PHASE2);
  // Breaks if the digest step is moved after a deploy (the deploy would render without it) or removed.
  assert.ok(d.start < p1.start, `digest step at ${d.start} must precede phase 1 at ${p1.start}`);
  assert.ok(d.start < p2.start, `digest step at ${d.start} must precede phase 2 at ${p2.start}`);
  assert.match(d.block, /\n {8}id: fhirdigest\n/);
  for (const { block } of [p1, p2]) {
    // Breaks if a deploy step reads a different output (e.g. a tag) or drops the env.
    assert.match(block, /\n {10}FHIR_DIGEST: \$\{\{ steps\.fhirdigest\.outputs\.digest \}\}\n/);
  }
});

test('workflow: the digest step has the same gate as the loom-health-cp preflight (full run, audiences resolved) and the 90 s lease wait', () => {
  const d = stepBlock(DIGEST_STEP).block;
  const pre = stepBlock('Image preflight - loom-health-cp tag exists in the registry').block;
  const ifOf = (b) => b.match(/\n {8}if: (.*)\n/)?.[1];
  // Breaks if the step stops running on a full deploy (no digest -> phase 2 refuses) or runs on a what-if (an ACR lease for nothing).
  assert.equal(ifOf(d), ifOf(pre));
  assert.match(ifOf(d), /inputs\.run_mode == 'full'/);
  assert.match(d, /\n {10}LOOM_ACR_LEASE_OPEN_SECONDS: '90'\n/);
});

// ── workflow: the digest step, executed ───────────────────────────────────────

function runDigestStep({ rc, stdout = '', cpJson = null }) {
  const dir = mkdtempSync(join(tmp, 'dig-'));
  mkdirSync(join(dir, 'scripts/ci'), { recursive: true });
  mkdirSync(join(dir, 'temp'), { recursive: true });
  if (cpJson !== null) writeFileSync(join(dir, 'temp/cp.json'), JSON.stringify(cpJson));
  writeFileSync(join(dir, 'stdout.txt'), stdout);
  writeFileSync(join(dir, 'scripts/ci/resolve-acr-digest.sh'), [
    '#!/usr/bin/env bash',
    'echo "resolve $*" >> "$STUB_LOG"',
    'echo "resolve-acr-digest: stub stderr" >&2',
    'cat "$STUB_STDOUT"',
    'exit "$STUB_RC"',
    '',
  ].join('\n'));
  writeFileSync(join(dir, 'step.sh'), stepScript(DIGEST_STEP));
  for (const f of ['log.txt', 'out.txt', 'summary.md']) writeFileSync(join(dir, f), '');
  const d = posix(dir);
  const r = spawnSync('bash', ['-e', 'step.sh'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ACR: 'acrtest', STUB_LOG: `${d}/log.txt`, STUB_STDOUT: `${d}/stdout.txt`, STUB_RC: String(rc), GITHUB_OUTPUT: `${d}/out.txt`, GITHUB_STEP_SUMMARY: `${d}/summary.md` },
  });
  const read = (f) => readFileSync(join(dir, f), 'utf8');
  return { status: r.status, out: r.stdout + r.stderr, calls: read('log.txt').split('\n').filter(Boolean), outputs: read('out.txt') };
}

test('digest step: resolves loom-health-fhir:<cp.json imageTag> under the lease and outputs exactly the digest', () => {
  const r = runDigestStep({ rc: 0, stdout: `${DIGEST}\n`, cpJson: { imageTag: 'v9.9' } });
  assert.equal(r.status, 0, r.out);
  // Breaks if the tag is transcribed (v0.1 here would be wrong), the repository changes, or --lease is dropped (locked ACR).
  assert.deepEqual(r.calls, ['resolve --acr acrtest --image loom-health-fhir:v9.9 --lease']);
  assert.equal(r.outputs, `digest=${DIGEST}\n`);
});

test('digest step: no imageTag in cp.json -> v0.1, the default health.bicep uses', () => {
  const r = runDigestStep({ rc: 0, stdout: `${DIGEST}\n`, cpJson: {} });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.calls, ['resolve --acr acrtest --image loom-health-fhir:v0.1 --lease']);
  assert.match(readFileSync(resolve(root, 'platform/fiab/bicep/health.bicep'), 'utf8'), /var cpImageTag = string\(controlPlaneConfig\.\?imageTag \?\? 'v0\.1'\)/);
});

test('digest step: the lease notices on stdout around the digest do not change the answer', () => {
  const stdout = `::notice::[acr-lease] opened acrtest\n${DIGEST}\r\n::notice::[acr-lease] released acrtest\n`;
  const r = runDigestStep({ rc: 0, stdout });
  assert.equal(r.status, 0, r.out);
  // Breaks if the step takes the LAST stdout line (the release notice) or the first one (the open notice) as the digest.
  assert.equal(r.outputs, `digest=${DIGEST}\n`);
});

test('digest step: exit 0 with a credential prompt (locked registry) instead of a digest FAILS and says the digest could not be read', () => {
  const r = runDigestStep({ rc: 0, stdout: 'Username: \n' });
  // Breaks if any non-empty stdout is accepted as the digest (status 0, digest=Username:).
  assert.equal(r.status, 1, r.out);
  assert.equal(r.outputs, '');
  assert.match(r.out, /has 0 distinct lines of the form sha256:<64 lowercase hex>/);
  assert.match(r.out, /could NOT be read; this is not a claim that the image is missing/);
});

test('digest step: an uppercase or 63-hex digest is not a digest (fails closed)', () => {
  for (const bad of ['sha256:' + 'A'.repeat(64), 'sha256:' + '3'.repeat(63)]) {
    const r = runDigestStep({ rc: 0, stdout: `${bad}\n` });
    // Breaks if the line check loosens to [0-9a-fA-F] or {63,64}.
    assert.equal(r.status, 1, `${bad}: ${r.out}`);
    assert.equal(r.outputs, '');
  }
});

test('digest step: two different digests in one answer fail closed (never pick one)', () => {
  const r = runDigestStep({ rc: 0, stdout: `${DIGEST}\nsha256:${'4'.repeat(64)}\n` });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /has 2 distinct lines/);
});

test('digest step: MISSING (3) and UNPROVEN (4) are kept apart, and neither outputs a digest', () => {
  const miss = runDigestStep({ rc: 3 });
  assert.equal(miss.status, 1, miss.out);
  assert.match(miss.out, /MISSING: the registry answered and loom-health-fhir:v0\.1 is not in acrtest/);
  assert.equal(miss.outputs, '');
  const unk = runDigestStep({ rc: 4 });
  assert.equal(unk.status, 1, unk.out);
  // Breaks if "could not read" is reported as "missing" (deploy-integrity R7).
  assert.match(unk.out, /UNPROVEN: acrtest could not be read, .* NOT a claim that the image is missing/);
  assert.doesNotMatch(unk.out, /MISSING/);
  assert.equal(unk.outputs, '');
});

test('digest step: discards nothing (no || true, no 2>/dev/null) and prints the resolver stderr', () => {
  const script = stepScript(DIGEST_STEP);
  assert.ok(!/\|\|\s*true/.test(script), '|| true');
  assert.ok(!/2>\s*\/dev\/null/.test(script), '2>/dev/null');
  // Positive: the resolver's own words reach the log.
  const r = runDigestStep({ rc: 4 });
  assert.match(r.out, /resolve-acr-digest: stub stderr/);
});

// ── workflow: the deploy steps, executed with a stub az ───────────────────────

function runDeployStep(name, { env = {}, outputs = {} } = {}) {
  const dir = mkdtempSync(join(tmp, 'dep-'));
  mkdirSync(join(dir, 'bin'), { recursive: true });
  mkdirSync(join(dir, 'temp'), { recursive: true });
  writeFileSync(join(dir, 'temp/cp.json'), '{}');
  writeFileSync(join(dir, 'outputs.json'), JSON.stringify(outputs));
  writeFileSync(join(dir, 'bin', 'az'), [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$*" >> "$STUB_LOG"',
    'cat "$STUB_OUTPUTS"',
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(join(dir, 'bin', 'az'), 0o755);
  writeFileSync(join(dir, 'step.sh'), stepScript(name));
  for (const f of ['log.txt', 'summary.md']) writeFileSync(join(dir, f), '');
  const d = posix(dir);
  const r = spawnSync('bash', ['-c', 'export PATH="$STUB_BIN:$PATH"; bash -e step.sh'], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env, STUB_BIN: `${d}/bin`, STUB_LOG: `${d}/log.txt`, STUB_OUTPUTS: `${d}/outputs.json`,
      PF: 'p.bicepparam', HUB_LOCATION: 'eastus2', ADMIN_GROUP: 'g', GITHUB_RUN_ID: '1', GITHUB_STEP_SUMMARY: `${d}/summary.md`,
      TLS_URI: '', PDP_FETCHED: 'false', FHIR_DIGEST: '', ...env,
    },
  });
  return { status: r.status, out: r.stdout + r.stderr, calls: readFileSync(join(dir, 'log.txt'), 'utf8').split('\n').filter(Boolean) };
}
const deploys = (calls) => calls.filter((c) => c.startsWith('deployment sub create'));
const PIN_ARG = `--parameters fhirImageDigest=${DIGEST}`;

test('phase 1: the resolved digest is passed to the deployment as fhirImageDigest (and nothing is passed without one)', () => {
  const r = runDeployStep(PHASE1, { env: { FHIR_DIGEST: DIGEST } });
  assert.equal(r.status, 0, r.out);
  // Breaks if the deploy drops the argument, or passes the tag / another value instead of the digest.
  assert.equal(deploys(r.calls).length, 1, r.calls.join('\n'));
  assert.ok(deploys(r.calls)[0].includes(PIN_ARG), deploys(r.calls)[0]);
  const none = runDeployStep(PHASE1, { env: { FHIR_DIGEST: '' } });
  assert.equal(none.status, 0, none.out);
  // Paired: with no digest the param is absent (an empty override would be the same as the default, but must not be malformed).
  assert.ok(!deploys(none.calls)[0].includes('fhirImageDigest'), deploys(none.calls)[0]);
});

const OK2 = (img) => ({ healthPdpState: { value: { deployed: true } }, healthControlPlaneState: { value: { deployed: true, fhirImage: img } }, healthStamp: { value: {} } });

test('phase 2: with the PDP, the digest is passed and the deployed reference is read back as <acr>/loom-health-fhir@<digest>', () => {
  const r = runDeployStep(PHASE2, { env: { FHIR_DIGEST: DIGEST, PDP_FETCHED: 'true' }, outputs: OK2(`acrx.azurecr.io/loom-health-fhir@${DIGEST}`) });
  assert.equal(r.status, 0, r.out);
  assert.ok(deploys(r.calls)[0].includes(PIN_ARG), deploys(r.calls)[0]);
  assert.match(r.out, /renders engines from acrx\.azurecr\.io\/loom-health-fhir@sha256:3{64} \(digest-pinned\)/);
});

test('phase 2: a PDP key with NO digest refuses before the deployment (it would render the moving tag)', () => {
  const r = runDeployStep(PHASE2, { env: { FHIR_DIGEST: '', PDP_FETCHED: 'true' }, outputs: OK2('acrx.azurecr.io/loom-health-fhir:v0.1') });
  // Breaks if the guard is removed: the deployment runs (1 call) and the tag is deployed.
  assert.equal(r.status, 1, r.out);
  assert.equal(deploys(r.calls).length, 0, r.calls.join('\n'));
  assert.match(r.out, /Refusing to render the tag reference/);
});

test('phase 2: a deployment that gave the control plane the TAG (or another digest) fails the read-back', () => {
  for (const img of ['acrx.azurecr.io/loom-health-fhir:v0.1', `acrx.azurecr.io/loom-health-fhir@sha256:${'5'.repeat(64)}`, '']) {
    const r = runDeployStep(PHASE2, { env: { FHIR_DIGEST: DIGEST, PDP_FETCHED: 'true' }, outputs: OK2(img) });
    // Breaks if the read-back is removed or matches on the repository only.
    assert.equal(r.status, 1, `${img}: ${r.out}`);
    assert.match(r.out, /not <acr>\/loom-health-fhir@sha256:3{64}/);
  }
});

test('phase 2: TLS only (no PDP key, no digest) still deploys and does not read a FHIR image back', () => {
  const r = runDeployStep(PHASE2, { env: { FHIR_DIGEST: '', PDP_FETCHED: 'false' }, outputs: { healthPdpState: { value: { deployed: false } }, healthControlPlaneState: { value: { deployed: true, fhirImage: '' } } } });
  // Breaks if the new guard fires without a PDP (a TLS-only phase 2 would be blocked for nothing).
  assert.equal(r.status, 0, r.out);
  assert.equal(deploys(r.calls).length, 1);
  assert.doesNotMatch(r.out, /digest-pinned/);
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
