/**
 * LHDS W2-2b B1 (#5422): the stamp PDP is delivered without a deploymentScript.
 *
 * Defect (measured 2026-11-21): engines.bicep applied the PDP manifest with a deploymentScripts resource,
 * which cannot run on a tenant whose policy forces storage shared-key access off, and nothing else applied
 * workloads to the private stamp cluster.
 *
 * Two methods, stated. (1) Compile the bicep with `az bicep build` and read the ARM (a missing `az` FAILS the
 * suite). (2) EXECUTE scripts/csa-loom/aks-apply-manifest.sh under bash with a stub `az` that returns the JSON
 * `az aks command invoke -o json` returns. Nothing here touches Azure, so nothing here proves a live apply: that
 * stays "merged, not deployed" until deploy-health has run it.
 *
 * Each test names the value that breaks it (assertion-design.md). LHDS_REPO_ROOT points the suite at a sandbox
 * copy for mutation runs.
 *
 * Run: node --test scripts/ci/__tests__/lhds-engine-delivery.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = process.env.LHDS_REPO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BICEP = 'platform/fiab/bicep';
const tmp = mkdtempSync(join(tmpdir(), 'lhds-eng-'));
const read = (rel) => readFileSync(resolve(root, rel), 'utf8').replace(/\r\n/g, '\n');

function compile(rel) {
  const outFile = join(tmp, rel.replace(/[\\/]/g, '_') + '.json');
  const r = spawnSync('az', ['bicep', 'build', '--file', resolve(root, rel), '--outfile', outFile], { encoding: 'utf8', shell: process.platform === 'win32' });
  assert.equal(r.status, 0, `az bicep build ${rel} failed (guard cannot run): ${r.stderr}`);
  return JSON.parse(readFileSync(outFile, 'utf8'));
}
const resourcesOf = (arm) => (Array.isArray(arm.resources) ? arm.resources : Object.values(arm.resources));
const engines = compile(`${BICEP}/modules/health/engines.bicep`);
const cp = compile(`${BICEP}/modules/health/control-plane.bicep`);
rmSync(tmp, { recursive: true, force: true });

const RBAC_CLUSTER_ADMIN = 'b1ff04bb-8a4e-4dc4-8eb5-8693973ce19b';
const RBAC_WRITER = 'a7ffa36f-339b-4b5c-8bdf-e2c188b2c0eb';

test('engines.bicep holds NO deploymentScripts resource and no script identity (breaks if either returns)', () => {
  const types = resourcesOf(engines).map((r) => r.type);
  // Breaks if Microsoft.Resources/deploymentScripts reappears: it cannot run where policy forces shared-key off.
  assert.ok(!types.includes('Microsoft.Resources/deploymentScripts'), `types: ${types.join(', ')}`);
  // Positive control: the ARM resources the module still owns are present, so this is not an empty compile.
  assert.ok(types.includes('Microsoft.ManagedIdentity/userAssignedIdentities'), 'PDP identity missing');
  assert.ok(types.includes('Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials'), 'federation missing');
  const ids = resourcesOf(engines).filter((r) => r.type === 'Microsoft.ManagedIdentity/userAssignedIdentities').map((r) => r.name);
  assert.equal(ids.length, 1, `exactly one identity expected, got ${JSON.stringify(ids)}`);
});

test('the only role assignment in engines.bicep is RBAC Cluster Admin for the applier, gated on a non-empty principal', () => {
  const ras = resourcesOf(engines).filter((r) => r.type === 'Microsoft.Authorization/roleAssignments');
  assert.equal(ras.length, 1, `expected the applier assignment only, got ${ras.length}`);
  const ra = ras[0];
  // Breaks if the role id changes (ARM Cluster Admin carries no Kubernetes data actions) or the condition drops
  // the empty-principal guard (an empty principalId would fail the whole stamp deployment).
  assert.equal(engines.variables.aksRbacClusterAdminRoleId, RBAC_CLUSTER_ADMIN);
  assert.ok(ra.properties.roleDefinitionId.includes("variables('aksRbacClusterAdminRoleId')"), ra.properties.roleDefinitionId);
  assert.match(ra.condition, /parameters\('skipRoleGrants'\)/);
  assert.match(ra.condition, /empty\(parameters\('applyPrincipalId'\)\)/);
  assert.equal(ra.properties.principalType, 'ServicePrincipal');
});

test('engines.bicep exposes the manifest, and the manifest still renders the PDP Deployment with the public key only', () => {
  assert.equal(engines.outputs.manifest.type, 'string');
  const src = read(`${BICEP}/modules/health/engines.bicep`);
  // Breaks if the output is dropped (the workflow would apply an empty file) or renamed.
  assert.match(src, /^output manifest string = manifest$/m);
  // Positive: the Deployment is what the workflow's `kind: Deployment` check and rollout wait look for.
  assert.match(src, /'kind: Deployment'/);
  assert.doesNotMatch(src, /PRIVATE KEY/);
});

test('health.bicep: the CP env address equals the module output, and the PDP module receives the same name and namespace', () => {
  const health = read(`${BICEP}/health.bicep`);
  const mod = read(`${BICEP}/modules/health/engines.bicep`);
  const fromHealth = health.match(/var pdpDecisionEndpoint = '(.+)'/)[1];
  const fromModule = mod.match(/output decisionEndpoint string = '(.+)'/)[1];
  // Both templates, with the name/namespace variables resolved, must give one string. Breaks if either side
  // changes the path or scheme: the CP would hand engines an address the PDP does not serve.
  const resolveHealth = fromHealth.replace('${pdpName}', 'N').replace('${pdpNamespace}', 'S');
  const resolveModule = fromModule.replace('${name}', 'N').replace('${aksNamespace}', 'S');
  assert.equal(resolveHealth, resolveModule);
  assert.ok(resolveHealth.endsWith('/v1/data/lhds/authz/decision'), resolveHealth);
  // Breaks if health.bicep stops passing its own name/namespace (the module defaults would silently diverge from CP env).
  assert.match(health, /name: pdpName\n\s+aksNamespace: pdpNamespace/);
  assert.match(health, /pdpUrl: pdpDeploy \? pdpDecisionEndpoint : ''/);
  assert.match(health, /manifest: healthPdp!\.outputs\.manifest/);
});

test('control-plane.bicep: grants RBAC Writer (never Cluster Admin / Owner) at the stamp cluster and emits LOOM_HEALTH_CP_PDP_URL only when set', () => {
  const ras = resourcesOf(cp).filter((r) => r.type === 'Microsoft.Authorization/roleAssignments' && JSON.stringify(r).includes("variables('aksRbacWriterRoleId')"));
  assert.equal(ras.length, 1, `expected exactly one RBAC Writer assignment, got ${ras.length}`);
  const ra = ras[0];
  assert.equal(cp.variables.aksRbacWriterRoleId, RBAC_WRITER);
  // Breaks if the grant widens: RBAC Cluster Admin b1ff04bb... would let the control plane edit any RBAC object.
  const src = read(`${BICEP}/modules/health/control-plane.bicep`);
  // (the file already carries that id for its own aks-path deploy script, so the check is on THIS assignment.)
  assert.ok(!JSON.stringify(ra).includes('aksRbacClusterAdminRoleId'), 'the CP runCommand grant must not be RBAC Cluster Admin');
  assert.ok(!JSON.stringify(ra).includes('aksClusterAdminRoleId'), 'nor AKS Cluster Admin Role');
  assert.match(ra.condition, /empty\(parameters\('stampAksClusterName'\)\)/);
  assert.match(ra.condition, /parameters\('skipRoleGrants'\)/);
  // Breaks if the env is emitted unconditionally: an empty value would be read as "PDP deployed" and fail validation.
  assert.match(src, /var pdpEnv = empty\(pdpUrl\) \? \[\] : \[\n\s+\{ name: 'LOOM_HEALTH_CP_PDP_URL', value: pdpUrl \}/);
  assert.equal(cp.parameters.pdpUrl.defaultValue, '');
});

// ── the apply script, executed ────────────────────────────────────────────────────────────────────────────
const SCRIPT = resolve(root, 'scripts/csa-loom/aks-apply-manifest.sh').replace(/\\/g, '/');
const OK = (logs) => `echo '{"exitCode":0,"logs":"${logs}"}'`;
const FAIL = (code, logs) => `echo '{"exitCode":${code},"logs":"${logs}"}'`;
const ARM_DENIED = `echo "(AuthorizationFailed) The client does not have authorization to perform action runcommand/action" >&2; exit 1`;

function runScript({ apply, rollout = OK('deployment successfully rolled out'), diag = OK('no diagnostics'), attempts = '3' }) {
  const dir = mkdtempSync(join(tmpdir(), 'lhds-apply-'));
  const d = dir.replace(/\\/g, '/');
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'm.yaml'), 'apiVersion: apps/v1\nkind: Deployment\n');
  const stub = `#!/bin/bash
cmd=""; prev=""; for a in "$@"; do [ "$prev" = "--command" ] && cmd="$a"; prev="$a"; done
echo "$cmd" >> "${d}/calls.log"
case "$cmd" in
  "kubectl apply"*) n=$(cat "${d}/apply.count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${d}/apply.count"; ${apply} ;;
  *"rollout status"*) ${rollout} ;;
  *"get pods"*) ${diag} ;;
  *) echo "unexpected command: $cmd" >&2; exit 9 ;;
esac
`;
  writeFileSync(join(dir, 'bin', 'az'), stub);
  chmodSync(join(dir, 'bin', 'az'), 0o755);
  writeFileSync(join(dir, 'bin', 'sleep'), '#!/bin/bash\nexit 0\n');
  chmodSync(join(dir, 'bin', 'sleep'), 0o755);
  const r = spawnSync('bash', [SCRIPT, '--resource-group', 'rg', '--cluster', 'aks-x', '--namespace', 'loom-health', '--deployment', 'loom-health-pdp', '--manifest', `${d}/m.yaml`, '--attempts', attempts, '--sleep', '0'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, MSYS_NO_PATHCONV: '1', AKS_APPLY_TMP: `${d}/w`, PATH: `${d}/bin:${process.env.PATH}` },
  });
  const read = (f) => { try { return readFileSync(join(dir, f), 'utf8'); } catch { return ''; } };
  const res = { status: r.status, out: `${r.stdout}\n${r.stderr}`, calls: read('calls.log').trim().split('\n').filter(Boolean), applies: Number(read('apply.count').trim() || 0) };
  rmSync(dir, { recursive: true, force: true });
  return res;
}

test('apply + rollout both succeed: exit 0, apply once, rollout asked with the bounded timeout', () => {
  const r = runScript({ apply: OK('deployment.apps/loom-health-pdp configured') });
  // Breaks if success needs more than one apply, or the rollout command loses --timeout (it would hang past ARM limits).
  assert.equal(r.status, 0, r.out);
  assert.equal(r.applies, 1);
  assert.ok(r.calls.some((c) => c === 'kubectl -n loom-health rollout status deployment/loom-health-pdp --timeout=300s'), r.calls.join(' | '));
});

test('a Kubernetes Forbidden on every attempt exits 3 naming the RBAC data role, after exactly the bounded attempts', () => {
  const r = runScript({ apply: FAIL(1, 'Error from server (Forbidden): namespaces is forbidden'), attempts: '3' });
  // Breaks if a refusal is retried forever (applies != 3), reported as success, or the message loses the role to grant.
  assert.equal(r.status, 3, r.out);
  assert.equal(r.applies, 3);
  assert.match(r.out, /Azure Kubernetes Service RBAC Cluster Admin/);
  assert.ok(!r.calls.some((c) => c.includes('rollout')), 'rollout must not run after a failed apply');
});

test('ARM refusing runCommand is retried, and a later success exits 0 (role propagation), with the apply attempted twice', () => {
  const r = runScript({ apply: `if [ "$n" -lt 2 ]; then ${ARM_DENIED}; else ${OK('configured')}; fi` });
  // Breaks if the first refusal is fatal (deploy would fail on every fresh role assignment) or if apply ran 1 or 3 times.
  assert.equal(r.status, 0, r.out);
  assert.equal(r.applies, 2);
});

test('ARM refusal on every attempt exits 3 naming runcommand/action', () => {
  const r = runScript({ apply: ARM_DENIED, attempts: '2' });
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /managedClusters\/runcommand\/action/);
});

test('a kubectl failure that is NOT a permission refusal exits 4 on the FIRST attempt (no retry of a real defect)', () => {
  const r = runScript({ apply: FAIL(1, 'error: unable to recognize manifest: no matches for kind'), attempts: '5' });
  // Breaks if a manifest defect is retried (applies would be 5) or mapped to 3.
  assert.equal(r.status, 4, r.out);
  assert.equal(r.applies, 1);
});

test('az exiting 0 with JSON that carries no exitCode is UNPROVEN (6), never success', () => {
  const r = runScript({ apply: `echo '{"logs":"hi"}'` });
  // Breaks if a missing exitCode is read as 0: that is the "unverified outcome reported as success" defect.
  assert.equal(r.status, 6, r.out);
  assert.match(r.out, /UNKNOWN/);
});

test('rollout not Ready exits 5; pod output mentioning the bundle is named as the MOST LIKELY cause, not a fact', () => {
  const r = runScript({
    apply: OK('configured'),
    rollout: FAIL(1, 'error: timed out waiting for the condition'),
    diag: OK('opa  0/1 Running; level=error msg=Bundle load failed: no bundle'),
  });
  assert.equal(r.status, 5, r.out);
  assert.match(r.out, /Most likely cause \(NOT proven\)/);
  // Positive control for the branch: without bundle text the message must NOT claim it.
  const r2 = runScript({ apply: OK('configured'), rollout: FAIL(1, 'timed out'), diag: OK('opa 0/1 ImagePullBackOff') });
  assert.equal(r2.status, 5, r2.out);
  assert.doesNotMatch(r2.out, /Most likely cause/);
  assert.match(r2.out, /cause is NOT established/);
});

test('a missing manifest or an empty input exits 2 and runs nothing', () => {
  const r = spawnSync('bash', [SCRIPT, '--resource-group', 'rg', '--cluster', 'c', '--namespace', 'n', '--deployment', 'd', '--manifest', '/nonexistent/m.yaml'], { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.match(`${r.stdout}${r.stderr}`, /missing or empty/);
});

// ── the workflow wiring ─────────────────────────────────────────────────────────────────────────────────
function stepBlock(wf, name) {
  const start = wf.indexOf(`- name: ${name}`);
  assert.ok(start >= 0, `step '${name}' not found`);
  const rest = wf.slice(start + 1);
  const next = rest.search(/\n {6}- name: |\n {6}# [A-Z]/);
  return next < 0 ? rest : rest.slice(0, next);
}

test('deploy-health.yml applies the manifest through the script, fail-closed, with no discarded results', () => {
  const wf = read('.github/workflows/deploy-health.yml');
  for (const name of ['Apply the stamp PDP manifest (az aks command invoke)', 'Resolve the PDP inputs (bundle verification public key, applying principal)']) {
    const b = stepBlock(wf, name);
    // Breaks if any of these result-discarding shapes enters either step.
    assert.doesNotMatch(b, /\|\| true|continue-on-error|2>\s*\/dev\/null/, name);
  }
  const apply = stepBlock(wf, 'Apply the stamp PDP manifest (az aks command invoke)');
  assert.match(apply, /bash scripts\/csa-loom\/aks-apply-manifest\.sh/);
  assert.match(apply, /--manifest temp\/pdp-manifest\.yaml/);
  assert.match(apply, /exit 1\n/);
  // The manifest is read from the deploy OUTPUT, the single source of truth, not re-rendered in the workflow.
  assert.match(apply, /\.healthPdpState\.value\.manifest/);
  // Ordering: the apply runs after the infra apply step (needs temp/outputs.json) and before the console bind.
  assert.ok(wf.indexOf('- name: Deploy health.bicep\n') < wf.indexOf('- name: Apply the stamp PDP manifest'), 'apply before infra apply');
  assert.ok(wf.indexOf('- name: Apply the stamp PDP manifest') < wf.indexOf('- name: Bind the health control plane into the console'), 'apply after console bind');
  // The PDP inputs reach health.bicep through cp.json BEFORE any what-if or apply reads it.
  assert.ok(wf.indexOf('- name: Resolve the PDP inputs') < wf.indexOf('- name: Bicep what-if'), 'inputs after what-if');
});

test('the PDP key input step refuses a private key and a non-P-256 key (the markers it greps are present)', () => {
  const b = stepBlock(read('.github/workflows/deploy-health.yml'), 'Resolve the PDP inputs (bundle verification public key, applying principal)');
  // Breaks if the PRIVATE guard or the curve guard is deleted: a private key in a repository variable would be accepted.
  assert.match(b, /\*PRIVATE\*\)/);
  assert.match(b, /prime256v1\|P-256/);
  assert.match(b, /pdpApplyPrincipalId: \$oid/);
});
