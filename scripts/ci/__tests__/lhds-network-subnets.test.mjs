/**
 * LHDS stamp subnet plan: every cidrSubnet(vnetAddressPrefix, size, index) in
 * modules/health/network.bicep must be pairwise non-overlapping for the default VNet prefix.
 *
 * Breaking value (assertion-design.md): a /24 `cidrSubnet(vnetAddressPrefix, 24, 7)`
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

test('the lift found the default prefix and the subnet plan (positive control)', () => {
  assert.ok(defaultPrefix, 'param vnetAddressPrefix default not found');
  // Breaks at 4 or 6: a dropped OR an added cidrSubnet var changes the count (aks, pe, pg, agw, fw).
  assert.equal(subnetVars.length, 5, `expected exactly 5 cidrSubnet vars (aks, pe, pg, agw, fw), got ${subnetVars.length}: ${subnetVars.map((m) => m[1]).join(',')}`);
  // Breaks if any of these five names is renamed or removed while the count stays 5.
  assert.deepEqual(subnetVars.map((m) => m[1]).sort(), ['agwPrefix', 'aksPrefix', 'fwPrefix', 'pePrefix', 'pgPrefix']);
});

test('every subnet sits inside the VNet prefix', () => {
  const base = ip(defaultPrefix[1]);
  const top = base + 2 ** (32 - Number(defaultPrefix[2]));
  // Breaks if a subnet index pushes its block past the VNet end (e.g. a /24 at idx 256 in a /16).
  for (const r of ranges()) assert.ok(r.start >= base && r.end <= top, `${r.name} outside the VNet prefix`);
});

test('subnet prefixes are pairwise non-overlapping (a /24 at idx 7 vs fwPrefix /26 idx 28 breaks it)', () => {
  const rs = ranges();
  // Breaks on any two overlapping blocks, e.g. a /24 at idx 7 against fwPrefix (10.60.7.0/26).
  for (let i = 0; i < rs.length; i++) {
    for (let j = i + 1; j < rs.length; j++) {
      assert.ok(rs[i].end <= rs[j].start || rs[j].end <= rs[i].start, `${rs[i].name} overlaps ${rs[j].name}`);
    }
  }
});
