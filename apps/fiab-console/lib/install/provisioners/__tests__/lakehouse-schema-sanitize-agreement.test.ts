/**
 * #3920 (part 2) — the schema-sanitize rule must have ONE answer, and the
 * writer and the reader must agree about where the data is.
 *
 * WHAT THE ISSUE DESCRIBED, AND WHAT IS ACTUALLY AT HEAD.
 * The issue reported ONE rule in THREE copies, two of which disagreed:
 *   `_seed-lakehouse-adls.ts`      `replace(/[^A-Za-z0-9_]/g, '_')`  -> `ops_eu`
 *   `app/api/apps/[id]/install/route.ts` `replace(/[^A-Za-z0-9_]/g, '')` -> `opseu`
 * Measured at head, that divergence is GONE, but not by the fix the issue
 * proposed (one exported sanitizer imported by three sites). #3904/#3911/#3919
 * deleted the two re-derivations outright: the install route and the lakehouse
 * editor now READ the recorded `secondaryIds.seedCsvPaths` through the single
 * `seedCsvPathLookup`, and the seeder hands its ALREADY-SANITIZED schema to the
 * per-table hook as `SeededTable.schema`. One call site is a stronger result
 * than three that agree — derive once and pass the value, rather than share a
 * function three callers may each stop calling.
 *
 * WHY THIS TEST EXISTS ANYWAY. Nothing asserted that the seeder keeps deriving
 * the schema ONCE and passing the value, rather than re-deriving it per consumer.
 * The structural fix was a side effect of three other issues, so a re-introduced
 * re-derivation would restore the divergence — which is precisely the failure the
 * issue filed ("a rule implemented more than once with nothing asserting the
 * copies agree"). The issue asked for exactly this: an assertion over a HOSTILE
 * input, not three unit tests of the same regex.
 *
 * WHAT THIS SUITE DOES AND DOES NOT SEE, STATED EXACTLY. It imports
 * `_seed-lakehouse-adls` and `report-binding`. It pins (a) the seeder's single
 * derivation — the schema in the table PATH is the same string handed to the
 * per-table hook — and (b) that the reader BOTH consumers use,
 * `seedCsvPathLookup`, resolves the seeder's recorded path for a hostile schema,
 * and returns `undefined` — never a rebuilt path — when keyed with the DELETED
 * sanitizer's form. It does NOT import `app/api/apps/[id]/install/route.ts` or
 * `lakehouse-editor-shell.tsx`, so it CANNOT prove those two modules keep
 * CALLING that reader. A consumer that re-introduced its own re-derivation would
 * pass this suite unchanged; what arm (b) buys is that such a consumer ends up
 * with an UNBINDABLE table rather than a stored path the data is not at. Holding
 * the consumers to the reader is a separate assertion this suite does not make.
 *
 * WHY A HOSTILE INPUT IS REQUIRED. The one pre-existing `schemasEnabled` test
 * (`lib/azure/__tests__/auto-bind-seed-siblings.test.ts`) uses schema `sales`,
 * which both historical sanitizers map to `sales`. A benign fixture cannot
 * reach this bug at all. `ops-eu` is the input that separates them:
 * `ops_eu` (seeder) vs `opseu` (route).
 *
 * REACHABILITY, STATED HONESTLY. Re-measured at head: `listBundleIds()` returns
 * 29 bundles and 0 of them set `schemasEnabled: true`, so this branch is
 * author-reachable, not user-reachable — the same conclusion the issue drew. It
 * is also why the branch had no hostile-input coverage: nothing exercises it in
 * production.
 *
 * MUTATION PROOF (break the subject, watch these go red, restore):
 *   a) In `_seed-lakehouse-adls.ts` pass the RAW schema to the hook
 *      (`schema: String(t.schema || 'dbo')` instead of `schema: tSchema`) ->
 *      RED: "the schema in the table PATH and the schema handed to the view
 *      hook are the same string".
 *   b) Change the seeder's sanitizer to the install route's old
 *      `replace(/[^A-Za-z0-9_]/g, '')` -> RED: "a hostile schema sanitizes to
 *      the underscore form, not the deleted form" (the agreement arm alone
 *      would stay green, which is why both arms are here).
 *   c) In `report-binding.ts` make `seedCsvPathLookup` rebuild the path from a
 *      naming convention instead of reading the recorded map -> RED: "the
 *      recorded CSV path round-trips through the reader both consumers use".
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const written = { dirs: [] as string[], files: [] as string[] };

vi.mock('@/lib/azure/adls-client', () => ({
  KNOWN_CONTAINERS: ['bronze', 'silver', 'gold', 'landing', 'csv-imports'],
  createDirectory: vi.fn(async (_c: string, path: string) => {
    written.dirs.push(path);
    return { ok: true };
  }),
  uploadFile: vi.fn(async (_c: string, path: string, body: Buffer) => {
    written.files.push(path);
    return { ok: true, size: body.length };
  }),
  getAccountName: vi.fn(() => 'fakeacct'),
  pathToHttpsUrl: vi.fn((c: string, p: string) => `https://fakeacct.dfs.core.windows.net/${c}/${p}`),
  resolveAbfssRoot: vi.fn((c: string, r: string) => `abfss://${c}@fakeacct.dfs.core.windows.net/${r}`),
}));

vi.mock('@/lib/azure/synapse-sql-client', () => ({
  executeQuery: vi.fn(async () => ({ rows: [] })),
  serverlessTarget: vi.fn(() => ({ server: 's', database: 'd' })),
}));

import { seedLakehouseAdls, type SeededTable } from '../_seed-lakehouse-adls';
import { seedCsvPathLookup } from '@/lib/install/report-binding';

/** The schema name that separated the two historical sanitizers. */
const HOSTILE = 'ops-eu';
const UNDERSCORE_FORM = 'ops_eu'; // seeder's `replace(…, '_')`
const DELETED_FORM = 'opseu';     // install route's old `replace(…, '')`

const CONTENT = {
  kind: 'lakehouse' as const,
  schemasEnabled: true,
  deltaTables: [
    { name: 'orders', schema: HOSTILE, ddl: 'CREATE TABLE orders ( id BIGINT )', sampleRows: [[1]] },
  ],
};

async function seedAndCapture(): Promise<SeededTable[]> {
  const seen: SeededTable[] = [];
  await seedLakehouseAdls('landing' as never, 'lakehouses/sales', CONTENT, [], async (t) => {
    seen.push(t);
  });
  return seen;
}

beforeEach(() => {
  written.dirs = [];
  written.files = [];
});

describe('lakehouse schema sanitize — one rule, one answer (#3920)', () => {
  it('a hostile schema sanitizes to the underscore form, not the deleted form', async () => {
    const seen = await seedAndCapture();
    expect(seen).toHaveLength(1);
    expect(seen[0].schema).toBe(UNDERSCORE_FORM);
    // The other historical sanitizer's output must NOT be what we produce —
    // this is the arm that pins WHICH rule won, so a silent swap is caught.
    expect(seen[0].schema).not.toBe(DELETED_FORM);
  });

  it('the schema in the table PATH and the schema handed to the view hook are the same string', async () => {
    // THE invariant. The Synapse view is registered as `${t.schema}.${leaf}`
    // (lakehouse.ts) while the Delta bytes land under `Tables/<schema>/<name>`
    // (this module). If those two schemas differ, the view names a location the
    // data is not at — "the writer and the reader silently disagree about where
    // the data is", which is the consequence the issue filed.
    const seen = await seedAndCapture();
    const hookSchema = seen[0].schema;

    // Derived from what was really written, not restated from the fixture.
    const tableDir = seen[0].tablePath;
    expect(tableDir).toBe(`lakehouses/sales/Tables/${hookSchema}/orders`);
    expect(written.dirs).toContain(`lakehouses/sales/Tables/${hookSchema}/orders`);

    // …and the path segment really is the sanitized schema, so this cannot pass
    // by both sides being equally wrong in some unsanitized way.
    const segment = tableDir.split('/').at(-2);
    expect(segment).toBe(UNDERSCORE_FORM);
    expect(segment).toBe(hookSchema);
  });

  it('the seeded Delta bytes land under the SAME schema segment', async () => {
    // The parquet + _delta_log writes must be under the same namespaced dir;
    // otherwise the directory exists at one schema and the data at another.
    const seen = await seedAndCapture();
    const prefix = `lakehouses/sales/Tables/${seen[0].schema}/orders/`;
    expect(written.files.filter((f) => f.startsWith(prefix)).length).toBeGreaterThan(0);
    expect(seen[0].dataPath.startsWith(prefix)).toBe(true);
  });

  it('the recorded CSV path round-trips through the reader both consumers use', async () => {
    // The writer→reader half of the invariant. `lakehouse.ts` stamps
    // `secondaryIds.seedCsvPaths` keyed `<schema>.<table>` from the SeededTable
    // this seeder hands back; `app/api/apps/[id]/install/route.ts` and
    // `lakehouse-editor-shell.tsx` both read it back through `seedCsvPathLookup`.
    // Building the map here from what the seeder ACTUALLY produced — not from
    // the fixture — is what makes this an agreement test rather than two
    // restatements of the same literal.
    const seen = await seedAndCapture();
    const t = seen[0];
    expect(t.csvPath, 'the seeder must record a CSV path to bind against').toBeTruthy();

    const secondaryIds = {
      seedCsvPaths: JSON.stringify({ [t.schema ? `${t.schema}.${t.name}` : t.name]: t.csvPath }),
    };
    const lookup = seedCsvPathLookup(secondaryIds);

    // Keyed the way the writer wrote it.
    expect(lookup(`${UNDERSCORE_FORM}.orders`)).toBe(t.csvPath);

    // Keyed by the bare leaf — the documented recovery path, which is exact
    // because it never reproduces either sanitizer.
    expect(lookup('orders')).toBe(t.csvPath);

    // …and keyed the way a consumer that re-derived the schema with the DELETED
    // sanitizer would ask: ABSENT, not a rebuilt path. Measured, not assumed —
    // the leaf recovery is keyed on the bare leaf, so `opseu.orders` matches
    // neither the recorded key nor the leaf map. That is the no-vaporware
    // outcome this module documents ("Absent is the honest answer; wrong is
    // not"): a re-introduced re-derivation makes the table unbindable, it does
    // NOT persist an OPENROWSET over a URL that 404s.
    expect(lookup(`${DELETED_FORM}.orders`)).toBeUndefined();

    // A table nobody recorded is `undefined` too. Without this arm a lookup that
    // returned a convention-built path for EVERYTHING would satisfy the first
    // two assertions.
    expect(lookup('never_seeded')).toBeUndefined();
  });

  it('schemasEnabled:false yields no schema segment at all', async () => {
    // The control. Without it, a sanitizer that returned '' for everything
    // would pass the arms above by collapsing both sides identically.
    const seen: SeededTable[] = [];
    await seedLakehouseAdls(
      'landing' as never,
      'lakehouses/sales',
      { ...CONTENT, schemasEnabled: false },
      [],
      async (t) => { seen.push(t); },
    );
    expect(seen[0].schema).toBe('');
    expect(seen[0].tablePath).toBe('lakehouses/sales/Tables/orders');
  });
});
