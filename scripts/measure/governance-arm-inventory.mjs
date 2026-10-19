#!/usr/bin/env node
/**
 * governance-arm-inventory.mjs - W0 live measurement (read-only ARM).
 *
 *   node scripts/measure/governance-arm-inventory.mjs --subscriptions id1,id2 [--out file.json]
 *
 * Lists the Azure resources Loom binds to Purview scans: storage accounts (and
 * the containers of Loom-owned ones), Synapse workspaces and pools, ADX
 * clusters and databases, Event Hubs, Azure SQL, Databricks, AAS, Cosmos, and
 * the Purview accounts themselves. Every call is a GET/list.
 *
 * Fail-closed (scripts/measure/README.md R1/R4/R5):
 *  - a list that fails is recorded as BLOCKED with the az error, never as 0;
 *  - the whole inventory is REFUSED unless a positive control holds: at least
 *    one storage account was read (a subscription set with none cannot prove
 *    the query path works). A real example of why: `az resource list
 *    --resource-type Microsoft.Kusto/clusters/databases` answers 0 for a
 *    subscription that has a cluster, because child types are not listed that
 *    way, so child resources are read through the parent (ARM REST) instead.
 */
import { writeFileSync } from 'node:fs';
import { az as azJson, MeasurementError } from './measure.mjs';
import { blocked, measured, scrub, isLoomOwned, STATE } from './governance-lib.mjs';

export const RESOURCE_TYPES = [
  'Microsoft.Purview/accounts',
  'Microsoft.Storage/storageAccounts',
  'Microsoft.Synapse/workspaces',
  'Microsoft.Synapse/workspaces/sqlPools',
  'Microsoft.Kusto/clusters',
  'Microsoft.EventHub/namespaces',
  'Microsoft.Sql/servers',
  'Microsoft.Sql/servers/databases',
  'Microsoft.Databricks/workspaces',
  'Microsoft.AnalysisServices/servers',
  'Microsoft.DocumentDB/databaseAccounts',
];
const KUSTO_API = '2023-08-15';

/**
 * @param {string[]} subscriptions
 * @param {(args: string[]) => any} azFn injectable for tests; defaults to the guarded az() runner
 */
export function collectInventory(subscriptions, azFn = azJson) {
  if (!Array.isArray(subscriptions) || subscriptions.length === 0) {
    throw new MeasurementError('collectInventory needs at least one explicit subscription id (the default az context may be the wrong tenant)');
  }
  const resources = [];
  const blockedReads = [];
  const containers = [];
  const kustoDatabases = [];
  for (const sub of subscriptions) {
    for (const type of RESOURCE_TYPES) {
      try {
        const rows = azFn(['resource', 'list', '--subscription', sub, '--resource-type', type]);
        if (!Array.isArray(rows)) throw new MeasurementError(`resource list for ${type} was not an array`);
        for (const r of rows) resources.push({ ...r, subscriptionId: sub });
      } catch (e) {
        blockedReads.push(blocked(`list ${type} in ${sub}`, { reason: e.message, who: 'operator with Reader on the subscription' }));
      }
    }
  }
  // Child reads go through the parent.
  for (const c of resources.filter((r) => r.type?.toLowerCase() === 'microsoft.kusto/clusters')) {
    try {
      const j = azFn(['rest', '--method', 'get', '--url', `${c.id}/databases?api-version=${KUSTO_API}`]);
      for (const d of j.value ?? []) kustoDatabases.push({ cluster: c.name, clusterId: c.id, name: String(d.name).split('/').pop(), id: d.id, kind: d.kind });
    } catch (e) {
      blockedReads.push(blocked(`list databases of ADX cluster ${c.name}`, { reason: e.message, who: 'operator with Reader on the cluster' }));
    }
  }
  for (const s of resources.filter((r) => r.type?.toLowerCase() === 'microsoft.storage/storageaccounts' && isLoomOwned(r))) {
    try {
      const rows = azFn(['storage', 'container-rm', 'list', '--storage-account', s.name, '--resource-group', s.resourceGroup, '--subscription', s.subscriptionId]);
      for (const k of rows) containers.push({ account: s.name, accountId: s.id, name: k.name });
    } catch (e) {
      blockedReads.push(blocked(`list containers of storage ${s.name}`, { reason: e.message, who: 'operator with Reader on the storage account' }));
    }
  }
  const storageCount = resources.filter((r) => r.type?.toLowerCase() === 'microsoft.storage/storageaccounts').length;
  if (storageCount === 0) {
    // Positive control failed: refuse to publish any count.
    return { state: STATE.INCONCLUSIVE, reason: 'positive control failed: 0 storage accounts read across the given subscriptions, so a zero for any other type cannot be trusted', blockedReads };
  }
  const byType = {};
  for (const r of resources) {
    byType[r.type] ??= { total: 0, loomOwned: 0 };
    byType[r.type].total += 1;
    if (isLoomOwned(r)) byType[r.type].loomOwned += 1;
  }
  return {
    state: STATE.MEASURED,
    control: measured('storage accounts read (positive control)', storageCount),
    resources: resources.map(({ id, name, type, resourceGroup, location, subscriptionId, tags, sku, kind }) => ({ id, name, type, resourceGroup, location, subscriptionId, tags, sku, kind })),
    kustoDatabases,
    containers,
    byType,
    blockedReads,
  };
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[++i];
  return o;
}

if (process.argv[1]?.endsWith('governance-arm-inventory.mjs')) {
  const o = parseArgs(process.argv.slice(2));
  let subs = o.subscriptions ? o.subscriptions.split(',').filter(Boolean) : null;
  if (!subs) subs = azJson(['account', 'list', '--query', '[?state==`Enabled`].id']);
  const out = collectInventory(subs);
  const text = scrub(JSON.stringify(out, null, 2));
  if (o.out) writeFileSync(o.out, text); else console.log(text);
  if (out.state !== STATE.MEASURED) process.exit(2);
}
