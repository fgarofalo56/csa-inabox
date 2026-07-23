/**
 * dax-golden/fixtures.ts — the canonical loader + types + pure-JS reference
 * evaluator for the DAX golden-result harness (loom-next-level ws-lineage-depth
 * A5). Imported by BOTH:
 *   - lib/azure/__tests__/dax-golden-fixtures.test.ts  (vitest provenance gate —
 *     recomputes every golden from the CSV reference data so a wrong number
 *     fails locally, no live backend needed), and
 *   - e2e/dax-golden.spec.ts                           (live Playwright harness —
 *     asserts the SAME numbers against real Synapse serverless).
 *
 * The reference data (reference-data/{Sales,Date,Customer}.csv) IS the model:
 * `referenceEvaluate` reproduces the Power BI numeric result in pure JS over the
 * exact same rows, so the goldens can never drift from a live tenant. A1/A2/A3
 * add their functions' rows to expected-results.json AND (when they introduce a
 * new aggregation shape) extend `referenceEvaluate`'s op switch, in the same PR.
 */
import fs from 'node:fs';
import path from 'node:path';
import goldenFile from './expected-results.json';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReferenceOp =
  | 'rowcount'
  | 'sum'
  | 'count'
  | 'average'
  | 'min'
  | 'max'
  | 'distinctcount';

export interface ReferenceDescriptor {
  /** The pure-JS reduction that yields the expected number. */
  op: ReferenceOp;
  /** Reference table the reduction runs over (Sales | Date | Customer). */
  table: string;
  /** Column the reduction folds (omitted for rowcount). */
  column?: string;
  /** Row cap (TOPN) for rowcount. */
  limit?: number;
}

export interface GoldenExpect {
  /** scalar = single value in rows[0][column]; rowCount = rows.length. */
  kind: 'scalar' | 'rowCount' | 'table';
  /** The result column carrying the scalar (ROW("label", …) → label). */
  column?: string;
  /** Expected numeric value. */
  value: number;
  /** Absolute tolerance for non-terminating decimals (default 0 = exact). */
  tolerance?: number;
}

export interface GoldenFixture {
  id: string;
  /** DAX function under test (EVALUATE, TOPN, SUM, …). */
  fn: string;
  category: string;
  /** PR that added the row (A5 baseline; A1/A2/A3 for later batches). */
  since: string;
  /** implemented = gated live; pending = declared but not yet foldable. */
  status: 'implemented' | 'pending';
  dax: string;
  reference: ReferenceDescriptor;
  expect: GoldenExpect;
  provenance?: string;
}

export type ReferenceRow = Record<string, string | number>;
export type ReferenceData = Record<string, ReferenceRow[]>;

// ---------------------------------------------------------------------------
// The seeded star schema — model content (PUT to /content) + backing database
// ---------------------------------------------------------------------------

/** Serverless database the seed script (seed-dax-golden.sh) provisions the
 *  `dbo.{Sales,Date,Customer}` views into. Passed as `database` on every
 *  /dax-query POST so evalDax folds against the seeded tables. */
export const SEED_DATABASE = 'loom_dax_golden';

/** The three reference tables, in load order. */
export const REFERENCE_TABLES = ['Sales', 'Date', 'Customer'] as const;

/**
 * SemanticModelContent for the seeded star schema — the body the harness PUTs
 * to /api/items/semantic-model/[id]/content so the model has tables/measures
 * (never the 412 "unbound" gate) and its DAX folds to the seeded views.
 * Column names + order MATCH the CSV headers exactly.
 */
export const MODEL_CONTENT = {
  kind: 'semantic-model' as const,
  tables: [
    {
      name: 'Sales',
      columns: [
        { name: 'SaleKey', dataType: 'int64' },
        { name: 'DateKey', dataType: 'int64' },
        { name: 'CustomerKey', dataType: 'int64' },
        { name: 'ProductCategory', dataType: 'string' },
        { name: 'Quantity', dataType: 'int64' },
        { name: 'UnitPrice', dataType: 'decimal' },
        { name: 'Amount', dataType: 'decimal' },
      ],
    },
    {
      name: 'Date',
      columns: [
        { name: 'DateKey', dataType: 'int64' },
        { name: 'Date', dataType: 'dateTime' },
        { name: 'Year', dataType: 'int64' },
        { name: 'Quarter', dataType: 'int64' },
        { name: 'MonthNumber', dataType: 'int64' },
        { name: 'MonthName', dataType: 'string' },
      ],
    },
    {
      name: 'Customer',
      columns: [
        { name: 'CustomerKey', dataType: 'int64' },
        { name: 'CustomerName', dataType: 'string' },
        { name: 'Segment', dataType: 'string' },
      ],
    },
  ],
  measures: [
    { table: 'Sales', name: 'Total Sales', expression: 'SUM(Sales[Amount])', formatString: '\\$#,0' },
    { table: 'Sales', name: 'Sales Count', expression: 'COUNT(Sales[Amount])' },
    { table: 'Sales', name: 'Avg Sale', expression: 'AVERAGE(Sales[Amount])' },
  ],
  // Star relationships (one Date/Customer → many Sales). A3 (time-intelligence)
  // and A2 (RELATED) fold over these. Cardinality uses the /content enum.
  relationships: [
    { from: 'Date[DateKey]', to: 'Sales[DateKey]', cardinality: '1:many' as const },
    { from: 'Customer[CustomerKey]', to: 'Sales[CustomerKey]', cardinality: '1:many' as const },
  ],
};

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

/** All golden fixtures (every status). */
export function loadFixtures(): GoldenFixture[] {
  return (goldenFile as { fixtures: GoldenFixture[] }).fixtures;
}

/** Only the fixtures the live engine is expected to fold today. */
export function implementedFixtures(): GoldenFixture[] {
  return loadFixtures().filter((f) => f.status === 'implemented');
}

// ---------------------------------------------------------------------------
// Reference-data (CSV) loading — runtime-agnostic (vitest ESM + Playwright CJS)
// ---------------------------------------------------------------------------

const FIXTURE_REL = 'lib/azure/__tests__/dax-golden';

/** Locate the fixture directory from the process cwd (apps/fiab-console under
 *  both runners), with an upward-walk fallback so it resolves from the repo
 *  root too. No `import.meta` / `__dirname` so it works in either module mode. */
function fixtureDir(): string {
  const direct = [
    path.join(process.cwd(), FIXTURE_REL),
    path.join(process.cwd(), 'apps', 'fiab-console', FIXTURE_REL),
  ];
  for (const c of direct) {
    if (fs.existsSync(path.join(c, 'reference-data'))) return c;
  }
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    for (const rel of [path.join('apps', 'fiab-console', FIXTURE_REL), FIXTURE_REL]) {
      const c = path.join(dir, rel);
      if (fs.existsSync(path.join(c, 'reference-data'))) return c;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`dax-golden reference-data not found from cwd ${process.cwd()}`);
}

/** Minimal CSV parser (no embedded commas/quotes in the reference data —
 *  deliberately kept trivial so the fixtures stay obviously correct). Numeric
 *  cells are coerced to Number; everything else stays a string. */
function parseCsv(text: string): ReferenceRow[] {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const headers = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row: ReferenceRow = {};
    headers.forEach((h, i) => {
      const raw = cells[i] ?? '';
      row[h] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
    });
    return row;
  });
}

/** Load all three reference tables from reference-data/*.csv. */
export function loadReferenceData(): ReferenceData {
  const dir = path.join(fixtureDir(), 'reference-data');
  const data: ReferenceData = {};
  for (const t of REFERENCE_TABLES) {
    data[t] = parseCsv(fs.readFileSync(path.join(dir, `${t}.csv`), 'utf8'));
  }
  return data;
}

// ---------------------------------------------------------------------------
// Pure-JS reference evaluator — the provenance ground truth
// ---------------------------------------------------------------------------

/**
 * Recompute a fixture's expected NUMBER from the CSV reference data in pure JS.
 * This is the golden's provenance: the CSV is the reference model, so the value
 * in expected-results.json must equal this. A2/A3 EXTEND this switch when they
 * add a new reduction shape (e.g. distinctcount is already here for A2).
 */
export function referenceEvaluate(fx: GoldenFixture, data: ReferenceData): number {
  const rows = data[fx.reference.table];
  if (!rows) throw new Error(`referenceEvaluate: reference table "${fx.reference.table}" not loaded`);
  const { op, column, limit } = fx.reference;
  const colNums = (): number[] => {
    if (!column) throw new Error(`referenceEvaluate: op "${op}" needs a column`);
    return rows.map((r) => Number(r[column])).filter((v) => Number.isFinite(v));
  };
  switch (op) {
    case 'rowcount':
      return typeof limit === 'number' ? Math.min(limit, rows.length) : rows.length;
    case 'sum':
      return colNums().reduce((a, b) => a + b, 0);
    case 'count':
      if (!column) throw new Error('referenceEvaluate: count needs a column');
      return rows.filter((r) => r[column] !== '' && r[column] != null).length;
    case 'average': {
      const n = colNums();
      return n.reduce((a, b) => a + b, 0) / n.length;
    }
    case 'min':
      return Math.min(...colNums());
    case 'max':
      return Math.max(...colNums());
    case 'distinctcount':
      if (!column) throw new Error('referenceEvaluate: distinctcount needs a column');
      return new Set(rows.map((r) => r[column])).size;
    default:
      throw new Error(
        `referenceEvaluate: unsupported op "${op}" — extend this switch in the A1/A2/A3 PR that adds it`,
      );
  }
}

// ---------------------------------------------------------------------------
// Result matching — shared by both the vitest and the Playwright layers
// ---------------------------------------------------------------------------

export interface MatchResult {
  ok: boolean;
  actual: number;
  expected: number;
  detail: string;
}

/** Compare an actual number to a fixture's expectation within tolerance. */
export function matchNumber(actual: number, expect: GoldenExpect): MatchResult {
  const tol = expect.tolerance ?? 0;
  const ok = Number.isFinite(actual) && Math.abs(actual - expect.value) <= tol;
  return {
    ok,
    actual,
    expected: expect.value,
    detail: ok
      ? `= ${expect.value}${tol ? ` (±${tol})` : ''}`
      : `expected ${expect.value}${tol ? ` (±${tol})` : ''}, got ${actual}`,
  };
}

/** Extract the number a live /dax-query result yields for a fixture:
 *  rowCount → rows.length; scalar → Number(rows[0][column]). */
export function extractActual(fx: GoldenFixture, rows: Array<Record<string, unknown>>): number {
  if (fx.expect.kind === 'rowCount' || fx.expect.kind === 'table') return rows.length;
  const col = fx.expect.column;
  const first = rows[0] ?? {};
  // The serverless result may bracket-strip or preserve the ROW() label; try both.
  const raw = col != null ? (first[col] ?? first[`[${col}]`] ?? Object.values(first)[0]) : Object.values(first)[0];
  return Number(raw);
}
