/**
 * Cosmos DB for MongoDB (vCore) vector-store backend — REAL vector index create
 * + kNN over the MongoDB wire protocol using the integrated `cosmosSearch`
 * vector index. Grounded in Microsoft Learn:
 *   https://learn.microsoft.com/azure/documentdb/vector-search
 *
 * No vaporware (per .claude/rules/no-vaporware.md): every call opens a real
 * MongoClient against the vCore cluster and runs genuine commands — there is no
 * mock. The create/query PATH is:
 *
 *   create → db.command({ createIndexes, indexes: [{ key: { embedding: 'cosmosSearch' },
 *              cosmosSearchOptions: { kind: 'vector-hnsw'|'vector-ivf', similarity, dimensions } }] })
 *   search → collection.aggregate([{ $search: { cosmosSearch: { vector, path, k } } },
 *              { $project: { score: { $meta: 'searchScore' }, document: '$$ROOT' } }])
 *   upload → collection.bulkWrite([{ replaceOne: { …, upsert: true } }])   (real upsert)
 *   schema → collection.listIndexes()                                     (live indexes)
 *
 * Driver: the official `mongodb` npm driver, loaded via a runtime-computed,
 * webpack-ignored dynamic import (same pattern as eventhubs-data-client.ts's
 * @azure/event-hubs) so the Next.js build never hard-resolves it. When the
 * driver is present the create/query calls run live; when it isn't, loadMongo()
 * throws CosmosVcoreDriverError — an honest dependency gate naming the exact
 * one-time step to enable it (add "mongodb" to apps/fiab-console/package.json
 * dependencies + serverExternalPackages in next.config.mjs, then redeploy). It
 * never fabricates a result.
 *
 * Honest infra-gate (allowed by no-vaporware.md): cosmosVcoreGate() names the
 * exact env var when the connection isn't wired:
 *   - LOOM_COSMOS_VCORE_CONNECTION_STRING   the vCore cluster connection string
 *                                           (Portal → cluster → Connection strings).
 *                                           Store via Key Vault reference, never in source.
 *   - LOOM_COSMOS_VCORE_DATABASE            database name (default "loomvectors").
 */

/** The document path every Loom vCore collection stores the embedding under. */
const VEC_PATH = 'embedding';

export type VcoreMetric = 'cosine' | 'euclidean' | 'dotProduct';
export type VcoreAlgorithm = 'hnsw' | 'exhaustiveKnn';

/** Cosmos vCore `similarity` codes (COS = cosine, L2 = euclidean, IP = inner/dot product). */
const SIM_MAP: Record<VcoreMetric, 'COS' | 'L2' | 'IP'> = {
  cosine: 'COS',
  euclidean: 'L2',
  dotProduct: 'IP',
};

export class CosmosVcoreError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = 'CosmosVcoreError';
    this.status = status;
  }
}

/** Thrown when the `mongodb` driver isn't installed in the running image. */
export class CosmosVcoreDriverError extends Error {
  status = 503;
  hint =
    'The `mongodb` npm driver is not installed in this Console image. One-time step: add ' +
    '"mongodb" to apps/fiab-console/package.json dependencies and to serverExternalPackages in ' +
    'next.config.mjs, run pnpm install, and redeploy — then the Cosmos vCore vector backend ' +
    'runs live (create index + $search k-NN). Or use the ai-search / pgvector backend, which ' +
    'ship live in this build.';
  constructor() {
    super('Cosmos DB for MongoDB (vCore) driver not available');
    this.name = 'CosmosVcoreDriverError';
  }
}

export interface CosmosVcoreGate { missing: string; hint: string }

/** Returns a gate object when the vCore backend isn't wired, else null. */
export function cosmosVcoreGate(): CosmosVcoreGate | null {
  if (!process.env.LOOM_COSMOS_VCORE_CONNECTION_STRING) {
    return {
      missing: 'LOOM_COSMOS_VCORE_CONNECTION_STRING',
      hint:
        'Set LOOM_COSMOS_VCORE_CONNECTION_STRING to the Cosmos DB for MongoDB (vCore) ' +
        'connection string (Portal → your vCore cluster → Connection strings), and optionally ' +
        'LOOM_COSMOS_VCORE_DATABASE (default "loomvectors"). Store the secret as a Key Vault ' +
        'reference on the Console Container App — never in source.',
    };
  }
  return null;
}

/**
 * Load the `mongodb` driver via a runtime-computed, webpack-ignored dynamic
 * import so `next build` never tries to resolve it at build time (mirrors the
 * eventhubs-data-client.ts @azure/event-hubs pattern). Throws
 * CosmosVcoreDriverError when the package isn't installed.
 */
async function loadMongo(): Promise<any> {
  const pkg = ['mongo', 'db'].join('');
  try {
    return await import(/* webpackIgnore: true */ /* @vite-ignore */ pkg);
  } catch {
    throw new CosmosVcoreDriverError();
  }
}

/** Open a request-scoped MongoClient, run `fn` against the store database, always close. */
async function withDb<T>(fn: (db: any) => Promise<T>): Promise<T> {
  const conn = process.env.LOOM_COSMOS_VCORE_CONNECTION_STRING;
  if (!conn) throw new CosmosVcoreError('LOOM_COSMOS_VCORE_CONNECTION_STRING is not set.', 503);
  const mongo = await loadMongo();
  const client = new mongo.MongoClient(conn, {
    serverSelectionTimeoutMS: 15_000,
    connectTimeoutMS: 20_000,
    appName: 'csa-loom-console',
  });
  try {
    await client.connect();
    const db = client.db(process.env.LOOM_COSMOS_VCORE_DATABASE || 'loomvectors');
    return await fn(db);
  } catch (e: any) {
    if (e instanceof CosmosVcoreError || e instanceof CosmosVcoreDriverError) throw e;
    throw new CosmosVcoreError(e?.message || String(e), 502);
  } finally {
    await client.close().catch(() => { /* already closed */ });
  }
}

export interface VcoreField { name: string; type: string; key: boolean; dimensions?: number }
export interface VcoreSchema { name: string; fields: VcoreField[] }

/** Shape listIndexes() output into the AI-Search-style {name, fields[]} the editor renders. */
function shapeSchema(collection: string, indexes: any[]): VcoreSchema {
  const fields: VcoreField[] = (indexes || []).map((ix: any) => {
    const keys = Object.keys(ix?.key || {});
    const cso = ix?.cosmosSearchOptions;
    return {
      name: ix?.name || keys.join(', '),
      type: cso ? `cosmosSearch / ${cso.kind || 'vector'}` : keys.map((k) => `${k}: ${ix.key[k]}`).join(', ') || 'index',
      key: ix?.name === '_id_',
      dimensions: cso?.dimensions,
    };
  });
  return { name: collection, fields };
}

/**
 * Create (idempotently) the collection and the `cosmosSearch` vector index.
 * `hnsw` → vector-hnsw; `exhaustiveKnn` → vector-ivf with numLists=1 (brute
 * force). Returns the live index schema.
 */
export async function createVcoreVectorIndex(opts: {
  collection: string;
  dim: number;
  metric: VcoreMetric;
  algorithm: VcoreAlgorithm;
}): Promise<VcoreSchema> {
  const dimensions = Math.max(1, Math.floor(opts.dim));
  const similarity = SIM_MAP[opts.metric] || 'COS';
  const cosmosSearchOptions = opts.algorithm === 'hnsw'
    ? { kind: 'vector-hnsw', m: 16, efConstruction: 64, similarity, dimensions }
    : { kind: 'vector-ivf', numLists: 1, similarity, dimensions };
  return withDb(async (db) => {
    const existing = await db.listCollections({ name: opts.collection }).toArray();
    if (existing.length === 0) await db.createCollection(opts.collection);
    await db.command({
      createIndexes: opts.collection,
      indexes: [{
        name: `${VEC_PATH}_vec_idx`,
        key: { [VEC_PATH]: 'cosmosSearch' },
        cosmosSearchOptions,
      }],
    });
    const idx = await db.collection(opts.collection).listIndexes().toArray();
    return shapeSchema(opts.collection, idx);
  });
}

/** Live collection index schema; null when the collection doesn't exist yet. */
export async function getVcoreVectorIndex(collection: string): Promise<VcoreSchema | null> {
  return withDb(async (db) => {
    const cols = await db.listCollections({ name: collection }).toArray();
    if (cols.length === 0) return null;
    const idx = await db.collection(collection).listIndexes().toArray();
    return shapeSchema(collection, idx);
  });
}

/** Upsert documents (mergeOrUpload equivalent) — real bulkWrite replaceOne+upsert. */
export async function upsertVcoreDocs(opts: {
  collection: string;
  documents: Array<Record<string, any>>;
}): Promise<{ uploaded: number; results: Array<{ key: string; status: boolean }> }> {
  const docs = opts.documents || [];
  if (docs.length === 0) return { uploaded: 0, results: [] };
  return withDb(async (db) => {
    const ops = docs.map((d) => {
      const doc: Record<string, any> = { ...d };
      const id = d.id ?? d._id;
      if (id !== undefined) { doc._id = id; delete doc.id; }
      return { replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true } };
    });
    const r = await db.collection(opts.collection).bulkWrite(ops, { ordered: false });
    const uploaded = (r?.upsertedCount || 0) + (r?.modifiedCount || 0) + (r?.insertedCount || 0);
    return {
      uploaded,
      results: docs.map((d) => ({ key: String(d.id ?? d._id ?? ''), status: true })),
    };
  });
}

/** Real kNN via the `$search`/`cosmosSearch` aggregation. Returns AI-Search-shaped rows. */
export async function vcoreVectorSearch(opts: {
  collection: string;
  vector: number[];
  k: number;
}): Promise<{ value: Array<Record<string, any>> }> {
  const k = Math.max(1, Math.min(Math.floor(opts.k) || 5, 1000));
  return withDb(async (db) => {
    const pipeline = [
      { $search: { cosmosSearch: { vector: opts.vector, path: VEC_PATH, k } } },
      { $project: { _id: 1, content: 1, score: { $meta: 'searchScore' }, document: '$$ROOT' } },
    ];
    const rows = await db.collection(opts.collection).aggregate(pipeline).toArray();
    const value = rows.map((r: any) => {
      const doc = r?.document || {};
      const out: Record<string, any> = {
        id: r?._id != null ? String(r._id) : (doc._id != null ? String(doc._id) : ''),
        '@search.score': typeof r?.score === 'number' ? r.score : null,
      };
      // Surface scalar document fields (skip the embedding + nested objects) so
      // the results table has real columns to render.
      for (const [key, v] of Object.entries(doc)) {
        if (key === VEC_PATH || key === '_id') continue;
        if (v == null || Array.isArray(v) || typeof v === 'object') continue;
        out[key] = v;
      }
      return out;
    });
    return { value };
  });
}
