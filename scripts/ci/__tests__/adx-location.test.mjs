/**
 * ADX cluster region for GCC-High (Gov run 42157975744).
 *
 * A fresh Standard_L8as_v3 cluster in usgovvirginia was refused (InsufficientResourcesForSubscription). GCC-High places the
 * cluster in usgovarizona through `adxConfig.adxLocation`; unset keeps the hub location byte-for-byte. An ADX database's
 * `location` must equal its cluster's, so everything that declares a database or data connection must follow the same value.
 * Each control names the input that breaks it.
 *
 * NOT PROVEN HERE: that usgovarizona has capacity for the cluster, nor that cross-region ingestion works for the estate.
 * The DLZ attach path (landing-zone/adx-db-inner.bicep) does NOT take a cluster region yet; this test does not cover it.
 *
 * Run: node --test scripts/ci/__tests__/adx-location.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const BICEP = path.resolve(import.meta.dirname, '..', '..', '..', 'platform', 'fiab', 'bicep');
const read = (rel) => fs.readFileSync(path.join(BICEP, rel), 'utf8').replace(/\r\n/g, '\n');
const AP = 'modules/admin-plane/main.bicep';

const callBlock = (src, header) => {
  const i = src.indexOf(header);
  assert.ok(i >= 0, `${header} not found`);
  return src.slice(i, src.indexOf('\n}\n', i));
};

test('ADX LOCATION: adxConfigT declares the optional field and the effective region falls back to the hub location', () => {
  // Breaks if: the field is dropped (the bicepparam value would not validate), or the fallback stops being `location`
  // (every boundary that sets no region would move its cluster).
  const src = read(AP);
  assert.ok(/\n {2}adxLocation: string\?\n/.test(src), 'adxConfigT must declare `adxLocation: string?`');
  assert.ok(src.includes('\nvar adxLocationEff = adxConfig.?adxLocation ?? location\n'), 'adxLocationEff must be `adxConfig.?adxLocation ?? location`');
});

test('ADX LOCATION: the cluster and the workspace-monitor database both take the effective region', () => {
  // Breaks if: either call goes back to `location: location`, which splits an ADX database (hub region) from its
  // cluster (Arizona): ARM refuses a database whose location differs from its cluster's.
  const src = read(AP);
  assert.ok(callBlock(src, "module adxCluster 'adx-cluster.bicep'").includes('\n    location: adxLocationEff\n'), 'the cluster module must take adxLocationEff');
  assert.ok(callBlock(src, "module workspaceMonitor 'workspace-monitor.bicep'").includes('\n    location: adxLocationEff\n'), 'workspace-monitor must take adxLocationEff');
});

test('ADX LOCATION: workspace-monitor uses `location` ONLY for ADX child resources', () => {
  // Breaks if: a non-Kusto resource is added to workspace-monitor with `location: location`. That module now receives the
  // CLUSTER's region, so any other resource using it would silently land in the wrong region.
  const wm = read('modules/admin-plane/workspace-monitor.bicep');
  const uses = [...wm.matchAll(/\n {2}location: location\n/g)].map((m) => m.index);
  assert.equal(uses.length, 2, `expected exactly 2 uses of location (database + data connection), found ${uses.length}`);
  for (const at of uses) {
    const head = wm.slice(wm.lastIndexOf('\nresource ', at), at);
    assert.ok(head.includes('Microsoft.Kusto/clusters/databases'), `a use of location sits in a non-ADX resource: ${head.trim().slice(0, 90)}`);
  }
});

test('ADX LOCATION: only GCC-High sets a region, to usgovarizona, and no longer pins the refused Virginia SKU', () => {
  // Breaks if: GCC-High loses the region (Gov retries the refused Virginia cluster), another boundary gains one (an
  // unprobed move), or `adxSkuName: 'Standard_L8as_v3'` is put back (the SKU that was refused in Virginia).
  const dir = path.join(BICEP, 'params');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.bicepparam'));
  assert.ok(files.length >= 8, `expected at least 8 param files, found ${files.length}`);
  const setters = {};
  for (const f of files) {
    const m = /adxLocation: '([^']*)'/.exec(read(`params/${f}`));
    if (m) setters[f] = m[1];
  }
  assert.deepEqual(setters, { 'gcc-high.bicepparam': 'usgovarizona' });
  assert.ok(!read('params/gcc-high.bicepparam').includes("adxSkuName: 'Standard_L8as_v3'"), 'the refused Virginia SKU override must not return');
  assert.ok(read(AP).includes("'Standard_E8as_v5+1TB_PS'"), 'the GCC-High default SKU substitution must still exist in admin-plane');
});
