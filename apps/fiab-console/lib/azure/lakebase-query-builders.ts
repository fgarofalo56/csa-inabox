/**
 * Lakebase / PostgreSQL query builders (DBX-4).
 *
 * PURE, side-effect-free SQL construction for the Lakebase editor's non-Monaco
 * actions — the pgvector enablement + a hybrid vector-distance search demo the
 * acceptance criteria call for. The free-text Query tool sends caller-authored
 * SQL verbatim (the pg-dialect Monaco surface, exactly like the T-SQL editor);
 * everything Loom itself CONSTRUCTS goes through these builders so identifiers
 * are dialect-quoted via `quoteIdent('postgres')` and any string literal
 * delegates to `escapeSqlLiteral` — never inline `.replace` (RULE A / CodeQL).
 *
 * The vector value is bound as a real parameter (`$1`) rather than interpolated,
 * so the search builder never string-concatenates client data at all.
 *
 * Cloud-invariant — no host/endpoint knowledge here.
 */

import { quoteIdent } from '@/lib/sql/quoting';

/**
 * pgvector distance operators (source grammar:
 * https://github.com/pgvector/pgvector#querying). Cosine distance is the
 * default for semantic search; L2 and inner-product are the alternatives.
 * A closed set — the editor picks from a dropdown (no-freeform-config).
 */
export type VectorDistance = 'cosine' | 'l2' | 'inner_product';

const DISTANCE_OP: Record<VectorDistance, string> = {
  cosine: '<=>',
  l2: '<->',
  inner_product: '<#>',
};

/** The three distance metrics as selectable options for the editor dropdown. */
export const VECTOR_DISTANCE_OPTIONS: ReadonlyArray<{ value: VectorDistance; label: string }> = [
  { value: 'cosine', label: 'Cosine distance (<=>)' },
  { value: 'l2', label: 'Euclidean / L2 (<->)' },
  { value: 'inner_product', label: 'Negative inner product (<#>)' },
];

/**
 * A pgvector extension name allowlist. Azure Database for PostgreSQL Flexible
 * Server gates CREATE EXTENSION behind the `azure.extensions` server parameter;
 * `vector` (pgvector) is the one this feature enables. Kept as an explicit set
 * so the enablement path can never be pointed at an arbitrary extension name.
 */
export const PGVECTOR_EXTENSION = 'vector';

/** ARM `azure.extensions` allowlist value (upper-cased token PostgreSQL expects). */
export const PGVECTOR_ALLOWLIST_TOKEN = 'VECTOR';

/**
 * Build `CREATE EXTENSION IF NOT EXISTS "vector"`. The extension identifier is
 * dialect-quoted; only the fixed pgvector name is accepted.
 */
export function buildCreateExtensionSql(ext: string = PGVECTOR_EXTENSION): string {
  if (ext !== PGVECTOR_EXTENSION) {
    throw new Error(`Only the '${PGVECTOR_EXTENSION}' extension is supported by this action`);
  }
  return `CREATE EXTENSION IF NOT EXISTS ${quoteIdent(ext, 'postgres')}`;
}

export interface VectorSearchSpec {
  /** Schema-qualified? optional schema, defaults to none (search_path resolves). */
  schema?: string;
  /** Table to search — a resolver-whitelisted real object name. */
  table: string;
  /** The vector column (pgvector `vector` type). */
  vectorColumn: string;
  /** Distance metric (dropdown-selected). */
  distance: VectorDistance;
  /** Row cap (1..1000). */
  limit: number;
  /** Optional extra columns to project (besides the distance). Identifier list. */
  selectColumns?: string[];
}

export interface BuiltVectorQuery {
  /** Parameterized SQL (the query vector binds to `$1`). */
  sql: string;
  /** Distance operator chosen (for display / assertions). */
  operator: string;
}

/**
 * Build a parameterized kNN vector-distance query:
 *
 *   SELECT <cols>, "<vecCol>" <op> $1 AS distance
 *   FROM   "<schema>"."<table>"
 *   ORDER  BY "<vecCol>" <op> $1
 *   LIMIT  <n>
 *
 * The query vector is bound as `$1` (a pgvector text literal like '[0.1,0.2]'),
 * so no client value is interpolated. Every identifier is postgres-quoted.
 */
export function buildVectorSearchSql(spec: VectorSearchSpec): BuiltVectorQuery {
  const op = DISTANCE_OP[spec.distance];
  if (!op) throw new Error(`Unknown vector distance metric: ${spec.distance}`);
  const limit = clampLimit(spec.limit);
  const vecCol = quoteIdent(spec.vectorColumn, 'postgres');
  const rel = spec.schema
    ? `${quoteIdent(spec.schema, 'postgres')}.${quoteIdent(spec.table, 'postgres')}`
    : quoteIdent(spec.table, 'postgres');

  const projected = (spec.selectColumns && spec.selectColumns.length)
    ? spec.selectColumns.map((c) => quoteIdent(c, 'postgres')).join(', ') + ', '
    : '';

  const sql =
    `SELECT ${projected}${vecCol} ${op} $1 AS distance\n` +
    `FROM ${rel}\n` +
    `ORDER BY ${vecCol} ${op} $1\n` +
    `LIMIT ${limit}`;
  return { sql, operator: op };
}

/** Clamp a requested row cap into [1, 1000]; non-finite → 10. */
export function clampLimit(n: number): number {
  if (!Number.isFinite(n)) return 10;
  return Math.min(1000, Math.max(1, Math.trunc(n)));
}

/**
 * Format a numeric embedding as the pgvector text form `[a,b,c]` for binding to
 * `$1`. Rejects non-finite entries so a malformed embedding never reaches the
 * driver as `NaN`/`Infinity`.
 */
export function toVectorLiteral(values: readonly number[]): string {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('vector must be a non-empty array of numbers');
  }
  for (const v of values) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error('vector entries must be finite numbers');
    }
  }
  return `[${values.join(',')}]`;
}
