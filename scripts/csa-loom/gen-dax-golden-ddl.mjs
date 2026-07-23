#!/usr/bin/env node
/**
 * gen-dax-golden-ddl.mjs — emit the Synapse serverless DDL that seeds the DAX
 * golden reference model (loom-next-level ws-lineage-depth A5).
 *
 * Reads the SAME reference CSVs the harness asserts against
 * (apps/fiab-console/lib/azure/__tests__/dax-golden/reference-data/*.csv) and
 * prints, to stdout:
 *   CREATE DATABASE loom_dax_golden   (if absent)
 *   CREATE OR ALTER VIEW dbo.[Sales|Date|Customer] AS SELECT … FROM (VALUES …)
 *
 * The views are pure metadata over a T-SQL VALUES table constructor — NO ADLS /
 * OPENROWSET / external table, so the seed needs no storage data-plane (which
 * this estate seals) and the numbers are perfectly deterministic. The CSV is the
 * single source of truth: change a row here and both the seeded view and the
 * golden recomputation move together.
 *
 * Usage:
 *   node scripts/csa-loom/gen-dax-golden-ddl.mjs               # both batches
 *   node scripts/csa-loom/gen-dax-golden-ddl.mjs --db-only     # CREATE DATABASE
 *   node scripts/csa-loom/gen-dax-golden-ddl.mjs --views-only  # the views
 *
 * Consumed by scripts/csa-loom/seed-dax-golden.sh.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const DATA_DIR = path.join(
  REPO_ROOT,
  'apps',
  'fiab-console',
  'lib',
  'azure',
  '__tests__',
  'dax-golden',
  'reference-data',
);

export const DATABASE = 'loom_dax_golden';

// Column SQL types per table (source of truth for the seeded view schema). The
// column ORDER + names must match the CSV headers exactly (asserted below).
const SCHEMA = {
  Sales: [
    ['SaleKey', 'int'],
    ['DateKey', 'int'],
    ['CustomerKey', 'int'],
    ['ProductCategory', 'nvarchar(100)'],
    ['Quantity', 'int'],
    ['UnitPrice', 'decimal(18,2)'],
    ['Amount', 'decimal(18,2)'],
  ],
  Date: [
    ['DateKey', 'int'],
    ['Date', 'date'],
    ['Year', 'int'],
    ['Quarter', 'int'],
    ['MonthNumber', 'int'],
    ['MonthName', 'nvarchar(20)'],
  ],
  Customer: [
    ['CustomerKey', 'int'],
    ['CustomerName', 'nvarchar(100)'],
    ['Segment', 'nvarchar(50)'],
  ],
};

const TABLES = ['Sales', 'Date', 'Customer'];

function parseCsv(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r/g, '');
  const lines = text.split('\n').filter((l) => l.length > 0);
  const headers = lines[0].split(',');
  const rows = lines.slice(1).map((l) => l.split(','));
  return { headers, rows };
}

/** Format one CSV cell as a SQL VALUES literal for its declared type. */
function literal(raw, sqlType) {
  if (raw === '' || raw == null) return 'NULL';
  if (sqlType.startsWith('int') || sqlType.startsWith('decimal')) return String(Number(raw));
  // strings + dates: single-quote, escaping embedded quotes
  return `'${String(raw).replace(/'/g, "''")}'`;
}

function viewDdl(table) {
  const schema = SCHEMA[table];
  const { headers, rows } = parseCsv(path.join(DATA_DIR, `${table}.csv`));
  const expected = schema.map(([n]) => n);
  if (headers.join(',') !== expected.join(',')) {
    throw new Error(
      `${table}.csv header mismatch:\n  csv:    ${headers.join(',')}\n  schema: ${expected.join(',')}`,
    );
  }
  const cols = schema.map(([name, type], i) => `    CAST(c${i} AS ${type}) AS [${name}]`).join(',\n');
  const valueRows = rows
    .map((cells) => '    (' + schema.map(([, type], i) => literal(cells[i], type)).join(', ') + ')')
    .join(',\n');
  const alias = schema.map((_, i) => `c${i}`).join(', ');
  return (
    `CREATE OR ALTER VIEW dbo.[${table}] AS\n` +
    `SELECT\n${cols}\n` +
    `FROM (VALUES\n${valueRows}\n` +
    `) AS v(${alias});\nGO\n`
  );
}

function createDatabaseBatch() {
  // Synapse serverless requires CREATE DATABASE to be the ONLY statement in its
  // batch (no IF-guard), so idempotency is handled by the runner's
  // --ignore-errors mode: a benign "database already exists" is logged, not
  // fatal. The seed passes --ignore-errors for this batch only.
  return `CREATE DATABASE [${DATABASE}];\nGO\n`;
}

function main() {
  const dbOnly = process.argv.includes('--db-only');
  const viewsOnly = process.argv.includes('--views-only');
  let out = '';
  if (!viewsOnly) out += createDatabaseBatch();
  if (!dbOnly) {
    out += `\n`;
    for (const t of TABLES) out += viewDdl(t) + '\n';
  }
  process.stdout.write(out);
}

main();
