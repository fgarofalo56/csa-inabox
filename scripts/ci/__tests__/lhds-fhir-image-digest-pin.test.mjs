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

// A GitHub `if:` of `&&`-joined `<path> (==|!=) '<literal>'` terms, evaluated against a context. Throws on any other shape, so a
// gate rewritten into a form this cannot read fails the test instead of being evaluated wrongly.
function evalIf(expr, ctx) {
  const m = expr.match(/^\$\{\{ (.*) \}\}$/);
  assert.ok(m, `not a \${{ }} expression: ${expr}`);
  return m[1].split(' && ').every((term) => {
    const t = term.match(/^([a-z_.]+) (==|!=) '([^']*)'$/);
    assert.ok(t, `unsupported if term: ${term}`);
    assert.ok(t[1] in ctx, `context has no ${t[1]}`);
    return t[2] === '==' ? ctx[t[1]] === t[3] : ctx[t[1]] !== t[3];
  });
}
const ifOf = (b) => b.match(/\n {8}if: (.*)\n/)?.[1];
const INSTALL_STEP = 'Install cosign (FHIR engine image signature check)';
const FULL = { 'steps.verdict.outputs.standdown': 'false', 'inputs.run_mode': 'full', 'steps.audiences.outputs.resolved': 'true', 'steps.hub.outputs.fd_profile': 'fd-loom' };

test('workflow: a hub with NO Front Door skips the digest step and the cosign install (no PDP -> no FHIR image rendered -> never failed for it)', () => {
  for (const name of [DIGEST_STEP, INSTALL_STEP]) {
    const g = ifOf(stepBlock(name).block);
    // Breaks if the fd_profile term is dropped (review finding 1): the step would run, exit 3/4 and fail a deploy with no PDP.
    assert.equal(evalIf(g, { ...FULL, 'steps.hub.outputs.fd_profile': '' }), false, `${name} runs without Front Door`);
    // Paired positive: with Front Door (the only path that fetches the PDP key) it runs.
    assert.equal(evalIf(g, FULL), true, `${name} does not run on a full deploy with Front Door`);
    // And not on a what-if or without audiences (an ACR lease for nothing).
    assert.equal(evalIf(g, { ...FULL, 'inputs.run_mode': 'whatif-only' }), false);
    assert.equal(evalIf(g, { ...FULL, 'steps.audiences.outputs.resolved': 'false' }), false);
  }
  // The PDP key is fetched only with Front Door: this is the fact the gate leans on (breaks if pdpkey stops requiring it).
  assert.match(ifOf(stepBlock('Fetch the PDP bundle verification key through Front Door').block), /steps\.hub\.outputs\.fd_profile != ''/);
  assert.match(stepBlock(DIGEST_STEP).block, /\n {10}LOOM_ACR_LEASE_OPEN_SECONDS: '90'\n/);
});

test('workflow: cosign is installed through the pinned retrying installer BEFORE the digest step', () => {
  const i = stepBlock(INSTALL_STEP);
  // Breaks if the install moves after the verify (cosign: command not found) or goes back to a bare installer action.
  assert.ok(i.start < stepBlock(DIGEST_STEP).start);
  assert.match(i.block, /\n {8}run: bash scripts\/ci\/cosign-install-retry\.sh --version v2\.6\.1\n/);
});

test('workflow: the trusted signer is exactly build-fiab-images-acr-tasks.yml, anchored, with the SC1 issuer', () => {
  const env = stepBlock(DIGEST_STEP).block.match(/\n {10}SIGNER_RE: '(.*)'\n/)?.[1];
  assert.ok(env, 'SIGNER_RE missing');
  const re = new RegExp(env.replace('${{ github.repository }}', 'org/repo'));
  // Breaks if the identity is widened to any workflow (a deploy lane could then sign an unscanned image) or unanchored.
  assert.ok(re.test('https://github.com/org/repo/.github/workflows/build-fiab-images-acr-tasks.yml@refs/heads/main'));
  assert.ok(!re.test('https://github.com/org/repo/.github/workflows/deploy-health.yml@refs/heads/main'));
  assert.ok(!re.test('https://github.com/evil/x/.github/workflows/build-fiab-images-acr-tasks.yml@refs/heads/main'));
  assert.match(stepScript(DIGEST_STEP), /--certificate-oidc-issuer "https:\/\/token\.actions\.githubusercontent\.com"/);
});

// ── workflow: the digest step, executed ───────────────────────────────────────

const LOGIN = 'acrtest.azurecr.io';
const PIN = `${LOGIN}/loom-health-fhir@${DIGEST}`;
/**
 * Runs the real step script. Resolver: a STUB (rc + stdout scripted) by default, or the REAL scripts/ci/resolve-acr-digest.sh with
 * `realResolver` (a stub `az` answers `acr repository show` with `azDigest`). The lease script is a stub that prints the real
 * script's ::notice:: shape on stdout; `releaseFailAt` makes the Nth release fail (1 = the resolver's, 2 = the step's).
 */
function runDigestStep({ rc = 0, stdout = `${DIGEST}\n`, cpJson = {}, cosign = 'signed', realResolver = false, azDigest = DIGEST, releaseFailAt = 0, acquireRc = 0, loginRc = 0 } = {}) {
  const dir = mkdtempSync(join(tmp, 'dig-'));
  for (const d of ['scripts/ci', 'scripts/csa-loom', 'temp', 'bin']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'temp/cp.json'), JSON.stringify({ acrLoginServer: LOGIN, ...cpJson }));
  writeFileSync(join(dir, 'stdout.txt'), stdout);
  if (realResolver) {
    writeFileSync(join(dir, 'scripts/ci/resolve-acr-digest.sh'), readFileSync(resolve(root, 'scripts/ci/resolve-acr-digest.sh'), 'utf8'));
  } else {
    writeFileSync(join(dir, 'scripts/ci/resolve-acr-digest.sh'), [
      '#!/usr/bin/env bash', 'echo "resolve $*" >> "$STUB_LOG"', 'echo "resolve-acr-digest: stub stderr" >&2', 'cat "$STUB_STDOUT"', 'exit "$STUB_RC"', '',
    ].join('\n'));
  }
  writeFileSync(join(dir, 'scripts/csa-loom/acr-firewall-lease.sh'), [
    '#!/usr/bin/env bash',
    'echo "lease $*" >> "$STUB_LOG"',
    'echo "::notice::[acr-lease] $1 $3"',
    'if [ "$1" = acquire ]; then exit "$STUB_ACQUIRE_RC"; fi',
    'N=$(grep -c "^lease release" "$STUB_LOG")',
    'if [ "$N" = "$STUB_RELEASE_FAIL_AT" ]; then echo "::error::[acr-lease] stub re-lock not verified"; exit 1; fi',
    'exit 0', '',
  ].join('\n'));
  writeFileSync(join(dir, 'scripts/ci/acr-login-retry.sh'), ['#!/usr/bin/env bash', 'echo "login $*" >> "$STUB_LOG"', 'exit "$STUB_LOGIN_RC"', ''].join('\n'));
  writeFileSync(join(dir, 'bin', 'az'), [
    '#!/usr/bin/env bash', 'echo "az $*" >> "$STUB_LOG"',
    'printf \'{\\n  "digest": "%s",\\n  "name": "v0.1"\\n}\\n\' "$STUB_AZ_DIGEST"', '',
  ].join('\n'));
  const COSIGN = {
    signed: 'echo "Verification for x -- The cosign claims were validated"; exit 0',
    unsigned: 'echo "Error: no matching signatures: none of the expected identities matched what was in the certificate" >&2; exit 1',
    unreachable: 'echo "Error: GET https://acrtest.azurecr.io/v2/: DENIED: client with IP 1.2.3.4 is not allowed access" >&2; exit 1',
    odd: 'echo "panic: runtime error: index out of range" >&2; exit 2',
  };
  writeFileSync(join(dir, 'bin', 'cosign'), ['#!/usr/bin/env bash', 'echo "cosign $*" >> "$STUB_LOG"', COSIGN[cosign], ''].join('\n'));
  chmodSync(join(dir, 'bin', 'az'), 0o755);
  chmodSync(join(dir, 'bin', 'cosign'), 0o755);
  writeFileSync(join(dir, 'step.sh'), stepScript(DIGEST_STEP));
  for (const f of ['log.txt', 'out.txt', 'summary.md']) writeFileSync(join(dir, f), '');
  const d = posix(dir);
  const r = spawnSync('bash', ['-c', 'export PATH="$STUB_BIN:$PATH"; bash -e step.sh'], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env, STUB_BIN: `${d}/bin`, ACR: 'acrtest', STUB_LOG: `${d}/log.txt`, STUB_STDOUT: `${d}/stdout.txt`, STUB_RC: String(rc),
      STUB_AZ_DIGEST: azDigest, STUB_RELEASE_FAIL_AT: String(releaseFailAt), STUB_ACQUIRE_RC: String(acquireRc), STUB_LOGIN_RC: String(loginRc),
      SIGNER_RE: '^https://github\\.com/org/repo/\\.github/workflows/build-fiab-images-acr-tasks\\.yml@',
      LOOM_COSIGN_RETRY_SECONDS: '0', LOOM_DIGEST_BACKOFF_SECONDS: '0', LOOM_DIGEST_ATTEMPTS: '1',
      GITHUB_OUTPUT: `${d}/out.txt`, GITHUB_STEP_SUMMARY: `${d}/summary.md`,
    },
  });
  const read = (f) => readFileSync(join(dir, f), 'utf8');
  return { status: r.status, out: r.stdout + r.stderr, calls: read('log.txt').split('\n').filter(Boolean), outputs: read('out.txt') };
}
const of = (calls, p) => calls.filter((c) => c.startsWith(p));

test('digest step: resolves loom-health-fhir:<cp.json imageTag> under the lease and outputs exactly the digest', () => {
  const r = runDigestStep({ cpJson: { imageTag: 'v9.9' } });
  assert.equal(r.status, 0, r.out);
  // Breaks if the tag is transcribed (v0.1 here would be wrong), the repository changes, or --lease is dropped (locked ACR).
  assert.deepEqual(of(r.calls, 'resolve'), ['resolve --acr acrtest --image loom-health-fhir:v9.9 --lease']);
  assert.equal(r.outputs, `digest=${DIGEST}\n`);
});

test('digest step: no imageTag in cp.json -> v0.1, the default health.bicep uses', () => {
  const r = runDigestStep({});
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(of(r.calls, 'resolve'), ['resolve --acr acrtest --image loom-health-fhir:v0.1 --lease']);
  assert.match(readFileSync(resolve(root, 'platform/fiab/bicep/health.bicep'), 'utf8'), /var cpImageTag = string\(controlPlaneConfig\.\?imageTag \?\? 'v0\.1'\)/);
});

test('digest step: the lease notices on stdout around the digest do not change the answer', () => {
  const r = runDigestStep({ stdout: `::notice::[acr-lease] opened acrtest\n${DIGEST}\r\n::notice::[acr-lease] released acrtest\n` });
  assert.equal(r.status, 0, r.out);
  // Breaks if the step takes the LAST stdout line (the release notice) or the first one (the open notice) as the digest.
  assert.equal(r.outputs, `digest=${DIGEST}\n`);
});

test('digest step: exit 0 with a credential prompt (locked registry) instead of a digest FAILS and says the digest could not be read', () => {
  const r = runDigestStep({ stdout: 'Username: \n' });
  // Breaks if any non-empty stdout is accepted as the digest (status 0, digest=Username:).
  assert.equal(r.status, 1, r.out);
  assert.equal(r.outputs, '');
  assert.match(r.out, /has 0 distinct lines of the form sha256:<64 lowercase hex>/);
  assert.match(r.out, /could NOT be read; this is not a claim that the image is missing/);
});

test('digest step: an uppercase or 63-hex digest is not a digest (fails closed)', () => {
  for (const bad of ['sha256:' + 'A'.repeat(64), 'sha256:' + '3'.repeat(63)]) {
    const r = runDigestStep({ stdout: `${bad}\n` });
    // Breaks if the line check loosens to [0-9a-fA-F] or {63,64}.
    assert.equal(r.status, 1, `${bad}: ${r.out}`);
    assert.equal(r.outputs, '');
  }
});

test('digest step: two different digests in one answer fail closed (never pick one)', () => {
  const r = runDigestStep({ stdout: `${DIGEST}\nsha256:${'4'.repeat(64)}\n` });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /has 2 distinct lines/);
});

test('digest step: MISSING (3), UNPROVEN (4) and RE-LOCK UNPROVEN (5) are kept apart, and none outputs a digest', () => {
  const miss = runDigestStep({ rc: 3, stdout: '' });
  assert.equal(miss.status, 1, miss.out);
  assert.match(miss.out, /MISSING: the registry answered and loom-health-fhir:v0\.1 is not in acrtest/);
  assert.equal(miss.outputs, '');
  const unk = runDigestStep({ rc: 4, stdout: '' });
  assert.equal(unk.status, 1, unk.out);
  // Breaks if "could not read" is reported as "missing" (deploy-integrity R7).
  assert.match(unk.out, /UNPROVEN: acrtest could not be read, .* NOT a claim that the image is missing/);
  assert.doesNotMatch(unk.out, /MISSING/);
  assert.equal(unk.outputs, '');
  // Exit 5 carries a digest on stdout and must STILL fail: breaks if 5 falls into the 0 arm or the generic `*` arm.
  const open = runDigestStep({ rc: 5 });
  assert.equal(open.status, 1, open.out);
  assert.match(open.out, /resolve-acr-digest\.sh exit 5\): acrtest may be PUBLICLY REACHABLE/);
  assert.doesNotMatch(open.out, /usage or unclassified/);
  assert.equal(open.outputs, '');
});

test('digest step: discards nothing (no || true, no 2>/dev/null) and prints the resolver stderr', () => {
  const script = stepScript(DIGEST_STEP);
  assert.ok(!/\|\|\s*true/.test(script), '|| true');
  assert.ok(!/2>\s*\/dev\/null/.test(script), '2>/dev/null');
  // Positive: the resolver's own words reach the log.
  const r = runDigestStep({ rc: 4, stdout: '' });
  assert.match(r.out, /resolve-acr-digest: stub stderr/);
});

// ── signature before pin (review finding 3) ──────────────────────────────────

test('signature: a signed digest is verified BY DIGEST against the producer identity, the step lease is released, then pinned', () => {
  const r = runDigestStep({});
  assert.equal(r.status, 0, r.out);
  const cos = of(r.calls, 'cosign');
  // Breaks if the verify runs on the TAG (a moved tag would verify a different image) or with another identity.
  assert.deepEqual(cos, [`cosign verify ${PIN} --certificate-oidc-issuer https://token.actions.githubusercontent.com --certificate-identity-regexp ^https://github\\.com/org/repo/\\.github/workflows/build-fiab-images-acr-tasks\\.yml@ --output text`]);
  // The verify happens between the step's own lease acquire and release, after the registry login.
  const seq = r.calls.filter((c) => /^(lease|login|cosign)/.test(c)).map((c) => c.split(' ').slice(0, 2).join(' '));
  assert.deepEqual(seq, ['lease acquire', 'login --acr', 'cosign verify', 'lease release']);
  assert.equal(r.outputs, `digest=${DIGEST}\n`);
});

test('signature: ABSENT OR INVALID fails closed, says the registry answered, pins nothing, and still re-locks', () => {
  const r = runDigestStep({ cosign: 'unsigned' });
  // Breaks if an unsigned digest is pinned (status 0) -- the Trivy-window image of review finding 3.
  assert.equal(r.status, 1, r.out);
  assert.equal(r.outputs, '');
  assert.match(r.out, /SIGNATURE ABSENT OR INVALID: the registry answered/);
  assert.doesNotMatch(r.out, /COULD NOT CHECK/);
  assert.equal(of(r.calls, 'cosign').length, 1, 'a signature verdict is not retried');
  assert.equal(of(r.calls, 'lease release').length, 1);
});

test('signature: an unreachable registry is COULD NOT CHECK (retried 3x), never "unsigned"; an unclassified failure is COULD NOT CHECK too', () => {
  const r = runDigestStep({ cosign: 'unreachable' });
  assert.equal(r.status, 1, r.out);
  assert.equal(r.outputs, '');
  assert.equal(of(r.calls, 'cosign').length, 3);
  // Breaks if a transport denial is reported as a signature verdict (the #3210 shape, deploy-integrity R7).
  assert.match(r.out, /COULD NOT CHECK the signature of .*: cosign could not reach acrtest on 3 attempts/);
  assert.doesNotMatch(r.out, /SIGNATURE ABSENT/);
  const odd = runDigestStep({ cosign: 'odd' });
  assert.equal(odd.status, 1, odd.out);
  assert.match(odd.out, /COULD NOT CHECK .* output this step does not classify/);
  assert.doesNotMatch(odd.out, /SIGNATURE ABSENT/);
  assert.equal(odd.outputs, '');
});

test('signature: no lease or no registry token -> COULD NOT CHECK, cosign never runs, nothing pinned', () => {
  const noLease = runDigestStep({ acquireRc: 1 });
  assert.equal(noLease.status, 1, noLease.out);
  assert.equal(of(noLease.calls, 'cosign').length, 0);
  assert.match(noLease.out, /COULD NOT CHECK .* lease could not be acquired/);
  const noLogin = runDigestStep({ loginRc: 1 });
  assert.equal(noLogin.status, 1, noLogin.out);
  assert.equal(of(noLogin.calls, 'cosign').length, 0);
  assert.match(noLogin.out, /COULD NOT CHECK .* no registry token could be minted/);
  // The lease taken for the check is released on that path too (breaks if the early exit skips the re-lock).
  assert.equal(of(noLogin.calls, 'lease release').length, 1);
  assert.equal(noLogin.outputs, '');
});

test('signature: a signed digest whose check-lease re-lock fails does NOT pin (the registry may be public)', () => {
  // Release #1 is the step's own (the stub resolver takes no lease).
  const r = runDigestStep({ releaseFailAt: 1 });
  assert.equal(r.status, 1, r.out);
  assert.equal(r.outputs, '');
  assert.match(r.out, /could NOT be verified re-locked after the signature check/);
});

// ── the REAL resolver under the step (review finding 2) ──────────────────────

test('real resolver: stub az answers the digest, the real stdout (lease notices + digest) parses to exactly that digest', () => {
  const r = runDigestStep({ realResolver: true });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(of(r.calls, 'az '), ['az acr repository show --name acrtest --image loom-health-fhir:v0.1 -o json']);
  // Breaks if the resolver's printed digest and the step's parse disagree (e.g. the resolver prints the JSON, or the step takes a notice).
  assert.equal(r.outputs, `digest=${DIGEST}\n`);
});

test('real resolver: a failed re-lock after a resolved digest exits 5, and the step fails with the re-lock message, pinning nothing', () => {
  // Release #1 is the RESOLVER's (its --lease). Before the fix the resolver exited 0 here (trap `return 1` is discarded).
  const r = runDigestStep({ realResolver: true, releaseFailAt: 1 });
  assert.equal(r.status, 1, r.out);
  assert.equal(r.outputs, '');
  assert.match(r.out, /resolve-acr-digest\.sh exit 5\): acrtest may be PUBLICLY REACHABLE/);
  assert.equal(of(r.calls, 'cosign').length, 0, 'no signature check over an unproven re-lock');
});

test('real resolver, direct: exit 5 only when the digest resolved and the re-lock failed; 0 when it re-locked; a 4 stays 4', () => {
  const dir = mkdtempSync(join(tmp, 'res-'));
  mkdirSync(join(dir, 'bin'));
  const log = join(dir, 'log.txt');
  writeFileSync(log, '');
  const lease = join(dir, 'lease.sh');
  writeFileSync(lease, '#!/usr/bin/env bash\necho "lease $*" >> "$STUB_LOG"\n[ "$1" = release ] && exit "$STUB_RELEASE_RC"\nexit 0\n');
  const az = join(dir, 'bin', 'az');
  writeFileSync(az, '#!/usr/bin/env bash\nif [ "$STUB_AZ_FAIL" = 1 ]; then echo "ERROR: DENIED: client with IP 1.2.3.4 is not allowed access" >&2; exit 1; fi\nprintf \'{"digest": "%s"}\\n\' "$STUB_AZ_DIGEST"\n');
  chmodSync(az, 0o755);
  const run = (releaseRc, azFail = 0) => spawnSync('bash', [posix(resolve(root, 'scripts/ci/resolve-acr-digest.sh')), '--acr', 'acrtest', '--image', 'loom-health-fhir:v0.1', '--lease'], {
    encoding: 'utf8',
    env: { ...process.env, LOOM_AZ_BIN: posix(az), LOOM_ACR_LEASE_SCRIPT: posix(lease), STUB_LOG: posix(log), STUB_RELEASE_RC: String(releaseRc), STUB_AZ_FAIL: String(azFail), STUB_AZ_DIGEST: DIGEST, LOOM_DIGEST_ATTEMPTS: '1', LOOM_DIGEST_BACKOFF_SECONDS: '0' },
  });
  const ok = run(0);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), DIGEST);
  const open = run(1);
  // Breaks on the pre-fix trap (status 0 with the registry left open).
  assert.equal(open.status, 5, open.stderr);
  assert.equal(open.stdout.trim(), DIGEST, 'the digest is still on stdout with exit 5');
  assert.match(open.stderr, /could NOT be verified re-locked after the lookup/);
  const unread = run(1, 1);
  // The lookup verdict is primary: an unreadable registry stays 4 even when the re-lock also fails (breaks if 5 masks 4).
  assert.equal(unread.status, 4, unread.stderr);
  assert.match(unread.stderr, /could NOT be verified re-locked/);
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
