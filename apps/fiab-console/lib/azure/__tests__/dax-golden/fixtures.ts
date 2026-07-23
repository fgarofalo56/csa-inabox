/**
 * fixtures.ts — the DAX golden harness's shared fixture layer (A5).
 *
 * ONE source of truth, consumed by BOTH:
 *   - `dax-golden.test.ts` (vitest, offline) — validates the fixture schema and
 *     independently RE-COMPUTES every non-`manual` golden from `./data/*.csv`,
 *     proving the expected numbers are real (not typos) before any backend runs.
 *   - `e2e/dax-golden.spec.ts` (Playwright, live) — seeds the reference model,
 *     POSTs each IMPLEMENTED case's DAX to the real serverless backend, and
 *     asserts the numeric result equals the golden (`assertLiveResult`).
 *
 * Per ws-lineage-depth.md A5: the harness gates the NUMERIC RESULT of an
 * implemented function, not its own existence. A case with `implemented:false`
 * is a PENDING template row — the A1/A2/A3 PR that lands its fold flips
 * `implemented:true` and the live harness begins gating its result; the offline
 * CSV cross-check already locks the correct number in today.
 *
 * SDK-free / pure Node (fs + path only) so it loads identically under vitest and
 * Playwright. No Azure, no Cosmos, no network.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Types — the fixture schema (validated at load)
// ---------------------------------------------------------------------------

export type AggOp = 'sum' | 'count' | 'countDistinct' | 'avg' | 'min' | 'max';

/** How the harness asserts a live dax-query result against the golden. */
export type GoldenExpectation =
  | { kind: 'scalar'; column: string; value: number }
  | { kind: 'rowCount'; value: number }
  | {
      kind: 'groupRows';
      keyColumn: string;
      valueColumn: string;
      rows: Array<{ key: string; value: number }>;
    };

/** How the golden is INDEPENDENTLY recomputed from the seeded CSVs (offline). */
export type GoldenReference =
  | { kind: 'csv-rowcount'; table: string; limit?: number; asScalar?: boolean }
  | { kind: 'csv-agg'; table: string; op: AggOp; column: string }
  | { kind: 'csv-sumproduct'; table: string; columns: [string, string] }
  | {
      kind: 'csv-groupagg';
      from: string;
      join?: { table: string; leftKey: string; rightKey: string };
      /** "<table>.<Column>" — the dimension column to GROUP BY. */
      groupBy: string;
      op: AggOp;
      /** "<table>.<Column>" — the fact column to aggregate. */
      column: string;
    }
  | { kind: 'manual' };

export interface GoldenCase {
  id: string;
  fn: string;
  landedBy: 'A5' | 'A1' | 'A2' | 'A3' | 'A4';
  implemented: boolean;
  dax: string;
  database?: string;
  expect: GoldenExpectation;
  reference: GoldenReference;
  provenance: string;
  tolerance?: number;
}

export interface GoldenSuite {
  provenanceModel: string;
  defaultTolerance: number;
  cases: GoldenCase[];
}

// ---------------------------------------------------------------------------
// Paths + loaders
// ---------------------------------------------------------------------------

export const GOLDEN_DIR = __dirname;
export const GOLDEN_DATA_DIR = join(__dirname, 'data');

const VALID_LANDED = new Set(['A5', 'A1', 'A2', 'A3', 'A4']);
const VALID_AGG = new Set<AggOp>(['sum', 'count', 'countDistinct', 'avg', 'min', 'max']);

/** Read + parse a seeded CSV into an array of string-keyed records. */
export function loadCsv(table: string): Array<Record<string, string>> {
  const raw = readFileSync(join(GOLDEN_DATA_DIR, `${table.toLowerCase()}.csv`), 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const header = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row: Record<string, string> = {};
    header.forEach((h, i) => {
      row[h] = (cells[i] ?? '').trim();
    });
    return row;
  });
}

/** Load + structurally validate the golden suite. Throws on any schema defect. */
export function loadGoldenSuite(): GoldenSuite {
  const raw = JSON.parse(readFileSync(join(GOLDEN_DIR, 'expected-results.json'), 'utf8'));
  const defaultTolerance =
    typeof raw.defaultTolerance === 'number' ? raw.defaultTolerance : 1e-6;
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
    throw new Error('expected-results.json: `cases` must be a non-empty array.');
  }
  const seen = new Set<string>();
  const cases: GoldenCase[] = raw.cases.map((c: unknown, i: number) => validateCase(c, i, seen));
  return {
    provenanceModel: String(raw.provenanceModel ?? ''),
    defaultTolerance,
    cases,
  };
}

function validateCase(c: unknown, i: number, seen: Set<string>): GoldenCase {
  const o = (c && typeof c === 'object') ? (c as Record<string, unknown>) : null;
  const at = `cases[${i}]`;
  if (!o) throw new Error(`${at}: must be an object.`);
  const id = String(o.id ?? '');
  if (!id) throw new Error(`${at}: missing id.`);
  if (seen.has(id)) throw new Error(`${at}: duplicate id "${id}".`);
  seen.add(id);
  if (!String(o.fn ?? '')) throw new Error(`${id}: missing fn.`);
  if (!VALID_LANDED.has(String(o.landedBy))) throw new Error(`${id}: landedBy must be A1..A5.`);
  if (typeof o.implemented !== 'boolean') throw new Error(`${id}: implemented must be boolean.`);
  const dax = String(o.dax ?? '');
  if (!/\bEVALUATE\b/i.test(dax)) throw new Error(`${id}: dax must contain EVALUATE.`);
  const provenance = String(o.provenance ?? '');
  if (provenance.length < 8) throw new Error(`${id}: provenance is mandatory (no-vaporware).`);
  const expect = validateExpectation(o.expect, id);
  const reference = validateReference(o.reference, id);
  if (reference.kind === 'manual' && !/power bi|manual|captured|reference/i.test(provenance)) {
    throw new Error(`${id}: a manual reference needs a provenance naming its external source.`);
  }
  const tolerance = typeof o.tolerance === 'number' ? o.tolerance : undefined;
  return {
    id,
    fn: String(o.fn),
    landedBy: String(o.landedBy) as GoldenCase['landedBy'],
    implemented: o.implemented,
    dax,
    database: o.database ? String(o.database) : undefined,
    expect,
    reference,
    provenance,
    tolerance,
  };
}

function validateExpectation(e: unknown, id: string): GoldenExpectation {
  const o = (e && typeof e === 'object') ? (e as Record<string, unknown>) : null;
  if (!o) throw new Error(`${id}: expect must be an object.`);
  switch (o.kind) {
    case 'scalar':
      if (!String(o.column ?? '')) throw new Error(`${id}: scalar expect needs a column.`);
      if (typeof o.value !== 'number') throw new Error(`${id}: scalar expect needs a numeric value.`);
      return { kind: 'scalar', column: String(o.column), value: o.value };
    case 'rowCount':
      if (typeof o.value !== 'number') throw new Error(`${id}: rowCount expect needs a numeric value.`);
      return { kind: 'rowCount', value: o.value };
    case 'groupRows': {
      const rows = Array.isArray(o.rows) ? o.rows : null;
      if (!rows || rows.length === 0) throw new Error(`${id}: groupRows expect needs rows.`);
      return {
        kind: 'groupRows',
        keyColumn: String(o.keyColumn ?? ''),
        valueColumn: String(o.valueColumn ?? ''),
        rows: rows.map((r: any) => ({ key: String(r.key), value: Number(r.value) })),
      };
    }
    default:
      throw new Error(`${id}: unknown expect.kind "${String(o.kind)}".`);
  }
}

function validateReference(r: unknown, id: string): GoldenReference {
  const o = (r && typeof r === 'object') ? (r as Record<string, unknown>) : null;
  if (!o) throw new Error(`${id}: reference must be an object.`);
  switch (o.kind) {
    case 'manual':
      return { kind: 'manual' };
    case 'csv-rowcount':
      return {
        kind: 'csv-rowcount',
        table: reqStr(o.table, id, 'reference.table'),
        limit: typeof o.limit === 'number' ? o.limit : undefined,
        asScalar: o.asScalar === true,
      };
    case 'csv-agg':
      if (!VALID_AGG.has(o.op as AggOp)) throw new Error(`${id}: reference.op invalid.`);
      return {
        kind: 'csv-agg',
        table: reqStr(o.table, id, 'reference.table'),
        op: o.op as AggOp,
        column: reqStr(o.column, id, 'reference.column'),
      };
    case 'csv-sumproduct': {
      const cols = Array.isArray(o.columns) ? o.columns.map(String) : [];
      if (cols.length !== 2) throw new Error(`${id}: csv-sumproduct needs exactly 2 columns.`);
      return { kind: 'csv-sumproduct', table: reqStr(o.table, id, 'reference.table'), columns: [cols[0], cols[1]] };
    }
    case 'csv-groupagg': {
      if (!VALID_AGG.has(o.op as AggOp)) throw new Error(`${id}: reference.op invalid.`);
      const join = o.join && typeof o.join === 'object'
        ? {
            table: reqStr((o.join as any).table, id, 'reference.join.table'),
            leftKey: reqStr((o.join as any).leftKey, id, 'reference.join.leftKey'),
            rightKey: reqStr((o.join as any).rightKey, id, 'reference.join.rightKey'),
          }
        : undefined;
      return {
        kind: 'csv-groupagg',
        from: reqStr(o.from, id, 'reference.from'),
        join,
        groupBy: reqStr(o.groupBy, id, 'reference.groupBy'),
        op: o.op as AggOp,
        column: reqStr(o.column, id, 'reference.column'),
      };
    }
    default:
      throw new Error(`${id}: unknown reference.kind "${String(o.kind)}".`);
  }
}

function reqStr(v: unknown, id: string, field: string): string {
  const s = String(v ?? '').trim();
  if (!s) throw new Error(`${id}: ${field} is required.`);
  return s;
}

// ---------------------------------------------------------------------------
// Pure reference evaluator — recompute a golden from the seeded CSVs
// ---------------------------------------------------------------------------

function aggregate(op: AggOp, values: number[]): number {
  switch (op) {
    case 'sum': return values.reduce((a, b) => a + b, 0);
    case 'count': return values.length;
    case 'avg': return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    case 'min': return values.length ? Math.min(...values) : 0;
    case 'max': return values.length ? Math.max(...values) : 0;
    // countDistinct handled by the caller (needs raw strings, not numbers)
    default: throw new Error(`aggregate: unsupported op ${op}`);
  }
}

/**
 * Recompute the reference result from CSV. Returns either a single number
 * (scalar/rowCount references) or a keyed map (csv-groupagg). `manual` throws —
 * callers must not attempt to recompute an external reference.
 */
export function computeReference(ref: GoldenReference): number | Record<string, number> {
  switch (ref.kind) {
    case 'manual':
      throw new Error('computeReference: manual references cannot be recomputed from CSV.');
    case 'csv-rowcount': {
      const rows = loadCsv(ref.table);
      return typeof ref.limit === 'number' ? Math.min(ref.limit, rows.length) : rows.length;
    }
    case 'csv-agg': {
      const rows = loadCsv(ref.table);
      if (ref.op === 'countDistinct') {
        return new Set(rows.map((r) => r[ref.column])).size;
      }
      const nums = rows.map((r) => Number(r[ref.column])).filter((n) => Number.isFinite(n));
      return aggregate(ref.op, nums);
    }
    case 'csv-sumproduct': {
      const rows = loadCsv(ref.table);
      const [a, b] = ref.columns;
      return rows.reduce((acc, r) => acc + Number(r[a]) * Number(r[b]), 0);
    }
    case 'csv-groupagg': {
      const factTable = stripTable(ref.from);
      const factCol = stripCol(ref.column);
      const groupCol = stripCol(ref.groupBy);
      const groupTable = stripTable(ref.groupBy);
      const fact = loadCsv(factTable);
      // Build the dim lookup (join) if the group column lives on a joined table.
      let lookup: Map<string, string> | undefined;
      if (ref.join && groupTable === stripTable(ref.join.table)) {
        const dim = loadCsv(ref.join.table);
        lookup = new Map(dim.map((d) => [d[ref.join!.rightKey], d[groupCol]]));
      }
      const buckets: Record<string, number[]> = {};
      for (const row of fact) {
        const key = lookup ? (lookup.get(row[ref.join!.leftKey]) ?? '') : row[groupCol];
        (buckets[key] ??= []).push(Number(row[factCol]));
      }
      const out: Record<string, number> = {};
      for (const [k, vals] of Object.entries(buckets)) {
        out[k] = ref.op === 'countDistinct' ? new Set(vals).size : aggregate(ref.op, vals);
      }
      return out;
    }
  }
}

function stripTable(qualified: string): string {
  return qualified.includes('.') ? qualified.split('.')[0] : qualified;
}
function stripCol(qualified: string): string {
  return qualified.includes('.') ? qualified.split('.').slice(1).join('.') : qualified;
}

// ---------------------------------------------------------------------------
// Comparison helpers (used by both the offline check and the live harness)
// ---------------------------------------------------------------------------

export function approxEqual(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) <= tolerance;
}

/**
 * Cross-check a case's declared `expect` against its CSV-recomputed `reference`.
 * Returns null when they agree, or a human-readable mismatch string otherwise.
 * `manual` references are not recomputable → returns null (skipped).
 */
export function crossCheckAgainstCsv(c: GoldenCase, tolerance: number): string | null {
  if (c.reference.kind === 'manual') return null;
  const computed = computeReference(c.reference);
  if (c.expect.kind === 'scalar' || c.expect.kind === 'rowCount') {
    if (typeof computed !== 'number') return `${c.id}: reference produced grouped rows but expect is a single value.`;
    const declared = c.expect.value;
    return approxEqual(computed, declared, tolerance)
      ? null
      : `${c.id}: golden ${declared} != CSV-recomputed ${computed} (${c.fn}).`;
  }
  // groupRows
  if (typeof computed === 'number') return `${c.id}: reference produced a single value but expect is grouped rows.`;
  for (const { key, value } of c.expect.rows) {
    if (!(key in computed)) return `${c.id}: golden group "${key}" absent from CSV recompute.`;
    if (!approxEqual(computed[key], value, tolerance)) {
      return `${c.id}: group "${key}" golden ${value} != CSV ${computed[key]}.`;
    }
  }
  const extra = Object.keys(computed).filter((k) => !c.expect.rows.some((r) => r.key === k));
  if (extra.length) return `${c.id}: CSV recompute has groups not in the golden: ${extra.join(', ')}.`;
  return null;
}

/** A live dax-query response as returned by the BFF (`{ columns, rows }`). */
export interface LiveDaxResult {
  columns?: string[];
  rows?: Array<Record<string, unknown>>;
}

export interface LiveAssertion {
  ok: boolean;
  detail: string;
}

/**
 * Assert a live dax-query result against a case's golden expectation.
 * Numeric-only (the harness's contract). Used by e2e/dax-golden.spec.ts.
 */
export function assertLiveResult(c: GoldenCase, result: LiveDaxResult, defaultTolerance: number): LiveAssertion {
  const tol = c.tolerance ?? defaultTolerance;
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  const e = c.expect;
  if (e.kind === 'rowCount') {
    return {
      ok: rows.length === e.value,
      detail: `rowCount got ${rows.length}, want ${e.value}`,
    };
  }
  if (e.kind === 'scalar') {
    if (rows.length < 1) return { ok: false, detail: 'scalar: no rows returned' };
    const got = Number(pickColumn(rows[0], e.column));
    if (!Number.isFinite(got)) return { ok: false, detail: `scalar: column "${e.column}" not numeric in ${JSON.stringify(rows[0])}` };
    return { ok: approxEqual(got, e.value, tol), detail: `scalar[${e.column}] got ${got}, want ${e.value} (±${tol})` };
  }
  // groupRows
  const byKey = new Map<string, number>();
  for (const row of rows) {
    const k = String(pickColumn(row, e.keyColumn));
    byKey.set(k, Number(pickColumn(row, e.valueColumn)));
  }
  for (const { key, value } of e.rows) {
    if (!byKey.has(key)) return { ok: false, detail: `groupRows: missing key "${key}"` };
    const got = byKey.get(key)!;
    if (!approxEqual(got, value, tol)) return { ok: false, detail: `groupRows[${key}] got ${got}, want ${value}` };
  }
  return { ok: true, detail: `groupRows: ${e.rows.length} keys matched` };
}

/**
 * Column-name tolerant lookup: the loom-native translator aliases `AS [Label]`,
 * and different backends surface the result column with or without brackets /
 * case. Try exact, then bracket-stripped, then case-insensitive.
 */
function pickColumn(row: Record<string, unknown>, column: string): unknown {
  if (column in row) return row[column];
  const bare = column.replace(/^\[|\]$/g, '');
  if (bare in row) return row[bare];
  const lc = bare.toLowerCase();
  for (const k of Object.keys(row)) {
    if (k.toLowerCase().replace(/^\[|\]$/g, '') === lc) return row[k];
  }
  return undefined;
}
