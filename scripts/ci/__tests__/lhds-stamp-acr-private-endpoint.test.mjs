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
const PG_SPEC_PATH = `${BICEP}/modules/health/pg-client-image.json`;
const pgSpec = JSON.parse(read(PG_SPEC_PATH));
// G1: the FHIR edge router image rides the same step, third and last.
const EDGE_SPEC_PATH = `${BICEP}/modules/health/edge-router-image.json`;
const edgeSpec = JSON.parse(read(EDGE_SPEC_PATH));

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
const importStart = wf.indexOf('- name: Ensure the digest-pinned stamp images (PDP, PG client)');
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

test('workflow: the import step waits the documented 90 s firewall propagation, not the 35 s default', () => {
  // Breaks if the env line is removed or lowered: run 45066030346 got 403 for ~65 s after the lease opened
  // the firewall, so resolve-acr-digest.sh (which never concludes "absent" after a refused read) exited 4
  // and the import never ran. Pinned to the step block, so the same line elsewhere cannot satisfy it.
  const m = importBlock.match(/^ {10}LOOM_ACR_LEASE_OPEN_SECONDS: '(\d+)'$/m);
  assert.ok(m, 'LOOM_ACR_LEASE_OPEN_SECONDS is not set on the import step');
  assert.ok(Number(m[1]) >= 90, `propagation wait ${m[1]}s is below the documented 90 s maximum`);
  assert.ok(importBlock.indexOf('LOOM_ACR_LEASE_OPEN_SECONDS') < importBlock.indexOf('run: |'), 'must be in the step env, not inside the script');
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
  assert.match(importBlock, /2> "temp\/\$N-import\.err"/);
  assert.match(importBlock, /head -c 600 "temp\/\$N-import\.err"/);
});

// Run the real step script under bash with stubs.
// pgSeq: the resolve answers for the PG client image, which runs AFTER the PDP image in the same step (default: already present).
// edgeSeq: the same for the edge router image, which runs after the PG image (default: already present).
function runStep({ peState = 'Approved', peRc = 0, resolveSeq, pgSeq = [`0 ${pgSpec.digest}`], edgeSeq = [`0 ${edgeSpec.digest}`], edgeDigestOverride, importRc = 0, assertRc = 0, cpJson = null, specDigest = spec.digest, pgDigest = pgSpec.digest, deployed = true }) {
  const dir = mkdtempSync(join(tmp, 'run-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(dir, 'scripts/ci'), { recursive: true });
  mkdirSync(join(dir, 'temp'), { recursive: true });
  mkdirSync(join(dir, BICEP, 'modules/health'), { recursive: true });
  writeFileSync(join(dir, SPEC_PATH), JSON.stringify({ ...spec, digest: specDigest }));
  const pgObj = { ...pgSpec, digest: pgDigest };
  if (pgDigest === null) delete pgObj.digest; // null = the key is absent from the file
  writeFileSync(join(dir, PG_SPEC_PATH), JSON.stringify(pgObj));
  writeFileSync(join(dir, EDGE_SPEC_PATH), JSON.stringify(edgeDigestOverride === undefined ? edgeSpec : { ...edgeSpec, digest: edgeDigestOverride }));
  writeFileSync(join(dir, 'temp/outputs.json'), JSON.stringify({
    healthPdpState: { value: { deployed } },
    healthStamp: { value: { acrPrivateEndpoint: { privateEndpointName: 'pe-lhds-dev01-acr', reason: 'r' } } },
  }));
  writeFileSync(join(dir, 'seq.txt'), [...resolveSeq, ...pgSeq, ...edgeSeq].join('\n') + '\n');
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
  writeFileSync(join(dir, 'scripts/ci/assert-acr-image-tags.sh'), [
    '#!/usr/bin/env bash',
    'echo "assert $*" >> "$STUB_LOG"',
    'exit "$STUB_ASSERT_RC"',
    '',
  ].join('\n'));
  if (cpJson !== null) writeFileSync(join(dir, 'temp/cp.json'), JSON.stringify(cpJson));
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
      STUB_PE_STATE: peState, STUB_PE_RC: String(peRc), STUB_IMPORT_RC: String(importRc), STUB_ASSERT_RC: String(assertRc),
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
  assert.equal(r.calls.filter((c) => c.startsWith('resolve') && c.includes(' opa@')).length, 2, 'PDP presence check AND read-back expected');
});

test('step script: import fails -> exit 1 with the real exit code, no success claim', () => {
  const r = runStep({ resolveSeq: ['3 x'], importRc: 7 });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /exited 7: ERROR: stub import refused/);
  assert.match(r.out, /NOT imported/);
  assert.doesNotMatch(r.out, /Imported docker\.io/);
});

test('step script: import returns 0 and the by-digest read-back resolves to a platform CHILD digest -> success (manifest list)', () => {
  // Measured live (run 45070074523): the pinned OPA index read back as its linux/arm64 child. Breaks if the
  // step demands printed-digest equality again (status 1 here), which can never hold for a manifest list.
  const r = runStep({ resolveSeq: ['3 x', `0 ${OTHER}`] });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /the registry resolves .*@sha256:/);
});

test('step script: import returns 0 but the by-digest read-back is NOT FOUND (exit 3) -> fails closed', () => {
  // Breaks if a failed read-back is accepted: an import that exited 0 is not proof the content is there.
  const r = runStep({ resolveSeq: ['3 x', '3 x'] });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /did not resolve .* afterwards \(resolve-acr-digest\.sh exit 3/);
  assert.doesNotMatch(r.out, /the registry resolves/);
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

// ── B2d: the FHIR engine and PG client images reach the control plane, and the PG image is imported ─────────────

test('B2d step script: PG client image absent -> imported exactly once BY DIGEST from its own spec, after the PDP image, and read back', () => {
  const r = runStep({ resolveSeq: [`0 ${D}`], pgSeq: ['3 x', `0 ${OTHER}`] });
  assert.equal(r.status, 0, r.out);
  const imp = imports(r.calls);
  // Breaks if the PG image is imported by :tag (source without @digest), from the PDP spec, or not at all (length 0).
  assert.equal(imp.length, 1, r.calls.join('\n'));
  assert.equal(imp[0], `az acr import --name acrtest --resource-group rg-hub --source ${pgSpec.source}@${pgSpec.digest} --image ${pgSpec.acrRepository}:${pgSpec.tag} --force`);
  assert.equal(pgSpec.acrRepository, 'postgres');
  assert.match(pgSpec.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(r.calls.filter((c) => c.startsWith('resolve') && c.includes(` ${pgSpec.acrRepository}@${pgSpec.digest}`)).length, 2, 'PG presence check AND read-back expected');
  // The edge image (G1) is checked last; among the PDP + PG calls the PG read-back is still last.
  const lastResolve = r.calls.filter((c) => c.startsWith('resolve') && !c.includes(` ${edgeSpec.acrRepository}@`)).at(-1);
  assert.ok(lastResolve.includes(pgSpec.acrRepository), `the last PDP/PG registry call must be the PG read-back: ${lastResolve}`);
});

test('G1 step script: edge router image absent -> imported exactly once BY DIGEST from edge-router-image.json, after PDP and PG, and read back', () => {
  const r = runStep({ resolveSeq: [`0 ${D}`], edgeSeq: ['3 x', `0 ${OTHER}`] });
  assert.equal(r.status, 0, r.out);
  const imp = imports(r.calls);
  // Breaks if the edge spec is dropped from SPECS (length 0), imported by :tag, or from another spec.
  assert.equal(imp.length, 1, r.calls.join('\n'));
  assert.equal(imp[0], `az acr import --name acrtest --resource-group rg-hub --source ${edgeSpec.source}@${edgeSpec.digest} --image ${edgeSpec.acrRepository}:${edgeSpec.tag} --force`);
  assert.equal(r.calls.filter((c) => c.startsWith('resolve') && c.includes(` ${edgeSpec.acrRepository}@${edgeSpec.digest}`)).length, 2, 'edge presence check AND read-back expected');
  assert.ok(r.calls.filter((c) => c.startsWith('resolve')).at(-1).includes(edgeSpec.acrRepository), 'the edge image is processed last');
});

test('G1 step script: a tag-only edge router digest fails the step before ANY Azure call', () => {
  // Uses a sandbox spec override: breaks if the validation loop stops covering the third spec.
  const r = runStep({ resolveSeq: [`0 ${D}`], edgeDigestOverride: '1.30.6-alpine-slim' });
  assert.equal(r.status, 1, r.out);
  assert.equal(r.calls.length, 0, r.calls.join('\n'));
  assert.match(r.out, /edge-router-image\.json is missing source\/acrRepository\/tag or its digest is not sha256/);
});

test('B2d step script: an EMPTY PG digest fails the step (exit 1) before ANY Azure call, naming the PG spec - it is not skipped', () => {
  // Breaks if the loop validates only the PDP spec, or if an empty digest is treated as "nothing to import" (status 0).
  const r = runStep({ pgDigest: '', resolveSeq: [`0 ${D}`] });
  assert.equal(r.status, 1, r.out);
  assert.equal(r.calls.length, 0, `a spec defect must stop the step before the registry is touched:\n${r.calls.join('\n')}`);
  assert.match(r.out, /pg-client-image\.json is missing source\/acrRepository\/tag or its digest is not sha256/);
  assert.match(r.out, /digest=''/);
});

test('B2d step script: a MISSING digest key in the PG spec fails the step too (jq yields empty, not a skip)', () => {
  const r = runStep({ pgDigest: null, resolveSeq: [`0 ${D}`] });
  assert.equal(r.status, 1, r.out);
  assert.equal(r.calls.length, 0, r.calls.join('\n'));
  assert.match(r.out, /pg-client-image\.json is missing/);
});

test('B2d step script: a PG import that fails after a good PDP import is NOT swallowed (exit 1, PG named)', () => {
  const r = runStep({ resolveSeq: [`0 ${D}`], pgSeq: ['3 x'], importRc: 9 });
  assert.equal(r.status, 1, r.out);
  // Exact substring, no regex: breaks if the PG source/digest is not named or the import rc is not surfaced.
  const want = `import of ${pgSpec.source}@${pgSpec.digest} into acrtest exited 9`;
  assert.ok(r.out.includes(want), `expected "${want}" in:\n${r.out}`);
});

test('B2d health: the control plane gets the FHIR image from cpFhirImage (tag fallback on the CP tag, digest pin per #5439) and the PG image DIGEST-pinned from pg-client-image.json, both only with the PDP', () => {
  const cp = resourcesOf(health).find((r) => r.type === 'Microsoft.Resources/deployments' && /lhds-control-plane/.test(JSON.stringify(r.name)));
  assert.ok(cp, 'control plane module missing');
  const p = cp.properties.parameters;
  // Breaks if the FHIR image is inlined again (the #5439 digest pin would be bypassed). The full cpFhirImage expression, including
  // the tag fallback on cpImageTag and the PDP gate, is pinned in lhds-fhir-image-digest-pin.test.mjs.
  assert.deepEqual(p.fhirImage, { value: "[variables('cpFhirImage')]" });
  assert.match(health.variables.cpFhirImage, /^\[if\(not\(variables\('pdpDeploy'\)\), '', if\(empty\(parameters\('fhirImageDigest'\)\), format\('\{0\}\/loom-health-fhir:\{1\}', variables\('cpAcrLoginServer'\), variables\('cpImageTag'\)\)/);
  assert.equal(p.image.value, "[format('{0}/loom-health-cp:{1}', variables('cpAcrLoginServer'), variables('cpImageTag'))]", 'the CP image must share the tag variable with the FHIR image');
  // Breaks if the PG image goes by tag (no @digest) or reads a different spec.
  assert.equal(p.pgClientImage, "[if(variables('pdpDeploy'), createObject('value', format('{0}/{1}@{2}', variables('cpAcrLoginServer'), variables('pgClientImageSpec').acrRepository, variables('pgClientImageSpec').digest)), createObject('value', ''))]");
  assert.ok(JSON.stringify(health.variables).includes(pgSpec.digest), 'compiled health.bicep does not carry the PG spec digest');
  assert.doesNotMatch(JSON.stringify(health.variables.cpImageTag), /latest/);
});

test('B2d control-plane: LOOM_HEALTH_CP_FHIR_IMAGE and LOOM_HEALTH_CP_PG_CLIENT_IMAGE are rendered from fhirImage / pgClientImage, together or not at all, and are in cpEnv', () => {
  const cpArm = compile(`${BICEP}/modules/health/control-plane.bicep`);
  const v = JSON.stringify(cpArm.variables.engineImageEnv);
  // Breaks if either env is sourced from the wrong param (a swap), or the all-or-nothing `or(empty..)` is dropped.
  assert.match(v, /or\(empty\(parameters\('fhirImage'\)\), empty\(parameters\('pgClientImage'\)\)\)/);
  assert.match(v, /'name', 'LOOM_HEALTH_CP_FHIR_IMAGE', 'value', parameters\('fhirImage'\)/);
  assert.match(v, /'name', 'LOOM_HEALTH_CP_PG_CLIENT_IMAGE', 'value', parameters\('pgClientImage'\)/);
  assert.equal(cpArm.parameters.fhirImage.defaultValue, '');
  assert.equal(cpArm.parameters.pgClientImage.defaultValue, '');
  // Positive pairing: the variable is actually concatenated into the container env (absence alone would pass if it were dead code).
  assert.match(JSON.stringify(cpArm), /variables\('pdpEnv'\), variables\('engineImageEnv'\), /);
});

const asserts = (calls) => calls.filter((c) => c.startsWith('assert '));

test('B2d step script: the FHIR image tag is asserted present, with the tag read from cp.json imageTag (not a transcribed v0.1)', () => {
  const r = runStep({ resolveSeq: [`0 ${D}`], cpJson: { imageTag: 'v9.9' } });
  assert.equal(r.status, 0, r.out);
  // Breaks if the assertion is dropped (length 0) or the tag is hard-coded to v0.1 (this fixture asks for v9.9).
  assert.deepEqual(asserts(r.calls), ['assert --acr acrtest --rg rg-hub --lease loom-health-fhir:v9.9']);
});

test('B2d step script: with no cp.json imageTag the FHIR tag defaults to v0.1, the default health.bicep uses', () => {
  const r = runStep({ resolveSeq: [`0 ${D}`] });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(asserts(r.calls), ['assert --acr acrtest --rg rg-hub --lease loom-health-fhir:v0.1']);
  assert.match(read(`${BICEP}/health.bicep`), /var cpImageTag = string\(controlPlaneConfig\.\?imageTag \?\? 'v0\.1'\)/);
});

test('B2d step script: FHIR tag MISSING (exit 3) fails the deploy before any import; UNPROVEN (exit 4) fails without claiming it is missing', () => {
  const miss = runStep({ resolveSeq: ['3 x'], assertRc: 3 });
  assert.equal(miss.status, 1, miss.out);
  assert.equal(imports(miss.calls).length, 0, 'no import may run once the FHIR image is known missing');
  assert.match(miss.out, /MISSING: the registry answered and loom-health-fhir:v0\.1 is not in it/);
  const unproven = runStep({ resolveSeq: ['3 x'], assertRc: 4 });
  assert.equal(unproven.status, 1, unproven.out);
  assert.match(unproven.out, /UNPROVEN: .* This is not a claim that it is missing/);
  assert.doesNotMatch(unproven.out, /MISSING: the registry answered/);
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
