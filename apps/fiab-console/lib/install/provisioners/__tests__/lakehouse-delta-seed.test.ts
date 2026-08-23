/**
 * #3904 — the Azure-native lakehouse seed must produce a REAL Delta table.
 *
 * The defect these tests exist for: `seedLakehouseAdls` wrote a plain CSV at
 * `Tables/<name>/<name>.csv` and the module docstring called it "ADLS Gen2
 * (Delta)". Nothing on the Azure-native path had ever written a `_delta_log`.
 * The reader was never wrong — `scanLakehouseTables`/`probeTable` saw no
 * `_delta_log` and no `.parquet`, classified the directory `format:'unknown',
 * status:'empty'`, and `countRows`' `OPENROWSET(… FORMAT='DELTA')` threw over a
 * CSV and honestly returned null. Every seeded table in every demo app read
 * empty. That is what the operator saw.
 *
 * WHY THE ASSERTIONS ARE SHAPED THIS WAY. A test that only checked "a file was
 * written under Tables/<name>/" passes on the DEFECT — the CSV was a file, and
 * `out.seeded` contained the table name. So these tests read back what was
 * written and run the REAL consumer over it:
 *
 *   1. `scanLakehouseTables` — the actual production reader, imported unmocked
 *      and pointed at the exact bytes the seeder produced. It is what reports
 *      `empty` today; here it must report `format:'delta', status:'ok'`.
 *   2. The Delta commit is parsed, and `add.stats.numRecords` is compared to
 *      the declared `sampleRows.length` AND to `add.size` vs the real file
 *      length — a post-deploy validation reads exactly that field (#3905), so a
 *      log that merely EXISTS is not enough.
 *
 * MUTATION PROOF (break the subject, watch these go red, restore):
 *   a) In `_seed-lakehouse-adls.ts` replace the Parquet + `_delta_log` writes
 *      with the old single `buildCsv` upload -> RED:
 *        "the real catalog scanner reports the seeded table as a live Delta table"
 *        "the Delta commit reports a truthful numRecords"
 *   b) Revert `stripSqlComments` (parse straight from `ddl.indexOf('(')`) -> RED:
 *        "parses a DDL whose leading comment contains parentheses (the SCD bug)"
 *        "every bundled Delta table's DDL parses to a plausible column list"
 *
 * The Parquet encoder is additionally verified against TWO independent
 * third-party readers (delta-rs/pyarrow, and hyparquet) over all 47 bundled +
 * edge-case tables; those receipts are in the PR body, because neither reader
 * is a dependency of this app and adding one is outside this change's scope.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Fake ADLS Gen2 — records writes AND serves them back through the same
// listPaths() surface the production catalog scanner walks, so the reader under
// test reads the exact bytes the writer under test produced.
// ---------------------------------------------------------------------------
interface FakeEntry {
  name: string;
  isDirectory: boolean;
  contentLength: number;
  lastModified: Date;
}

const fs = {
  entries: [] as FakeEntry[],
  bytes: new Map<string, Buffer>(),
  failWriteOn: null as RegExp | null,
  failWriteStatus: 500,
  failDirOn: null as RegExp | null,
};

function put(path: string, isDirectory: boolean, body?: Buffer) {
  const existing = fs.entries.findIndex((e) => e.name === path);
  const entry: FakeEntry = {
    name: path,
    isDirectory,
    contentLength: body?.length ?? 0,
    lastModified: new Date('2026-08-22T00:00:00Z'),
  };
  if (existing >= 0) fs.entries[existing] = entry;
  else fs.entries.push(entry);
  if (body) fs.bytes.set(path, body);
}

/**
 * Record a path AND its ancestor directories — ADLS Gen2 with a hierarchical
 * namespace materializes intermediate directories, so `Tables/` exists as a
 * listable directory once `Tables/orders/` is created. A fake without this
 * cannot list `<root>/Tables` at all, which is the first thing the catalog
 * scanner does.
 */
function record(path: string, isDirectory: boolean, body?: Buffer) {
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    const anc = parts.slice(0, i).join('/');
    if (anc && !fs.entries.some((e) => e.name === anc)) put(anc, true);
  }
  put(path, isDirectory, body);
}

vi.mock('@/lib/azure/adls-client', () => ({
  KNOWN_CONTAINERS: ['bronze', 'silver', 'gold', 'landing', 'csv-imports'],
  createDirectory: vi.fn(async (_c: string, path: string) => {
    if (fs.failDirOn?.test(path)) throw Object.assign(new Error('dir denied'), { statusCode: 500 });
    record(path, true);
    return { ok: true };
  }),
  uploadFile: vi.fn(async (_c: string, path: string, body: Buffer) => {
    if (fs.failWriteOn?.test(path)) {
      throw Object.assign(new Error('write denied'), { statusCode: fs.failWriteStatus });
    }
    record(path, false, Buffer.from(body));
    return { ok: true, size: body.length };
  }),
  getAccountName: vi.fn(() => 'fakeacct'),
  getServiceClientFor: vi.fn(() => ({
    getFileSystemClient: () => ({
      listPaths: ({ path, recursive }: { path: string; recursive?: boolean }) => ({
        async *[Symbol.asyncIterator]() {
          // ADLS Gen2 404s only when the DIRECTORY itself is absent; an
          // existing-but-empty directory yields nothing. A fake that 404s on
          // "no children" would make every empty table look 'broken' and would
          // hide the difference between a missing table and an empty one.
          if (!fs.entries.some((e) => e.name === path && e.isDirectory)) {
            throw Object.assign(new Error('PathNotFound'), { statusCode: 404 });
          }
          const prefix = `${path}/`;
          for (const e of fs.entries.filter((x) => x.name.startsWith(prefix))) {
            const rel = e.name.slice(prefix.length);
            if (!recursive && rel.includes('/')) continue;
            yield e;
          }
        },
      }),
    }),
  })),
  pathToHttpsUrl: vi.fn((c: string, p: string) => `https://fakeacct.dfs.core.windows.net/${c}/${p}`),
  listContainers: vi.fn(async () => [{ name: 'landing' }]),
  resolveAbfssRoot: vi.fn((c: string, r: string) => `abfss://${c}@fakeacct.dfs.core.windows.net/${r}`),
}));

// synapse-catalog-client pulls the serverless SQL client in at module scope.
vi.mock('@/lib/azure/synapse-sql-client', () => ({
  executeQuery: vi.fn(async () => ({ rows: [] })),
  serverlessTarget: vi.fn(() => ({ server: 's', database: 'd' })),
}));

import {
  buildDeltaTableFiles,
  buildParquetFile,
  columnsFromDdl,
  parseDdlColumns,
  resolveDeltaTypes,
  seedLakehouseAdls,
  stripSqlComments,
  DELTA_FIRST_COMMIT,
} from '../_seed-lakehouse-adls';
import { scanLakehouseTables } from '@/lib/azure/synapse-catalog-client';
import { listBundleIds, getBundle } from '@/lib/apps/content-bundles';

const ROOT = 'lakehouses/sales';

const CONTENT = {
  kind: 'lakehouse',
  folders: [{ path: 'Files/raw' }, { path: 'Files/curated' }],
  deltaTables: [
    {
      name: 'orders',
      ddl: 'CREATE TABLE orders ( order_id BIGINT, amount DECIMAL(18,2), placed_at TIMESTAMP, shipped BOOLEAN )',
      sampleRows: [
        [1, 10.5, '2026-08-15T00:00:00Z', true],
        [2, 20.25, '2026-08-16T00:00:00Z', false],
        [3, 99.0, '2026-08-17T00:00:00Z', null],
      ],
    },
    { name: 'customers', ddl: 'CREATE TABLE customers ( id BIGINT )' },
  ],
};

/**
 * The REAL DDL from `lib/apps/content-bundles/app-lakehouse-inspector.ts`
 * (`dim_customer`), verbatim. A synthetic fixture would not have caught this:
 * the bug needs a leading `--` comment that itself contains parentheses, AND a
 * trailing `TBLPROPERTIES (…)` whose close paren is the file's last one.
 */
const DIM_CUSTOMER_DDL =
  '-- Translated from dbt/models/gold/dim_customer.sql (SCD Type 2)\n' +
  'CREATE TABLE gold.dim_customer (\n' +
  '    customer_key       BIGINT         NOT NULL,\n' +
  '    customer_id        VARCHAR(64)    NOT NULL,\n' +
  '    customer_name      VARCHAR(200)   NOT NULL,\n' +
  '    customer_segment   VARCHAR(50)    NOT NULL,\n' +
  '    country            VARCHAR(80)    NOT NULL,\n' +
  '    region             VARCHAR(80)    NOT NULL,\n' +
  '    valid_from         TIMESTAMP      NOT NULL,\n' +
  '    valid_to           TIMESTAMP,\n' +
  '    is_current         BOOLEAN        NOT NULL,\n' +
  '    CONSTRAINT pk_dim_customer PRIMARY KEY (customer_key)\n' +
  ') USING DELTA\n' +
  "TBLPROPERTIES ('delta.enableChangeDataFeed' = 'true');";

const DIM_CUSTOMER_COLUMNS = [
  'customer_key',
  'customer_id',
  'customer_name',
  'customer_segment',
  'country',
  'region',
  'valid_from',
  'valid_to',
  'is_current',
];

beforeEach(() => {
  fs.entries = [];
  fs.bytes = new Map();
  fs.failWriteOn = null;
  fs.failWriteStatus = 500;
  fs.failDirOn = null;
  // The scanner only walks containers whose URL env var is set.
  process.env.LOOM_LANDING_URL = 'https://fakeacct.dfs.core.windows.net/landing';
});

// ===========================================================================
// Fix 2 — columnsFromDdl
// ===========================================================================

describe('columnsFromDdl — comment / literal / matching-paren correctness', () => {
  it('parses a DDL whose leading comment contains parentheses (the SCD bug)', () => {
    // Before the fix this returned exactly ['SCD'] — `indexOf('(')` found the
    // paren inside `(SCD Type 2)`, nothing split at depth 0, and the guard at
    // `columns.length === 0` therefore never fired. The seeder wrote a 1-column
    // table headed `SCD`, dropped 8 of 9 columns, registered a Synapse view over
    // that bogus schema, and logged success.
    expect(columnsFromDdl(DIM_CUSTOMER_DDL)).toEqual(DIM_CUSTOMER_COLUMNS);
    expect(columnsFromDdl(DIM_CUSTOMER_DDL)).toHaveLength(9);
  });

  it('does not lose the column that follows an inline -- comment', () => {
    // app-multi-agency-onboarding: `classification STRING,   -- CUI | …` made the
    // NEXT segment start with `--`, so `endorsement` failed the identifier test
    // and vanished. Two columns were silently dropped from that table.
    const ddl =
      'CREATE TABLE marketplace_data_product (\n' +
      '    product_id        STRING,\n' +
      '    classification    STRING,   -- CUI | Restricted-PII | Restricted-PHI | Internal\n' +
      '    endorsement       STRING,   -- promoted | certified | null\n' +
      '    delta_share_name  STRING,\n' +
      '    published_utc     TIMESTAMP\n' +
      ') USING DELTA';
    expect(columnsFromDdl(ddl)).toEqual([
      'product_id',
      'classification',
      'endorsement',
      'delta_share_name',
      'published_utc',
    ]);
  });

  it('does not invent phantom columns from commas inside a string literal', () => {
    // app-healthcare-popmgt: `COMMENT 'Medicare, Medicaid, Commercial, Uninsured'`
    // split at depth 0 and injected Medicaid/Commercial/Uninsured as columns.
    const ddl =
      "CREATE TABLE bronze.patients (\n" +
      "  patient_id STRING NOT NULL COMMENT 'De-identified patient identifier',\n" +
      "  insurance_type STRING COMMENT 'Medicare, Medicaid, Commercial, Uninsured, etc.',\n" +
      "  ingested_at TIMESTAMP NOT NULL\n" +
      ') USING DELTA';
    expect(columnsFromDdl(ddl)).toEqual(['patient_id', 'insurance_type', 'ingested_at']);
  });

  it('stops at the MATCHING close paren, not the last one in the file', () => {
    // `lastIndexOf(')')` was the close of TBLPROPERTIES(…), so `USING DELTA …
    // TBLPROPERTIES (` leaked into the column list.
    expect(columnsFromDdl(DIM_CUSTOMER_DDL)).not.toContain('USING');
    expect(columnsFromDdl(DIM_CUSTOMER_DDL)).not.toContain('TBLPROPERTIES');
    expect(columnsFromDdl('CREATE TABLE t (a BIGINT) PARTITIONED BY (a) TBLPROPERTIES (\'k\' = \'v\')')).toEqual(['a']);
  });

  it('keeps the behaviours the pre-existing sibling specs pin', () => {
    expect(columnsFromDdl('CREATE TABLE t ( a BIGINT, b DECIMAL(18,2), c STRING )')).toEqual(['a', 'b', 'c']);
    expect(columnsFromDdl('CREATE TABLE t ( id BIGINT, name STRING, PRIMARY KEY (id) )')).toEqual(['id', 'name']);
  });

  it('strips block comments without eating a -- inside a string literal', () => {
    expect(stripSqlComments("SELECT 'a -- b' /* gone */ , x")).toBe("SELECT 'a -- b'   , x");
  });

  it('returns [] rather than a phantom column when there is no column list', () => {
    expect(columnsFromDdl('-- just a comment (with parens)')).toEqual([]);
    expect(columnsFromDdl('')).toEqual([]);
  });
});

describe('every bundled Delta table parses to a plausible column list', () => {
  it('has non-zero population and no DDL that collapses to a single phantom column', async () => {
    const seen: Array<{ app: string; table: string; cols: string[]; rows: number }> = [];
    for (const id of listBundleIds()) {
      const bundle = await getBundle(id);
      for (const item of bundle?.items ?? []) {
        const content = item.content as any;
        for (const t of Array.isArray(content?.deltaTables) ? content.deltaTables : []) {
          if (!t?.ddl) continue;
          seen.push({
            app: id,
            table: String(t.name),
            cols: columnsFromDdl(t.ddl),
            rows: Array.isArray(t.sampleRows) ? t.sampleRows.length : 0,
          });
        }
      }
    }

    // A guard over an empty population proves nothing. 45 delta tables carry a
    // DDL today; assert the floor so a bundle-registry regression that empties
    // this loop fails here instead of passing vacuously.
    expect(seen.length).toBeGreaterThanOrEqual(45);

    // The SCD signature: a multi-line DDL that parses to ONE column while its
    // sample rows carry many values. Two tables looked exactly like this before
    // the fix (app-lakehouse-inspector dim_customer + dim_product).
    const collapsed = seen.filter((t) => t.cols.length <= 1 && t.rows > 0);
    expect(collapsed).toEqual([]);

    // And every one of them yields at least two real columns.
    expect(seen.filter((t) => t.cols.length < 2)).toEqual([]);
  });
});

// ===========================================================================
// Fix 1 — a real Delta table
// ===========================================================================

describe('buildDeltaTableFiles / buildParquetFile', () => {
  it('emits a Parquet file with the PAR1 framing and a self-consistent footer length', () => {
    const buf = buildParquetFile(['a', 'b'], ['long', 'string'], [[1, 'x'], [2, null]]);
    expect(buf.subarray(0, 4).toString('ascii')).toBe('PAR1');
    expect(buf.subarray(-4).toString('ascii')).toBe('PAR1');
    const footerLen = buf.readUInt32LE(buf.length - 8);
    // The declared footer length must land exactly on the end of the data
    // section — an off-by-one here is what makes a reader say "not a parquet
    // file", and it is invisible to any "was a file written?" assertion.
    expect(footerLen).toBeGreaterThan(0);
    expect(buf.length - 8 - footerLen).toBeGreaterThan(4);
    // Column names are in the footer, in order.
    const footer = buf.subarray(buf.length - 8 - footerLen, buf.length - 8).toString('latin1');
    expect(footer.indexOf('a')).toBeLessThan(footer.indexOf('b'));
  });

  it('reports a truthful numRecords, byte size and data-file name in the commit', () => {
    const columns = parseDdlColumns(DIM_CUSTOMER_DDL);
    const rows = [
      [1, 'CUST-0017', 'Acme', 'Enterprise', 'US', 'AMER', '2026-01-01T00:00:00Z', null, true],
      [2, 'CUST-0042', 'Smith', 'Consumer', 'US', 'AMER', '2026-01-01T00:00:00Z', null, true],
    ];
    const d = buildDeltaTableFiles({ identity: 'landing/x/Tables/dim_customer', tableName: 'dim_customer', columns, rows, now: 1 });

    const actions = d.logText.trim().split('\n').map((l) => JSON.parse(l));
    expect(actions).toHaveLength(3);
    expect(actions[0].protocol).toEqual({ minReaderVersion: 1, minWriterVersion: 2 });
    const stats = JSON.parse(actions[2].add.stats);
    expect(stats.numRecords).toBe(rows.length);
    expect(actions[2].add.size).toBe(d.dataBytes.length);
    expect(actions[2].add.path).toBe(d.dataFileName);
    expect(d.dataFileName).toMatch(/^part-00000-[0-9a-f-]{36}-c000\.parquet$/);

    // The Delta schema must describe the same columns, in order, as the DDL.
    const schema = JSON.parse(actions[1].metaData.schemaString);
    expect(schema.fields.map((f: any) => f.name)).toEqual(DIM_CUSTOMER_COLUMNS);
    expect(schema.fields.map((f: any) => f.type)).toEqual(d.types);
  });

  it('is deterministic, so a re-install overwrites rather than orphaning parts', () => {
    const columns = parseDdlColumns('CREATE TABLE t (a BIGINT)');
    const a = buildDeltaTableFiles({ identity: 'landing/x/Tables/t', tableName: 't', columns, rows: [[1]], now: 7 });
    const b = buildDeltaTableFiles({ identity: 'landing/x/Tables/t', tableName: 't', columns, rows: [[1]], now: 7 });
    expect(b.dataFileName).toBe(a.dataFileName);
    expect(b.logText).toBe(a.logText);
    // …but two different tables never collide.
    const c = buildDeltaTableFiles({ identity: 'landing/x/Tables/u', tableName: 'u', columns, rows: [[1]], now: 7 });
    expect(c.dataFileName).not.toBe(a.dataFileName);
  });

  it('believes the DDL type when the values fit it, and the values when they do not', () => {
    const cols = parseDdlColumns('CREATE TABLE t (price DECIMAL(18,2), n BIGINT, flag BOOLEAN, s VARCHAR(10))');
    // Every sampled price is whole — value inference alone would call this a
    // long; the DDL says DECIMAL, and every value fits a double, so double wins.
    expect(resolveDeltaTypes(cols, [[100, 1, true, 'a'], [200, 2, false, 'b']])).toEqual([
      'double',
      'long',
      'boolean',
      'string',
    ]);
    // A BIGINT column whose bundle rows are actually text: encode what is there.
    expect(resolveDeltaTypes(cols, [[1.5, 'not-a-number', true, 'a']])).toEqual([
      'double',
      'string',
      'boolean',
      'string',
    ]);
  });
});

describe('seedLakehouseAdls — what lands on disk', () => {
  it('writes a Parquet data file and a _delta_log commit per seeded table', async () => {
    const steps: string[] = [];
    const r = await seedLakehouseAdls('landing' as never, ROOT, CONTENT, steps);

    expect(r.seeded).toEqual(['orders']);
    expect(r.emptyTables).toEqual(['customers']);
    expect(r.failedTables).toEqual([]);
    expect(r.failedFolders).toEqual([]);
    expect(r.expectedSeedTables).toBe(1);

    const logPath = `${ROOT}/Tables/orders/${DELTA_FIRST_COMMIT}`;
    const log = fs.bytes.get(logPath);
    expect(log, `no Delta commit at ${logPath}`).toBeDefined();

    const actions = log!.toString('utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(actions.map((a) => Object.keys(a)[0])).toEqual(['protocol', 'metaData', 'add']);

    // The add action must point at a file that REALLY EXISTS, with the size it
    // claims. "a file was written" would pass without either.
    const dataPath = `${ROOT}/Tables/orders/${actions[2].add.path}`;
    const data = fs.bytes.get(dataPath);
    expect(data, `add.path points at ${dataPath}, which was never written`).toBeDefined();
    expect(actions[2].add.size).toBe(data!.length);
    expect(data!.subarray(0, 4).toString('ascii')).toBe('PAR1');

    // …and numRecords must equal the declared sampleRows length.
    expect(JSON.parse(actions[2].add.stats).numRecords).toBe(CONTENT.deltaTables[0].sampleRows!.length);

    // The seed CSV is still written, but OUTSIDE the Delta table directory: an
    // unreferenced file inside it would inflate the table's reported size.
    expect(fs.bytes.has(`${ROOT}/Files/_seed/orders.csv`)).toBe(true);
    expect([...fs.bytes.keys()].filter((k) => k.startsWith(`${ROOT}/Tables/orders/`) && k.endsWith('.csv'))).toEqual([]);
  });

  it('the real catalog scanner reports the seeded table as a live Delta table', async () => {
    // THE regression that matters. `scanLakehouseTables` is the production
    // reader, imported unmocked, walking the exact bytes the seeder just wrote.
    // On the CSV writer it returns format:'unknown', status:'empty' — which is
    // precisely what the operator saw for all 25 demo tables.
    await seedLakehouseAdls('landing' as never, ROOT, CONTENT, []);

    const tables = await scanLakehouseTables({ containers: ['landing'], rootPrefix: ROOT });
    const orders = tables.find((t) => t.name === 'orders');
    expect(orders, 'the scanner did not see the table at all').toBeDefined();
    expect(orders!.format).toBe('delta');
    expect(orders!.status).toBe('ok');
    expect(orders!.latestVersion).toBe(0);
    expect(orders!.sizeBytes).toBeGreaterThan(0);

    // The declared-empty table is still browsable and still honestly 'empty'.
    const customers = tables.find((t) => t.name === 'customers');
    expect(customers?.status).toBe('empty');
  });

  it('discloses an arity mismatch instead of silently truncating the row', async () => {
    // 6 of the 45 bundled tables ship sample rows shorter than their DDL
    // (app-healthcare-popmgt). The old code padded silently via
    // `columns.map((_, i) => r[i])` — the same mechanism that wrote 9 values
    // into the 1-column `SCD` table and called it a 6-row success.
    const steps: string[] = [];
    const r = await seedLakehouseAdls(
      'landing' as never,
      ROOT,
      {
        deltaTables: [
          { name: 'short', ddl: 'CREATE TABLE short (a BIGINT, b STRING, c STRING)', sampleRows: [[1, 'x'], [2, 'y']] },
        ],
      },
      steps,
    );
    expect(r.arityMismatches).toEqual(['short']);
    expect(r.seeded).toEqual(['short']);
    expect(steps.join('\n')).toMatch(/declares 3 column\(s\) but sample rows carry 2 value\(s\)/);

    // The table is still real, and the missing column is NULL rather than absent.
    const log = fs.bytes.get(`${ROOT}/Tables/short/${DELTA_FIRST_COMMIT}`)!.toString('utf-8');
    const add = JSON.parse(log.trim().split('\n')[2]).add;
    expect(JSON.parse(add.stats).nullCount).toEqual({ a: 0, b: 0, c: 2 });
  });

  it('counts a failed table write instead of only logging it', async () => {
    // The exact defect #3905 records: `steps.push('… failed …')` and continue,
    // with nothing in the return value that a caller could gate on.
    fs.failWriteOn = /Tables\/orders\/part-/;
    const steps: string[] = [];
    const r = await seedLakehouseAdls('landing' as never, ROOT, CONTENT, steps);

    expect(r.seeded).toEqual([]);
    expect(r.failedTables).toEqual(['orders']);
    expect(r.expectedSeedTables).toBe(1);
    expect(steps.join('\n')).toMatch(/Delta write failed/);
    // No commit may exist for a table whose data file never landed.
    expect(fs.bytes.has(`${ROOT}/Tables/orders/${DELTA_FIRST_COMMIT}`)).toBe(false);
  });

  it('counts a failed folder create instead of only logging it', async () => {
    fs.failDirOn = /Files\/curated$/;
    const r = await seedLakehouseAdls('landing' as never, ROOT, CONTENT, []);
    expect(r.createdFolders).toEqual(['Files/raw']);
    expect(r.failedFolders).toEqual(['Files/curated']);
  });

  it('classifies a table-directory failure by what the bundle PROMISED', async () => {
    // A table with rows cannot seed without its directory -> failed TABLE (the
    // caller's gate must see it). A schema-only table's directory is
    // browsability, not data -> failed FOLDER, which keeps it out of the fatal
    // path for the same reason a declared folder's 409 is not fatal.
    fs.failDirOn = /Tables\/(orders|customers)$/;
    const r = await seedLakehouseAdls('landing' as never, ROOT, CONTENT, []);
    expect(r.failedTables).toEqual(['orders']);
    expect(r.failedFolders).toEqual(['Tables/customers']);
    expect(r.emptyTables).toEqual([]);
  });

  it('still short-circuits a 401/403 into authGate', async () => {
    fs.failWriteOn = /part-/;
    fs.failWriteStatus = 403;
    const r = await seedLakehouseAdls('landing' as never, ROOT, CONTENT, []);
    expect(r.authGate?.status).toBe(403);
  });

  it('hands the per-table hook the Delta table directory, not a CSV path', async () => {
    const seen: Array<{ name: string; tablePath: string; rowCount: number }> = [];
    await seedLakehouseAdls('landing' as never, ROOT, CONTENT, [], async (t) => {
      seen.push({ name: t.name, tablePath: t.tablePath, rowCount: t.rowCount });
    });
    // The Synapse view is registered with FORMAT='DELTA' over this path, which
    // is the same read `synapse-catalog-client.countRows` performs.
    expect(seen).toEqual([{ name: 'orders', tablePath: `${ROOT}/Tables/orders`, rowCount: 3 }]);
  });
});
