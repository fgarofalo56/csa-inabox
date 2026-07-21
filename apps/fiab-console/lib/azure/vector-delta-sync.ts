/**
 * vector-delta-sync — WS-2.2: Delta-synced, auto-indexed vector search
 * (Databricks Vector Search "Delta Sync Index" parity, Azure-native).
 *
 * Instead of hand-uploading document JSON, a vector-store binds to a SOURCE
 * Delta table (a lakehouse / Unity-Catalog Delta folder on ADLS Gen2). A sync
 * job then:
 *
 *   1. READS the Delta table via Synapse Serverless `OPENROWSET(FORMAT='DELTA')`
 *      — the same no-Fabric-dependency reader the lakehouse preview uses. The
 *      Serverless DELTA reader auto-discovers `_delta_log` and returns the
 *      latest committed version, so every sync sees current data.
 *   2. DIFFS the current rows against the last sync using a stable KEY column +
 *      a content HASH per row — reusing the WS-G corpus-manifest pattern
 *      (`loom-docs-index.ts`). New/changed rows are re-embedded; unchanged rows
 *      are skipped; rows that vanished from the source are deleted from the
 *      index. This is an INCREMENTAL sync — no full re-population.
 *   3. EMBEDS the changed rows' content with the real Azure OpenAI embeddings
 *      data-plane (`aoaiEmbed`) and UPSERTS them into the Azure AI Search vector
 *      index (`mergeOrUpload`). Removed keys are `delete`d.
 *   4. PERSISTS the per-row hash manifest in Cosmos, keyed by the owning
 *      vector-store item, so the next sync diffs against it.
 *
 * Correctness vs a full rebuild: for the changed set the upserted docs are
 * byte-identical to what a full rebuild would upload (same key, same content,
 * same embedding for the same content), unchanged rows keep their existing index
 * docs, and removed rows are deleted — so an incremental sync converges to the
 * exact index a full rebuild produces, at a fraction of the embedding cost.
 *
 * No Fabric dependency: source is plain ADLS Gen2 Delta, reader is Synapse
 * Serverless, index is Azure AI Search, embeddings are Azure OpenAI — all work
 * with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset. Honest gates (per no-vaporware)
 * name the exact env var when a backend isn't wired.
 */

import crypto from 'node:crypto';
import { parseDeltaSource, toHttps } from './delta-source-uri';
import { escapeSqlLiteral, bracket } from '@/lib/sql/quoting';
import { serverlessTarget, executeQuery } from './synapse-sql-client';
import { aoaiEmbed } from './aoai-chat-client';
import {
  getIndex, uploadDocuments, deleteDocuments,
} from './foundry-client';
import { vectorSyncManifestsContainer } from './cosmos-client';

// ---------- Types ----------

export interface DeltaSyncSource {
  /** abfss:// or https:// URI of the source Delta table root (contains _delta_log). */
  deltaUri: string;
  /** Column whose value is the stable document key (primary key of the row). */
  keyColumn: string;
  /** Column(s) concatenated into the embedded/searchable content. */
  contentColumns: string[];
  /** Row cap for a single sync pass (1..50000, default 5000). */
  maxRows?: number;
  /** Embeddings deployment override (defaults to LOOM_AOAI_EMBED_DEPLOYMENT). */
  embedDeployment?: string;
}

/** Per-row index state persisted in the manifest: content hash only (the key is
 *  the map key; chunk ids are the key itself, so no id list is stored). */
export type RowHashMap = Record<string, string>;

export interface SyncManifest {
  /** Cosmos doc id = the index name. */
  id: string;
  /** Cosmos partition key = the owning vector-store item id. */
  itemId: string;
  backend: 'ai-search';
  deltaUri: string;
  keyColumn: string;
  contentColumns: string[];
  vectorField: string;
  contentField: string;
  builtAt: string;
  rowCount: number;
  rows: RowHashMap;
}

export interface RowDiff {
  /** Keys that are new or whose content hash changed → re-embed + upsert. */
  changedKeys: string[];
  /** Keys present last sync but gone now → delete from the index. */
  removedKeys: string[];
  /** Count of keys whose hash is unchanged → skipped. */
  unchanged: number;
}

export interface DeltaSyncResult {
  ok: boolean;
  mode: 'full' | 'incremental';
  /** Rows re-embedded + upserted this pass (new + changed). */
  synced: number;
  /** Rows skipped because their content hash was unchanged. */
  skipped: number;
  /** Rows deleted from the index because they left the source. */
  removed: number;
  /** Total rows read from the source Delta table. */
  sourceRows: number;
  deltaUri: string;
  indexName: string;
  executionMs: number;
}

// ---------- Pure helpers (unit-tested) ----------

/** Stable content hash (sha256 hex, first 32 chars) for a row's content. */
export function hashRowContent(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex').slice(0, 32);
}

/** Concatenate the chosen content columns of a row into one embedded string.
 *  Null/undefined cells become '' so a row's hash is stable across syncs. */
export function rowContent(row: Record<string, unknown>, contentColumns: string[]): string {
  return contentColumns.map((c) => {
    const v = row[c];
    return v === null || v === undefined ? '' : String(v);
  }).join('\n');
}

/** A safe T-SQL column identifier: letters/digits/underscore/space/dot/dash only.
 *  Rejects anything that could break out of the bracket-quote (defence-in-depth
 *  on top of {@link bracket}). */
export function isSafeColumn(name: string): boolean {
  return /^[A-Za-z0-9_ .\-]{1,128}$/.test(name);
}

/**
 * Build the Serverless OPENROWSET SELECT that reads the key + content columns of
 * a Delta table. Column names are validated ({@link isSafeColumn}) and
 * bracket-quoted; the BULK URL's single quotes are doubled. `maxRows` is an
 * integer clamped by the caller and inlined as `TOP n`.
 */
export function buildDeltaSelectSql(httpsUrl: string, keyColumn: string, contentColumns: string[], maxRows: number): string {
  const cols = [keyColumn, ...contentColumns];
  for (const c of cols) {
    if (!isSafeColumn(c)) throw new Error(`Unsafe column name "${c}" — use letters, digits, underscore, space, dot or dash only.`);
  }
  // De-dupe while preserving order (key may also be a content column).
  const seen = new Set<string>();
  const selectList = cols.filter((c) => (seen.has(c) ? false : (seen.add(c), true)))
    .map((c) => `r.${bracket(c)}`)
    .join(', ');
  const safeUrl = escapeSqlLiteral(httpsUrl);
  const n = Math.min(Math.max(1, Math.floor(maxRows) || 1), 50_000);
  return `SELECT TOP ${n} ${selectList}\nFROM OPENROWSET(\n  BULK '${safeUrl}',\n  FORMAT = 'DELTA'\n) AS r;`;
}

/**
 * Pure diff of the previous per-row hash map vs the current one. Determines the
 * minimal upsert (new + changed) + delete (removed) set the incremental sync
 * applies. Deterministic; independent of any backend.
 */
export function diffRows(prev: RowHashMap, next: RowHashMap): RowDiff {
  const changedKeys: string[] = [];
  const removedKeys: string[] = [];
  let unchanged = 0;
  for (const [k, h] of Object.entries(next)) {
    const before = prev[k];
    if (before === undefined || before !== h) changedKeys.push(k);
    else unchanged += 1;
  }
  for (const k of Object.keys(prev)) {
    if (!(k in next)) removedKeys.push(k);
  }
  return { changedKeys, removedKeys, unchanged };
}

// ---------- Manifest persistence (Cosmos) ----------

async function loadManifest(itemId: string, indexName: string): Promise<SyncManifest | null> {
  try {
    const c = await vectorSyncManifestsContainer();
    const r = await c.item(indexName, itemId).read<SyncManifest>().catch(() => ({ resource: null }));
    return (r.resource as SyncManifest) || null;
  } catch {
    return null;
  }
}

async function saveManifest(manifest: SyncManifest): Promise<void> {
  const c = await vectorSyncManifestsContainer();
  await c.items.upsert(manifest);
}

/** Read the persisted binding/status for a vector-store's Delta sync (or null
 *  when never synced) — powers the editor's status panel. */
export async function getSyncStatus(itemId: string, indexName: string): Promise<{
  bound: boolean;
  deltaUri?: string; keyColumn?: string; contentColumns?: string[];
  builtAt?: string; rowCount?: number;
} | null> {
  const m = await loadManifest(itemId, indexName);
  if (!m) return { bound: false };
  return {
    bound: true,
    deltaUri: m.deltaUri, keyColumn: m.keyColumn, contentColumns: m.contentColumns,
    builtAt: m.builtAt, rowCount: m.rowCount,
  };
}

// ---------- Orchestration ----------

const EMBED_BATCH = 64;

/** Honest, var-named errors carry a `hint` the route turns into a 503 gate. */
export class SyncGateError extends Error {
  hint: string;
  constructor(message: string, hint: string) { super(message); this.name = 'SyncGateError'; this.hint = hint; }
}

/**
 * Run one incremental Delta→vector sync into the AI Search index `indexName`,
 * owned by vector-store item `itemId`. Reads the source Delta table, diffs
 * against the last manifest, re-embeds + upserts changed rows, deletes removed
 * rows, and persists the new manifest. Throws {@link SyncGateError} for honest
 * infra gates (Serverless / AI Search / embeddings not wired) — the caller
 * surfaces a 503 + hint; the full UI still renders.
 */
export async function syncDeltaToVectorIndex(
  itemId: string,
  indexName: string,
  source: DeltaSyncSource,
  opts: { contentField?: string; vectorField?: string } = {},
): Promise<DeltaSyncResult> {
  const started = Date.now();
  const contentField = opts.contentField || 'content';
  const vectorField = opts.vectorField || 'embedding';

  // 1. Resolve + validate the Delta source URI (abfss/https on ADLS Gen2).
  const ref = parseDeltaSource(source.deltaUri);
  if (!ref) {
    throw new SyncGateError(
      `"${source.deltaUri}" is not a recognisable ADLS Gen2 Delta path.`,
      'Provide the Delta table ROOT as abfss://<container>@<account>.dfs.<suffix>/<path> ' +
      'or https://<account>.dfs.<suffix>/<container>/<path> (the folder containing _delta_log).',
    );
  }
  if (!source.keyColumn) throw new SyncGateError('No key column selected.', 'Pick the column that uniquely identifies each row.');
  if (!source.contentColumns?.length) throw new SyncGateError('No content columns selected.', 'Pick one or more columns to embed + search over.');
  const httpsUrl = toHttps(ref);

  // 2. Read the source Delta rows via Synapse Serverless OPENROWSET (no Fabric).
  const sql = buildDeltaSelectSql(httpsUrl, source.keyColumn, source.contentColumns, source.maxRows ?? 5000);
  let read;
  try {
    read = await executeQuery(serverlessTarget('master'), sql, 90_000);
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (/Missing env var: LOOM_SYNAPSE_WORKSPACE/i.test(msg)) {
      throw new SyncGateError(
        'Synapse Serverless is not configured, so the source Delta table cannot be read.',
        'Set LOOM_SYNAPSE_WORKSPACE and grant the Synapse Serverless managed identity ' +
        '"Storage Blob Data Reader" on the source storage account. ' +
        'See platform/fiab/bicep/modules/data-plane/synapse.bicep.',
      );
    }
    throw e;
  }

  // Map result rows (arrays parallel to columns) to keyed content.
  const keyIdx = read.columns.indexOf(source.keyColumn);
  if (keyIdx < 0) {
    throw new SyncGateError(
      `Key column "${source.keyColumn}" not found in the Delta table.`,
      `Available columns: ${read.columns.join(', ') || '(none)'}.`,
    );
  }
  const nextRows: RowHashMap = {};
  const contentByKey = new Map<string, string>();
  for (const row of read.rows) {
    const rec: Record<string, unknown> = {};
    read.columns.forEach((c, i) => { rec[c] = row[i]; });
    const keyVal = rec[source.keyColumn];
    if (keyVal === null || keyVal === undefined) continue; // skip null-key rows
    const key = String(keyVal);
    const content = rowContent(rec, source.contentColumns);
    nextRows[key] = hashRowContent(content);
    contentByKey.set(key, content);
  }

  // 3. Diff against the last manifest.
  const prev = await loadManifest(itemId, indexName);
  const diff = diffRows(prev?.rows || {}, nextRows);
  const mode: 'full' | 'incremental' = prev ? 'incremental' : 'full';

  // 4. Embed changed rows (real AOAI) + upsert into the AI Search index.
  //    Validate the embedding width matches the live index's vector field so a
  //    dim mismatch surfaces honestly instead of a silent 400 on upload.
  if (diff.changedKeys.length > 0) {
    let liveIndex: any = null;
    try { liveIndex = await getIndex(indexName); }
    catch (e: any) {
      if ((e as any)?.name === 'NotDeployedError') {
        throw new SyncGateError((e as any).message, (e as any).hint || 'Set LOOM_AI_SEARCH_SERVICE and grant the Console UAMI Search Index Data Contributor.');
      }
      throw e;
    }
    if (!liveIndex) {
      throw new SyncGateError(
        `Vector index "${indexName}" does not exist yet.`,
        'Create the index on the Index schema tab first (its dimensions must match your embedding model), then sync.',
      );
    }
    const vf = (liveIndex.fields || []).find((f: any) => f.name === vectorField);
    const indexDim = vf?.dimensions;

    const docs: any[] = [];
    for (let i = 0; i < diff.changedKeys.length; i += EMBED_BATCH) {
      const batchKeys = diff.changedKeys.slice(i, i + EMBED_BATCH);
      const inputs = batchKeys.map((k) => contentByKey.get(k) || '');
      let embedded;
      try {
        embedded = await aoaiEmbed({ input: inputs, deployment: source.embedDeployment });
      } catch (e: any) {
        const msg = String(e?.message || e);
        if (/NoAoaiDeployment|embeddings deployment|not configured|not found/i.test(msg)) {
          throw new SyncGateError(
            'Azure OpenAI embeddings are not configured, so rows cannot be embedded.',
            'Deploy a text-embedding model on the Foundry hub and set LOOM_AOAI_EMBED_DEPLOYMENT ' +
            '(its output dimension must match the index vector field).',
          );
        }
        throw e;
      }
      const vectors = embedded.vectors || [];
      if (typeof indexDim === 'number' && vectors[0] && vectors[0].length !== indexDim) {
        throw new SyncGateError(
          `Embedding width ${vectors[0].length} does not match index "${indexName}" vector field dimensions ${indexDim}.`,
          `Recreate the index with ${vectors[0].length} dimensions, or set LOOM_AOAI_EMBED_DEPLOYMENT to a model that outputs ${indexDim}-dim vectors.`,
        );
      }
      batchKeys.forEach((k, j) => {
        docs.push({ id: k, [contentField]: contentByKey.get(k) || '', [vectorField]: vectors[j] || [] });
      });
    }
    await uploadDocuments(indexName, docs);
  }

  // 5. Delete rows that left the source.
  if (diff.removedKeys.length > 0) {
    await deleteDocuments(indexName, diff.removedKeys, 'id');
  }

  // 6. Persist the new manifest.
  const manifest: SyncManifest = {
    id: indexName, itemId, backend: 'ai-search',
    deltaUri: source.deltaUri, keyColumn: source.keyColumn, contentColumns: source.contentColumns,
    vectorField, contentField,
    builtAt: new Date().toISOString(),
    rowCount: Object.keys(nextRows).length,
    rows: nextRows,
  };
  await saveManifest(manifest);

  return {
    ok: true, mode,
    synced: diff.changedKeys.length,
    skipped: diff.unchanged,
    removed: diff.removedKeys.length,
    sourceRows: Object.keys(nextRows).length,
    deltaUri: source.deltaUri, indexName,
    executionMs: Date.now() - started,
  };
}
