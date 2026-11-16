/**
 * LHDS stamp subnet plan: every cidrSubnet(vnetAddressPrefix, size, index) in
 * modules/health/network.bicep must be pairwise non-overlapping for the default VNet prefix.
 *
 * Breaking value (assertion-design.md): `scriptPrefix = cidrSubnet(vnetAddressPrefix, 24, 7)`
 * is 10.60.7.0/24 and contains `fwPrefix = cidrSubnet(vnetAddressPrefix, 26, 28)` =
 * 10.60.7.0/26 (28*64 = 1792 = 7*256), which ARM rejects with NetcfgSubnetRangesOverlap on
 * every egressMode 'firewall' stamp. Index 8 passes.
 *
 * The prefix, sizes and indexes are LIFTED from the source at runtime, not transcribed.
 * LHDS_REPO_ROOT points the suite at a sandbox copy for mutation runs.
 *
 * Run: node --test scripts/ci/__tests__/lhds-network-subnets.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.LHDS_REPO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const src = readFileSync(resolve(root, 'platform/fiab/bicep/modules/health/network.bicep'), 'utf8').replace(/\r\n/g, '\n');

const defaultPrefix = /param vnetAddressPrefix string = '([0-9.]+)\/(\d+)'/.exec(src);
const subnetVars = [...src.matchAll(/^var (\w+) = cidrSubnet\(vnetAddressPrefix, (\d+), (\d+)\)$/gm)];

const ip = (s) => s.split('.').reduce((a, o) => a * 256 + Number(o), 0);

function ranges() {
  const base = ip(defaultPrefix[1]);
  return subnetVars.map(([, name, size, idx]) => {
    const len = 2 ** (32 - Number(size));
    const start = base + Number(idx) * len; // cidrSubnet: idx-th /size block of the VNet prefix
    return { name, start, end: start + len };
  });
}

// ── tls-cert.bicep: identity-based staging storage access (live failure, run 43794877307) ──
// Breaking value: deleting the Storage File Data Privileged Contributor assignment
// (69566ab7-960f-475b-8e7c-b3118f30c6bd) on the staging account, or the script's dependsOn on it,
// makes ARM reject the script with DeploymentScriptStorageAccountWithServiceEndpointEnabled.
const ROLE = '69566ab7-960f-475b-8e7c-b3118f30c6bd';
const tlsSrc = readFileSync(resolve(root, 'platform/fiab/bicep/modules/health/tls-cert.bicep'), 'utf8').replace(/\r\n/g, '\n');

function compileTls() {
  for (const [cmd, args] of [['az', ['bicep', 'build']], ['bicep', ['build']]]) {
    try {
      const out = execFileSync(cmd, [...args, '--file', resolve(root, 'platform/fiab/bicep/modules/health/tls-cert.bicep'), '--stdout'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' });
      return JSON.parse(out);
    } catch { /* try next tool */ }
  }
  return null;
}

test('tls-cert.bicep source: the role assignment exists, no account key is passed, the script depends on it', () => {
  assert.ok(tlsSrc.includes(ROLE), 'Storage File Data Privileged Contributor role id missing');
  assert.ok(/scope: staging\b/.test(tlsSrc), 'role assignment is not scoped to the staging account');
  assert.ok(!/listKeys\(|storageAccountKey/.test(tlsSrc), 'the script must not pass an account key');
  assert.ok(/dependsOn: \[[^\]]*stagingFileRole/.test(tlsSrc), 'deploymentScript does not depend on stagingFileRole');
});

test('tls-cert.bicep compiled ARM: role assignment scoped to the staging account, script dependsOn it', (t) => {
  const arm = compileTls();
  if (!arm) return t.skip('neither `az bicep` nor `bicep` is available; the source-text test above still ran');
  const res = Object.values(arm.resources);
  // roleDefinitionId compiles to variables('<name>'): resolve it to the literal GUID.
  const roleOf = (r) => {
    const m = /variables\('(\w+)'\)/.exec(String(r.properties.roleDefinitionId));
    return m ? arm.variables[m[1]] : String(r.properties.roleDefinitionId);
  };
  const ra = res.find((r) => r.type === 'Microsoft.Authorization/roleAssignments' && roleOf(r) === ROLE);
  assert.ok(ra, 'no roleAssignment for 69566ab7 in the compiled template');
  assert.ok(ra.scope.includes('Microsoft.Storage/storageAccounts'), `role scope is not the staging account: ${ra.scope}`);
  const ds = res.find((r) => r.type === 'Microsoft.Resources/deploymentScripts');
  assert.equal(ds.apiVersion, '2023-08-01');
  assert.ok(!('storageAccountKey' in ds.properties.storageAccountSettings), 'storageAccountKey still passed');
  assert.ok(ds.dependsOn.some((d) => d.includes('roleAssignments') && d.includes('Microsoft.Storage/storageAccounts')), `script dependsOn lacks the storage role: ${JSON.stringify(ds.dependsOn)}`);
});

test('the lift found the default prefix and the subnet plan (positive control)', () => {
  assert.ok(defaultPrefix, 'param vnetAddressPrefix default not found');
  assert.ok(subnetVars.length >= 6, `expected >= 6 cidrSubnet vars (aks, pe, pg, agw, fw, script), got ${subnetVars.length}`);
  assert.ok(subnetVars.some((m) => m[1] === 'scriptPrefix'), 'scriptPrefix var missing');
});

test('every subnet sits inside the VNet prefix', () => {
  const base = ip(defaultPrefix[1]);
  const top = base + 2 ** (32 - Number(defaultPrefix[2]));
  for (const r of ranges()) assert.ok(r.start >= base && r.end <= top, `${r.name} outside the VNet prefix`);
});

test('subnet prefixes are pairwise non-overlapping (scriptPrefix idx 7 vs fwPrefix /26 idx 28 breaks it)', () => {
  const rs = ranges();
  for (let i = 0; i < rs.length; i++) {
    for (let j = i + 1; j < rs.length; j++) {
      assert.ok(rs[i].end <= rs[j].start || rs[j].end <= rs[i].start, `${rs[i].name} overlaps ${rs[j].name}`);
    }
  }
});
