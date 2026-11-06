/**
 * Explicit ADX cluster name for GCC-High (Gov run 42106150785).
 *
 * The deleted cluster's name (adx-csa-loom-fmezxj) was still `InvalidClusterName ... already taken` about 20 hours after
 * the delete. `adxConfig.adxClusterName` lets a boundary choose a name; unset keeps the derived default byte-for-byte.
 * Each control names the input that breaks it. The default expression is LIFTED from adx-cluster.bicep, not transcribed.
 *
 * NOT PROVEN HERE: that the new name is free in Azure Government. Only a live create witnesses it. A landing zone that
 * attaches to this cluster must be given the same name; this test does not cover that.
 *
 * Run: node --test scripts/ci/__tests__/adx-cluster-name.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const BICEP = path.resolve(import.meta.dirname, '..', '..', '..', 'platform', 'fiab', 'bicep');
const read = (rel) => fs.readFileSync(path.join(BICEP, rel), 'utf8').replace(/\r\n/g, '\n');
const DELETED_NAME = 'adx-csa-loom-fmezxj';

test('ADX NAME: the admin-plane fallback is the SAME expression as the module default, so other boundaries keep their name', () => {
  // Breaks if: either default is edited without the other (a boundary that sets no name would then be renamed, which
  // creates a SECOND cluster beside the live one). The module default is lifted from source.
  const mod = /^param clusterName string = ('adx-csa-loom-\$\{take\(uniqueString\(subscription\(\)\.id\), 6\)\}')$/m.exec(read('modules/admin-plane/adx-cluster.bicep'));
  assert.ok(mod, 'adx-cluster.bicep no longer defaults clusterName to the derived expression; this test has nothing to compare');
  const ap = read('modules/admin-plane/main.bicep');
  const eff = /^var adxClusterNameEff = adxConfig\.\?adxClusterName \?\? (.+)$/m.exec(ap);
  assert.ok(eff, 'admin-plane must define adxClusterNameEff from adxConfig.?adxClusterName');
  assert.equal(eff[1].trim(), mod[1], 'the fallback must equal the module default exactly');
});

test('ADX NAME: adxConfigT declares the optional, length-bounded field and the module call passes it', () => {
  // Breaks if: the field is dropped from the type (the bicepparam value would not validate), loses its length bounds
  // (ADX names are 4-22 chars), or the module call stops passing clusterName (the setting would silently do nothing).
  const ap = read('modules/admin-plane/main.bicep');
  assert.ok(/@minLength\(4\)\n {2}@maxLength\(22\)\n {2}adxClusterName: string\?\n/.test(ap), 'adxConfigT must declare `adxClusterName: string?` bounded 4-22');
  const call = ap.slice(ap.indexOf("module adxCluster 'adx-cluster.bicep'"));
  assert.ok(call.slice(0, call.indexOf('\n}\n')).includes('\n    clusterName: adxClusterNameEff\n'), 'the adx-cluster module call must pass clusterName: adxClusterNameEff');
});

test('ADX NAME: only GCC-High sets a name, it is a valid ADX name, and it is not the reserved one', () => {
  // Breaks if: GCC-High loses the setting (Gov retries the reserved name), another boundary gains one (an unprobed
  // rename), the value breaks ADX naming rules, or it is set back to the deleted cluster's name.
  const dir = path.join(BICEP, 'params');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.bicepparam'));
  assert.ok(files.length >= 8, `expected at least 8 param files, found ${files.length}`);
  const setters = {};
  for (const f of files) {
    const m = /adxClusterName: '([^']*)'/.exec(read(`params/${f}`));
    if (m) setters[f] = m[1];
  }
  assert.deepEqual(Object.keys(setters), ['gcc-high.bicepparam'], 'only gcc-high.bicepparam may set adxClusterName');
  const name = setters['gcc-high.bicepparam'];
  assert.ok(/^[a-z0-9][a-z0-9-]{2,20}[a-z0-9]$/.test(name), `"${name}" must be 4-22 chars of lowercase letters, digits and inner hyphens`);
  assert.notEqual(name, DELETED_NAME, 'the deleted cluster name is still reserved');
});
