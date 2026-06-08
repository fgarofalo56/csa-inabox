/**
 * labelPropagation — timer-triggered Azure Function (F15).
 *
 * Every N minutes (LABEL_PROPAGATION_CRON, default every 15 min) this Function:
 *   1. reads the Loom workspaces + items from the shared Cosmos `loom` database,
 *   2. rebuilds the lineage edge graph from typed state references (identical
 *      to apps/fiab-console/app/api/governance/lineage/route.ts),
 *   3. computes the most-restrictive sensitivity label each item should inherit
 *      from its upstream sources (computePropagation), and
 *   4. upserts one row per item into the `label-propagation` container so the
 *      Console lineage view can render the real, last-computed propagation state.
 *
 * Auth: the Function App's identity (system-assigned by default; set
 * AZURE_CLIENT_ID to use a user-assigned identity). It must hold the Cosmos DB
 * Built-in Data Contributor role at the account — granted by
 * scripts/csa-loom/grant-navigator-rbac.sh during post-deploy bootstrap.
 *
 * No Microsoft Fabric dependency: operates purely on the Loom Cosmos store.
 */
import { app, InvocationContext, Timer } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';
import { DefaultAzureCredential, ManagedIdentityCredential, ChainedTokenCredential } from '@azure/identity';
import { computePropagation } from '../propagation-core';

const REFERENCE_KEYS = [
  'lakehouseId', 'warehouseId', 'datasetId', 'datasourceId',
  'sourceItemId', 'targetItemId', 'sourceLakehouseId', 'sourceWarehouseId',
  'reportId', 'modelId', 'kqlDatabaseId', 'pipelineId',
];

let _client: CosmosClient | null = null;
function cosmos(): CosmosClient {
  if (_client) return _client;
  const endpoint = process.env.LOOM_COSMOS_ENDPOINT;
  if (!endpoint) throw new Error('LOOM_COSMOS_ENDPOINT not set');
  const clientId = process.env.AZURE_CLIENT_ID || process.env.LOOM_UAMI_CLIENT_ID;
  const chain: any[] = [];
  if (clientId) chain.push(new ManagedIdentityCredential({ clientId }));
  chain.push(new DefaultAzureCredential());
  _client = new CosmosClient({ endpoint, aadCredentials: new ChainedTokenCredential(...chain) });
  return _client;
}

interface ItemDoc {
  id: string;
  workspaceId: string;
  itemType: string;
  displayName: string;
  state?: Record<string, unknown>;
}

/** Core run logic — exported so it can be invoked/tested outside the trigger. */
export async function runPropagation(context: InvocationContext): Promise<{ tenants: number; items: number; written: number }> {
  const dbId = process.env.LOOM_COSMOS_DATABASE || 'loom';
  const db = cosmos().database(dbId);
  const wsC = db.container('workspaces');
  const itC = db.container('items');
  const propC = db.container('label-propagation');

  // Workspaces grouped by tenant (PK /tenantId).
  const { resources: workspaces } = await wsC.items
    .query<{ id: string; tenantId: string }>('SELECT c.id, c.tenantId FROM c')
    .fetchAll();
  const wsTenant = new Map<string, string>();
  const tenantWs = new Map<string, Set<string>>();
  for (const w of workspaces) {
    wsTenant.set(w.id, w.tenantId);
    if (!tenantWs.has(w.tenantId)) tenantWs.set(w.tenantId, new Set());
    tenantWs.get(w.tenantId)!.add(w.id);
  }

  const { resources: items } = await itC.items
    .query<ItemDoc>('SELECT c.id, c.workspaceId, c.itemType, c.displayName, c.state FROM c')
    .fetchAll();

  const runAt = new Date().toISOString();
  let written = 0;

  for (const [tenantId, wsIds] of tenantWs.entries()) {
    const tenantItems = items.filter((i) => wsIds.has(i.workspaceId));
    if (tenantItems.length === 0) continue;
    const nodeIds = new Set(tenantItems.map((i) => i.id));

    const edges: Array<{ from: string; to: string }> = [];
    for (const it of tenantItems) {
      const st = (it.state || {}) as Record<string, unknown>;
      for (const k of REFERENCE_KEYS) {
        const v = st[k];
        if (typeof v === 'string' && v && nodeIds.has(v) && v !== it.id) edges.push({ from: v, to: it.id });
      }
      const attached = st.attachedSources as Array<{ id?: string }> | undefined;
      if (Array.isArray(attached)) for (const a of attached) if (a?.id && nodeIds.has(a.id) && a.id !== it.id) edges.push({ from: a.id, to: it.id });
    }

    const records = computePropagation(
      tenantItems.map((i) => ({ id: i.id, sensitivity: (i.state as any)?.sensitivityLabel })),
      edges,
    );
    const typeById = new Map(tenantItems.map((i) => [i.id, i.itemType]));
    const nameById = new Map(tenantItems.map((i) => [i.id, i.displayName]));

    for (const rec of records) {
      await propC.items.upsert({
        id: `prop:${rec.itemId}`,
        tenantId,
        itemId: rec.itemId,
        itemType: typeById.get(rec.itemId),
        displayName: nameById.get(rec.itemId),
        currentLabel: rec.currentLabel,
        expectedLabel: rec.expectedLabel,
        status: rec.status,
        upstream: rec.upstream,
        runAt,
      });
      written++;
    }
  }

  context.log(`label-propagation: ${tenantWs.size} tenants, ${items.length} items, ${written} rows written at ${runAt}`);
  return { tenants: tenantWs.size, items: items.length, written };
}

app.timer('labelPropagation', {
  // Default: every 15 minutes. Override via LABEL_PROPAGATION_CRON app setting
  // (NCRONTAB, 6-field: sec min hour day month day-of-week).
  schedule: process.env.LABEL_PROPAGATION_CRON || '0 */15 * * * *',
  runOnStartup: false,
  handler: async (_timer: Timer, context: InvocationContext) => {
    try {
      await runPropagation(context);
    } catch (e: any) {
      context.error(`label-propagation failed: ${e?.message || e}`);
      throw e;
    }
  },
});
