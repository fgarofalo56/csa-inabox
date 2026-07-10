// Unit tests for the Loom OneLake resolver core (pure, zero-dependency).
// Run: node --test  (from apps/loom-onelake). No npm install required.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLoomUri,
  buildLoomUri,
  resolvePhysical,
  deriveStorageConfig,
  safeRelPath,
  safeSeg,
} from '../src/resolver.mjs';

const CFG = {
  defaultAccount: 'dlzlakecus',
  dfsSuffix: 'dfs.core.windows.net',
  defaultContainer: 'bronze',
  tokenScope: 'https://storage.azure.com/.default',
};

// ── parseLoomUri ────────────────────────────────────────────────────────────

test('parse: canonical 4-segment uri', () => {
  const p = parseLoomUri('loom://acme/sales-ws/orders/Tables/fact');
  assert.equal(p.ok, true);
  assert.equal(p.tenant, 'acme');
  assert.equal(p.workspace, 'sales-ws');
  assert.equal(p.item, 'orders');
  assert.equal(p.itemType, null);
  assert.equal(p.path, 'Tables/fact');
});

test('parse: item.type suffix is split out', () => {
  const p = parseLoomUri('loom://acme/ws/sales.lakehouse/Tables/orders');
  assert.equal(p.ok, true);
  assert.equal(p.item, 'sales');
  assert.equal(p.itemType, 'lakehouse');
  assert.equal(p.path, 'Tables/orders');
});

test('parse: trailing dotted alpha token becomes the item type', () => {
  const p = parseLoomUri('loom://acme/ws/report.2024.parquet');
  // Only a letter/dash suffix is a type; the earlier "2024" stays in the item.
  assert.equal(p.ok, true);
  assert.equal(p.itemType, 'parquet');
  assert.equal(p.item, 'report.2024');
});

test('parse: item root with no path', () => {
  const p = parseLoomUri('loom://acme/ws/orders');
  assert.equal(p.ok, true);
  assert.equal(p.path, '');
});

test('parse: rejects non-loom scheme', () => {
  assert.equal(parseLoomUri('abfss://c@a.dfs/x').ok, false);
  assert.equal(parseLoomUri('https://onelake.dfs.fabric.microsoft.com/ws/x').ok, false);
});

test('parse: rejects too-few segments', () => {
  assert.equal(parseLoomUri('loom://acme/ws').ok, false);
  assert.equal(parseLoomUri('loom://acme').ok, false);
});

test('parse: rejects empty / non-string', () => {
  assert.equal(parseLoomUri('').ok, false);
  assert.equal(parseLoomUri(null).ok, false);
  assert.equal(parseLoomUri(undefined).ok, false);
});

test('parse: path traversal segments are stripped', () => {
  const p = parseLoomUri('loom://acme/ws/orders/../../etc/passwd');
  assert.equal(p.ok, true);
  assert.equal(p.path, 'etc/passwd');
});

test('build/parse round-trip', () => {
  const uri = buildLoomUri({ tenant: 'acme', workspace: 'ws', item: 'sales', itemType: 'lakehouse', path: 'Tables/orders' });
  assert.equal(uri, 'loom://acme/ws/sales.lakehouse/Tables/orders');
  const p = parseLoomUri(uri);
  assert.equal(p.item, 'sales');
  assert.equal(p.itemType, 'lakehouse');
  assert.equal(p.path, 'Tables/orders');
});

// ── resolvePhysical ─────────────────────────────────────────────────────────

test('resolve: convention fallback (no registration)', () => {
  const p = parseLoomUri('loom://acme/ws/salesdata/Tables/orders');
  const r = resolvePhysical(p, null, CFG);
  assert.equal(r.ok, true);
  assert.equal(r.source, 'convention');
  assert.equal(r.physical.container, 'bronze');
  assert.equal(
    r.physical.abfss,
    'abfss://bronze@dlzlakecus.dfs.core.windows.net/lakehouses/salesdata/Tables/orders',
  );
  assert.equal(r.auth.mode, 'managed-identity');
  assert.equal(r.auth.sas, null);
});

test('resolve: registry container + rootPath', () => {
  const p = parseLoomUri('loom://acme/ws/sales/Tables/orders');
  const entry = { container: 'silver', rootPath: 'lakehouses/sales/root' };
  const r = resolvePhysical(p, entry, CFG);
  assert.equal(r.ok, true);
  assert.equal(r.source, 'registry');
  assert.equal(
    r.physical.abfss,
    'abfss://silver@dlzlakecus.dfs.core.windows.net/lakehouses/sales/root/Tables/orders',
  );
});

test('resolve: stamped full abfss root wins + carries account', () => {
  const p = parseLoomUri('loom://acme/ws/sales/Files/raw.csv');
  const entry = { abfssRoot: 'abfss://gold@extacct.dfs.core.windows.net/lakehouses/s' };
  const r = resolvePhysical(p, entry, CFG);
  assert.equal(r.ok, true);
  assert.equal(r.source, 'stamped-abfss');
  assert.equal(r.physical.account, 'extacct');
  assert.equal(r.physical.container, 'gold');
  assert.equal(
    r.physical.abfss,
    'abfss://gold@extacct.dfs.core.windows.net/lakehouses/s/Files/raw.csv',
  );
});

test('resolve: explicit account on entry overrides default', () => {
  const p = parseLoomUri('loom://acme/ws/ext/Tables/t');
  const entry = { container: 'landing', rootPath: 'x', account: 'customacct' };
  const r = resolvePhysical(p, entry, CFG);
  assert.equal(r.physical.account, 'customacct');
  assert.equal(r.physical.abfss, 'abfss://landing@customacct.dfs.core.windows.net/x/Tables/t');
});

test('resolve: internal shortcut → passthrough MI', () => {
  const p = parseLoomUri('loom://acme/ws/link/sub/dir');
  const entry = { shortcut: { target: 'abfss://silver@dlzlakecus.dfs.core.windows.net/other', kind: 'internal' } };
  const r = resolvePhysical(p, entry, CFG);
  assert.equal(r.ok, true);
  assert.equal(r.source, 'shortcut');
  assert.equal(r.physical.scheme, 'shortcut');
  assert.equal(r.physical.target, 'abfss://silver@dlzlakecus.dfs.core.windows.net/other/sub/dir');
  assert.equal(r.auth.mode, 'managed-identity');
});

test('resolve: external shortcut → stored-connection auth', () => {
  const p = parseLoomUri('loom://acme/ws/s3link/data');
  const entry = { shortcut: { target: 's3://bucket/prefix', kind: 's3', credentialRef: 'kv://conn/s3' } };
  const r = resolvePhysical(p, entry, CFG);
  assert.equal(r.auth.mode, 'stored-connection');
  assert.equal(r.auth.credentialRef, 'kv://conn/s3');
  assert.equal(r.physical.target, 's3://bucket/prefix/data');
});

test('resolve: honest gate when no storage account configured', () => {
  const p = parseLoomUri('loom://acme/ws/sales/t');
  const r = resolvePhysical(p, null, null);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_configured');
  assert.match(r.error, /LOOM_ONELAKE_DEFAULT_ACCOUNT/);
});

test('resolve: gov dfs suffix is honoured', () => {
  const gov = { ...CFG, dfsSuffix: 'dfs.core.usgovcloudapi.net' };
  const p = parseLoomUri('loom://acme/ws/sales/t');
  const r = resolvePhysical(p, null, gov);
  assert.ok(r.physical.abfss.includes('dfs.core.usgovcloudapi.net'));
});

test('resolve: never emits a Fabric OneLake host', () => {
  const p = parseLoomUri('loom://acme/ws/sales/Tables/x');
  const r = resolvePhysical(p, null, CFG);
  assert.ok(!r.physical.abfss.includes('onelake.dfs.fabric.microsoft.com'));
  assert.ok(!r.physical.dfsUrl.includes('fabric.microsoft.com'));
});

// ── deriveStorageConfig ─────────────────────────────────────────────────────

test('deriveStorageConfig: explicit account', () => {
  const c = deriveStorageConfig({ LOOM_ONELAKE_DEFAULT_ACCOUNT: 'acct1' });
  assert.equal(c.defaultAccount, 'acct1');
  assert.equal(c.dfsSuffix, 'dfs.core.windows.net');
});

test('deriveStorageConfig: parses account from container URL', () => {
  const c = deriveStorageConfig({ LOOM_BRONZE_URL: 'https://dlzcus.dfs.core.windows.net/bronze' });
  assert.equal(c.defaultAccount, 'dlzcus');
  assert.equal(c.defaultContainer, 'bronze');
});

test('deriveStorageConfig: gov cloud flips suffix', () => {
  const c = deriveStorageConfig({ LOOM_ONELAKE_DEFAULT_ACCOUNT: 'a', AZURE_CLOUD: 'AzureUSGovernment' });
  assert.equal(c.dfsSuffix, 'dfs.core.usgovcloudapi.net');
});

test('deriveStorageConfig: null when nothing configured', () => {
  assert.equal(deriveStorageConfig({}), null);
});

// ── sanitisers ──────────────────────────────────────────────────────────────

test('safeRelPath drops traversal + empty segments', () => {
  assert.equal(safeRelPath('/a//b/../c/'), 'a/b/c');
  assert.equal(safeRelPath('a\\b\\c'), 'a/b/c');
});

test('safeSeg collapses to a single token', () => {
  assert.equal(safeSeg('sales/data ws'), 'sales-data ws');
});
