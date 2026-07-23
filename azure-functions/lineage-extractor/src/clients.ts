/**
 * lineage-extractor — Azure IO (loom-next-level WS-L, L3).
 *
 * Managed-identity (DefaultAzureCredential) only — no keys, no mocks
 * (no-vaporware). This module does the real IO the pure extract.ts core cannot:
 *   - list COMPLETED ADF / Synapse pipeline runs since a Cosmos-persisted
 *     watermark,
 *   - GET each run's pipeline definition + the datasets its Copy activities
 *     reference,
 *   - resolve each dataset → the Loom item it maps to (annotation-stamped
 *     `loomItemId` first — Loom-authored pipelines stamp it — else a physical
 *     endpoint match against the Cosmos `items` container),
 *   - UPSERT the derived ThreadEdge rows (deterministic id ⇒ idempotent),
 *   - advance the watermark.
 *
 * Runs as an in-VNet Container App Job (Schedule trigger) — NOT a Y1 Function
 * (this estate's Linux Consumption plan cannot reach its own AAD-only storage
 * data-plane; the ACA-job pattern is the estate standard, per
 * synthetic-monitor-job.bicep).
 */
import { DefaultAzureCredential } from '@azure/identity';
import { CosmosClient, type Container } from '@azure/cosmos';
import type { DatasetEndpoint, LineageEdgeInput } from './extract';
import { edgeId } from './extract';

const cred = new DefaultAzureCredential();

/** Reserved partition for the extractor's own watermark doc in `thread-edges`
 *  (never a real Entra oid, so it can never surface in a tenant's lineage). */
const WATERMARK_TENANT = '__lineage_extractor__';
const WATERMARK_ID = 'lineage-extractor:watermark';

function cosmos(): CosmosClient {
  const endpoint = process.env.LOOM_COSMOS_ENDPOINT;
  if (!endpoint) throw new Error('LOOM_COSMOS_ENDPOINT not set');
  return new CosmosClient({ endpoint, aadCredentials: cred });
}
function db() {
  return cosmos().database(process.env.LOOM_COSMOS_DATABASE || 'loom');
}
export function threadEdgesContainer(): Container { return db().container('thread-edges'); }
export function itemsContainer(): Container { return db().container('items'); }

/** Bearer token for a resource (ARM / Synapse dev endpoint). */
async function tokenFor(resource: string): Promise<string> {
  const t = await cred.getToken(`${resource.replace(/\/$/, '')}/.default`);
  if (!t?.token) throw new Error(`no token for ${resource}`);
  return t.token;
}

const ARM = (process.env.LOOM_ARM_ENDPOINT || 'https://management.azure.com').replace(/\/$/, '');
const ADF_API = '2018-06-01';

// ── Watermark (Cosmos-persisted; also the run de-dupe high-water) ────────────

export interface Watermark { lastRunEnd: string; processedRunIds: string[] }

export async function readWatermark(): Promise<Watermark> {
  try {
    const { resource } = await threadEdgesContainer().item(WATERMARK_ID, WATERMARK_TENANT).read<any>();
    if (resource) {
      return {
        lastRunEnd: resource.lastRunEnd || new Date(Date.now() - 3600_000).toISOString(),
        processedRunIds: Array.isArray(resource.processedRunIds) ? resource.processedRunIds : [],
      };
    }
  } catch { /* first run — no watermark yet */ }
  // Default lookback: 1h (the cron cadence is 15m; overlap is idempotent).
  return { lastRunEnd: new Date(Date.now() - 3600_000).toISOString(), processedRunIds: [] };
}

export async function writeWatermark(w: Watermark): Promise<void> {
  // Keep only the most recent 2000 run ids as an anti-double-process cache.
  const processedRunIds = w.processedRunIds.slice(-2000);
  await threadEdgesContainer().items.upsert({
    id: WATERMARK_ID,
    tenantId: WATERMARK_TENANT,
    lastRunEnd: w.lastRunEnd,
    processedRunIds,
    updatedAt: new Date().toISOString(),
  });
}

// ── ADF / Synapse run + artifact reads ──────────────────────────────────────

export interface PipelineRun { runId: string; pipelineName: string; status: string; runEnd?: string }

interface RunSource { kind: 'adf' | 'synapse'; base: string; token: string }

/** Build the configured ADF and/or Synapse run sources (whichever is set). */
export async function runSources(): Promise<RunSource[]> {
  const sources: RunSource[] = [];
  const sub = process.env.LOOM_ADF_SUB || process.env.LOOM_SUBSCRIPTION_ID;
  const rg = process.env.LOOM_ADF_RG || process.env.LOOM_DLZ_RG;
  const adf = process.env.LOOM_ADF_NAME || process.env.LOOM_ADF_FACTORY;
  if (sub && rg && adf) {
    sources.push({
      kind: 'adf',
      base: `${ARM}/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.DataFactory/factories/${adf}`,
      token: await tokenFor(ARM),
    });
  }
  const synapse = process.env.LOOM_SYNAPSE_WORKSPACE;
  if (synapse) {
    const suffix = process.env.LOOM_SYNAPSE_DEV_SUFFIX || 'dev.azuresynapse.net';
    const devBase = `https://${synapse}.${suffix}`;
    sources.push({ kind: 'synapse', base: devBase, token: await tokenFor(devBase) });
  }
  return sources;
}

async function armPost(url: string, token: string, body: unknown): Promise<any> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST ${url} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
async function armGet(url: string, token: string): Promise<any> {
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

/** List Succeeded pipeline runs that ended after `sinceIso` for one source. */
export async function listCompletedRuns(src: RunSource, sinceIso: string): Promise<PipelineRun[]> {
  const nowIso = new Date().toISOString();
  const url = src.kind === 'adf'
    ? `${src.base}/queryPipelineRuns?api-version=${ADF_API}`
    : `${src.base}/queryPipelineRuns?api-version=2020-12-01`;
  const body = {
    lastUpdatedAfter: sinceIso,
    lastUpdatedBefore: nowIso,
    filters: [{ operand: 'Status', operator: 'Equals', values: ['Succeeded'] }],
  };
  const res = await armPost(url, src.token, body);
  const runs: PipelineRun[] = [];
  for (const v of res?.value || []) {
    if (v?.runId && v?.pipelineName) {
      runs.push({ runId: v.runId, pipelineName: v.pipelineName, status: v.status, runEnd: v.runEnd || v.lastUpdated });
    }
  }
  return runs;
}

export async function getPipelineDef(src: RunSource, pipelineName: string): Promise<any> {
  const url = src.kind === 'adf'
    ? `${src.base}/pipelines/${encodeURIComponent(pipelineName)}?api-version=${ADF_API}`
    : `${src.base}/pipelines/${encodeURIComponent(pipelineName)}?api-version=2020-12-01`;
  return armGet(url, src.token);
}

export async function getDatasetDef(src: RunSource, datasetName: string): Promise<any> {
  const url = src.kind === 'adf'
    ? `${src.base}/datasets/${encodeURIComponent(datasetName)}?api-version=${ADF_API}`
    : `${src.base}/datasets/${encodeURIComponent(datasetName)}?api-version=2020-12-01`;
  return armGet(url, src.token);
}

// ── Dataset → Loom item resolution ───────────────────────────────────────────

/** Extract a physical endpoint key + column list from a dataset definition.
 *  Loom-authored datasets carry an `annotations: ['loomItemId:<id>']` stamp we
 *  honor first; else we build a best-effort endpoint match key. */
export function datasetMatchKeys(datasetDef: any): { loomItemId?: string; endpointKeys: string[]; columns: string[] } {
  const props = datasetDef?.properties || {};
  const annotations: string[] = Array.isArray(props.annotations) ? props.annotations : [];
  const stamp = annotations.map(String).find((a) => a.startsWith('loomItemId:'));
  const loomItemId = stamp ? stamp.slice('loomItemId:'.length).trim() : undefined;

  const endpointKeys: string[] = [];
  const tp = props.typeProperties || {};
  // SQL table datasets: schema.table.
  const schema = typeof tp.schema === 'string' ? tp.schema : tp.schema?.value;
  const table = typeof tp.table === 'string' ? tp.table : (tp.tableName || tp.table?.value);
  if (table) endpointKeys.push(`table:${(schema ? `${schema}.` : '')}${table}`.toLowerCase());
  // ADLS/Blob location: fileSystem + folderPath (+ fileName).
  const loc = tp.location || {};
  const fs = loc.fileSystem || loc.container;
  const folder = loc.folderPath;
  if (fs || folder) endpointKeys.push(`path:${[fs, folder].filter(Boolean).join('/')}`.toLowerCase());

  // Column names from the dataset `structure` (used for the derived by-name map).
  const columns: string[] = [];
  const structure = props.structure;
  if (Array.isArray(structure)) {
    for (const c of structure) { const n = c?.name; if (typeof n === 'string' && n.trim()) columns.push(n.trim()); }
  }
  return { loomItemId, endpointKeys, columns };
}

/** Resolve one dataset → its Loom item endpoint (annotation first, then a
 *  physical-endpoint query against `items`). Returns {} (unresolved) honestly. */
export async function resolveDataset(src: RunSource, datasetName: string): Promise<DatasetEndpoint> {
  let def: any;
  try { def = await getDatasetDef(src, datasetName); } catch { return {}; }
  const { loomItemId, endpointKeys, columns } = datasetMatchKeys(def);

  if (loomItemId) {
    const item = await readItem(loomItemId);
    if (item) return { itemId: item.id, itemType: item.type, itemName: item.name, tenantId: item.tenantId, columns };
  }
  for (const key of endpointKeys) {
    const item = await findItemByEndpointKey(key);
    if (item) return { itemId: item.id, itemType: item.type, itemName: item.name, tenantId: item.tenantId, columns };
  }
  return { columns };
}

interface LoomItem { id: string; type?: string; name?: string; tenantId?: string }

async function readItem(id: string): Promise<LoomItem | undefined> {
  const { resources } = await itemsContainer().items
    .query<LoomItem>({ query: 'SELECT c.id, c.type, c.name, c.tenantId FROM c WHERE c.id = @id', parameters: [{ name: '@id', value: id }] })
    .fetchAll();
  return resources?.[0];
}

/** Match an item whose stored endpoint key (state.lineageEndpointKey, an array
 *  Loom stamps on provision) contains `key`. Honest empty when none match. */
async function findItemByEndpointKey(key: string): Promise<LoomItem | undefined> {
  const { resources } = await itemsContainer().items
    .query<LoomItem>({
      query: 'SELECT c.id, c.type, c.name, c.tenantId FROM c WHERE ARRAY_CONTAINS(c.state.lineageEndpointKeys, @k)',
      parameters: [{ name: '@k', value: key }],
    })
    .fetchAll();
  return resources?.[0];
}

// ── Edge persistence ─────────────────────────────────────────────────────────

/** UPSERT a derived lineage edge as a ThreadEdge (idempotent by deterministic
 *  id). Best-effort — one bad edge never blocks the batch. */
export async function upsertLineageEdge(e: LineageEdgeInput): Promise<void> {
  const id = edgeId(e);
  const now = new Date().toISOString();
  const doc: Record<string, unknown> = {
    id,
    tenantId: e.tenantId,
    fromItemId: e.fromItemId,
    fromType: e.fromType,
    fromName: e.fromName,
    toItemId: e.toItemId,
    toType: e.toType,
    toName: e.toName,
    action: e.action,
    createdAt: now,
    createdBy: 'lineage-extractor',
    derivedFrom: e.pipelineName ? { pipelineName: e.pipelineName, runId: e.runId } : undefined,
    ...(e.columnMappings?.length ? { columnMappings: e.columnMappings } : {}),
  };
  await threadEdgesContainer().items.upsert(doc);
}
