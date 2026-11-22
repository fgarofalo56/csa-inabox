/**
 * LHDS stamp image path (#5422 decision 8): private endpoint to the hub ACR + digest-pinned PDP image import.
 *
 * Defect (measured 2026-11-22, Commercial dev01): PDP pods in ImagePullBackOff on <acr>/opa:1.9.0-static ("failed to
 * fetch anonymous token"). The kubelet identity HAS AcrPull; the hub ACR is publicNetworkAccess=Disabled with its private
 * endpoints in the hub VNet; the stamp VNet has none; nothing imported the image.
 *
 * Methods, stated. (1) Compile the bicep with `az bicep build` and read the ARM (a missing `az` FAILS the suite). The
 * compiled ARM proves the templates are shaped right; it does not prove a live deploy or that a connection auto-approves.
 * (2) EXECUTE the deploy-health import step's real `run:` script under bash with a stub `az` and a stub
 * resolve-acr-digest.sh, so the fail-closed branches are exercised, not grepped.
 *
 * Each test names the value that breaks it (assertion-design.md). LHDS_REPO_ROOT points the suite at a sandbox copy for
 * mutation runs.
 *
 * Run: node --test scripts/ci/__tests__/lhds-stamp-acr-private-endpoint.test.mjs
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
const tmp = mkdtempSync(join(tmpdir(), 'lhds-acr-'));
const read = (rel) => readFileSync(resolve(root, rel), 'utf8').replace(/\r\n/g, '\n');
const posix = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);

function compile(rel) {
  const outFile = join(tmp, rel.replace(/[\\/]/g, '_') + '.json');
  const r = spawnSync('az', ['bicep', 'build', '--file', resolve(root, rel), '--outfile', outFile], { encoding: 'utf8', shell: process.platform === 'win32' });
  assert.equal(r.status, 0, `az bicep build ${rel} failed (guard cannot run): ${r.stderr}`);
  return JSON.parse(readFileSync(outFile, 'utf8'));
}
const resourcesOf = (arm) => (Array.isArray(arm.resources) ? arm.resources : Object.values(arm.resources));
const network = compile(`${BICEP}/modules/health/network.bicep`);
const stamp = compile(`${BICEP}/modules/health/stamp.bicep`);
const acrPe = compile(`${BICEP}/modules/health/acr-pe.bicep`);
const health = compile(`${BICEP}/health.bicep`);

const SPEC_PATH = `${BICEP}/modules/health/pdp-image.json`;
const spec = JSON.parse(read(SPEC_PATH));

// ── bicep ─────────────────────────────────────────────────────────────────────

test('network: the acr zone and its stamp-VNet link exist ONLY when acrPrivateLinkEnabled (breaks if the condition is dropped or inverted)', () => {
  const zone = resourcesOf(network).find((r) => r.type === 'Microsoft.Network/privateDnsZones' && JSON.stringify(r.name).includes('acrZoneName'));
  const link = resourcesOf(network).find((r) => r.type === 'Microsoft.Network/privateDnsZones/virtualNetworkLinks' && JSON.stringify(r.name).includes('acrZoneName'));
  assert.ok(zone, 'no acr private DNS zone resource');
  assert.ok(link, 'no acr zone VNet link resource');
  // A dropped condition would create a registry zone on every stamp; an inverted one would create it only when no registry is known.
  assert.equal(zone.condition, "[parameters('acrPrivateLinkEnabled')]");
  assert.equal(link.condition, "[parameters('acrPrivateLinkEnabled')]");
  assert.equal(network.parameters.acrPrivateLinkEnabled.defaultValue, false, 'default must create nothing');
  // The link points at the stamp VNet (breaks if it is wired to a different VNet).
  assert.match(JSON.stringify(link.properties.virtualNetwork), /Microsoft\.Network\/virtualNetworks/);
  assert.equal(network.outputs.acrZoneId.value, "[if(parameters('acrPrivateLinkEnabled'), resourceId('Microsoft.Network/privateDnsZones', variables('acrZoneName')), '')]");
});

test('network: the zone suffix is cloud-derived (environment().suffixes.acrLoginServer), never a hard-coded .io or .us', () => {
  // Breaks if the name is replaced by a literal: GCC-High is azurecr.us, and a literal .io would make the zone useless there.
  assert.equal(network.variables.acrZoneName, "[format('privatelink.{0}', substring(environment().suffixes.acrLoginServer, 1))]");
  assert.ok(!/azurecr\.(io|us)/.test(JSON.stringify(network.variables.acrZoneName)), 'a literal cloud suffix is hard-coded');
  // Computed from the real expression: '.azurecr.io' -> privatelink.azurecr.io, '.azurecr.us' -> privatelink.azurecr.us.
  const derive = (suffix) => `privatelink.${suffix.substring(1)}`;
  assert.equal(derive('.azurecr.io'), 'privatelink.azurecr.io');
  assert.equal(derive('.azurecr.us'), 'privatelink.azurecr.us');
});

test('network: the acr zone is NOT in zoneNames, so the hub VNet (which links its own privatelink.azurecr zone) is never linked to a second one', () => {
  // Breaks if the zone is appended to zoneNames: extraLinks would then link the hub VNet to two zones of one name and the deployment would fail.
  const keys = network.variables.zoneNames.map((z) => z.key);
  assert.deepEqual(keys, ['vault', 'blob', 'eventhubs']);
  assert.ok(!JSON.stringify(network.variables.zoneNames).includes('acrZoneName'));
});

test('acr-pe: private endpoint targets the supplied registry id with groupIds [registry], in the supplied subnet, with a zone group into the supplied zone', () => {
  const pe = resourcesOf(acrPe).find((r) => r.type === 'Microsoft.Network/privateEndpoints');
  const zg = resourcesOf(acrPe).find((r) => r.type === 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups');
  assert.ok(pe && zg, 'private endpoint or zone group missing');
  const conn = pe.properties.privateLinkServiceConnections;
  assert.equal(conn.length, 1);
  // Breaks if groupIds changes (e.g. to 'vault'): the connection would be refused by the registry.
  assert.deepEqual(conn[0].properties.groupIds, ['registry']);
  assert.equal(conn[0].properties.privateLinkServiceId, "[parameters('acrResourceId')]");
  assert.equal(pe.properties.subnet.id, "[parameters('peSubnetId')]");
  // Breaks if the zone group is dropped: the endpoint would exist but the registry name would still resolve to the blocked public address.
  assert.equal(zg.properties.privateDnsZoneConfigs[0].properties.privateDnsZoneId, "[parameters('acrZoneId')]");
  assert.ok(JSON.stringify(zg.dependsOn).includes('privateEndpoints'));
});

test('stamp: the endpoint module is conditional on a NON-empty acrResourceId and the same flag drives the zone', () => {
  // Breaks if `not` is dropped (module would deploy on an empty id and fail) or `empty` is swapped for a different test.
  assert.equal(stamp.variables.acrPrivateLinkEnabled, "[not(empty(parameters('acrResourceId')))]");
  assert.equal(stamp.parameters.acrResourceId.defaultValue, '');
  const mod = resourcesOf(stamp).find((r) => r.type === 'Microsoft.Resources/deployments' && JSON.stringify(r.name).includes('acr-pe'));
  assert.ok(mod, 'acr-pe module missing from the stamp');
  assert.equal(mod.condition, "[variables('acrPrivateLinkEnabled')]");
  const net = resourcesOf(stamp).find((r) => r.type === 'Microsoft.Resources/deployments' && JSON.stringify(r.name).includes('-network'));
  assert.equal(net.properties.parameters.acrPrivateLinkEnabled.value, "[variables('acrPrivateLinkEnabled')]");
  assert.equal(mod.properties.parameters.acrResourceId.value, "[parameters('acrResourceId')]");
});

test('stamp: with no registry the stamp output carries a TRUE skip reason (deployed false, no endpoint name)', () => {
  const expr = stamp.outputs.stamp.value.acrPrivateEndpoint;
  // Breaks if the ternary is inverted or a branch is lost: the set case carries the endpoint name, the empty case the reason.
  assert.ok(expr.startsWith("[if(variables('acrPrivateLinkEnabled'), createObject('deployed', true(), 'privateEndpointName', reference("), expr.slice(0, 200));
  const empty = expr.slice(expr.indexOf("createObject('deployed', false()"));
  assert.ok(empty.startsWith("createObject('deployed', false(), 'privateEndpointName', '', 'zoneId', '', 'reason', 'no hub registry resource id was supplied to the stamp"), empty.slice(0, 200));
  // The reason states what is established (no id was supplied), not that the registry is missing.
  assert.ok(!/does not exist|not found/i.test(empty), 'the skip reason asserts a cause it did not establish');
});

test('health: the stamp receives the registry id only when the registry is known, built from the cp registry name + resource group', () => {
  const stampMod = resourcesOf(health).find((r) => r.type === 'Microsoft.Resources/deployments' && r.properties.parameters?.acrResourceId);
  assert.ok(stampMod, 'health.bicep does not pass acrResourceId to the stamp');
  // Breaks if the empty branch is dropped, if the id uses a different registry variable, or if the condition is not cpAcrKnown.
  assert.equal(
    JSON.stringify(stampMod.properties.parameters.acrResourceId),
    JSON.stringify("[if(variables('cpAcrKnown'), createObject('value', resourceId(subscription().subscriptionId, variables('cpAcrResourceGroup'), 'Microsoft.ContainerRegistry/registries', variables('cpAcrName'))), createObject('value', ''))]"),
  );
});

test('the PDP image is deployed BY DIGEST from the one spec file the workflow also reads', () => {
  const pdp = resourcesOf(health).find((r) => r.type === 'Microsoft.Resources/deployments' && /lhds-pdp/.test(JSON.stringify(r.name)));
  assert.ok(pdp, 'pdp module missing');
  // Breaks if the image goes back to ':tag' (a retag in the registry would change what is deployed) or the digest is not from the spec.
  assert.equal(pdp.properties.parameters.image.value, "[format('{0}/{1}@{2}', variables('cpAcrLoginServer'), variables('pdpImageSpec').acrRepository, variables('pdpImageSpec').digest)]");
  assert.match(spec.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(spec.source, 'docker.io/openpolicyagent/opa');
  assert.equal(spec.acrRepository, 'opa');
  // The compiled variable carries the file's own digest (loadJsonContent inlines the file at build time).
  assert.ok(JSON.stringify(health.variables).includes(spec.digest), 'compiled health.bicep does not carry the spec digest');
  assert.doesNotMatch(read(`${BICEP}/health.bicep`), /pdpImageTag\s*\?\?/);
});

// ── workflow ──────────────────────────────────────────────────────────────────

const wf = read('.github/workflows/deploy-health.yml');
const importStart = wf.indexOf('- name: Ensure the digest-pinned PDP image is in the registry');
const applyStart = wf.indexOf('- name: Apply the stamp PDP manifest');
const importEnd = wf.indexOf('\n      # Runs AFTER the console bind', importStart);
const importBlock = wf.slice(importStart, importEnd);
const runBody = importBlock.split('        run: |\n')[1].split('\n').map((l) => l.replace(/^ {10}/, '')).join('\n');

test('workflow: the import step exists and runs BEFORE the PDP apply step', () => {
  // Breaks if the import is moved after the apply (the pods would pull before the image exists) or removed.
  assert.ok(importStart > 0, 'import step missing');
  assert.ok(applyStart > 0, 'apply step missing');
  assert.ok(importStart < applyStart, `import at ${importStart} must precede apply at ${applyStart}`);
  assert.ok(importEnd > importStart);
});

test('workflow: the import source is digest-pinned and the tag is not the pull reference', () => {
  assert.match(runBody, /az acr import --name "\$ACR" --resource-group "\$HUB_RG" --source "\$SRC@\$DIGEST" --image "\$REPO:\$TAG"/);
  assert.match(runBody, /grep -qE '\^sha256:\[0-9a-f\]\{64\}\$'/);
  // Breaks if the source drops @digest for :tag.
  assert.doesNotMatch(runBody, /--source "\$SRC:/);
  assert.ok(importBlock.includes('platform/fiab/bicep/modules/health/pdp-image.json'), 'does not read the shared spec');
});

test('workflow: the import step discards nothing (no || true, no 2>/dev/null, no continue-on-error) and no curl -f', () => {
  // Breaks if any result-discarding form is added to this step.
  assert.ok(!/\|\|\s*true/.test(importBlock), '|| true');
  assert.ok(!/2>\s*\/dev\/null/.test(importBlock), '2>/dev/null');
  assert.ok(!/continue-on-error/.test(importBlock), 'continue-on-error');
  assert.ok(!/curl\s+[^\n]*-[a-zA-Z]*f/.test(importBlock), 'curl -f');
  // Positive: the step does capture stderr to a file it later prints.
  assert.match(importBlock, /2> temp\/pdp-import\.err/);
  assert.match(importBlock, /head -c 600 temp\/pdp-import\.err/);
});

// Run the real step script under bash with stubs.
function runStep({ peState = 'Approved', peRc = 0, resolveSeq, importRc = 0, specDigest = spec.digest, deployed = true }) {
  const dir = mkdtempSync(join(tmp, 'run-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(dir, 'scripts/ci'), { recursive: true });
  mkdirSync(join(dir, 'temp'), { recursive: true });
  mkdirSync(join(dir, BICEP, 'modules/health'), { recursive: true });
  writeFileSync(join(dir, SPEC_PATH), JSON.stringify({ ...spec, digest: specDigest }));
  writeFileSync(join(dir, 'temp/outputs.json'), JSON.stringify({
    healthPdpState: { value: { deployed } },
    healthStamp: { value: { acrPrivateEndpoint: { privateEndpointName: 'pe-lhds-dev01-acr', reason: 'r' } } },
  }));
  writeFileSync(join(dir, 'seq.txt'), resolveSeq.join('\n') + '\n');
  writeFileSync(join(bin, 'az'), [
    '#!/usr/bin/env bash',
    'echo "az $*" >> "$STUB_LOG"',
    'case "$1 $2" in',
    '  "acr private-endpoint-connection") if [ "$STUB_PE_RC" != "0" ]; then echo "ERROR: stub read failed" >&2; exit "$STUB_PE_RC"; fi; printf "%s\\n" "$STUB_PE_STATE"; exit 0 ;;',
    '  "acr import") if [ "$STUB_IMPORT_RC" != "0" ]; then echo "ERROR: stub import refused" >&2; fi; exit "$STUB_IMPORT_RC" ;;',
    'esac',
    'echo "unexpected az $*" >&2; exit 99',
    '',
  ].join('\n'));
  writeFileSync(join(dir, 'scripts/ci/resolve-acr-digest.sh'), [
    '#!/usr/bin/env bash',
    'echo "resolve $*" >> "$STUB_LOG"',
    'L=$(head -n1 "$STUB_SEQ"); tail -n +2 "$STUB_SEQ" > "$STUB_SEQ.n"; mv "$STUB_SEQ.n" "$STUB_SEQ"',
    'RC=${L%% *}; D=${L#* }',
    '[ "$RC" = "0" ] && echo "$D"',
    'exit "$RC"',
    '',
  ].join('\n'));
  chmodSync(join(bin, 'az'), 0o755);
  writeFileSync(join(dir, 'step.sh'), runBody);
  const log = join(dir, 'log.txt');
  writeFileSync(log, '');
  const r = spawnSync('bash', ['-c', 'export PATH="$STUB_BIN:$PATH"; bash step.sh'], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      STUB_BIN: posix(bin), STUB_LOG: posix(log), STUB_SEQ: posix(join(dir, 'seq.txt')),
      STUB_PE_STATE: peState, STUB_PE_RC: String(peRc), STUB_IMPORT_RC: String(importRc),
      ACR: 'acrtest', HUB_RG: 'rg-hub', GITHUB_STEP_SUMMARY: posix(join(dir, 'summary.md')),
    },
  });
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return { status: r.status, out: r.stdout + r.stderr, calls };
}
const imports = (calls) => calls.filter((c) => c.startsWith('az acr import'));
const D = spec.digest;
const OTHER = 'sha256:' + 'a'.repeat(64);

test('step script: already present -> no import, exit 0 (breaks if it imports unconditionally)', () => {
  const r = runStep({ resolveSeq: [`0 ${D}`] });
  assert.equal(r.status, 0, r.out);
  assert.equal(imports(r.calls).length, 0, r.calls.join('\n'));
  assert.match(r.out, /already in acrtest; import skipped/);
});

test('step script: absent -> imports exactly once from the digest source, reads it back, exit 0', () => {
  const r = runStep({ resolveSeq: ['3 x', `0 ${D}`] });
  assert.equal(r.status, 0, r.out);
  const imp = imports(r.calls);
  assert.equal(imp.length, 1, r.calls.join('\n'));
  // Breaks if the source is not docker.io/openpolicyagent/opa@<digest from the spec> or the target is not opa:<tag>.
  assert.equal(imp[0], `az acr import --name acrtest --resource-group rg-hub --source ${spec.source}@${D} --image ${spec.acrRepository}:${spec.tag} --force`);
  assert.equal(r.calls.filter((c) => c.startsWith('resolve')).length, 2, 'presence check AND read-back expected');
});

test('step script: import fails -> exit 1 with the real exit code, no success claim', () => {
  const r = runStep({ resolveSeq: ['3 x'], importRc: 7 });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /exited 7: ERROR: stub import refused/);
  assert.match(r.out, /NOT imported/);
  assert.doesNotMatch(r.out, /Imported docker\.io/);
});

test('step script: import returns 0 but read-back shows a DIFFERENT digest -> fails closed', () => {
  const r = runStep({ resolveSeq: ['3 x', `0 ${OTHER}`] });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, new RegExp(`digest '${OTHER}'`));
});

test('step script: registry unreadable (resolve exit 4) -> exit 1, NO import, and no claim that the image is missing', () => {
  const r = runStep({ resolveSeq: ['4 x'] });
  assert.equal(r.status, 1, r.out);
  assert.equal(imports(r.calls).length, 0);
  assert.match(r.out, /NOT a claim that the image is missing/);
});

test('step script: private endpoint connection not Approved -> exit 1 before any registry call', () => {
  const r = runStep({ peState: 'Pending', resolveSeq: [`0 ${D}`] });
  assert.equal(r.status, 1, r.out);
  assert.equal(r.calls.filter((c) => c.startsWith('resolve')).length, 0, 'must not probe the registry first');
  assert.match(r.out, /'Pending', not Approved/);
});

test('step script: connection list unreadable -> exit 1 and says nothing is established', () => {
  const r = runStep({ peRc: 3, resolveSeq: [`0 ${D}`] });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /Nothing is established about whether pe-lhds-dev01-acr is approved/);
});

test('step script: a spec with a non-digest value (tag only) is refused, nothing is imported', () => {
  const r = runStep({ specDigest: '1.9.0-static', resolveSeq: ['3 x'] });
  assert.equal(r.status, 1, r.out);
  assert.equal(r.calls.length, 0, r.calls.join('\n'));
  assert.match(r.out, /must be pinned by digest/);
});

test('step script: PDP not deployed -> notice and exit 0 without touching Azure', () => {
  const r = runStep({ deployed: false, resolveSeq: [] });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.calls.length, 0);
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
