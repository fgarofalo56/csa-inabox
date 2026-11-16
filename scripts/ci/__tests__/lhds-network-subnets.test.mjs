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
