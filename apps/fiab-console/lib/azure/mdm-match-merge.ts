/**
 * Master Data Management (MDM) match-merge engine — Azure-native, self-built,
 * NO Microsoft Fabric / partner-SaaS dependency.
 *
 * Microsoft Purview MDM is partner-only (Semarchy / Profisee / Reltio /
 * CluedIn). Per no-fabric-dependency.md + no-vaporware.md, Loom ships its own
 * lightweight match-merge that runs on the workspace's OWN Databricks SQL
 * Warehouse (Spark SQL). The flow mirrors the partner pattern:
 *
 *   match  → candidate duplicate pairs scored by deterministic (exact) +
 *            probabilistic (Spark `levenshtein` / `soundex`) similarity.
 *   merge  → survivorship pass producing GOLDEN RECORDS with source lineage
 *            (`source_systems`, `source_record_count`) into a Delta table.
 *
 * Survivorship strategies (per attribute), grounded in the standard MDM
 * golden-record patterns:
 *   most-recent      → value from the row with the latest timestamp
 *   most-complete    → value from the row with the most populated attributes
 *   source-priority  → value from the highest-priority source system
 *   max / min        → numeric extreme across the cluster
 *
 * Deterministic clustering: records sharing ALL exact-match attribute values
 * form a golden cluster (a real GROUP-BY key). Fuzzy pairs are surfaced for
 * steward review (the Match candidates tab) — approving a pair is an explicit
 * stewardship action, never an automatic silent merge.
 *
 * Spark functions used (all GA on Databricks SQL):
 *   https://learn.microsoft.com/azure/databricks/sql/language-manual/functions/levenshtein
 *   https://learn.microsoft.com/azure/databricks/sql/language-manual/functions/soundex
 */

import { executeStatement, databricksConfigGate } from './databricks-client';

export type SurvivorshipStrategy = 'most-recent' | 'most-complete' | 'source-priority' | 'max' | 'min';
export type MatchType = 'exact' | 'fuzzy';

export interface MatchAttribute {
  column: string;
  matchType: MatchType;
  /** Fuzzy similarity threshold (0–100); ignored for exact. */
  threshold?: number;
}

export interface SurvivorshipRule {
  column: string;
  strategy: SurvivorshipStrategy;
}

export interface MdmModel {
  id: string;
  name: string;
  /** Business entity, e.g. "Customer" / "Product". */
  entity: string;
  /** Source table (simple name, or fully-qualified catalog.schema.table). */
  sourceTable: string;
  catalog?: string;
  schema?: string;
  /** Column uniquely identifying a record within a source system. */
  recordIdColumn: string;
  /** Column naming the source system (for lineage + source-priority survivorship). */
  sourceSystemColumn?: string;
  /** Timestamp column used by most-recent survivorship. */
  timestampColumn?: string;
  matchAttributes: MatchAttribute[];
  survivorship: SurvivorshipRule[];
  /** Source systems highest-priority first (for source-priority survivorship). */
  sourcePriority?: string[];
  /** Destination Delta table for golden records (catalog.schema.table or simple). */
  goldenTable: string;
}

export const SURVIVORSHIP_STRATEGIES: SurvivorshipStrategy[] = [
  'most-recent', 'most-complete', 'source-priority', 'max', 'min',
];
export const MATCH_TYPES: MatchType[] = ['exact', 'fuzzy'];

/** Honest gate: MDM runs on the workspace Databricks SQL Warehouse. */
export function mdmConfigGate(): { missing: string } | null {
  const g = databricksConfigGate();
  if (g) return g;
  if (!process.env.LOOM_DATABRICKS_SQL_WAREHOUSE_ID) return { missing: 'LOOM_DATABRICKS_SQL_WAREHOUSE_ID' };
  return null;
}

function warehouse(explicit?: string): string {
  const w = (explicit || process.env.LOOM_DATABRICKS_SQL_WAREHOUSE_ID || '').trim();
  if (!w) throw new Error('No Databricks SQL Warehouse — set LOOM_DATABRICKS_SQL_WAREHOUSE_ID');
  return w;
}

function safeIdent(seg: string): string {
  if (!/^[A-Za-z0-9_ $-]+$/.test(seg)) throw new Error(`Unsafe SQL identifier: "${seg}"`);
  return seg;
}
function q(name: string): string {
  return name.split('.').map((s) => `\`${safeIdent(s)}\``).join('.');
}
function sqlStr(v: string): string {
  return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
function fq(table: string, catalog?: string, schema?: string): string {
  if (table.includes('.')) return q(table);
  const parts: string[] = [];
  if (catalog) parts.push(catalog);
  if (schema) parts.push(schema);
  parts.push(table);
  return q(parts.join('.'));
}

/** Per-attribute similarity expression (0–100) between aliases `a` and `b`. */
function similarityExpr(attr: MatchAttribute): string {
  const ca = `a.${q(attr.column)}`;
  const cb = `b.${q(attr.column)}`;
  if (attr.matchType === 'exact') {
    return `(CASE WHEN ${ca} <=> ${cb} THEN 100.0 ELSE 0.0 END)`;
  }
  // Fuzzy: normalized Levenshtein similarity on the string cast.
  return `(CASE WHEN ${ca} IS NULL OR ${cb} IS NULL THEN 0.0 ELSE ` +
    `(1.0 - (levenshtein(CAST(${ca} AS STRING), CAST(${cb} AS STRING)) / ` +
    `GREATEST(LENGTH(CAST(${ca} AS STRING)), LENGTH(CAST(${cb} AS STRING)), 1))) * 100.0 END)`;
}

export interface MatchCandidate {
  idA: string;
  idB: string;
  sourceA?: string;
  sourceB?: string;
  score: number;
}

/**
 * Generate scored candidate duplicate pairs for steward review. Blocks on
 * `soundex` of the first fuzzy attribute (or exact-key equality) to bound the
 * self-join, scores by the mean per-attribute similarity, and keeps pairs at or
 * above `minScore`.
 */
export function buildMatchSql(model: MdmModel, minScore = 80, limit = 500): string {
  if (!model.matchAttributes.length) throw new Error('model has no match attributes');
  const T = fq(model.sourceTable, model.catalog, model.schema);
  const idA = `a.${q(model.recordIdColumn)}`;
  const idB = `b.${q(model.recordIdColumn)}`;
  const scoreExpr = `(${model.matchAttributes.map(similarityExpr).join(' + ')}) / ${model.matchAttributes.length}`;

  // Blocking predicate: keep the join tractable. Exact attributes must match;
  // fuzzy attributes block on equal soundex of the first fuzzy column.
  const exactAttrs = model.matchAttributes.filter((m) => m.matchType === 'exact');
  const fuzzyAttrs = model.matchAttributes.filter((m) => m.matchType === 'fuzzy');
  const blocks: string[] = [];
  for (const e of exactAttrs) blocks.push(`a.${q(e.column)} <=> b.${q(e.column)}`);
  if (fuzzyAttrs.length) {
    const f = fuzzyAttrs[0];
    blocks.push(`soundex(CAST(a.${q(f.column)} AS STRING)) = soundex(CAST(b.${q(f.column)} AS STRING))`);
  }
  const blocking = blocks.length ? `AND (${blocks.join(' OR ')})` : '';
  const srcSel = model.sourceSystemColumn
    ? `, a.${q(model.sourceSystemColumn)} AS source_a, b.${q(model.sourceSystemColumn)} AS source_b`
    : ', CAST(NULL AS STRING) AS source_a, CAST(NULL AS STRING) AS source_b';

  return `SELECT ${idA} AS id_a, ${idB} AS id_b${srcSel}, ROUND(${scoreExpr}, 1) AS score
FROM ${T} a JOIN ${T} b
  ON CAST(${idA} AS STRING) < CAST(${idB} AS STRING) ${blocking}
WHERE (${scoreExpr}) >= ${Number(minScore)}
ORDER BY score DESC
LIMIT ${Math.max(1, Math.floor(limit))}`;
}

/** Run match → scored candidate pairs (real Spark SQL on the warehouse). */
export async function runMatch(model: MdmModel, minScore = 80, warehouseId?: string): Promise<{ sql: string; candidates: MatchCandidate[] }> {
  const sql = buildMatchSql(model, minScore);
  const r = await executeStatement(warehouse(warehouseId), sql, model.catalog, model.schema);
  const idx = (n: string) => r.columns.findIndex((c) => c.toLowerCase() === n);
  const ia = idx('id_a'), ib = idx('id_b'), sa = idx('source_a'), sb = idx('source_b'), sc = idx('score');
  const candidates = r.rows.map((row) => ({
    idA: String(row[ia] ?? ''),
    idB: String(row[ib] ?? ''),
    sourceA: sa >= 0 && row[sa] != null ? String(row[sa]) : undefined,
    sourceB: sb >= 0 && row[sb] != null ? String(row[sb]) : undefined,
    score: Number(row[sc] ?? 0),
  }));
  return { sql, candidates };
}

// ---------------------------------------------------------------------------
// Steward-approved crosswalk (manual match overrides)
// ---------------------------------------------------------------------------

/**
 * A steward-approved duplicate pair. Approving a fuzzy candidate is an explicit
 * stewardship action that forces the two records into the SAME golden cluster
 * even when they don't share every exact-match attribute. Pairs are persisted
 * per model (mdm-crosswalk:<tenantId>) and unioned into the merge below.
 */
export interface CrosswalkPair {
  idA: string;
  idB: string;
  approvedBy?: string;
  approvedAt?: string;
}

/**
 * Union-find over approved pairs → a stable cluster id (the smallest member id)
 * for every record that appears in any approved pair. Records not in any pair
 * are absent (they cluster deterministically by exact attributes instead).
 */
export function clusterCrosswalk(pairs: CrosswalkPair[]): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
    // path-compress
    let c = x;
    while (parent.get(c) !== undefined && parent.get(c) !== r) { const n = parent.get(c)!; parent.set(c, r); c = n; }
    return r;
  };
  const union = (a: string, b: string) => {
    if (parent.get(a) === undefined) parent.set(a, a);
    if (parent.get(b) === undefined) parent.set(b, b);
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    // keep the lexicographically smaller id as the representative (stable)
    if (ra < rb) parent.set(rb, ra); else parent.set(ra, rb);
  };
  for (const p of pairs) {
    const a = String(p.idA), b = String(p.idB);
    if (!a || !b) continue;
    union(a, b);
  }
  const out = new Map<string, string>();
  for (const k of parent.keys()) out.set(k, find(k));
  return out;
}

/**
 * Build the inline `VALUES (record_id, cluster_gid)` crosswalk relation that the
 * golden merge LEFT JOINs to override `_gid`. Returns null when there are no
 * approved pairs. `cluster_gid` is prefixed `cw:` so it never collides with an
 * md5 deterministic cluster id.
 */
export function buildCrosswalkValues(pairs: CrosswalkPair[]): string | null {
  const clusters = clusterCrosswalk(pairs);
  if (!clusters.size) return null;
  const rows = [...clusters.entries()].map(([id, rep]) => `(${sqlStr(id)}, ${sqlStr(`cw:${rep}`)})`);
  return `(SELECT * FROM VALUES ${rows.join(', ')} AS _cw(_cw_record_id, _cw_gid))`;
}

/** Per-column survivorship select expression, windowed over the golden cluster. */
function survivorshipExpr(model: MdmModel, rule: SurvivorshipRule): string {
  const C = `s.${q(rule.column)}`;
  const part = `PARTITION BY s._gid`;
  switch (rule.strategy) {
    case 'max':
      return `MAX(${C}) OVER (${part})`;
    case 'min':
      return `MIN(${C}) OVER (${part})`;
    case 'most-recent': {
      const ts = model.timestampColumn ? `s.${q(model.timestampColumn)}` : 's._completeness';
      return `FIRST_VALUE(${C}) IGNORE NULLS OVER (${part} ORDER BY ${ts} DESC NULLS LAST)`;
    }
    case 'source-priority': {
      const order = sourcePriorityOrder(model);
      return `FIRST_VALUE(${C}) IGNORE NULLS OVER (${part} ORDER BY ${order} ASC, s._completeness DESC)`;
    }
    case 'most-complete':
    default:
      return `FIRST_VALUE(${C}) IGNORE NULLS OVER (${part} ORDER BY s._completeness DESC)`;
  }
}

/** CASE expression mapping a source system to its priority rank (lower = higher). */
function sourcePriorityOrder(model: MdmModel): string {
  if (!model.sourceSystemColumn || !model.sourcePriority?.length) return '1';
  const col = `s.${q(model.sourceSystemColumn)}`;
  const whens = model.sourcePriority.map((sys, i) => `WHEN ${col} = ${sqlStr(sys)} THEN ${i}`).join(' ');
  return `CASE ${whens} ELSE 999 END`;
}

/**
 * Build the CREATE-OR-REPLACE golden-record SQL. The cluster key is the
 * concatenation of all exact-match attribute values (deterministic survivorship
 * cluster); `_gid` is its md5. Each survivorship column is resolved by its
 * strategy via a window over the cluster, and source lineage is captured as
 * `source_systems` (array) + `source_record_count`.
 *
 * When `crosswalk` holds steward-approved pairs, those records are forced into a
 * shared cluster (`_gid` overridden via a LEFT JOIN to an inline VALUES relation)
 * so manually-confirmed fuzzy duplicates survive into one golden record.
 */
export function buildGoldenRecordSql(model: MdmModel, crosswalk: CrosswalkPair[] = []): string {
  const T = fq(model.sourceTable, model.catalog, model.schema);
  const G = fq(model.goldenTable, model.catalog, model.schema);
  const exactAttrs = model.matchAttributes.filter((m) => m.matchType === 'exact');
  if (!exactAttrs.length) {
    throw new Error('golden-record merge needs at least one exact match attribute to form a deterministic cluster');
  }
  const clusterKey = `concat_ws('||', ${exactAttrs.map((e) => `CAST(\`${safeIdent(e.column)}\` AS STRING)`).join(', ')})`;
  // Completeness score = count of populated survivorship attributes per row.
  const completeness = model.survivorship.length
    ? model.survivorship.map((r) => `CASE WHEN \`${safeIdent(r.column)}\` IS NOT NULL THEN 1 ELSE 0 END`).join(' + ')
    : '0';

  const survivedCols = model.survivorship
    .map((r) => `${survivorshipExpr(model, r)} AS ${q(r.column)}`)
    .join(',\n    ');

  const srcArr = model.sourceSystemColumn
    ? `collect_set(s.${q(model.sourceSystemColumn)}) OVER (PARTITION BY s._gid) AS source_systems`
    : `array() AS source_systems`;

  // Steward-approved crosswalk: override _gid for manually-confirmed pairs.
  const cwValues = buildCrosswalkValues(crosswalk);
  const rid = `CAST(t.${q(model.recordIdColumn)} AS STRING)`;
  const srcCte = cwValues
    ? `src AS (
  SELECT t.*, COALESCE(_cw._cw_gid, md5(${clusterKey})) AS _gid, (${completeness}) AS _completeness
  FROM ${T} t
  LEFT JOIN ${cwValues} ON ${rid} = _cw._cw_record_id
)`
    : `src AS (
  SELECT *, md5(${clusterKey}) AS _gid, (${completeness}) AS _completeness
  FROM ${T}
)`;

  return `CREATE OR REPLACE TABLE ${G} AS
WITH ${srcCte},
golden AS (
  SELECT
    s._gid AS golden_id,
    ${survivedCols}${survivedCols ? ',' : ''}
    ${srcArr},
    count(*) OVER (PARTITION BY s._gid) AS source_record_count,
    row_number() OVER (PARTITION BY s._gid ORDER BY s.${q(model.recordIdColumn)}) AS _rn
  FROM src s
)
SELECT * EXCEPT (_rn) FROM golden WHERE _rn = 1`;
}

export interface MdmMergeResult {
  sql: string;
  goldenTable: string;
  goldenRecordCount: number | null;
  sourceRecordCount: number | null;
}

/** Execute the survivorship merge → write golden records to the Delta table. */
export async function runMerge(model: MdmModel, warehouseId?: string, crosswalk: CrosswalkPair[] = []): Promise<MdmMergeResult> {
  const wh = warehouse(warehouseId);
  const sql = buildGoldenRecordSql(model, crosswalk);
  await executeStatement(wh, sql, model.catalog, model.schema);
  const G = fq(model.goldenTable, model.catalog, model.schema);
  const T = fq(model.sourceTable, model.catalog, model.schema);
  let goldenRecordCount: number | null = null;
  let sourceRecordCount: number | null = null;
  try {
    const gc = await executeStatement(wh, `SELECT COUNT(*) AS c FROM ${G}`, model.catalog, model.schema);
    goldenRecordCount = gc.rows.length ? Number(gc.rows[0][0]) : null;
    const sc = await executeStatement(wh, `SELECT COUNT(*) AS c FROM ${T}`, model.catalog, model.schema);
    sourceRecordCount = sc.rows.length ? Number(sc.rows[0][0]) : null;
  } catch { /* counts are best-effort; the merge itself succeeded */ }
  return { sql, goldenTable: model.goldenTable, goldenRecordCount, sourceRecordCount };
}

export interface GoldenRecordPage {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
}

/** Browse golden records (paged) for the stewardship grid. */
export async function listGoldenRecords(model: MdmModel, limit = 200, warehouseId?: string): Promise<GoldenRecordPage> {
  const G = fq(model.goldenTable, model.catalog, model.schema);
  const r = await executeStatement(
    warehouse(warehouseId),
    `SELECT * FROM ${G} LIMIT ${Math.max(1, Math.floor(limit))}`,
    model.catalog,
    model.schema,
  );
  return { columns: r.columns, rows: r.rows, rowCount: r.rowCount };
}
