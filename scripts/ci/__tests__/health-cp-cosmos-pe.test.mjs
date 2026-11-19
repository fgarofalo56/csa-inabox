/**
 * Guard for the control-plane registry Cosmos private endpoint default (#5370).
 *
 * Defect: tenant policy CosmosDB_PublicNetwork_Modify forces publicNetworkAccess=Disabled, and
 * deploy-health.yml never passed privateEndpointSubnetId, so the CP Cosmos account had NO private
 * endpoint and was reachable from nowhere (CP 500 `internal`, job sweep failing every 30 s).
 * Fix: health.bicep defaults privateEndpointSubnetId / cosmosPrivateDnsZoneId to the hub PE subnet and
 * the hub privatelink.documents zone on the containerApps path, same-subscription only.
 *
 * Method: `az bicep build` health.bicep, inspect the compiled ARM variables and the control-plane
 * deployment parameters. A missing `az` FAILS the suite. LHDS_REPO_ROOT points at a sandbox copy for
 * mutation runs. Input that breaks each assertion is named inline (assertion-design.md).
 *
 * Run: node --test scripts/ci/__tests__/health-cp-cosmos-pe.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = process.env.LHDS_REPO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'health-cpcosmos-'));
const out = join(tmp, 'health.json');
const build = spawnSync('az', ['bicep', 'build', '--file', resolve(root, 'platform/fiab/bicep/health.bicep'), '--outfile', out], { encoding: 'utf8', shell: process.platform === 'win32' });
assert.equal(build.status, 0, `az bicep build failed (guard cannot run): ${build.stderr}`);
const arm = JSON.parse(readFileSync(out, 'utf8'));
rmSync(tmp, { recursive: true, force: true });

const v = arm.variables;
const cp = arm.resources.find((r) => r.type === 'Microsoft.Resources/deployments' && String(r.name).startsWith("[format('lhds-control-plane-"));

test('the CP deployment receives the defaulted PE subnet and zone, not the raw controlPlaneConfig read (positive control)', () => {
  assert.ok(cp, 'no lhds-control-plane deployment found');
  const p = cp.properties.parameters;
  // Breaks if the module params revert to `controlPlaneConfig.?privateEndpointSubnetId ?? ''`: the compiled
  // value would be an inline coalesce on controlPlaneConfig instead of the defaulted variable.
  assert.equal(p.privateEndpointSubnetId.value, "[variables('cpCosmosPeSubnetId')]");
  assert.equal(p.cosmosPrivateDnsZoneId.value, "[variables('cpCosmosZoneId')]");
});

test('the default subnet is the hub snet-private-endpoints, and an empty fallback exists only for the non-default case', () => {
  const s = v.cpCosmosPeSubnetId;
  // Breaks if the default is deleted (`?? ''`): hubVaultPeSubnetId disappears, the CP gets an empty
  // subnet again and the account is private-with-no-PE (the defect).
  assert.match(s, /variables\('hubVaultPeSubnetId'\)/, `no hub subnet default: ${s}`);
  assert.match(s, /variables\('hubCosmosPeDefault'\)/);
  // Explicit override still wins: coalesce reads controlPlaneConfig first.
  assert.match(s, /coalesce\(tryGet\(parameters\('controlPlaneConfig'\), 'privateEndpointSubnetId'\)/);
  assert.match(v.hubVaultPeSubnetId, /snet-private-endpoints/);
});

test('the default zone is the hub privatelink.documents zone in the hub resource group', () => {
  const z = v.cpCosmosZoneId;
  // Breaks if the zone default is deleted or points at the vaultcore zone.
  assert.match(z, /variables\('hubCosmosZoneName'\)/);
  assert.match(z, /variables\('hubResourceGroup'\)/);
  assert.match(z, /variables\('hubSubscriptionId'\)/);
  assert.match(z, /coalesce\(tryGet\(parameters\('controlPlaneConfig'\), 'cosmosPrivateDnsZoneId'\)/);
});

test('the zone suffix is per boundary: .com on Commercial, .us on GCC-High/IL5, never hard-coded', () => {
  const z = v.hubCosmosZoneName;
  // Breaks if hard-coded to .com (GCC-High/IL5 would resolve documents.azure.us) or to .us (Commercial).
  assert.match(z, /^\[format\('privatelink\.documents\.azure\.\{0\}'/);
  assert.match(z, /variables\('healthIsGov'\)/);
  assert.match(z, /'us'/);
  assert.match(z, /'com'/);
  assert.match(v.healthIsGov, /'GCC-High'/);
  assert.match(v.healthIsGov, /'IL5'/);
});

test('the default applies only on containerApps AND only when the hub subscription is the deploy subscription', () => {
  const c = v.hubCosmosPeDefault;
  // Breaks if the platform term is dropped (aks CP is inside the stamp VNet), or if the subscription
  // equality is dropped: a PE must share the VNet's subscription, so a cross-subscription hub would
  // fail the deployment instead of falling back to no-PE.
  assert.match(c, /variables\('cpPlatform'\), 'containerApps'/);
  assert.match(c, /variables\('hubSubscriptionId'\), subscription\(\)\.subscriptionId/);
  assert.match(c, /variables\('hubEnvIdValid'\)/);
});
