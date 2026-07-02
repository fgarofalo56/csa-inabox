/**
 * pgvector vector-store backend — REAL index create + kNN over Azure Database
 * for PostgreSQL Flexible Server with the `vector` (pgvector) extension.
 *
 * No vaporware (per .claude/rules/no-vaporware.md): every call runs against the
 * real PostgreSQL wire protocol via the shared executePostgresBatch() helper in
 * postgres-flex-client.ts (Entra-token auth, no stored password). There is no
 * mock — the create/query PATH is genuine PostgreSQL SQL:
 *
 *   create  → CREATE EXTENSION IF NOT EXISTS vector;
 *             CREATE TABLE IF NOT EXISTS "<t>" (id text PK, content text,
 *                                               metadata jsonb, embedding vector(<dim>));
 *             CREATE INDEX … USING hnsw (embedding <opclass>)   (skipped for exact/exhaustive)
 *   search  → SELECT … ORDER BY embedding <op> $1::vector LIMIT k     (real kNN)
 *   upload  → INSERT … ON CONFLICT (id) DO UPDATE                     (real upsert)
 *   schema  → pg_attribute + format_type()                           (live columns)
 *
 * Honest infra-gate (allowed by no-vaporware.md): pgVectorGate() names the exact
 * env var / one-time setup when the connection isn't wired:
 *   - LOOM_PGVECTOR_HOST         the flexible-server FQDN that hosts the store
 *   - LOOM_PGVECTOR_DATABASE     database name (default "postgres")
 *   - LOOM_POSTGRES_AAD_USER     the Entra principal the Console UAMI is
 *                                registered under in PostgreSQL (shared with the
 *                                Postgres editor; see postgresQueryGate()).
 * The server must also have the `vector` extension allow-listed via the
 * `azure.extensions` server parameter — if it isn't, CREATE EXTENSION returns a
 * precise PostgreSQL error which the route surfaces verbatim (still real, not a
 * mock).
 */

import {
  executePostgresBatch,
  postgresQueryGate,
  PostgresError,
} from '@/lib/azure/postgres-flex-client';

/** The vector column every Loom pgvector table uses (matches the editor default). */
const VEC_FIELD = 'embedding';

export type VectorMetric = 'cosine' | 'euclidean' | 'dotProduct';
export type VectorAlgorithm = 'hnsw' | 'exhaustiveKnn';

const METRIC_MAP: Record<VectorMetric, { opclass: string; op: string; score: (dist: string) => string }> = {
  // cosine distance in [0,2]; similarity = 1 - distance.
  cosine: { opclass: 'vector_cosine_ops', op: '<=>', score: (d) => `1 - (${d})` },
  // L2 distance in [0,∞); higher score = closer, so negate.
  euclidean: { opclass: 'vector_l2_ops', op: '<->', score: (d) => `-(${d})` },
  // pgvector `<#>` returns the NEGATIVE inner product; negate to get the dot product.
  dotProduct: { opclass: 'vector_ip_ops', op: '<#>', score: (d) => `-(${d})` },
};

export interface PgVectorGate { missing: string; hint: string }

/** Returns a gate object when the pgvector backend isn't wired, else null. */
export function pgVectorGate(): PgVectorGate | null {
  const host = pgHost();
  if (!host) {
    return {
      missing: 'LOOM_PGVECTOR_HOST',
      hint:
        'Set LOOM_PGVECTOR_HOST to the fully-qualified name of the Azure Database for ' +
        'PostgreSQL flexible server that hosts the vector store ' +
        '(e.g. myserver.postgres.database.azure.com), and optionally LOOM_PGVECTOR_DATABASE ' +
        '(default "postgres"). The server must have the `vector` extension allow-listed via ' +
        'the `azure.extensions` server parameter.',
    };
  }
  const aad = postgresQueryGate();
  if (aad) return { missing: aad.missing, hint: aad.detail };
  return null;
}

function pgHost(): string {
  return process.env.LOOM_PGVECTOR_HOST || process.env.LOOM_POSTGRES_HOST || '';
}
function pgDatabase(): string {
  return process.env.LOOM_PGVECTOR_DATABASE || 'postgres';
}

/** Validate a table/index identifier (letters, digits, dash, underscore). */
function assertIdent(name: string): string {
  const n = (name || '').trim();
  if (!n || !/^[A-Za-z0-9_-]{1,128}$/.test(n)) {
    throw new PostgresError(`Invalid identifier "${name}". Use letters, digits, dashes and underscores (max 128).`, 400);
  }
  return n;
}
/** Double-quote a validated identifier so dashed names (e.g. docs-vec) are legal. */
function qi(name: string): string {
  return `"${assertIdent(name)}"`;
}

export interface PgVectorField { name: string; type: string; key: boolean; dimensions?: number }
export interface PgVectorSchema { name: string; fields: PgVectorField[] }

/**
 * Read the live table schema (columns + the pgvector column's dimensions).
 * Returns null when the table does not exist yet.
 */
export async function getPgVectorSchema(table: string): Promise<PgVectorSchema | null> {
  const t = assertIdent(table);
  const res = await executePostgresBatch(pgHost(), pgDatabase(), [{
    sql:
      'SELECT a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS data_type, ' +
      "  COALESCE((a.attnum = ANY((SELECT conkey FROM pg_constraint " +
      "    WHERE conrelid = c.oid AND contype = 'p'))), false) AS is_key " +
      'FROM pg_attribute a ' +
      'JOIN pg_class c ON c.oid = a.attrelid ' +
      'JOIN pg_namespace n ON n.oid = c.relnamespace ' +
      'WHERE c.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped ' +
      'ORDER BY a.attnum',
    params: [t],
  }]);
  const rows = res[0]?.rows || [];
  if (rows.length === 0) return null;
  const cols = res[0].columns;
  const iName = cols.indexOf('column_name');
  const iType = cols.indexOf('data_type');
  const iKey = cols.indexOf('is_key');
  const fields: PgVectorField[] = rows.map((r) => {
    const type = String(r[iType] ?? '');
    const dimMatch = /vector\((\d+)\)/i.exec(type);
    return {
      name: String(r[iName] ?? ''),
      type,
      key: r[iKey] === true || r[iKey] === 't',
      dimensions: dimMatch ? Number(dimMatch[1]) : undefined,
    };
  });
  return { name: t, fields };
}

/**
 * Create (idempotently) the pgvector extension, the store table, and the ANN
 * index. Returns the resulting live schema. `exhaustiveKnn` skips the index so
 * search runs an exact brute-force scan.
 */
export async function createPgVectorIndex(opts: {
  table: string;
  dim: number;
  metric: VectorMetric;
  algorithm: VectorAlgorithm;
}): Promise<PgVectorSchema | null> {
  const t = qi(opts.table);
  const dim = Math.max(1, Math.floor(opts.dim));
  const m = METRIC_MAP[opts.metric] || METRIC_MAP.cosine;
  const stmts = [
    { sql: 'CREATE EXTENSION IF NOT EXISTS vector' },
    { sql: `CREATE TABLE IF NOT EXISTS ${t} (id text PRIMARY KEY, content text, metadata jsonb, ${VEC_FIELD} vector(${dim}))` },
  ];
  if (opts.algorithm !== 'exhaustiveKnn') {
    const idxName = qi(`${assertIdent(opts.table)}_emb_idx`);
    stmts.push({ sql: `CREATE INDEX IF NOT EXISTS ${idxName} ON ${t} USING hnsw (${VEC_FIELD} ${m.opclass})` });
  }
  await executePostgresBatch(pgHost(), pgDatabase(), stmts);
  return getPgVectorSchema(opts.table);
}

/** Upsert documents ({ id, content, embedding:number[], …metadata }) — real INSERT … ON CONFLICT. */
export async function upsertPgVectorDocs(opts: {
  table: string;
  documents: Array<Record<string, any>>;
}): Promise<{ uploaded: number; results: Array<{ key: string; status: boolean }> }> {
  const t = qi(opts.table);
  const stmts = opts.documents.map((doc) => {
    const emb = Array.isArray(doc.embedding) ? doc.embedding.map(Number) : [];
    const vecLit = `[${emb.join(',')}]`;
    const meta: Record<string, any> = { ...doc };
    delete meta.id; delete meta.content; delete meta.embedding;
    return {
      sql:
        `INSERT INTO ${t} (id, content, metadata, ${VEC_FIELD}) VALUES ($1, $2, $3::jsonb, $4::vector) ` +
        `ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, metadata = EXCLUDED.metadata, ${VEC_FIELD} = EXCLUDED.${VEC_FIELD}`,
      params: [
        String(doc.id ?? ''),
        doc.content != null ? String(doc.content) : null,
        JSON.stringify(meta),
        vecLit,
      ],
    };
  });
  if (stmts.length === 0) return { uploaded: 0, results: [] };
  await executePostgresBatch(pgHost(), pgDatabase(), stmts);
  return {
    uploaded: stmts.length,
    results: opts.documents.map((d) => ({ key: String(d.id ?? ''), status: true })),
  };
}

/** Real kNN search — ORDER BY embedding <op> $1::vector LIMIT k. Returns AI-Search-shaped rows. */
export async function pgVectorSearch(opts: {
  table: string;
  vector: number[];
  k: number;
  metric: VectorMetric;
}): Promise<{ value: Array<Record<string, any>> }> {
  const t = qi(opts.table);
  const m = METRIC_MAP[opts.metric] || METRIC_MAP.cosine;
  const vecLit = `[${(opts.vector || []).map(Number).join(',')}]`;
  const k = Math.max(1, Math.min(Math.floor(opts.k) || 5, 1000));
  const distExpr = `${VEC_FIELD} ${m.op} $1::vector`;
  const sql =
    `SELECT id, content, metadata, (${distExpr}) AS distance, (${m.score(distExpr)}) AS score ` +
    `FROM ${t} ORDER BY ${distExpr} LIMIT ${k}`;
  const res = await executePostgresBatch(pgHost(), pgDatabase(), [{ sql, params: [vecLit] }]);
  const r0 = res[0];
  const cols = r0?.columns || [];
  const value = (r0?.rows || []).map((row) => {
    const o: Record<string, any> = {};
    cols.forEach((c, i) => { o[c] = row[i]; });
    const score = typeof o.score === 'number' ? o.score : Number(o.score);
    o['@search.score'] = Number.isFinite(score) ? score : null;
    return o;
  });
  return { value };
}
