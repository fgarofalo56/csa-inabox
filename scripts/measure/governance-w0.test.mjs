/**
 * Tests for the governance-w0 measurement scripts. Run: node --test scripts/measure/governance-w0.test.mjs
 *
 * assertion-design.md: each test states the input that would break it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scrub, blocked, measured, isLoomOwned, expectedSources, diffRegistered, scanCostMonthly, STATE,
} from './governance-lib.mjs';
import { collectInventory } from './governance-arm-inventory.mjs';
import { measureDataPlane, readList, summariseRun, whoForStatus, conventionBase } from './governance-purview-dataplane.mjs';
import { pickRates, scenarios } from './governance-cost.mjs';
import { assertCloud } from './governance-run.mjs';

// ---------- scrub ----------
test('scrub removes a JWT, a Bearer header, a SAS signature and an account key but keeps the surrounding text', () => {
  // Assembled at runtime from three fake segments so no JWT-shaped literal sits in the repo (gitleaks).
  const jwt = ['eyJhbGciOiJGQUtFIn0', 'eyJzdWIiOiJmYWtlLXN1YmplY3QifQ', 'ZmFrZS1zaWduYXR1cmUtdmFsdWU'].join('.');
  const s = scrub(`tok=${jwt} h=Bearer abcdefghijklmnop url=https://x/y?sv=2020&sig=SECRETSIG123&se=1 cs=AccountKey=KEYKEYKEY;Endpoint=z`);
  // Breaks if any rule is removed: each needle below is the secret that rule targets.
  for (const needle of [jwt, 'abcdefghijklmnop', 'SECRETSIG123', 'KEYKEYKEY']) assert.ok(!s.includes(needle), `leaked ${needle}`);
  // Positive pair: deleting scrub() entirely or blanking the string would fail this.
  assert.ok(s.includes('Endpoint=z') && s.includes('https://x/y'), 'scrub must not destroy non-secret text');
});

// ---------- blocked / measured ----------
test('blocked() refuses a missing owner, and measured() refuses a null value', () => {
  assert.throws(() => blocked('d', { reason: 'r' }), /owner/);
  assert.throws(() => measured('d', null), /UNKNOWN/);
  assert.equal(measured('d', 0).value, 0, 'a real zero is allowed when supplied explicitly');
});

// ---------- isLoomOwned / expectedSources ----------
const R = (type, name, rg, tags) => ({ id: `/subscriptions/s/resourceGroups/${rg}/providers/${type}/${name}`, type, name, resourceGroup: rg, tags });
test('isLoomOwned: tag, estate id and rg prefix each qualify; an untagged demo rg does not', () => {
  assert.equal(isLoomOwned(R('t', 'a', 'x', { CSA_Loom: 'true' })), true);
  assert.equal(isLoomOwned(R('t', 'a', 'x', { 'loom-estate-id': 'e' })), true);
  assert.equal(isLoomOwned(R('t', 'a', 'rg-csa-loom-admin-centralus', {})), true);
  assert.equal(isLoomOwned(R('t', 'a', 'rg-demo', {})), false, 'a demo resource must not be counted');
  assert.equal(isLoomOwned(R('t', 'a', 'rg-demo', null)), false);
});

test('expectedSources: lakehouse storage in, infra storage out, managed + non-scannable + platform stores classified', () => {
  const lake = R('Microsoft.Storage/storageAccounts', 'lake', 'rg-csa-loom-dlz', { CSA_Loom: 'true' });
  const infra = R('Microsoft.Storage/storageAccounts', 'infra', 'rg-csa-loom-dlz', { CSA_Loom: 'true' });
  const managed = R('Microsoft.Storage/storageAccounts', 'dbstorageabc', 'rg-csa-loom-dlz', { CSA_Loom: 'true' });
  const foreign = R('Microsoft.Storage/storageAccounts', 'foreign', 'rg-other', {});
  const eh = R('Microsoft.EventHub/namespaces', 'eh', 'rg-csa-loom-dlz', { CSA_Loom: 'true' });
  const cosmos = R('Microsoft.DocumentDB/databaseAccounts', 'cosmos', 'rg-csa-loom-dlz', { CSA_Loom: 'true' });
  const synSql = R('Microsoft.Sql/servers', 'syn', 'synapseworkspace-managedrg-1', { CSA_Loom: 'true' });
  const containers = [
    { accountId: lake.id.toUpperCase(), name: 'bronze' }, // upper-cased id: ARM ids are case-insensitive
    { accountId: infra.id, name: 'azure-webjobs-hosts' },
  ];
  const r = expectedSources([lake, infra, managed, foreign, eh, cosmos, synSql], { containers });
  assert.deepEqual(r.expected.map((e) => e.name), ['lake'], 'only the medallion storage account should be expected');
  const reasons = Object.fromEntries(r.excluded.map((x) => [x.id.split('/').pop(), x.reason]));
  assert.equal(reasons.infra, 'no-lakehouse-container');
  assert.equal(reasons.dbstorageabc, 'databricks-or-purview-managed-storage');
  assert.equal(reasons.foreign, 'not-loom-owned');
  assert.equal(reasons.cosmos, 'loom-platform-state-store');
  assert.equal(reasons.syn, 'synapse-managed-sql-server');
  assert.deepEqual(r.notScannable.map((x) => x.name), ['eh'], 'Event Hubs is listed as not scannable, not silently dropped');
});

// ---------- diffRegistered ----------
test('diffRegistered returns INCONCLUSIVE (not "everything missing") when the registered list was not read', () => {
  const exp = [{ idKey: '/a', hostHint: 'a.dfs.core.windows.net', name: 'a' }];
  assert.equal(diffRegistered(exp, null).state, STATE.INCONCLUSIVE, 'a failed read passed as null must not produce a diff');
  const d = diffRegistered(exp, []);
  assert.equal(d.state, STATE.MEASURED);
  assert.equal(d.missing.length, 1, 'a real empty list means the one expected source is missing');
});

test('diffRegistered matches by case-insensitive resourceId or by endpoint host, and flags a registered source Loom did not expect', () => {
  const exp = [
    { idKey: '/subscriptions/s/resourcegroups/rg/providers/microsoft.storage/storageaccounts/lake', hostHint: 'lake.dfs.core.windows.net', name: 'lake' },
    { idKey: '/x/sql', hostHint: 'sqlsrv.database.', name: 'sqlsrv' },
  ];
  const reg = [
    { name: 'ds1', kind: 'AdlsGen2', properties: { resourceId: '/subscriptions/S/resourceGroups/RG/providers/Microsoft.Storage/storageAccounts/LAKE' } },
    { name: 'ds2', kind: 'AzureSqlDatabase', properties: { serverEndpoint: 'sqlsrv.database.windows.net' } },
    { name: 'ds3', kind: 'AdlsGen2', properties: { resourceId: '/other' } },
  ];
  const d = diffRegistered(exp, reg);
  assert.equal(d.registered, 2, 'break: matching on the raw (case-sensitive) id would give 1');
  assert.equal(d.missing.length, 0);
  assert.deepEqual(d.unexpectedRegistered.map((x) => x.name), ['ds3']);
});

// ---------- cost ----------
test('scanCostMonthly: arithmetic on hand-computable inputs and rejection of a missing rate', () => {
  // 2 sources: (1 full * 2h + 4 incr * 0.5h) = 4 h each -> 8 h; * 10 vCores * $0.5 = $40; base 1 CU * $1 * 730 = $730
  const src = { fullScansPerMonth: 1, fullHours: 2, incrScansPerMonth: 4, incrHours: 0.5 };
  const c = scanCostMonthly({ cuRate: 1, vcoreRate: 0.5, capacityUnits: 1, vcoresPerScan: 10, sources: [src, src] });
  assert.equal(c.vcoreHours, 8);
  assert.equal(c.scanUsd, 40);
  assert.equal(c.baseUsd, 730);
  assert.equal(c.totalUsd, 770);
  assert.throws(() => scanCostMonthly({ cuRate: undefined, vcoreRate: 1, capacityUnits: 1, vcoresPerScan: 1, sources: [] }), /cuRate/);
});

test('pickRates takes the Standard meters, and throws on a missing or duplicated meter', () => {
  const items = [
    { productName: 'Azure Purview Data Map', meterName: 'Standard Capacity Unit', retailPrice: 0.411 },
    { productName: 'Azure Purview Scanning Ingestion and Classification', meterName: 'Standard vCore', retailPrice: 0.63 },
    { productName: 'Azure Purview Scanning Ingestion and Classification', meterName: 'PowerBI vCore', retailPrice: 0 },
  ];
  assert.deepEqual(pickRates(items), { cuPerHour: 0.411, vcoreHour: 0.63 });
  assert.throws(() => pickRates(items.slice(0, 1)), /Scanning Standard vCore/);
  assert.throws(() => pickRates([...items, items[1]]), /found 2/);
});

test('scenarios: a zero-source estate prices scans at 0 (the table is driven by sourceCount)', () => {
  const rates = { cuPerHour: 1, vcoreHour: 1 };
  assert.ok(scenarios({ rates, sourceCount: 0, capacityUnits: 1 }).every((r) => r.scanUsdPerMonth === 0));
  assert.ok(scenarios({ rates, sourceCount: 3, capacityUnits: 1 }).every((r) => r.scanUsdPerMonth > 0));
});

// ---------- ARM inventory ----------
function fakeAz(table) {
  return (args) => {
    const key = args.join(' ');
    for (const [pat, val] of table) if (key.includes(pat)) { if (val instanceof Error) throw val; return val; }
    return [];
  };
}
test('collectInventory REFUSES (INCONCLUSIVE) when the positive control fails: zero storage accounts', () => {
  const r = collectInventory(['sub1'], fakeAz([]));
  assert.equal(r.state, STATE.INCONCLUSIVE, 'a subscription set that returns nothing must not be published as an empty estate');
});

test('collectInventory records a failed list as BLOCKED, not as zero, and reads child databases through the parent', () => {
  const sa = { id: '/subscriptions/s/resourceGroups/rg-csa-loom-x/providers/Microsoft.Storage/storageAccounts/lake', name: 'lake', type: 'Microsoft.Storage/storageAccounts', resourceGroup: 'rg-csa-loom-x', tags: { CSA_Loom: 'true' } };
  const cl = { id: '/subscriptions/s/resourceGroups/rg-csa-loom-x/providers/Microsoft.Kusto/clusters/adx', name: 'adx', type: 'Microsoft.Kusto/clusters', resourceGroup: 'rg-csa-loom-x', tags: { CSA_Loom: 'true' } };
  const az = fakeAz([
    ['--resource-type Microsoft.Storage/storageAccounts', [sa]],
    ['--resource-type Microsoft.Kusto/clusters', [cl]],
    ['--resource-type Microsoft.Synapse/workspaces/sqlPools', new Error('az exited 1: AuthorizationFailed')],
    ['databases?api-version', { value: [{ name: 'adx/db1', id: 'i' }, { name: 'adx/db2', id: 'j' }] }],
    ['container-rm list', [{ name: 'bronze' }]],
  ]);
  const r = collectInventory(['s'], az);
  assert.equal(r.state, STATE.MEASURED);
  assert.equal(r.kustoDatabases.length, 2, 'break: reading databases with resource list on the child type returns 0');
  assert.deepEqual(r.kustoDatabases.map((d) => d.name), ['db1', 'db2']);
  assert.equal(r.containers.length, 1);
  const b = r.blockedReads.find((x) => x.datum.includes('sqlPools'));
  assert.ok(b && b.state === STATE.BLOCKED && /AuthorizationFailed/.test(b.reason), 'the failed list must surface with its error');
  assert.equal(r.byType['Microsoft.Synapse/workspaces/sqlPools'], undefined, 'a blocked type must have NO count rather than 0');
});

test('collectInventory refuses an empty subscription list (default az context may be the wrong tenant)', () => {
  assert.throws(() => collectInventory([], fakeAz([])), /explicit subscription/);
});

// ---------- data plane ----------
const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
test('measureDataPlane: a 404 TenantNotFound on every audience is BLOCKED and reads NO list (no fabricated empty arrays)', async () => {
  const r = await measureDataPlane({
    account: 'acct', boundary: 'GCC-High',
    tokenFn: () => ({ token: 'tok' }),
    fetchFn: async () => resp(404, { error: { code: 'TenantNotFound' } }),
  });
  assert.equal(r.state, STATE.BLOCKED);
  assert.equal(r.audienceProbe.length, 3, 'GCC-High probes three audiences');
  assert.ok(r.audienceProbe.every((p) => p.httpStatus === 404));
  assert.equal(r.dataSources, undefined, 'break: returning dataSources: [] here would read a failure as an empty estate');
});

test('measureDataPlane: token failure on an audience is recorded BLOCKED and the next audience is tried', async () => {
  const seen = [];
  const r = await measureDataPlane({
    account: 'acct', boundary: 'GCC-High',
    tokenFn: (aud) => (aud.endsWith('.net') ? { error: 'AADSTS500011 resource not found' } : { token: 't-' + aud }),
    fetchFn: async (url, init) => {
      seen.push(init.headers.authorization);
      if (url.includes('/scan/datasources/ds1/scans/sc1/runs')) return resp(200, { value: [{ id: 'r1', status: 'Succeeded', startTime: '2026-01-01T00:00:00Z', endTime: '2026-01-01T00:10:00Z', discoveryExecutionDetails: { statistics: { assets: { discovered: 7, classified: 3, failed: 0 } } } }] });
      if (url.includes('/scan/datasources/ds1/scans?')) return resp(200, { value: [{ name: 'sc1' }] });
      if (url.includes('/scan/datasources?')) return resp(200, { value: [{ name: 'ds1', kind: 'AdlsGen2', properties: { resourceId: '/r' } }] });
      if (url.includes('/collections?')) return resp(200, { value: [{ name: 'root' }] });
      return resp(500, 'unexpected ' + url);
    },
  });
  assert.equal(r.state, STATE.MEASURED);
  assert.equal(r.audienceProbe[0].state, STATE.BLOCKED);
  assert.equal(r.workingAudience, 'https://purview.azure.us', 'first audience failed to mint; second is the first that works');
  assert.equal(r.runs[0].runs.value[0].discovered, 7, 'positive control: the run counts are read back from the nested statistics path');
  assert.equal(r.runs[0].runs.value[0].durationSeconds, 600);
});

test('readList: a 403 is BLOCKED naming who must act, and a 2xx without value[] is not a list', async () => {
  const a = await readList('x', 'https://h/x', 't', async () => resp(403, 'forbidden'));
  assert.equal(a.state, STATE.BLOCKED);
  assert.equal(a.status, 403);
  assert.match(a.who, /Data Reader/);
  const b = await readList('x', 'https://h/x', 't', async () => resp(200, { notValue: 1 }));
  assert.equal(b.state, STATE.BLOCKED, 'break: treating a missing value[] as [] would fabricate an empty list');
  const c = await readList('x', 'https://h/x', 't', async () => { throw new TypeError('fetch failed'); });
  assert.equal(c.state, STATE.BLOCKED);
  assert.equal(c.status, null);
});

test('summariseRun: Learn field paths; absent statistics give null, never 0', () => {
  assert.equal(summariseRun({ id: 'r' }).discovered, null);
  assert.equal(summariseRun({ discoveryExecutionDetails: { statistics: { assets: { discovered: 0 } } } }).discovered, 0);
});

test('whoForStatus and conventionBase are per-status and per-boundary', () => {
  assert.match(whoForStatus(401), /audience/);
  assert.match(whoForStatus(429), /throttled/);
  assert.equal(conventionBase('a', 'GCC-High'), 'https://a.purview.azure.us');
  assert.equal(conventionBase('a', 'Commercial'), 'https://a.purview.azure.com');
});

// ---------- cloud guard ----------
test('assertCloud refuses a boundary/cloud mismatch before any read', () => {
  assert.throws(() => assertCloud('GCC-High', 'AzureCloud'), /refusing before any read/);
  assert.throws(() => assertCloud('Commercial', undefined), /undefined/);
  assert.doesNotThrow(() => assertCloud('GCC-High', 'AzureUSGovernment'));
  assert.throws(() => assertCloud('DoD', 'AzureDOD'), /unknown boundary/);
});
