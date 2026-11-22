/**
 * LHDS issuer through Front Door (#5410, W1b-2 L1).
 *
 * Defect (measured 2026-11-21, Commercial dev01): the authorization server runs in the control plane
 * Container App in the INTERNAL hub environment; the stamp Application Gateway has no path to it, so
 * https://<stamp ingress>/auth answered 502 on every path. The issuer is now served by the existing Front
 * Door Premium profile on a dedicated endpoint whose route matches ONLY /auth/*.
 *
 * Two methods, stated: (1) compile the bicep with `az bicep build` and read the compiled ARM (a missing
 * `az` FAILS the suite); (2) EXECUTE the deploy-health.yml step scripts under bash with a stub `az` /
 * `curl`. Nothing here deploys, so nothing here proves a live Front Door route; that stays "merged, not
 * deployed" until the verify step has run in the lane.
 *
 * Each test names the value that breaks it (assertion-design.md). LHDS_REPO_ROOT points the suite at a
 * sandbox copy for mutation runs.
 *
 * Run: node --test scripts/ci/__tests__/lhds-afd-issuer.test.mjs
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
const tmp = mkdtempSync(join(tmpdir(), 'lhds-afd-'));

function compile(rel) {
  const outFile = join(tmp, rel.replace(/[\\/]/g, '_') + '.json');
  const r = spawnSync('az', ['bicep', 'build', '--file', resolve(root, rel), '--outfile', outFile], { encoding: 'utf8', shell: process.platform === 'win32' });
  assert.equal(r.status, 0, `az bicep build ${rel} failed (guard cannot run): ${r.stderr}`);
  return JSON.parse(readFileSync(outFile, 'utf8'));
}
const resourcesOf = (arm) => (Array.isArray(arm.resources) ? arm.resources : Object.values(arm.resources));

const issuer = compile(`${BICEP}/modules/health/afd-issuer.bicep`);
const cp = compile(`${BICEP}/modules/health/control-plane.bicep`);
const health = compile(`${BICEP}/health.bicep`);
rmSync(tmp, { recursive: true, force: true });

const ofType = (arm, t) => resourcesOf(arm).filter((r) => r.type === t);

// Front Door pattern semantics (Learn, "Routing rules"): '/x/*' matches /x/ and anything under it; a path matching no pattern gets 404.
const afdMatches = (patterns, path) => patterns.some((pt) => (pt.endsWith('/*') ? path.startsWith(pt.slice(0, -1)) : path === pt));

test('the route matches EXACTLY /auth/* and /api/health/pdp/* (breaks on /*, on /api/health/*, on a third pattern, or on a dropped pattern)', () => {
  const routes = ofType(issuer, 'Microsoft.Cdn/profiles/afdEndpoints/routes');
  assert.equal(routes.length, 1, 'exactly one route');
  // Breaks if patternsToMatch becomes ['/*'] or ['/auth/*', '/api/health/*'] (publishes the rest of the control plane API),
  // gains a pattern, or loses /api/health/pdp/* (the stamp PDP could then never pull its bundle: the 2026-11-21 defect).
  const patterns = routes[0].properties.patternsToMatch;
  assert.deepEqual(patterns, ['/auth/*', '/api/health/pdp/*']);
  // NEGATIVE CONTROL on the compiled patterns: the paths that must NOT be served resolve to Front Door's 404.
  for (const p of ['/api/health/tenants', '/api/health/stamps', '/api/health/jobs', '/api/health/pdp', '/api/health/pdpx/stamps/a/bundle.tar.gz', '/']) {
    assert.equal(afdMatches(patterns, p), false, `${p} must not be served on this endpoint`);
  }
  // POSITIVE CONTROL: the paths that must be served are matched, so the negatives above are not an empty matcher.
  for (const p of ['/auth/.well-known/openid-configuration', '/api/health/pdp/stamps/a/bundle.tar.gz', '/api/health/pdp/stamps/a/verification-key']) {
    assert.equal(afdMatches(patterns, p), true, `${p} must be served on this endpoint`);
  }
  assert.deepEqual(routes[0].properties.supportedProtocols, ['Https'], 'issuer is HTTPS only');
  assert.equal(routes[0].properties.forwardingProtocol, 'HttpsOnly');
});

test('the origin is the control plane FQDN with a Private Link to the managed environment, host header = FQDN', () => {
  const [o] = ofType(issuer, 'Microsoft.Cdn/profiles/originGroups/origins');
  assert.ok(o, 'no origin');
  // Breaks if the origin is pointed at a literal host, or the Private Link groupId is not managedEnvironments
  // (Front Door could not reach the internal environment: the original 502).
  assert.equal(o.properties.hostName, "[parameters('cpFqdn')]");
  assert.equal(o.properties.originHostHeader, "[parameters('cpFqdn')]");
  assert.equal(o.properties.sharedPrivateLinkResource.groupId, 'managedEnvironments');
  assert.equal(o.properties.sharedPrivateLinkResource.privateLink.id, "[parameters('caeId')]");
});

test('the health probe targets the issuer metadata document, the one URL the verify step also reads', () => {
  const [g] = ofType(issuer, 'Microsoft.Cdn/profiles/originGroups');
  const wf = readFileSync(resolve(root, '.github/workflows/deploy-health.yml'), 'utf8');
  // Breaks if the probe path drifts from the AS route (apps/loom-health-cp src/auth/server.ts serves
  // {issuerPath}/.well-known/openid-configuration) or from what the workflow verifies.
  assert.equal(g.properties.healthProbeSettings.probePath, '/auth/.well-known/openid-configuration');
  assert.ok(wf.includes('/auth/.well-known/openid-configuration'), 'workflow verifies a different URL than the probe');
});

test('the console endpoint and route are NOT touched: a dedicated endpoint, the profile is referenced, not declared', () => {
  const profiles = ofType(issuer, 'Microsoft.Cdn/profiles');
  // `existing` compiles to no resource of type profiles: breaks if the module declares (and so would rewrite) the profile.
  assert.equal(profiles.length, 0, 'the profile must be an existing reference');
  const [ep] = ofType(issuer, 'Microsoft.Cdn/profiles/afdEndpoints');
  assert.match(String(issuer.variables.endpointName), /lhds-auth-/, 'the endpoint must be a dedicated lhds-auth-* endpoint');
  assert.match(String(ep.name), /variables\('endpointName'\)/, 'the endpoint resource must use that name');
  assert.doesNotMatch(JSON.stringify(issuer), /console-route|console-waf-policy|loom-console-/, 'module references a console resource');
});

test('WAF: a NEW security policy attaches a WAF policy DECLARED IN THIS MODULE to the issuer endpoint only', () => {
  const [sp] = ofType(issuer, 'Microsoft.Cdn/profiles/securityPolicies');
  assert.ok(sp, 'no security policy resource');
  // Breaks if the policy is named like the console one (would overwrite its domain list).
  assert.match(String(sp.name), /lhds-auth-waf-policy/);
  const [waf] = ofType(issuer, 'Microsoft.Network/FrontDoorWebApplicationFirewallPolicies');
  assert.ok(waf, 'the module must declare its own WAF policy');
  // Breaks if wafPolicy.id points at an input (the console policy id again: Front Door rejects a second security
  // policy for the same WAF with "Web Application Firewall Policy is already attached to AFDX profile").
  assert.match(String(sp.properties.parameters.wafPolicy.id), /^\[resourceId\('Microsoft\.Network\/FrontDoorWebApplicationFirewallPolicies', format\('waflhdsauth/);
  assert.doesNotMatch(JSON.stringify(sp), /parameters\('wafPolicyId'\)/);
  assert.equal(Object.hasOwn(issuer.parameters, 'wafPolicyId'), false, 'a wafPolicyId input would let the console policy back in');
  assert.equal(sp.properties.parameters.associations.length, 1);
  assert.match(String(waf.name), /^\[format\('waflhdsauth\{0\}'/, 'WAF policy names are alphanumeric: the waflhdsauth prefix + uniqueString');
  assert.equal(waf.sku.name, 'Premium_AzureFrontDoor');
});

test('WAF policy: Prevention mode, DefaultRuleSet 2.1, and NO Bot Manager rule set (machine clients)', () => {
  const [waf] = ofType(issuer, 'Microsoft.Network/FrontDoorWebApplicationFirewallPolicies');
  // Breaks on Detection (the policy would log and block nothing).
  assert.equal(waf.properties.policySettings.mode, 'Prevention');
  assert.equal(waf.properties.policySettings.enabledState, 'Enabled');
  const sets = waf.properties.managedRules.managedRuleSets;
  // Positive control: the policy still carries the DRS rule set (a deleted managedRules block would otherwise pass the Bot check).
  assert.ok(sets.some((s) => s.ruleSetType === 'Microsoft_DefaultRuleSet' && s.ruleSetVersion === '2.1'), 'DefaultRuleSet 2.1 missing');
  // Breaks if Microsoft_BotManagerRuleSet is added: SMART backend services and APIM validate-jwt would be blocked as bots.
  assert.equal(sets.some((s) => /BotManager/i.test(s.ruleSetType)), false, 'Bot Manager must not be on the issuer policy');
});

test('control plane ingress is external:true on the containerApps path (breaks on external:false: Front Door cannot reach it)', () => {
  const apps = ofType(cp, 'Microsoft.App/containerApps');
  assert.ok(apps.length >= 1, 'no container app in control-plane.bicep');
  const ing = apps[0].properties.configuration.ingress;
  assert.equal(ing.external, true);
  assert.ok(Number.isFinite(Number(ing.targetPort)) || typeof ing.targetPort === 'string', 'ingress still has a target port');
});

test('health.bicep invokes the module twice: endpoint before the control plane (empty FQDN), route after it (the FQDN)', () => {
  const deployments = ofType(health, 'Microsoft.Resources/deployments');
  const ep = deployments.find((d) => String(d.name).includes('lhds-afd-issuer-endpoint-'));
  const rt = deployments.find((d) => String(d.name).includes('lhds-afd-issuer-route-'));
  const cpd = deployments.find((d) => String(d.name).startsWith("[format('lhds-control-plane-"));
  assert.ok(ep && rt && cpd, 'missing one of the three deployments');
  // Breaks if the endpoint invocation is given the FQDN (cycle through the issuer env var) or the route one is not.
  assert.equal(ep.properties.parameters.cpFqdn.value, '');
  assert.match(String(rt.properties.parameters.cpFqdn.value), /lhds-control-plane-/);
  assert.ok(JSON.stringify(rt.dependsOn).includes('lhds-control-plane-'), 'route must be ordered after the control plane');
  assert.ok(JSON.stringify(cpd.dependsOn).includes('lhds-afd-issuer-endpoint-'), 'control plane must be ordered after the endpoint');
  // Scoped to the profile resource group, not the stamp group, and gated on the resolved profile.
  assert.equal(rt.resourceGroup, "[variables('fdResourceGroup')]");
  assert.equal(rt.condition, "[variables('fdIssuerDeploy')]");
});

test('issuer default: the Front Door host when a profile is set, the stamp URL otherwise, an explicit authIssuerUrl wins; the gap is stated', () => {
  // Bicep inlines a variable that reads a module output into its use site, so read the control plane
  // deployment's authIssuerUrl parameter. Breaks if any of the three arms is dropped.
  const cpd = ofType(health, 'Microsoft.Resources/deployments').find((d) => String(d.name).startsWith("[format('lhds-control-plane-"));
  const v = JSON.stringify(cpd.properties.parameters.authIssuerUrl);
  assert.match(v, /authIssuerUrl/);
  assert.match(v, /lhds-afd-issuer-endpoint-/);
  assert.match(v, /issuerUrl/);
  assert.match(v, /ingressPublicFqdn/, 'the stamp-URL fallback arm is gone');
  assert.match(String(health.variables.fdIssuerDeploy), /empty\(variables\('fdProfileName'\)\)/);
  assert.match(String(health.variables.fdIssuerDeploy), /variables\('cpPlatform'\), 'containerApps'/);
  const state = JSON.stringify(health.outputs.healthIssuerState);
  assert.match(state, /no Front Door profile on this boundary/);
  assert.match(state, /supported-in-code, follow-up/);
});

// ── deploy-health.yml steps, executed ────────────────────────────────────────

const wf = readFileSync(resolve(root, '.github/workflows/deploy-health.yml'), 'utf8').replace(/\r\n/g, '\n');
function stepScript(name) {
  const start = wf.indexOf(`- name: ${name}\n`);
  assert.ok(start >= 0, `step ${name} not found`);
  const rest = wf.slice(start + 1);
  const next = rest.search(/\n {6}- name: |\n {6}# /);
  const block = next < 0 ? rest : rest.slice(0, next);
  const m = block.match(/\n {8}run: \|\n([\s\S]*)$/);
  assert.ok(m, `step ${name} has no run block`);
  return { script: m[1].split('\n').map((l) => l.replace(/^ {10}/, '')).join('\n'), block };
}

function run(step, { az = 'exit 0', curl = null, env = {}, files = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lhds-afd-step-'));
  const d = dir.replace(/\\/g, '/');
  mkdirSync(join(dir, 'temp'));
  mkdirSync(join(dir, 'bin'));
  for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, k), v);
  const stub = (name, body) => { writeFileSync(join(dir, 'bin', name), `#!/bin/bash\n${body}\n`); chmodSync(join(dir, 'bin', name), 0o755); };
  stub('az', `echo "$*" >> "${d}/az-calls.log"\n${az}`);
  stub('sleep', 'exit 0');
  if (curl) stub('curl', curl);
  writeFileSync(join(dir, 'out.txt'), '');
  writeFileSync(join(dir, 'step.sh'), stepScript(step).script);
  const r = spawnSync('bash', ['-e', 'step.sh'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, MSYS_NO_PATHCONV: '1', VERIFY_ATTEMPTS: '3', PATH: `${d}/bin:${process.env.PATH}`, GITHUB_OUTPUT: `${d}/out.txt`, GITHUB_STEP_SUMMARY: `${d}/summary.md`, ...env },
  });
  const read = (f) => { try { return readFileSync(join(dir, f), 'utf8'); } catch { return ''; } };
  const result = { ...r, out: `${r.stdout}\n${r.stderr}`, outputs: read('out.txt'), cpJson: read('temp/cp.json'), calls: read('az-calls.log') };
  rmSync(dir, { recursive: true, force: true });
  return result;
}

const HUB = 'Discover the hub (registry and Container Apps environment)';
const CAE = '/subscriptions/00000000-0000-4000-8000-000000000000/resourceGroups/rg-csa-loom-admin-centralus/providers/Microsoft.App/managedEnvironments/cae-csa-loom-centralus';
const hubAz = ({ profiles }) => `
case "$*" in
  "group exists"*) echo true ;;
  *"registries"*) echo '["acrloom"]' ;;
  "acr show"*) echo acrloom.azurecr.io ;;
  *"managedEnvironments"*) echo '["${CAE}"]' ;;
  "afd profile list"*) ${profiles} ;;
  *) echo "unexpected az call: $*" >&2; exit 9 ;;
esac`;
const hubEnv = { HUB_LOCATION: 'centralus', PLATFORM: 'containerApps', AUDIENCES: 'api://x' };

test('hub step, exactly one Front Door profile: cp.json carries frontDoor.profileName and NO wafPolicyId; no warning', () => {
  const r = run(HUB, { az: hubAz({ profiles: `echo '["fd-loom-abc"]'` }), env: hubEnv });
  assert.equal(r.status, 0, r.out);
  const cpj = JSON.parse(r.cpJson);
  // Breaks if the profile is not resolved, or the WAF id is not carried (the issuer endpoint would be unprotected).
  assert.equal(cpj.frontDoor.profileName, 'fd-loom-abc');
  assert.equal(cpj.frontDoor.resourceGroup, 'rg-csa-loom-admin-centralus');
  assert.equal("wafPolicyId" in cpj.frontDoor, false);
  assert.ok(r.outputs.split('\n').includes('fd_profile=fd-loom-abc'));
  assert.doesNotMatch(r.out, /issuer unreachable/);
});

test('hub step, NO Front Door profile: loud ::warning:: naming the gap, no frontDoor key, the run continues', () => {
  const r = run(HUB, { az: hubAz({ profiles: `echo '[]'` }), env: hubEnv });
  assert.equal(r.status, 0, r.out);
  // Breaks if the fallback is silent (no warning) or if an empty frontDoor object is written (health.bicep would deploy against '').
  assert.match(r.out, /::warning::issuer unreachable: no Front Door on this boundary/);
  assert.match(r.out, /supported-in-code only here, follow-up/);
  assert.equal('frontDoor' in JSON.parse(r.cpJson), false);
  assert.ok(r.outputs.split('\n').includes('fd_profile='));
});

test('hub step, TWO profiles: fails rather than guessing; the az read erroring says UNKNOWN-class, not "no Front Door"', () => {
  const two = run(HUB, { az: hubAz({ profiles: `echo '["fd-a","fd-b"]'` }), env: hubEnv });
  assert.notEqual(two.status, 0, 'ambiguous profile must fail');
  assert.match(two.out, /found 2/);
  const bad = run(HUB, { az: hubAz({ profiles: `echo 'Connection timed out' >&2; exit 1` }), env: hubEnv });
  assert.notEqual(bad.status, 0);
  // R7: a failed read must not be reported as "no Front Door on this boundary".
  assert.doesNotMatch(bad.out, /no Front Door on this boundary/);
  assert.match(bad.out, /TRANSIENT/);
});

test('hub step on the aks path never queries Front Door (the issuer is not served through it)', () => {
  const r = run(HUB, { az: hubAz({ profiles: `echo 'SHOULD NOT BE CALLED' >&2; exit 7` }), env: { ...hubEnv, PLATFORM: 'aks' } });
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.calls, /afd profile list/);
});

const APPROVE = 'Approve the Front Door private-endpoint connection on the hub environment';
test('approve step: runs the shared approve script with --require-one; refuses when the deployment did not route through Front Door', () => {
  const { block } = stepScript(APPROVE);
  assert.match(block, /approve-cae-private-endpoints\.sh --cae-id "\$CAE_ID" --require-one/);
  // R6/R7: no discarded results in the approval path. Breaks if someone appends `|| true` or `2>/dev/null`.
  assert.doesNotMatch(block, /\|\| true|2>\/dev\/null|continue-on-error/);
  const r = run(APPROVE, { env: { CAE_ID: CAE }, files: { 'temp/outputs.json': JSON.stringify({ healthIssuerState: { value: { viaFrontDoor: false, reason: 'x' } } }) } });
  assert.notEqual(r.status, 0, 'must fail when the issuer is not served via Front Door');
  assert.match(r.out, /NOT served through it/);
});

const VERIFY = 'Verify the issuer through Front Door';
const outputsJson = JSON.stringify({ healthStamp: { value: { stampName: 'stamp-x' } }, healthIssuerState: { value: { viaFrontDoor: true, frontDoorEndpointHost: 'lhds-auth-x.z01.azurefd.net', issuerUrl: 'https://lhds-auth-x.z01.azurefd.net/auth' } } });
// A curl stub: writes the -o body and prints the status code chosen per URL.
const curlStub = ({ oidcCode, oidcBody, negCode, pdpCode = 401 }) => `
OUT=""; URL=""
while [ $# -gt 0 ]; do case "$1" in -o) OUT="$2"; shift 2 ;; http*) URL="$1"; shift ;; *) shift ;; esac; done
case "$URL" in
  */auth/.well-known/openid-configuration) [ "$OUT" != /dev/null ] && printf '%s' '${oidcBody}' > "$OUT"; printf '%s' ${oidcCode} ;;
  */api/health/pdp/*) printf '%s' ${pdpCode} ;;
  *) printf '%s' ${negCode} ;;
esac`;
const goodBody = '{"issuer":"https://lhds-auth-x.z01.azurefd.net/auth"}';

test('verify step: 200 with the configured issuer and a 404 negative control passes', () => {
  const r = run(VERIFY, { curl: curlStub({ oidcCode: 200, oidcBody: goodBody, negCode: 404 }), files: { 'temp/outputs.json': outputsJson } });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Issuer verified through Front Door/);
});

test('verify step: NEGATIVE CONTROL fails when /api/health/* answers 401 on the issuer host (route widened to /*)', () => {
  // 401 is what the control plane itself returns to an unauthenticated /api/health call: reachable = published.
  const r = run(VERIFY, { curl: curlStub({ oidcCode: 200, oidcBody: goodBody, negCode: 401 }), files: { 'temp/outputs.json': outputsJson } });
  assert.notEqual(r.status, 0);
  assert.match(r.out, /NEGATIVE CONTROL FAILED/);
});

test('verify step: the PDP path must answer 401 WITHOUT a token: 404 (not routed) and 200 (no authentication) both fail', () => {
  const files = { 'temp/outputs.json': outputsJson };
  const ok = run(VERIFY, { curl: curlStub({ oidcCode: 200, oidcBody: goodBody, negCode: 404, pdpCode: 401 }), files });
  assert.equal(ok.status, 0, ok.out); // positive control
  assert.match(ok.out, /\/api\/health\/pdp\/\* answered HTTP 401 without a token/);
  // 404 is retried first (Front Door propagation); once the attempts are exhausted it fails with its own message.
  const notRouted = run(VERIFY, { curl: curlStub({ oidcCode: 200, oidcBody: goodBody, negCode: 404, pdpCode: 404 }), files });
  assert.notEqual(notRouted.status, 0, 'a PDP path that never leaves 404 must fail');
  assert.match(notRouted.out, /still answered HTTP 404/);
  for (const bad of [200, 403]) {
    const r = run(VERIFY, { curl: curlStub({ oidcCode: 200, oidcBody: goodBody, negCode: 404, pdpCode: bad }), files });
    assert.notEqual(r.status, 0, `HTTP ${bad} on the PDP path must fail the verify step`);
    assert.match(r.out, new RegExp(`answered HTTP ${bad} to an UNAUTHENTICATED request`));
  }
});

test('verify step: a persistent 502 fails closed naming the code; a wrong issuer in the document fails', () => {
  const dead = run(VERIFY, { curl: curlStub({ oidcCode: 502, oidcBody: '', negCode: 404 }), files: { 'temp/outputs.json': outputsJson } });
  assert.notEqual(dead.status, 0);
  assert.match(dead.out, /answered HTTP 502/);
  const wrong = run(VERIFY, { curl: curlStub({ oidcCode: 200, oidcBody: '{"issuer":"https://other.example/auth"}', negCode: 404 }), files: { 'temp/outputs.json': outputsJson } });
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.out, /not the configured/);
});
