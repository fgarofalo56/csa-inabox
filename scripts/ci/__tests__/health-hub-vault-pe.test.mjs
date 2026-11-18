/**
 * Guard for the hub-side private endpoint on the LHDS stamp vault (#5345).
 *
 * Defect (deploy-health run 44236097017): the control plane runs in the HUB Container Apps
 * environment; the stamp vault is private-only and its stamp-VNet-linked zone is invisible to the hub
 * VNet, so every vault call failed with `fetch failed`. Fix: a second PE on the vault in the hub PE
 * subnet, DNS zone group in the HUB vaultcore zone.
 *
 * Method: compile health.bicep with `az bicep build` and inspect the compiled ARM (no grep of the
 * .bicep source, so a refactor that keeps the behaviour still passes). A missing `az` FAILS the
 * suite, it does not skip. Inputs that break each assertion are named inline (assertion-design.md).
 * LHDS_REPO_ROOT points the suite at a sandbox copy for mutation runs.
 *
 * Run: node --test scripts/ci/__tests__/health-hub-vault-pe.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = process.env.LHDS_REPO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'health-hubpe-'));
const out = join(tmp, 'health.json');
const build = spawnSync('az', ['bicep', 'build', '--file', resolve(root, 'platform/fiab/bicep/health.bicep'), '--outfile', out], { encoding: 'utf8', shell: process.platform === 'win32' });
assert.equal(build.status, 0, `az bicep build failed (guard cannot run): ${build.stderr}`);
const arm = JSON.parse(readFileSync(out, 'utf8'));
rmSync(tmp, { recursive: true, force: true });

const deployments = arm.resources.filter((r) => r.type === 'Microsoft.Resources/deployments');
const hub = deployments.find((r) => String(r.name).startsWith('[format(\'lhds-hub-vault-pe-'));
const cp = deployments.find((r) => String(r.name).startsWith('[format(\'lhds-control-plane-'));

test('the hub PE module is present, scoped to the HUB resource group, not the stamp group (positive control)', () => {
  assert.ok(hub, 'no lhds-hub-vault-pe deployment: the control plane again cannot reach the stamp vault');
  // Breaks if scope: healthRg is used: the PE would land in the stamp RG and carry the stamp region.
  assert.equal(hub.resourceGroup, "[variables('hubResourceGroup')]");
  assert.equal(hub.subscriptionId, "[variables('hubSubscriptionId')]");
});

test('the hub PE deploys only on the containerApps path with a deployed control plane', () => {
  const cond = arm.variables.hubVaultPeDeploy;
  // Breaks if the cpPlatform == containerApps term is dropped (aks CP is inside the stamp VNet, needs no hub PE)
  // or the cpDeploy term is dropped (a PE for a control plane that does not exist).
  assert.match(cond, /variables\('cpDeploy'\)/);
  assert.match(cond, /variables\('cpPlatform'\), 'containerApps'/);
  assert.equal(hub.condition, "[variables('hubVaultPeDeploy')]");
});

test('the control plane is ordered AFTER the hub PE', () => {
  // Breaks if dependsOn is removed: the CP starts and issues the cert before DNS/PE exist.
  assert.ok(cp.dependsOn.some((d) => d.includes('lhds-hub-vault-pe-')), 'control plane does not depend on the hub PE module');
});

test('the hub vaultcore zone name comes from environment(), never a hard-coded cloud suffix', () => {
  const z = arm.variables.hubVaultZoneName;
  // Breaks if hard-coded to privatelink.vaultcore.azure.net: GCC-High / IL5 / DoD resolve .usgovcloudapi.net.
  assert.match(z, /environment\(\)\.suffixes\.keyvaultDns/);
  assert.doesNotMatch(z, /vaultcore\.(azure\.net|usgovcloudapi\.net)/);
  assert.match(z, /^\[format\('privatelink\.vaultcore/);
});

test('the PE writes its A record into the hub zone and creates no zone link', () => {
  const res = hub.properties.template.resources;
  const pe = res.find((r) => r.type === 'Microsoft.Network/privateEndpoints');
  const grp = res.find((r) => r.type === 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups');
  assert.ok(pe && grp);
  const conn = pe.properties.privateLinkServiceConnections[0].properties;
  // Breaks if groupIds is not ['vault'] (ARM rejects the connection) or the target is not the stamp vault parameter.
  assert.deepEqual(conn.groupIds, ['vault']);
  assert.equal(conn.privateLinkServiceId, "[parameters('vaultId')]");
  assert.equal(pe.properties.subnet.id, "[parameters('hubPeSubnetId')]");
  assert.equal(grp.properties.privateDnsZoneConfigs[0].properties.privateDnsZoneId, "[parameters('hubVaultZoneId')]");
  // Breaks if someone links the stamp zone to the hub VNet (a VNet cannot link two zones of one name).
  assert.ok(!res.some((r) => r.type.endsWith('virtualNetworkLinks')), 'hub PE module must not create a zone VNet link');
});
