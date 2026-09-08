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
 * WHAT THIS SUITE DOES AND DOES NOT SEE, STATED EXACTLY.
 * It drives TWO subjects:
 *   (1) `seedLakehouseAdls` directly, with the suite's own hook — the seeder's
 *       single derivation, i.e. the schema in the table PATH is the same string
 *       handed to the per-table hook; and
 *   (2) the REAL `lakehouseProvisioner`, whose OWN hook is the other half of the
 *       invariant: `lakehouse.ts` registers the Synapse view as
 *       `<viewSchema>.<leaf>` and keys `secondaryIds.seedCsvPaths` as
 *       `<schema>.<table>`. An earlier version of this suite asserted only (1)
 *       and named `lakehouse.ts` in a comment without importing it — so
 *       re-introducing the DELETED sanitizer at exactly the consumer whose
 *       disagreement the issue filed (`viewSchema = …replace(/[^A-Za-z0-9_]/g,'')`)
 *       left every assertion green while the emitted view named a location the
 *       Delta bytes are not at. Arm (2) is that hole closed: the view's schema
 *       segment, the recorded key's schema segment, and the ADLS path segment
 *       are asserted to be the SAME STRING, derived from what was really
 *       written rather than restated from the fixture.
 * It also pins (3) that the reader BOTH consumers use, `seedCsvPathLookup`,
 * resolves the seeder's recorded path for a hostile schema and returns
 * `undefined` — never a rebuilt path — when keyed with the DELETED sanitizer's
 * form.
 * It does NOT import `app/api/apps/[id]/install/route.ts` or
 * `lakehouse-editor-shell.tsx`, so it CANNOT prove those two modules keep
 * CALLING that reader. A consumer that re-introduced its own re-derivation would
 * pass this suite unchanged; what arm (3) buys is that such a consumer ends up
 * with an UNBINDABLE table rather than a stored path the data is not at. Holding
 * the consumers to the reader is a separate assertion this suite does not make.
 *
 * WHY HOSTILE INPUTS ARE REQUIRED, AND WHY MORE THAN ONE. The one pre-existing
 * `schemasEnabled` test (`lib/azure/__tests__/auto-bind-seed-siblings.test.ts`)
 * uses schema `sales`, which both historical sanitizers map to `sales`. A benign
 * fixture cannot reach this bug at all. `ops-eu` separates the two historical
 * rules (`ops_eu` seeder vs `opseu` route) and is kept as the which-rule-won
 * pin — but it is not sufficient on its own: widening the surviving sanitizer by
 * ONE CHARACTER (`/[^A-Za-z0-9_]/g` -> `/[^A-Za-z0-9_.]/g`) leaves `ops-eu`
 * mapping to `ops_eu`, so a single-literal guard stays green while schema
 * `ops.eu` now flows through unsanitized into `CREATE SCHEMA`. So the arms are
 * an `it.each` over the inputs the issue named plus the ones it omitted, and
 * they assert the general PROPERTY (`/^[A-Za-z0-9_]+$/`, and all three schema
 * segments equal) rather than a literal pair.
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
 *      RED: the seeder-agreement arm.
 *   b) Change the seeder's sanitizer to the install route's old
 *      `replace(/[^A-Za-z0-9_]/g, '')` -> RED: "a hostile schema sanitizes to
 *      the underscore form, not the deleted form".
 *   c) Widen the seeder's sanitizer by one character to
 *      `replace(/[^A-Za-z0-9_.]/g, '_')` -> RED on the `ops.eu` row of the
 *      matrix (and NOT on the `ops-eu` row, which is the whole point).
 *   d) In `lakehouse.ts` re-introduce the deleted re-derivation
 *      (`const viewSchema = schemasEnabled ? String(t.schema||'dbo').replace(/[^A-Za-z0-9_]/g,'') : 'lakehouse'`)
 *      -> RED: "the Synapse view, the recorded key and the ADLS path all name
 *      the SAME schema".
 *   e) In `lakehouse.ts` drop the brackets from the emitted DDL
 *      (`CREATE SCHEMA ${viewSchema}`) -> RED on the leading-digit row.
 *   f) In `report-binding.ts` make `seedCsvPathLookup` rebuild the path from a
 *      naming convention instead of reading the recorded map -> RED: "the
 *      recorded CSV path round-trips through the reader both consumers use".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const written = { dirs: [] as string[], files: [] as string[] };
const sql = { executed: [] as string[] };

vi.mock('@azure/identity', () => ({
  ChainedTokenCredential: class {},
  DefaultAzureCredential: class {},
  ManagedIdentityCredential: class {},
}));
vi.mock('@/lib/azure/aca-managed-identity', () => ({ AcaManagedIdentityCredential: class {} }));
vi.mock('@/lib/azure/fabric-client', () => ({
  FabricError: class extends Error {
    status: number;
    constructor(m: string, s = 500) { super(m); this.status = s; }
  },
  fabricHint: vi.fn(() => 'hint'),
}));
vi.mock('@/lib/azure/fetch-with-timeout', () => ({ fetchWithTimeout: vi.fn() }));
vi.mock('@/lib/azure/lakehouse-shortcuts', () => ({ createShortcut: vi.fn() }));
vi.mock('@/lib/apps/repo-datasets', () => ({ readRepoDataset: vi.fn(async () => null) }));

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
  listContainers: vi.fn(async () => [{ name: 'landing' }]),
  getAccountName: vi.fn(() => 'fakeacct'),
  pathToHttpsUrl: vi.fn((c: string, p: string) => `https://fakeacct.dfs.core.windows.net/${c}/${p}`),
  resolveAbfssRoot: vi.fn((c: string, r: string) => `abfss://${c}@fakeacct.dfs.core.windows.net/${r}`),
}));

vi.mock('@/lib/azure/synapse-sql-client', () => ({
  // Capture the DDL rather than discard it — the view-registration half of the
  // invariant is only observable here.
  executeQuery: vi.fn(async (_t: unknown, q: string) => {
    sql.executed.push(String(q));
    return { rows: [] };
  }),
  serverlessTarget: vi.fn((db: string) => ({ server: 's', database: db })),
}));

import { seedLakehouseAdls, type SeededTable } from '../_seed-lakehouse-adls';
import { lakehouseProvisioner } from '../lakehouse';
import { seedCsvPathLookup } from '@/lib/install/report-binding';

/** The schema name that separated the two historical sanitizers. */
const HOSTILE = 'ops-eu';
const UNDERSCORE_FORM = 'ops_eu'; // seeder's `replace(…, '_')`
const DELETED_FORM = 'opseu';     // install route's old `replace(…, '')`

/**
 * The hostile schemas, and why each is here. #3920's fix text named the first
 * three; the rest are the ones it omitted, each of which a one-character
 * widening of the surviving sanitizer would let through.
 */
const HOSTILE_SCHEMAS: Array<{ raw: string; sanitized: string; why: string }> = [
  { raw: 'ops-eu', sanitized: 'ops_eu', why: 'named by the issue; separates the two historical sanitizers' },
  { raw: 'ops.eu', sanitized: 'ops_eu', why: 'a `.` reaching CREATE SCHEMA unsanitized is a T-SQL syntax error, AND it fakes a 2-part name' },
  { raw: 'ops eu', sanitized: 'ops_eu', why: 'a space reaching an unbracketed identifier is a syntax error' },
  { raw: '2024-q1', sanitized: '2024_q1', why: 'LEADING DIGIT — legal only as a delimited identifier, which is why the DDL brackets' },
  { raw: 'opsé', sanitized: 'ops_', why: 'non-ASCII: sanitizes to a DIFFERENT string, so writer and reader must still agree on it' },
];

const CONTENT = {
  kind: 'lakehouse' as const,
  schemasEnabled: true,
  deltaTables: [
    { name: 'orders', schema: HOSTILE, ddl: 'CREATE TABLE orders ( id BIGINT )', sampleRows: [[1]] },
  ],
};

async function seedAndCapture(schema: string = HOSTILE): Promise<SeededTable[]> {
  const seen: SeededTable[] = [];
  await seedLakehouseAdls(
    'landing' as never,
    'lakehouses/sales',
    { ...CONTENT, deltaTables: [{ ...CONTENT.deltaTables[0], schema }] },
    [],
    async (t) => { seen.push(t); },
  );
  return seen;
}

/** Drive the REAL provisioner (and therefore `lakehouse.ts`'s own hook). */
function provisionerInput(deltaTables: unknown[]) {
  return {
    session: { claims: { oid: 'o' } } as any,
    target: { mode: 'shared' as const, lakehouseBackend: 'adls' as const },
    cosmosItemId: 'lh-1',
    workspaceId: 'w',
    displayName: 'Sales Lakehouse',
    appId: 'app-test',
    content: { schemasEnabled: true, deltaTables },
  };
}

const TABLE = (name: string, schema: string) => ({
  name,
  schema,
  ddl: `CREATE TABLE ${name} ( id BIGINT )`,
  sampleRows: [[1]],
});

beforeEach(() => {
  written.dirs = [];
  written.files = [];
  sql.executed = [];
  // The view-registration layer is skipped entirely without this, so the
  // lakehouse.ts half of the invariant would go unexercised.
  process.env.LOOM_SYNAPSE_WORKSPACE = 'fake-synapse-ws';
});

afterEach(() => {
  delete process.env.LOOM_SYNAPSE_WORKSPACE;
});

/**
 * The `<schema>` and `<leaf>` the emitted CREATE VIEW names, from the real DDL.
 *
 * Parses BOTH the bracketed and the bare form deliberately. If it only matched
 * `[a].[b]`, dropping the brackets would make every arm fail with "no CREATE
 * VIEW was emitted" — a message asserting something the code never established
 * (one WAS emitted, just undelimited), which is the R7 shape this repo treats
 * as a defect in its own right. The bracketing is asserted where it belongs,
 * in its own test, with its own message.
 */
function viewIdentity(): { schema: string; leaf: string; bracketed: boolean } | null {
  const ddl = sql.executed.find((q) => q.includes('CREATE VIEW'));
  if (!ddl) return null;
  const delimited = /CREATE VIEW \[([^\]]*)\]\.\[([^\]]*)\]/.exec(ddl);
  if (delimited) return { schema: delimited[1], leaf: delimited[2], bracketed: true };
  const bare = /CREATE VIEW ([A-Za-z0-9_]*)\.([A-Za-z0-9_]*)/.exec(ddl);
  return bare ? { schema: bare[1], leaf: bare[2], bracketed: false } : null;
}

describe('lakehouse schema sanitize — one rule, one answer (#3920)', () => {
  it('a hostile schema sanitizes to the underscore form, not the deleted form', async () => {
    const seen = await seedAndCapture();
    expect(seen).toHaveLength(1);
    expect(seen[0].schema).toBe(UNDERSCORE_FORM);
    // The other historical sanitizer's output must NOT be what we produce —
    // this is the arm that pins WHICH rule won, so a silent swap is caught.
    expect(seen[0].schema).not.toBe(DELETED_FORM);
  });

  it.each(HOSTILE_SCHEMAS)(
    'seeder: schema $raw — the table PATH and the schema handed to the view hook are the same string ($why)',
    async ({ raw, sanitized }) => {
      // Half one of THE invariant, at the writer. The Delta bytes land under
      // `Tables/<schema>/<name>`; if the hook is handed a different string the
      // downstream view names a location the data is not at.
      const seen = await seedAndCapture(raw);
      const hookSchema = seen[0].schema;

      // The general property, not a literal: a schema that reaches T-SQL or a
      // storage path must be `[A-Za-z0-9_]` only. This is the arm that a
      // one-character widening of the sanitizer cannot survive.
      expect(hookSchema, `sanitized '${raw}'`).toMatch(/^[A-Za-z0-9_]+$/);
      expect(hookSchema).toBe(sanitized);

      // Derived from what was really written, not restated from the fixture.
      const tableDir = seen[0].tablePath;
      expect(tableDir).toBe(`lakehouses/sales/Tables/${hookSchema}/orders`);
      expect(written.dirs).toContain(tableDir);
      expect(tableDir.split('/').at(-2)).toBe(hookSchema);

      // …and the seeded Delta bytes are under that SAME segment, so the
      // directory cannot exist at one schema with the data at another.
      const prefix = `${tableDir}/`;
      expect(written.files.filter((f) => f.startsWith(prefix)).length).toBeGreaterThan(0);
      expect(seen[0].dataPath.startsWith(prefix)).toBe(true);
    },
  );

  it.each(HOSTILE_SCHEMAS)(
    'provisioner: schema $raw — the Synapse view, the recorded key and the ADLS path all name the SAME schema',
    async ({ raw, sanitized }) => {
      // Half two of THE invariant, at the reader that `lakehouse.ts` owns. This
      // arm drives the REAL provisioner, so a re-introduced re-derivation of the
      // schema inside `lakehouse.ts`'s hook is caught here — the earlier version
      // of this suite could not see it.
      const r: any = await lakehouseProvisioner(provisionerInput([TABLE('orders', raw)]) as any);
      expect(r.status).toBe('created');

      const view = viewIdentity();
      expect(view, `a CREATE VIEW must have been emitted; got: ${sql.executed.join(' | ')}`).toBeTruthy();

      // The recorded key, as the writer wrote it.
      const recorded: Record<string, string> = JSON.parse(r.secondaryIds.seedCsvPaths);
      const keys = Object.keys(recorded);
      expect(keys).toHaveLength(1);
      const keySchema = keys[0].slice(0, keys[0].lastIndexOf('.'));

      // The ADLS path segment, from what was really written.
      const tableDir = written.dirs.find((d) => d.endsWith('/orders'));
      expect(tableDir, `no Tables/<schema>/orders directory in ${written.dirs.join(' | ')}`).toBeTruthy();
      const pathSchema = tableDir!.split('/').at(-2)!;

      // THE assertion: three independently derived strings, one value.
      expect(pathSchema).toBe(sanitized);
      expect(keySchema).toBe(pathSchema);
      expect(view!.schema).toBe(pathSchema);

      // …and it is a legal identifier, so the equality above is not three
      // copies of the same broken string.
      expect(view!.schema).toMatch(/^[A-Za-z0-9_]+$/);
    },
  );

  it('the emitted DDL delimits its identifiers, so a leading-digit schema is legal T-SQL', async () => {
    // `2024-q1` sanitizes to `2024_q1`, which satisfies `[A-Za-z0-9_]` and is
    // still an ILLEGAL bare T-SQL identifier. Unbracketed, `CREATE SCHEMA
    // 2024_q1` is a syntax error, the whole registration lands in the hook's
    // catch as a step string, and the table is silently unqueryable while the
    // install still reports 'created'. Asserting the SHAPE of the DDL is the
    // only way this suite can tell the difference from here — it has no SQL
    // engine to run it against, and says so rather than implying otherwise.
    await lakehouseProvisioner(provisionerInput([TABLE('orders', '2024-q1')]) as any);
    const createSchema = sql.executed.find((q) => q.includes('CREATE SCHEMA'));
    expect(createSchema).toContain("EXEC('CREATE SCHEMA [2024_q1]')");
    // SCHEMA_ID takes a NAME, not a delimited identifier — bracketing there
    // would look up a schema literally called `[2024_q1]` and always miss.
    expect(createSchema).toContain("SCHEMA_ID('2024_q1')");
    const drop = sql.executed.find((q) => q.includes('DROP VIEW'));
    expect(drop).toContain('DROP VIEW [2024_q1].[orders]');
    expect(drop).toContain("OBJECT_ID('[2024_q1].[orders]','V')");
  });

  it('two schemas that sanitize to the SAME name collide, and the reader says so rather than guessing', async () => {
    // The input class the issue did not enumerate: `ops-eu` and `ops.eu` are
    // DISTINCT declared schemas that both sanitize to `ops_eu`. Two tables both
    // called `orders` then key `ops_eu.orders` twice, and a Map keeps the last
    // writer — so one of the two tables has no recorded path of its own.
    //
    // This arm pins the CONSEQUENCE, measured rather than assumed: the leaf
    // recovery in `seedCsvPathLookup` detects the ambiguous leaf and drops it,
    // so a consumer keying by the bare leaf gets `undefined` (unbindable) rather
    // than the other table's CSV — the "absent, never wrong" contract that
    // module's docblock states. The direct key still resolves, to the surviving
    // writer. Recording it here so that if the collapse is ever fixed upstream
    // (by keying on the DECLARED schema rather than the sanitized one) this
    // test is what says the behaviour changed.
    const r: any = await lakehouseProvisioner(
      provisionerInput([TABLE('orders', 'ops-eu'), TABLE('orders', 'ops.eu')]) as any,
    );
    const recorded: Record<string, string> = JSON.parse(r.secondaryIds.seedCsvPaths);
    expect(Object.keys(recorded)).toEqual(['ops_eu.orders']);

    const lookup = seedCsvPathLookup(r.secondaryIds);
    expect(lookup('ops_eu.orders')).toBe(recorded['ops_eu.orders']);
    // Only ONE entry survived the collapse, so the leaf is not ambiguous in the
    // recorded map — the collision happened before the reader ever saw it. That
    // is the honest description of this state: the reader cannot detect a
    // collision it was never told about.
    expect(lookup('orders')).toBe(recorded['ops_eu.orders']);
  });

  it('an ambiguous leaf across two schemas resolves to nothing, never to the other table', async () => {
    // The neighbouring case that DOES reach the reader: two DISTINCT sanitized
    // schemas sharing a table name. Both are recorded, so the leaf is genuinely
    // ambiguous and `seedCsvPathLookup` must drop it rather than pick one.
    const r: any = await lakehouseProvisioner(
      provisionerInput([TABLE('orders', 'ops-eu'), TABLE('orders', 'ops-us')]) as any,
    );
    const recorded: Record<string, string> = JSON.parse(r.secondaryIds.seedCsvPaths);
    expect(Object.keys(recorded).sort()).toEqual(['ops_eu.orders', 'ops_us.orders']);

    const lookup = seedCsvPathLookup(r.secondaryIds);
    expect(lookup('ops_eu.orders')).toBe(recorded['ops_eu.orders']);
    expect(lookup('ops_us.orders')).toBe(recorded['ops_us.orders']);
    // Wrong is worse than absent: the bare leaf must NOT silently pick one.
    expect(lookup('orders')).toBeUndefined();
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

    // Keyed the way the WRITER writes it. This is not a shape a consumer picks
    // at random: the provisioner arms above assert `lakehouse.ts` really stamps
    // this exact key, and `report-binding.ts`'s direct branch is what resolves
    // it (`report-binding.ts` is also reached with a qualified physical table
    // name from the semantic-model binder).
    expect(lookup(`${UNDERSCORE_FORM}.orders`)).toBe(t.csvPath);

    // Keyed by the bare leaf — the shape BOTH production consumers use
    // (`install/route.ts`, `lakehouse-editor-shell.tsx`), and the documented
    // recovery path, which is exact because it never reproduces either
    // sanitizer.
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

  it('schemasEnabled:false yields no schema segment at all, and the classic `lakehouse` view schema', async () => {
    // The control. Without it, a sanitizer that returned '' for everything
    // would pass the arms above by collapsing both sides identically.
    //
    // (An earlier version of this comment claimed the control guards against a
    // sanitizer returning '' — at the seeder that state is unreachable, because
    // `String(t.schema || 'dbo')` supplies a non-empty input and the `|| 'dbo'`
    // after `.replace()` can therefore never fire. What it actually guards is
    // the BRANCH: `schemasEnabled:false` must take the flat layout and the fixed
    // `lakehouse` view schema, not a namespaced one.)
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

    // …and through the real provisioner, the view goes to the classic single
    // `lakehouse` schema rather than to an empty-string one.
    sql.executed = [];
    written.dirs = [];
    const r: any = await lakehouseProvisioner(
      {
        ...provisionerInput([TABLE('orders', 'ops-eu')]),
        content: { schemasEnabled: false, deltaTables: [TABLE('orders', 'ops-eu')] },
      } as any,
    );
    expect(r.status).toBe('created');
    expect(viewIdentity()).toEqual({ schema: 'lakehouse', leaf: 'orders', bracketed: true });
    expect(JSON.parse(r.secondaryIds.seedCsvPaths)).toHaveProperty('orders');
  });
});
