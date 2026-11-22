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

test('control-plane.bicep holds NO Azure data role on the cluster (the cluster-scope RBAC Writer is gone) and emits LOOM_HEALTH_CP_PDP_URL only when set', () => {
  const src = read(`${BICEP}/modules/health/control-plane.bicep`);
  // Breaks if the cluster-scope Azure role returns: RBAC Writer reads Secrets and runs pods as any ServiceAccount in EVERY
  // namespace. The control plane's Kubernetes access is the namespace-scoped RoleBinding rendered by engines.bicep instead.
  assert.ok(!src.includes(RBAC_WRITER), 'RBAC Writer must not be granted to the control plane');
  assert.ok(!src.includes('cpAksRbacWriter') && !src.includes('stampAksClusterName'));
  assert.equal(cp.variables.aksRbacWriterRoleId, undefined);
  // Breaks if the env is emitted unconditionally: an empty value would be read as "PDP deployed" and fail validation.
  assert.match(src, /var pdpEnv = empty\(pdpUrl\) \? \[\] : \[\n\s+\{ name: 'LOOM_HEALTH_CP_PDP_URL', value: pdpUrl \}/);
  assert.equal(cp.parameters.pdpUrl.defaultValue, '');
});

test('the control plane gets a namespace-scoped RoleBinding (ClusterRole edit) in the manifest, never cluster-admin and never a ClusterRoleBinding', () => {
  const expr = JSON.stringify(engines.variables.controlPlaneBinding);
  // Breaks if the binding widens to a ClusterRoleBinding (cluster-wide) or to cluster-admin, if its kind/roleRef drift, or if
  // the subject stops being the control plane principal id (the binding would then name nobody).
  assert.match(expr, /kind: RoleBinding/);
  assert.match(expr, /kind: ClusterRole'/);
  assert.match(expr, /name: edit'/);
  assert.doesNotMatch(expr, /ClusterRoleBinding|cluster-admin|name: admin/);
  assert.match(expr, /parameters\('controlPlanePrincipalId'\)/);
  assert.match(expr, /parameters\('aksNamespace'\)/);
  // The guard: no principal, no binding (a literal empty subject would be rejected by the API server).
  assert.match(JSON.stringify(engines.variables.controlPlaneBinding), /empty\(parameters\('controlPlanePrincipalId'\)\)/);
  assert.match(read(`${BICEP}/health.bicep`), /controlPlanePrincipalId: healthControlPlane!\.outputs\.identityPrincipalId/);
});

test('control-plane.bicep creates the PDP bundle signing key as EC-HSM P-256, sign+verify only, with Crypto User on THAT key only', () => {
  const key = resourcesOf(cp).find((r) => r.type === 'Microsoft.KeyVault/vaults/keys' && JSON.stringify(r.name).includes('pdpSigningKeyName'));
  assert.ok(key, 'PDP signing key resource missing');
  // Breaks if the curve is not P-256 (ES256 needs it), the key is software-backed (kty EC), or it gains key ops such as 'export'/'decrypt'.
  assert.equal(key.properties.kty, 'EC-HSM');
  assert.equal(key.properties.curveName, 'P-256');
  assert.deepEqual(key.properties.keyOps, ['sign', 'verify']);
  assert.equal(cp.variables.pdpSigningKeyName, 'lhds-pdp-bundle-sign');
  assert.notEqual(cp.variables.pdpSigningKeyName, 'lhds-as-signing', 'must not share the token signing key');
  const ras = resourcesOf(cp).filter((r) => r.type === 'Microsoft.Authorization/roleAssignments' && JSON.stringify(r).includes('pdpSigningKeyName'));
  assert.equal(ras.length, 1);
  assert.match(JSON.stringify(ras[0].scope), /pdpSigningKeyName/); // scoped to the key, not the vault
  assert.equal(cp.variables.kvCryptoUserRoleId, '12338af0-0e69-4776-bea7-57ae8d297424');
  const src = read(`${BICEP}/modules/health/control-plane.bicep`);
  assert.match(src, /var pdpSigningEnv = empty\(pdpSigningKeyId\) \? \[\] : \[\n\s+\{ name: 'LOOM_HEALTH_CP_PDP_SIGNING_KEY_ID', value: pdpSigningKeyId \}/);
  assert.match(src, /var pdpSigningKeyId = createPdpSigningKey \? pdpSigningKey!\.properties\.keyUriWithVersion : ''/); // the VERSIONED id
});

test('health.bicep: the PDP pulls its bundle through the Front Door endpoint, which is on the egress allow-list; no Front Door and no override = no PDP', () => {
  const health = read(`${BICEP}/health.bicep`);
  // Breaks if the default goes back to the internal control plane FQDN (the stamp cannot resolve or reach it), if the PDP
  // deploys without any URL it can use, or if the AFD host is not allowed through the stamp firewall.
  assert.match(health, /controlPlaneBaseUrl: !empty\(pdpCpBaseUrlOverride\) \? pdpCpBaseUrlOverride : healthAuthEndpoint!\.outputs\.pdpBaseUrl/);
  const pdpBlock = health.slice(health.indexOf("module healthPdp "), health.indexOf('// ── APIM tenant-routing fragment'));
  assert.ok(pdpBlock.length > 200, 'pdp module block not found');
  assert.doesNotMatch(pdpBlock, /healthControlPlane!\.outputs\.fqdn/);
  assert.match(health, /var pdpUrlKnown = startsWith\(pdpCpBaseUrlOverride, 'https:\/\/'\) \|\| fdIssuerDeploy\n/);
  assert.match(health, /extraAllowedFqdns: concat\(healthConfig\.\?extraAllowedFqdns \?\? \[\], fdIssuerDeploy \? \[healthAuthEndpoint!\.outputs\.endpointHostName\] : \[\]\)/);
  const issuer = read(`${BICEP}/modules/health/afd-issuer.bicep`);
  assert.match(issuer, /output pdpBaseUrl string = 'https:\/\/\$\{endpoint\.properties\.hostName\}'/); // scheme+host only: OPA appends /api/health/pdp/...
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
  const names = ['Apply the stamp PDP manifest (az aks command invoke)', 'Resolve the PDP applying principal', 'Fetch the PDP bundle verification key through Front Door'];
  for (const name of names) {
    const b = stepBlock(wf, name);
    // Breaks if any of these result-discarding shapes enters a step.
    assert.doesNotMatch(b, /\|\| true|continue-on-error|2>\s*\/dev\/null/, name);
  }
  const apply = stepBlock(wf, names[0]);
  assert.match(apply, /bash scripts\/csa-loom\/aks-apply-manifest\.sh/);
  assert.match(apply, /--manifest temp\/pdp-manifest\.yaml/);
  assert.match(apply, /exit 1\n/);
  // The manifest is read from the deploy OUTPUT, the single source of truth, not re-rendered in the workflow.
  assert.match(apply, /\.healthPdpState\.value\.manifest/);
  // Ordering: the apply runs after the infra apply (needs temp/outputs.json) and before the console bind.
  assert.ok(wf.indexOf('- name: Deploy health.bicep\n') < wf.indexOf('- name: Apply the stamp PDP manifest'), 'apply before infra apply');
  // The console bind (#5346) runs BEFORE the apply: the first apply fails at rollout until a bundle is published, and that must not skip the bind.
  assert.ok(wf.indexOf('- name: Bind the health control plane into the console') < wf.indexOf('- name: Apply the stamp PDP manifest'), 'bind must precede the PDP apply');
  assert.ok(wf.indexOf('- name: Apply the stamp PDP manifest') < wf.indexOf('- name: Fail the run when the PDP was not deployed'), 'final step last');
  // The applying principal reaches health.bicep through cp.json BEFORE any what-if or apply reads it.
  assert.ok(wf.indexOf('- name: Resolve the PDP applying principal') < wf.indexOf('- name: Bicep what-if'), 'principal after what-if');
});

test('the repository-variable key gate is GONE: no LOOM_HEALTH_PDP_BUNDLE_PUBKEY_PEM anywhere in the workflow', () => {
  // Breaks if the hand-supplied key path (decision 6 removed it) creeps back as a second source of the verification key.
  assert.doesNotMatch(read('.github/workflows/deploy-health.yml'), /LOOM_HEALTH_PDP_BUNDLE_PUBKEY_PEM/);
});

test('the verification key is fetched through Front Door AFTER the issuer is verified, as the deploy principal, and feeds the ONE phase-2 deployment', () => {
  const wf = read('.github/workflows/deploy-health.yml');
  const fetch = stepBlock(wf, 'Fetch the PDP bundle verification key through Front Door');
  // Breaks if the fetch goes direct to the (private, internal) control plane FQDN instead of Front Door, if the token is not
  // masked, if the key id check is dropped, or if the key is not validated as EC P-256 before it reaches the template.
  assert.match(fetch, /URL="https:\/\/\$HOST\/api\/health\/pdp\/stamps\/\$STAMP\/verification-key"/);
  assert.match(fetch, /::add-mask::\$TOKEN/);
  assert.match(fetch, /"\$KEYID" != "global"/);
  assert.match(fetch, /prime256v1\|P-256/);
  assert.match(fetch, /pdpBundleVerificationPublicKeyPem: \$pem/);
  assert.match(fetch, /401\) skip_pdp/);
  assert.match(fetch, /403\) skip_pdp/);
  assert.ok(wf.indexOf('- name: Verify the issuer through Front Door') < wf.indexOf('- name: Fetch the PDP bundle verification key'), 'key fetch before issuer verified');
  assert.ok(wf.indexOf('- name: Fetch the PDP bundle verification key') < wf.indexOf('- name: Deploy health.bicep phase 2'), 'key fetch after phase 2');
  // roll-race pins the az deployment write count of this workflow at 2 (phase 1 + phase 2): a third deployment is a defect here.
  assert.equal((wf.match(/^\s+az deployment sub create --name/gm) ?? []).length, 2);
  const phase2 = stepBlock(wf, 'Deploy health.bicep phase 2');
  assert.match(phase2, /steps\.pdpkey\.outputs\.fetched == 'true'/);
  assert.match(phase2, /TLS_ARG=\(\)/);
});


// ── the verification-key fetch step, EXECUTED under bash with stub az / curl (real openssl) ────────────────────────
import { generateKeyPairSync } from 'node:crypto';

function stepScript(name) {
  const wf = read('.github/workflows/deploy-health.yml');
  const b = stepBlock(wf, name);
  const m = b.match(/\n {8}run: \|\n([\s\S]*)$/);
  assert.ok(m, `step ${name} has no run block`);
  return m[1].split('\n').map((l) => l.replace(/^ {10}/, '')).join('\n');
}
const pem = (curve) => generateKeyPairSync('ec', { namedCurve: curve }).publicKey.export({ format: 'pem', type: 'spki' }).toString();
const FETCH = 'Fetch the PDP bundle verification key through Front Door';
const CP_JSON = JSON.stringify({ audiences: ['a', 'b'] });
const OUTPUTS = JSON.stringify({ healthControlPlaneState: { value: { deployed: true } }, healthIssuerState: { value: { frontDoorEndpointHost: 'lhds-auth-x.z01.azurefd.net' } }, healthStamp: { value: { stampName: 'stamp-x' } } });

function runFetch({ codes, body, az = 'echo tok-SECRET-123', attempts = '3' }) {
  const dir = mkdtempSync(join(tmpdir(), 'lhds-key-'));
  const d = dir.replace(/\\/g, '/');
  mkdirSync(join(dir, 'temp'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'temp/outputs.json'), OUTPUTS);
  writeFileSync(join(dir, 'temp/cp.json'), CP_JSON);
  writeFileSync(join(dir, 'codes'), codes.join('\n') + '\n');
  writeFileSync(join(dir, 'body.json'), body ?? '');
  const stub = (n, t) => { writeFileSync(join(dir, 'bin', n), `#!/bin/bash\n${t}\n`); chmodSync(join(dir, 'bin', n), 0o755); };
  stub('az', `echo "az $*" >> "${d}/az.log"\n${az}`);
  stub('sleep', 'exit 0');
  // curl: pops the next status code from the list (the last one repeats), writes the canned body to -o, prints the code.
  stub('curl', `OUT=""; while [ $# -gt 0 ]; do case "$1" in -o) OUT="$2"; shift 2 ;; *) shift ;; esac; done
n=$(cat "${d}/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${d}/n"
code=$(sed -n "\${n}p" "${d}/codes"); [ -n "$code" ] || code=$(tail -n 1 "${d}/codes")
[ "$OUT" != /dev/null ] && cp "${d}/body.json" "$OUT"
printf '%s' "$code"`);
  writeFileSync(join(dir, 'out.txt'), '');
  writeFileSync(join(dir, 'step.sh'), stepScript(FETCH));
  const r = spawnSync('bash', ['-e', 'step.sh'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, MSYS_NO_PATHCONV: '1', PATH: `${d}/bin:${process.env.PATH}`, GITHUB_OUTPUT: `${d}/out.txt`, GITHUB_STEP_SUMMARY: `${d}/summary.md`, BOUNDARY: 'Commercial', AUDIENCES: 'aaaa,api://aaaa', KEY_ATTEMPTS: attempts },
  });
  const read2 = (f) => { try { return readFileSync(join(dir, f), 'utf8'); } catch { return ''; } };
  const res = { status: r.status, out: `${r.stdout}\n${r.stderr}`, outputs: read2('out.txt'), cp: read2('temp/cp.json'), curls: Number(read2('n').trim() || 0) };
  rmSync(dir, { recursive: true, force: true });
  return res;
}
const keyBody = (o) => JSON.stringify({ ok: true, data: { alg: 'ES256', keyId: 'global', publicKeyPem: pem('prime256v1'), ...o } });

test('key fetch: 200 with a P-256 key and key id global writes it into cp.json and reports fetched=true; the token is masked and never echoed', () => {
  const r = runFetch({ codes: [200], body: keyBody({}) });
  assert.equal(r.status, 0, r.out);
  assert.match(r.outputs, /fetched=true/);
  // Breaks if the key is not handed to the template under the name health.bicep reads.
  assert.match(JSON.parse(r.cp).pdpBundleVerificationPublicKeyPem, /^-----BEGIN PUBLIC KEY-----/);
  assert.match(r.out, /::add-mask::tok-SECRET-123/); // masked BEFORE any use
  assert.doesNotMatch(r.out.replace('::add-mask::tok-SECRET-123', ''), /tok-SECRET-123/); // and never printed otherwise
});

// A fetch failure must NOT fail the step (TLS phase 2 and the console bind still have to run): it records fetched=false and a reason.
const skipped = (r, why) => {
  assert.equal(r.status, 0, `the step must exit 0 so later steps run: ${r.out}`);
  assert.match(r.outputs, /fetched=false/);
  assert.doesNotMatch(r.outputs, /fetched=true/);
  assert.match(r.outputs, /reason=[^\n]+/);
  assert.match(r.out, /::warning::PDP NOT deployed by this run/);
  assert.match(r.outputs, why);
  assert.equal(JSON.parse(r.cp).pdpBundleVerificationPublicKeyPem, undefined, 'no key may reach the template after a failure');
};

test('key fetch: 403 on a greenfield run skips ONLY the PDP (exit 0, fetched=false), on the FIRST attempt, naming the bootstrap', () => {
  const r403 = runFetch({ codes: [403], body: '{}', attempts: '5' });
  // Breaks if a 403 fails the step (it would skip TLS phase 2 on every greenfield run) or is retried (a retry cannot grant a role).
  skipped(r403, /csa-loom-post-deploy-bootstrap/);
  assert.equal(r403.curls, 1, 'a 403 must not be retried');
  assert.match(r403.outputs, /greenfield/);
  const r401 = runFetch({ codes: [401], body: '{}', attempts: '5' });
  skipped(r401, /answered 401/);
  assert.equal(r401.curls, 1);
});

test('key fetch: a persistent 404 / 503 is retried the bounded number of times, then skips the PDP naming the cause WITHOUT claiming it', () => {
  const r = runFetch({ codes: [404], body: JSON.stringify({ ok: false, error: { code: 'not_found' } }), attempts: '3' });
  skipped(r, /NOT established: why/);
  assert.equal(r.curls, 3, 'exactly the bounded attempts');
  // Recovery: 503 twice, then 200 passes (the control plane reads the key after it starts).
  const ok = runFetch({ codes: [503, 503, 200], body: keyBody({}), attempts: '5' });
  assert.equal(ok.status, 0, ok.out);
  assert.match(ok.outputs, /fetched=true/);
  assert.equal(ok.curls, 3);
});

test('key fetch: a key id other than global, a key that is not EC P-256, or junk skips the PDP (it could never verify with any of them)', () => {
  skipped(runFetch({ codes: [200], body: keyBody({ keyId: 'default' }) }), /key id 'default'/);
  skipped(runFetch({ codes: [200], body: keyBody({ publicKeyPem: pem('secp384r1') }) }), /not EC P-256/);
  skipped(runFetch({ codes: [200], body: keyBody({ publicKeyPem: 'not a pem' }) }), /not a PEM public key/);
});

test('the fetch step can never fail the job (no exit 1), and the job FAILS LAST when the PDP was not deployed, with the recorded reason', () => {
  const wf = read('.github/workflows/deploy-health.yml');
  const fetch = stepBlock(wf, 'Fetch the PDP bundle verification key through Front Door');
  // Breaks if an `exit 1` returns to the fetch step: it would skip TLS phase 2 and the console bind again.
  assert.doesNotMatch(fetch, /exit 1/);
  const fin = stepBlock(wf, 'Fail the run when the PDP was not deployed');
  assert.match(fin, /steps\.pdpkey\.outputs\.fetched == 'false'/);
  assert.match(fin, /!cancelled\(\)/);
  assert.match(fin, /exit 1/);
  // It is the LAST step: everything else (TLS phase 2, ingress verify, bind, apply) has run before it can fail the job.
  assert.ok(wf.indexOf('- name: Fail the run when the PDP was not deployed') > wf.indexOf('- name: Apply the stamp PDP manifest'));
  assert.ok(wf.indexOf('- name: Fail the run when the PDP was not deployed') > wf.indexOf('- name: Verify the ingress presents the issued certificate'));
  // TLS phase 2 does not depend on the PDP key outcome.
  assert.match(stepBlock(wf, 'Deploy health.bicep phase 2'), /steps\.tlswait\.outputs\.wait == 'true' \|\| steps\.pdpkey\.outputs\.fetched == 'true'/);
  // Executed: with a recorded reason the step exits 1 and states it; this is the value that makes the job red.
  const dir = mkdtempSync(join(tmpdir(), 'lhds-fin-'));
  writeFileSync(join(dir, 'step.sh'), stepScript('Fail the run when the PDP was not deployed'));
  const r = spawnSync('bash', ['step.sh'], { cwd: dir, encoding: 'utf8', env: { ...process.env, PDP_REASON: 'the control plane answered 403 (test reason)' } });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 1);
  assert.match(`${r.stdout}${r.stderr}`, /PDP was NOT deployed: the control plane answered 403 \(test reason\)/);
});

// ── the issuer verify step's PDP-path probe, EXECUTED under bash with a stub curl (#5422 follow-up) ──────────────────
const VERIFY = 'Verify the issuer through Front Door';
function runVerify({ pdp, tenants = [404], attempts = '3' }) {
  const dir = mkdtempSync(join(tmpdir(), 'lhds-ver-'));
  const d = dir.replace(/\\/g, '/');
  mkdirSync(join(dir, 'temp'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'temp/outputs.json'), JSON.stringify({ healthStamp: { value: { stampName: 'stamp-x' } }, healthIssuerState: { value: { frontDoorEndpointHost: 'h.z01.azurefd.net', issuerUrl: 'https://h.z01.azurefd.net/auth' } } }));
  writeFileSync(join(dir, 'pdp'), pdp.join('\n') + '\n');
  writeFileSync(join(dir, 'tenants'), tenants.join('\n') + '\n');
  const stub = (n, t) => { writeFileSync(join(dir, 'bin', n), `#!/bin/bash\n${t}\n`); chmodSync(join(dir, 'bin', n), 0o755); };
  stub('sleep', 'exit 0');
  // Each URL has its own call counter and code list (the last code repeats). The call ORDER is logged.
  stub('curl', `OUT=""; URL=""; while [ $# -gt 0 ]; do case "$1" in -o) OUT="$2"; shift 2 ;; http*) URL="$1"; shift ;; *) shift ;; esac; done
case "$URL" in
  */auth/.well-known/openid-configuration) [ "$OUT" != /dev/null ] && printf '%s' '{"issuer":"https://h.z01.azurefd.net/auth"}' > "$OUT"; printf '%s' 200; exit 0 ;;
  */api/health/pdp/*) K=pdp ;;
  *) K=tenants ;;
esac
echo "$K" >> "${d}/order"
n=$(grep -c "^$K$" "${d}/order"); code=$(sed -n "\${n}p" "${d}/$K"); [ -n "$code" ] || code=$(tail -n 1 "${d}/$K")
printf '%s' "$code"`);
  writeFileSync(join(dir, 'step.sh'), stepScript(VERIFY));
  const r = spawnSync('bash', ['step.sh'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1', VERIFY_ATTEMPTS: attempts, PATH: `${d}/bin:${process.env.PATH}` } });
  let order = [];
  try { order = readFileSync(join(dir, 'order'), 'utf8').trim().split('\n'); } catch { order = []; }
  rmSync(dir, { recursive: true, force: true });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`, pdpCalls: order.filter((x) => x === 'pdp').length, tenantCalls: order.filter((x) => x === 'tenants').length, order };
}

test('PDP-path probe: 404 is retried (propagation) and a later 401 passes; the tenants negative control then runs exactly once, AFTER the PDP probe', () => {
  const r = runVerify({ pdp: [404, 404, 401] });
  assert.equal(r.status, 0, r.out);
  // Breaks if the probe is single-shot again (the 2026-11-22 live failure: pdpCalls would be 1 and the run red), or if the
  // negative control moves before the PDP probe (it would read a stale edge configuration).
  assert.equal(r.pdpCalls, 3);
  assert.equal(r.tenantCalls, 1);
  assert.equal(r.order.lastIndexOf('pdp') < r.order.indexOf('tenants'), true, `order was ${r.order.join(',')}`);
});

test('PDP-path probe: 404 on EVERY attempt fails after exactly the bounded attempts, naming propagation as the likely but UNPROVEN cause with the elapsed time', () => {
  const r = runVerify({ pdp: [404], attempts: '4' });
  assert.notEqual(r.status, 0);
  assert.equal(r.pdpCalls, 4, 'exactly the bounded attempts, no more');
  assert.equal(r.tenantCalls, 0, 'the negative control must not run when the PDP path never answered');
  // Breaks if the message asserts a cause it did not establish, or loses the elapsed time.
  assert.match(r.out, /Most likely cause \(NOT proven\)/);
  assert.match(r.out, /after 4 attempts \(about \d+s\)/);
});

test('PDP-path probe: 200 (no authentication) and 403 fail IMMEDIATELY with one call; they are never retried into a pass', () => {
  for (const code of [200, 403, 500]) {
    const r = runVerify({ pdp: [code, 401, 401], attempts: '5' });
    // Breaks if retry covers more than 404: the later 401 in the list would then mask a 200 (open endpoint) as a pass.
    assert.notEqual(r.status, 0, `HTTP ${code} must fail`);
    assert.equal(r.pdpCalls, 1, `HTTP ${code} must not be retried`);
    assert.match(r.out, new RegExp(`answered HTTP ${code} to an UNAUTHENTICATED request`));
    assert.equal(r.tenantCalls, 0);
  }
});

test('negative control stays SINGLE-SHOT: 404 is its pass condition, so a 401 on it fails once and is never retried into a pass', () => {
  const r = runVerify({ pdp: [401], tenants: [401, 404, 404], attempts: '5' });
  // Breaks if the control is wrapped in a retry: the later 404 would turn a reachable control-plane API (401) into a pass.
  assert.notEqual(r.status, 0);
  assert.equal(r.tenantCalls, 1);
  assert.match(r.out, /NEGATIVE CONTROL FAILED/);
});
