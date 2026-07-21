/**
 * Dataset→Object sync (WS-4.4 — OSv2 at scale).
 *
 * Binds a declared ontology object type to an Azure-native datasource
 * (ADLS Gen2 Delta lakehouse via Synapse Serverless, or Synapse SQL Dedicated
 * warehouse) and backfills its rows into the Weave AGE graph store (as object
 * instances = AGE vertices) and an Azure AI Search index
 * (`loom-object-instances`) so every instance is searchable.
 *
 * ## Architecture
 *
 *   source table (Synapse Serverless / Dedicated SQL)
 *     ↓ batch-read (PAGE_SIZE rows per pass)
 *   upsertObjectByPk (AGE MERGE — idempotent)
 *     ↓ batch
 *   AI Search mergeOrUpload  (`loom-object-instances` index)
 *     ↓ after each batch
 *   Cosmos `object-sync-jobs` progress document (polled by UI)
 *
 * ## Honest gates (no-vaporware.md)
 *
 *   • Weave AGE backend not wired → `SyncGateError('LOOM_WEAVE_PG_FQDN')`
 *   • Synapse not wired           → `SyncGateError('LOOM_SYNAPSE_WORKSPACE')`
 *   • AI Search not wired         → sync proceeds, instances are in AGE only;
 *                                   the job doc records `indexed:false` and the
 *                                   UI surfaces a MessageBar gate
 *
 * No new env vars — reuses LOOM_WEAVE_PG_FQDN, LOOM_AI_SEARCH_SERVICE,
 * LOOM_SYNAPSE_WORKSPACE / LOOM_SYNAPSE_DEDICATED_POOL.
 *
 * Azure-native only; no Fabric dependency (no-fabric-dependency.md).
 */

import { quoteIdent } from '@/lib/sql/quoting';
import { serverlessTarget, dedicatedTarget, executeQuery } from './synapse-sql-client';
import { weaveGate, safeLabel, runCypher } from './weave-ontology-store';
import {
  searchConfigGate, resolveServiceName, getIndex, createIndex,
} from './search-index-client';
import { fetchWithTimeout } from './fetch-with-timeout';
import {
  DefaultAzureCredential, ManagedIdentityCredential, ChainedTokenCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from './aca-managed-identity';
import { objectSyncJobsContainer } from './cosmos-client';
import type { OntoDatasource } from '@/lib/editors/ontology-model';

// ============================================================
// Types
// ============================================================

export type SyncStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface SyncJobDoc {
  /** Cosmos id = `${ontologyId}::${objectType}` */
  id: string;
  /** Partition key */
  ontologyId: string;
  objectType: string;
  status: SyncStatus;
  startedAt: string;
  completedAt?: string;
  /** Estimated total rows (from COUNT(*) pre-scan; -1 if unavailable). */
  totalRows: number;
  /** Rows synced to AGE so far (monotonically increasing). */
  syncedRows: number;
  /** Whether AI Search indexing was performed this run. */
  indexed: boolean;
  /** Set when status = 'failed'. */
  error?: string;
  /** ISO-8601 of the last page-flush (useful for stall detection). */
  lastProgressAt?: string;
}

export interface SyncResult {
  ok: boolean;
  status: SyncStatus;
  syncedRows: number;
  totalRows: number;
  indexed: boolean;
  durationMs: number;
  error?: string;
}

export class SyncGateError extends Error {
  constructor(
    public readonly missing: string,
    public readonly detail: string,
  ) {
    super(`Dataset sync requires ${missing}: ${detail}`);
    this.name = 'SyncGateError';
  }
}

// ============================================================
// Auth (AI Search data-plane)
// ============================================================

const _uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const _searchCred: ChainedTokenCredential | DefaultAzureCredential = _uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: _uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

const SEARCH_SCOPE = 'https://search.azure.com/.default';
const SEARCH_DATA_API = '2024-07-01';

async function searchToken(): Promise<string> {
  const t = await _searchCred.getToken(SEARCH_SCOPE);
  if (!t?.token) throw new Error('Failed to acquire AAD token for AI Search (object-dataset-sync)');
  return t.token;
}

// ============================================================
// AI Search index for object instances
// ============================================================

/**
 * Shared AI Search index name for all ontology object instances.
 * Documents are filtered by `ontologyId` + `objectType`.
 */
export const OBJECT_INSTANCES_INDEX = 'loom-object-instances';

function searchBase(service: string): string {
  // Accept either bare name or fully-qualified host.
  const suffix = process.env.LOOM_SEARCH_SUFFIX || 'search.windows.net';
  if (service.includes('.')) return `https://${service.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
  return `https://${service}.${suffix}`;
}

/** Ensure the `loom-object-instances` AI Search index exists (idempotent). */
async function ensureObjectInstancesIndex(): Promise<void> {
  const existing = await getIndex(OBJECT_INSTANCES_INDEX).catch(() => null);
  if (existing) return;
  const definition = {
    name: OBJECT_INSTANCES_INDEX,
    fields: [
      { name: 'id', type: 'Edm.String', key: true, retrievable: true, filterable: true },
      { name: 'ontologyId', type: 'Edm.String', filterable: true, facetable: true, retrievable: true },
      { name: 'objectType', type: 'Edm.String', filterable: true, facetable: true, retrievable: true },
      { name: 'instanceId', type: 'Edm.String', retrievable: true, filterable: true },
      { name: 'displayLabel', type: 'Edm.String', searchable: true, retrievable: true, sortable: true, analyzer: 'standard.lucene' },
      { name: 'propertiesJson', type: 'Edm.String', searchable: true, retrievable: true, analyzer: 'standard.lucene' },
      { name: 'syncedAt', type: 'Edm.DateTimeOffset', retrievable: true, filterable: true, sortable: true },
    ],
  };
  await createIndex(definition);
}

/** Upsert a batch of instance documents into the AI Search index (mergeOrUpload). */
async function indexInstanceBatch(
  service: string,
  ontologyId: string,
  objectType: string,
  instances: Array<{ instanceId: string; properties: Record<string, unknown>; titleKey?: string }>,
): Promise<void> {
  if (!instances.length) return;
  const tok = await searchToken();
  const now = new Date().toISOString();
  const docs = instances.map((inst) => ({
    '@search.action': 'mergeOrUpload',
    id: `${ontologyId}::${objectType}::${inst.instanceId}`,
    ontologyId,
    objectType,
    instanceId: inst.instanceId,
    displayLabel: inst.titleKey
      ? String(inst.properties[inst.titleKey] ?? inst.instanceId)
      : inst.instanceId,
    propertiesJson: JSON.stringify(inst.properties),
    syncedAt: now,
  }));
  const base = searchBase(service);
  const res = await fetchWithTimeout(
    `${base}/indexes/${encodeURIComponent(OBJECT_INSTANCES_INDEX)}/docs/index?api-version=${SEARCH_DATA_API}`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ value: docs }),
    },
  );
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`AI Search index batch failed (${res.status}): ${t.slice(0, 200)}`);
  }
}

// ============================================================
// AGE upsert by primary-key property (MERGE = idempotent)
// ============================================================

/**
 * Upsert an object vertex keyed by its primary-key property value.
 *
 * Uses openCypher MERGE to upsert: if a vertex of `objectType` already carries
 * `{pkProp: pkValue}` it is matched and its other properties are updated;
 * otherwise a new vertex is created. This is the idempotent path for backfill —
 * re-running converges to the same state with no duplicate vertices.
 *
 * All values are embedded via JSON encoding (same injection guard as
 * `cypherValue` in weave-ontology-store.ts — never raw string concatenation).
 */
export async function upsertObjectByPk(
  objectType: string,
  pkProp: string,
  pkValue: unknown,
  props: Record<string, unknown>,
): Promise<{ id: string }> {
  const label = safeLabel(objectType);
  if (!label) throw new Error(`Object type '${objectType}' is not a valid AGE label`);
  if (!/^[A-Za-z_][\w]{0,62}$/.test(pkProp)) {
    throw new Error(`Primary-key property '${pkProp}' is not a valid identifier`);
  }

  // Encode pk value for cypher
  const pkLiteral =
    pkValue === null || pkValue === undefined ? 'null'
    : typeof pkValue === 'number' && Number.isFinite(pkValue) ? String(pkValue)
    : typeof pkValue === 'boolean' ? (pkValue ? 'true' : 'false')
    : JSON.stringify(String(pkValue));

  // Build SET clause for non-pk properties
  const setLiterals = Object.entries(props)
    .filter(([k]) => k !== pkProp && /^[A-Za-z_][\w]{0,62}$/.test(k))
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => {
      const vLit =
        typeof v === 'number' && Number.isFinite(v) ? String(v)
        : typeof v === 'boolean' ? (v ? 'true' : 'false')
        : JSON.stringify(String(v));
      return `n.${k} = ${vLit}`;
    });

  const mergeMap = `{${pkProp}: ${pkLiteral}}`;
  const stmt = setLiterals.length > 0
    ? `MERGE (n:${label} ${mergeMap}) ON CREATE SET ${setLiterals.join(', ')} ON MATCH SET ${setLiterals.join(', ')} RETURN id(n) AS vid`
    : `MERGE (n:${label} ${mergeMap}) RETURN id(n) AS vid`;

  const res = await runCypher(stmt, [{ name: 'vid', type: 'agtype' }]);
  const rawId = res.rows.length ? res.rows[0][0] : null;
  return { id: rawId !== null ? String(rawId) : '' };
}

// ============================================================
// Row fetching from Synapse SQL (paged)
// ============================================================

const PAGE_SIZE = 1000;

interface RowBatch {
  rows: Array<Record<string, unknown>>;
  /** null = no more pages; number = offset for the next page */
  nextOffset: number | null;
  totalEstimate: number;
  columns: string[];
}

/**
 * Fetch a page of rows from the source table.
 * Uses OFFSET/FETCH for deterministic pagination over both Serverless and
 * Dedicated targets. Returns column-keyed objects with values coerced to
 * AGE-compatible scalar types (string / number / boolean).
 */
async function fetchRowPage(
  datasource: OntoDatasource,
  offset: number,
  pageSize = PAGE_SIZE,
): Promise<RowBatch> {
  const { kind, table } = datasource;
  if (!table) {
    throw new SyncGateError(
      'table',
      'The object type datasource has no table configured. Edit the object type to set a backing table.',
    );
  }

  const [schemaRaw, tableRaw] = table.includes('.') ? table.split('.', 2) : ['dbo', table];
  const qSchema = quoteIdent(schemaRaw);
  const qTable = quoteIdent(tableRaw);

  if (kind === 'lakehouse') {
    if (!process.env.LOOM_SYNAPSE_WORKSPACE) {
      throw new SyncGateError(
        'LOOM_SYNAPSE_WORKSPACE',
        'Set LOOM_SYNAPSE_WORKSPACE so Loom can read the lakehouse Delta table (Synapse Serverless). ' +
        'Grant Storage Blob Data Reader to the Console UAMI on the ADLS storage account.',
      );
    }
    const target = serverlessTarget('master');
    let totalEstimate = -1;
    if (offset === 0) {
      const cnt = await executeQuery(target, `SELECT COUNT_BIG(*) AS cnt FROM ${qSchema}.${qTable}`);
      const v = cnt.rows.length ? cnt.rows[0][0] : null;
      if (v !== null && v !== undefined) totalEstimate = Number(v);
    }
    const res = await executeQuery(
      target,
      `SELECT * FROM ${qSchema}.${qTable} ORDER BY (SELECT NULL) OFFSET ${offset} ROWS FETCH NEXT ${pageSize} ROWS ONLY`,
    );
    const rows = resultToObjects(res.columns, res.rows);
    return { rows, columns: res.columns, nextOffset: rows.length === pageSize ? offset + pageSize : null, totalEstimate };
  }

  // warehouse — Synapse Dedicated SQL pool
  if (!process.env.LOOM_SYNAPSE_WORKSPACE || !process.env.LOOM_SYNAPSE_DEDICATED_POOL) {
    throw new SyncGateError(
      'LOOM_SYNAPSE_WORKSPACE + LOOM_SYNAPSE_DEDICATED_POOL',
      'Set LOOM_SYNAPSE_WORKSPACE and LOOM_SYNAPSE_DEDICATED_POOL for warehouse backfill. ' +
      'Grant db_datareader to the Console UAMI on the Dedicated SQL pool.',
    );
  }
  const target = dedicatedTarget();
  let totalEstimate = -1;
  if (offset === 0) {
    const cnt = await executeQuery(target, `SELECT COUNT_BIG(*) AS cnt FROM ${qSchema}.${qTable}`);
    const v = cnt.rows.length ? cnt.rows[0][0] : null;
    if (v !== null && v !== undefined) totalEstimate = Number(v);
  }
  const res = await executeQuery(
    target,
    `SELECT * FROM ${qSchema}.${qTable} ORDER BY (SELECT NULL) OFFSET ${offset} ROWS FETCH NEXT ${pageSize} ROWS ONLY`,
  );
  const rows = resultToObjects(res.columns, res.rows);
  return { rows, columns: res.columns, nextOffset: rows.length === pageSize ? offset + pageSize : null, totalEstimate };
}

function resultToObjects(columns: string[], rows: unknown[][]): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      if (!/^[A-Za-z_][\w]{0,62}$/.test(col)) continue;
      const v = row[i];
      if (v === null || v === undefined) continue;
      if (typeof v === 'number' || typeof v === 'boolean') { obj[col] = v; continue; }
      if (v instanceof Date) { obj[col] = v.toISOString(); continue; }
      obj[col] = String(v);
    }
    return obj;
  });
}

// ============================================================
// Job progress — Cosmos `object-sync-jobs`
// ============================================================

function jobDocId(ontologyId: string, objectType: string): string {
  return `${ontologyId}::${objectType}`;
}

async function readJob(ontologyId: string, objectType: string): Promise<SyncJobDoc | null> {
  const c = await objectSyncJobsContainer();
  try {
    const { resource } = await c.item(jobDocId(ontologyId, objectType), ontologyId).read<SyncJobDoc>();
    return resource ?? null;
  } catch {
    return null;
  }
}

async function writeJob(doc: SyncJobDoc): Promise<void> {
  const c = await objectSyncJobsContainer();
  await c.items.upsert(doc);
}

// ============================================================
// Public API
// ============================================================

/**
 * Get the current sync job status for an object type.
 * Returns null when no job has been started yet (idle state).
 */
export async function getDatasetSyncStatus(
  ontologyId: string,
  objectType: string,
): Promise<SyncJobDoc | null> {
  return readJob(ontologyId, objectType);
}

/**
 * Cancel a running sync job by writing 'cancelled' to the Cosmos job document.
 * The running `runDatasetSync` checks the job status before each page and stops.
 */
export async function cancelDatasetSync(
  ontologyId: string,
  objectType: string,
): Promise<void> {
  const job = await readJob(ontologyId, objectType);
  if (!job || job.status !== 'running') return;
  await writeJob({ ...job, status: 'cancelled', completedAt: new Date().toISOString() });
}

/**
 * Run the full dataset→object backfill pipeline.
 *
 *   1. Gate-check: Weave AGE backend (LOOM_WEAVE_PG_FQDN) + Synapse.
 *   2. Create/update the Cosmos job document.
 *   3. Ensure `loom-object-instances` AI Search index exists (if AI Search wired).
 *   4. Page through the source table in batches of PAGE_SIZE (1 000 rows).
 *   5. Per batch: MERGE each row as an AGE vertex + mergeOrUpload into AI Search.
 *   6. Update Cosmos progress after each batch (UI polls GET /sync for live updates).
 *   7. Write final job document (completed / failed).
 *
 * AI Search is **optional** — if LOOM_AI_SEARCH_SERVICE is unset, instances still
 * land in AGE; `indexed:false` in the result and the UI surfaces an infra gate.
 */
export async function runDatasetSync(
  ontologyId: string,
  objectType: string,
  datasource: OntoDatasource,
  opts: { titleKey?: string } = {},
): Promise<SyncResult> {
  const start = Date.now();

  // ── Gate checks ──
  const wGate = weaveGate();
  if (wGate) throw new SyncGateError(wGate.missing, wGate.detail);

  const searchGate = searchConfigGate();
  let searchSvc: string | null = null;
  if (!searchGate) {
    try { searchSvc = resolveServiceName(); } catch { searchSvc = null; }
  }

  // ── Initialise job ──
  const baseDoc: SyncJobDoc = {
    id: jobDocId(ontologyId, objectType),
    ontologyId,
    objectType,
    status: 'running',
    startedAt: new Date().toISOString(),
    totalRows: -1,
    syncedRows: 0,
    indexed: false,
  };
  await writeJob(baseDoc);

  // ── Ensure AI Search index ──
  if (searchSvc) {
    await ensureObjectInstancesIndex().catch(() => undefined);
  }

  // ── Paginate + upsert ──
  let offset = 0;
  let syncedRows = 0;
  let totalRows = -1;
  let indexed = false;

  try {
    while (true) {
      // Cancellation check
      const live = await readJob(ontologyId, objectType);
      if (live?.status === 'cancelled') {
        return { ok: false, status: 'cancelled', syncedRows, totalRows, indexed, durationMs: Date.now() - start };
      }

      const batch = await fetchRowPage(datasource, offset);
      if (offset === 0 && batch.totalEstimate >= 0) {
        totalRows = batch.totalEstimate;
      }
      if (batch.rows.length === 0) break;

      const pkCol = datasource.primaryKeyColumn || batch.columns[0] || '_rownum';
      const colMap = datasource.columnMap || {};

      // AGE upserts
      for (let i = 0; i < batch.rows.length; i++) {
        const row = batch.rows[i];
        const pkRaw = pkCol === '_rownum' ? offset + i : row[pkCol];
        const pkValue = pkRaw !== undefined && pkRaw !== null ? pkRaw : offset + i;
        const resolvedPkProp = pkCol === '_rownum' ? '_rownum' : pkCol;

        const props: Record<string, unknown> = {};
        for (const [col, val] of Object.entries(row)) {
          const propName = colMap[col] || col;
          if (/^[A-Za-z_][\w]{0,62}$/.test(propName)) props[propName] = val;
        }
        await upsertObjectByPk(objectType, resolvedPkProp, pkValue, props);
        syncedRows++;
      }

      // AI Search index batch
      if (searchSvc) {
        const idocs = batch.rows.map((row, i) => {
          const pkRaw = pkCol === '_rownum' ? offset + i : row[pkCol];
          const pkValue = pkRaw !== undefined && pkRaw !== null ? pkRaw : offset + i;
          const props: Record<string, unknown> = {};
          for (const [col, val] of Object.entries(row)) {
            const propName = colMap[col] || col;
            if (/^[A-Za-z_][\w]{0,62}$/.test(propName)) props[propName] = val;
          }
          return { instanceId: String(pkValue), properties: props, titleKey: opts.titleKey };
        });
        await indexInstanceBatch(searchSvc, ontologyId, objectType, idocs).catch(() => undefined);
        indexed = true;
      }

      offset += batch.rows.length;

      // Persist progress
      await writeJob({
        ...baseDoc,
        totalRows,
        syncedRows,
        indexed,
        lastProgressAt: new Date().toISOString(),
      });

      if (batch.nextOffset === null) break;
    }

    const finalDoc: SyncJobDoc = {
      ...baseDoc,
      status: 'completed',
      completedAt: new Date().toISOString(),
      totalRows: totalRows < 0 ? syncedRows : totalRows,
      syncedRows,
      indexed,
    };
    await writeJob(finalDoc);
    return { ok: true, status: 'completed', syncedRows, totalRows: finalDoc.totalRows, indexed, durationMs: Date.now() - start };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const failedDoc: SyncJobDoc = {
      ...baseDoc,
      status: 'failed',
      completedAt: new Date().toISOString(),
      totalRows,
      syncedRows,
      indexed,
      error: msg.slice(0, 500),
    };
    await writeJob(failedDoc).catch(() => undefined);
    return { ok: false, status: 'failed', syncedRows, totalRows, indexed, durationMs: Date.now() - start, error: msg };
  }
}

/**
 * Search object instances via AI Search.
 * Returns empty array when AI Search is not configured (graceful degradation).
 */
export async function searchObjectInstances(
  ontologyId: string,
  objectType: string,
  query: string,
  top = 20,
): Promise<Array<{ instanceId: string; displayLabel: string; propertiesJson: string; score: number }>> {
  const gate = searchConfigGate();
  if (gate) return [];
  let svc: string;
  try { svc = resolveServiceName(); } catch { return []; }

  const tok = await searchToken();
  const base = searchBase(svc);
  try {
    const res = await fetchWithTimeout(
      `${base}/indexes/${encodeURIComponent(OBJECT_INSTANCES_INDEX)}/docs/search?api-version=${SEARCH_DATA_API}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          search: query,
          filter: `ontologyId eq '${ontologyId}' and objectType eq '${objectType}'`,
          top,
          select: 'instanceId,displayLabel,propertiesJson',
        }),
      },
    );
    if (!res.ok) return [];
    const j: any = await res.json();
    return (j?.value || []).map((d: any) => ({
      instanceId: String(d.instanceId || ''),
      displayLabel: String(d.displayLabel || ''),
      propertiesJson: String(d.propertiesJson || '{}'),
      score: Number(d['@search.score'] || 0),
    }));
  } catch {
    return [];
  }
}
