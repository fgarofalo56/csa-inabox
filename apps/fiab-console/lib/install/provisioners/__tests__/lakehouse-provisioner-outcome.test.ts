/**
 * #3905 — `provisionAzureNative` must not report 'created' having written
 * nothing.
 *
 * Until 2026-08-22 the Azure-native lakehouse path returned status:'created'
 * unconditionally. `createdFolders`, `seeded` and `emptyTables` were computed
 * and then used ONLY to build a log line and `secondaryIds`; every per-folder
 * and per-table failure was a `steps.push` and continue. Only a 401/403 could
 * change the return. Because `provisioning-engine` aggregates returned
 * statuses, `outcome:'all-created'` — and a job status of `done` — was close to
 * arithmetically guaranteed regardless of what reached the data plane.
 *
 * The gate copied here is `kql-db.ts`'s: gate on real counters, report the
 * total-miss case first, keep `resourceId` + `secondaryIds` on the failure.
 *
 * MUTATION PROOF (break the subject, watch these go red, restore):
 *   a) Delete the two `if (…) return { status: 'failed', … }` blocks at the end
 *      of `provisionAzureNative` -> RED:
 *        "fails when every declared table seed failed"
 *        "fails when ONE table of several failed"
 *   b) Weaken the second gate to `failedTables.length > 1` -> RED:
 *        "fails when ONE table of several failed"
 *      (i.e. the gate is not satisfied merely by the all-fail case — the
 *      narrow, partial failure is what a status fix usually misses.)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

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
vi.mock('@/lib/azure/synapse-sql-client', () => ({
  executeQuery: vi.fn(async () => ({ rows: [] })),
  serverlessTarget: vi.fn(() => ({ server: 's', database: 'd' })),
}));

const adls = {
  dirs: [] as string[],
  files: [] as string[],
  failWriteOn: null as RegExp | null,
  failDirOn: null as RegExp | null,
  failDirStatus: 500,
};

vi.mock('@/lib/azure/adls-client', () => ({
  KNOWN_CONTAINERS: ['bronze', 'silver', 'gold', 'landing', 'csv-imports'],
  createDirectory: vi.fn(async (_c: string, path: string) => {
    if (adls.failDirOn?.test(path)) {
      throw Object.assign(new Error('dir denied'), { statusCode: adls.failDirStatus });
    }
    adls.dirs.push(path);
    return { ok: true };
  }),
  uploadFile: vi.fn(async (_c: string, path: string, body: Buffer) => {
    if (adls.failWriteOn?.test(path)) throw Object.assign(new Error('write denied'), { statusCode: 500 });
    adls.files.push(path);
    return { ok: true, size: body.length };
  }),
  listContainers: vi.fn(async () => [{ name: 'landing' }]),
  pathToHttpsUrl: vi.fn((c: string, p: string) => `https://fakeacct.dfs.core.windows.net/${c}/${p}`),
  resolveAbfssRoot: vi.fn((c: string, r: string) => `abfss://${c}@fakeacct.dfs.core.windows.net/${r}`),
}));

import { lakehouseProvisioner } from '../lakehouse';

const TABLE = (name: string) => ({
  name,
  ddl: `CREATE TABLE ${name} ( id BIGINT, label STRING )`,
  sampleRows: [[1, 'a'], [2, 'b']],
});

function input(content: unknown) {
  return {
    session: { claims: { oid: 'o' } } as any,
    target: { mode: 'shared' as const, lakehouseBackend: 'adls' as const },
    cosmosItemId: 'lh-1',
    workspaceId: 'w',
    displayName: 'Sales Lakehouse',
    appId: 'app-test',
    content,
  };
}

beforeEach(() => {
  adls.dirs = [];
  adls.files = [];
  adls.failWriteOn = null;
  adls.failDirOn = null;
  adls.failDirStatus = 500;
  delete process.env.LOOM_SYNAPSE_WORKSPACE;
});

describe('lakehouse provisioner — the status reflects the outcome', () => {
  it('reports created when the folders and every declared table actually landed', async () => {
    const r = await lakehouseProvisioner(
      input({ folders: [{ path: 'Files/raw' }], deltaTables: [TABLE('orders'), TABLE('returns')] }) as any,
    );
    expect(r.status).toBe('created');
    expect(r.secondaryIds?.seededTables).toBe('orders,returns');
    expect(r.secondaryIds?.failedTables).toBeUndefined();
  });

  it('fails when every declared table seed failed', async () => {
    adls.failWriteOn = /part-/;
    const r = await lakehouseProvisioner(
      input({ folders: [{ path: 'Files/raw' }], deltaTables: [TABLE('orders'), TABLE('returns')] }) as any,
    );
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/all 2 declared Delta table seed\(s\) failed/);
    // The receipt still names what WAS created — a failure is not a black hole.
    expect(r.resourceId).toMatch(/^landing\//);
    expect(r.secondaryIds?.failedTables).toBe('orders,returns');
  });

  it('fails when ONE table of several failed', async () => {
    // The narrow case a status fix usually misses: a gate that only trips when
    // EVERYTHING fails still reports 'created' for a half-built lakehouse.
    adls.failWriteOn = /Tables\/returns\/part-/;
    const r = await lakehouseProvisioner(
      input({ folders: [{ path: 'Files/raw' }], deltaTables: [TABLE('orders'), TABLE('returns')] }) as any,
    );
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/INCOMPLETE/);
    expect(r.error).toMatch(/returns/);
    expect(r.secondaryIds?.seededTables).toBe('orders');
    expect(r.secondaryIds?.failedTables).toBe('returns');
  });

  it('surfaces a non-auth folder failure in the receipt without failing the install', async () => {
    // SCOPE BOUNDARY, asserted rather than assumed. A non-auth folder-create
    // failure stays non-fatal — `lib/install/__tests__/lakehouse-extraction-
    // behaviour.test.ts` pins that decision with its rationale ("the right
    // answer for anything a grant would not fix"), and this change does not
    // reverse it. What changed is that the failure is now COUNTED and lands on
    // the receipt, so the post-provision validation pass #3905 asks for can gate
    // on it instead of re-deriving it.
    adls.failDirOn = /Files\/curated$/;
    const r = await lakehouseProvisioner(
      input({ folders: [{ path: 'Files/raw' }, { path: 'Files/curated' }], deltaTables: [TABLE('orders')] }) as any,
    );
    expect(r.status).toBe('created');
    expect(r.secondaryIds?.failedFolders).toBe('Files/curated');
    expect(r.secondaryIds?.folders).toBe('Files/raw');
  });

  it('still reports created for a bundle that declares tables with no sample rows', async () => {
    // `expectedSeedTables` counts only tables we PROMISED to seed, so a bundle
    // whose tables are schema-only is not a failure — it never claimed rows.
    const r = await lakehouseProvisioner(
      input({ folders: [], deltaTables: [{ name: 'skeleton', ddl: 'CREATE TABLE skeleton ( id BIGINT )' }] }) as any,
    );
    expect(r.status).toBe('created');
    expect(r.secondaryIds?.emptyTables).toBe('skeleton');
  });

  it('still reports the precise RBAC remediation on a 403, not a bare failure', async () => {
    // Driven through the fake's own switch rather than by reassigning the mocked
    // module's export: that reassignment is permanent for the rest of the FILE,
    // so every test declared after it would silently run against a 403 ADLS.
    adls.failDirOn = /.*/;
    adls.failDirStatus = 403;
    const r = await lakehouseProvisioner(input({ deltaTables: [TABLE('orders')] }) as any);
    expect(r.status).toBe('remediation');
    expect(r.gate?.remediation).toMatch(/Storage Blob Data Contributor/);
  });
});

/**
 * The seed CSV moved to `Files/_seed/` in #3904. Two consumers RE-DERIVE the old
 * `Tables/<name>/<name>.csv` location instead of reading it:
 *
 *   - `app/api/apps/[id]/install/route.ts` builds the path and persists it into
 *     every auto-bound report's `dataSource` as an `OPENROWSET(… FORMAT='CSV')`
 *     URL — so a wrong path is not a transient 404, it is a stored one.
 *   - `lib/editors/lakehouse/lakehouse-editor-shell.tsx` does the same.
 *
 * Their derivations do not even agree with each other: the install route
 * sanitizes a schema with `replace(/[^A-Za-z0-9_]/g, '')`, the seeder with
 * `'_'`. Three copies of one rule is why the recorded value exists.
 *
 * These tests pin the RECORD, not the consumers (which are a follow-up in files
 * this work item does not own).
 *
 * MUTATION PROOF:
 *   a) Delete the `seedCsvPaths.set(...)` line in the hook -> RED (all four).
 *   b) Move that line BELOW the `if (!synapse) return` -> RED:
 *        "records the seed CSV path when Synapse is NOT configured"
 *      and GREEN on the with-Synapse test — which is the whole point of (b):
 *      the inert-in-the-common-case version passes a naive test.
 */
describe('lakehouse provisioner — the seed CSV path is RECORDED, not re-derivable', () => {
  const recorded = (r: any): Record<string, string> => JSON.parse(r.secondaryIds!.seedCsvPaths);

  it('records the seed CSV path when Synapse is NOT configured', async () => {
    // THE trap. `LOOM_SYNAPSE_WORKSPACE` is unset here (beforeEach) — the usual
    // Azure-native state and the one the demo deploy runs in. The recording hook
    // sits above the hook's `if (!synapse) return`, so it still fires.
    expect(process.env.LOOM_SYNAPSE_WORKSPACE).toBeUndefined();
    const r = await lakehouseProvisioner(input({ deltaTables: [TABLE('orders'), TABLE('returns')] }) as any);

    expect(r.status).toBe('created');
    expect(Object.keys(recorded(r)).sort()).toEqual(['orders', 'returns']);
  });

  it('records it with Synapse configured too — the control for the trap above', async () => {
    // Without this pair, mutation (b) (recording moved below `if (!synapse)
    // return`) is invisible: it leaves THIS test green and only the unset case
    // red. Two arms make the difference observable.
    process.env.LOOM_SYNAPSE_WORKSPACE = 'syn-test';
    const r = await lakehouseProvisioner(input({ deltaTables: [TABLE('orders')] }) as any);

    expect(r.status).toBe('created');
    expect(recorded(r).orders).toMatch(/\/Files\/_seed\/orders\.csv$/);
    // …and the Synapse view really was registered, so the hook ran to the end.
    expect(r.secondaryIds?.synapseViews).toBe('lakehouse.orders');
  });

  it('records a path that a blob ACTUALLY EXISTS at', async () => {
    // Read-back, not shape-check: the recorded value is compared against what
    // the ADLS client was really asked to write. A test that only asserted the
    // key was present would pass on a recorded path that is still a guess.
    const r = await lakehouseProvisioner(input({ deltaTables: [TABLE('orders')] }) as any);
    const path = recorded(r).orders;

    expect(adls.files).toContain(path);
    expect(path).toMatch(/\/Files\/_seed\/orders\.csv$/);
    expect(path.startsWith(`${r.secondaryIds!.rootPath}/`)).toBe(true);
  });

  it('the path the two consumers currently re-derive does NOT exist', async () => {
    // Why the follow-up must consume the recorded value rather than be left
    // alone. This is the exact string `install/route.ts:562` builds.
    const r = await lakehouseProvisioner(input({ deltaTables: [TABLE('orders')] }) as any);
    const derived = `${r.secondaryIds!.rootPath}/Tables/orders/orders.csv`;

    expect(adls.files).not.toContain(derived);
    expect(recorded(r).orders).not.toBe(derived);
  });

  it('keys by <schema>.<table> when schemas are enabled, and survives a comma in a name', async () => {
    // JSON rather than `k=v,k=v`: `safeAdlsRelPath` is structural, not
    // charset-based, so a comma survives into both key and path. A lakehouse or
    // table named with one would silently corrupt a comma-split encoding.
    const r = await lakehouseProvisioner(
      input({
        schemasEnabled: true,
        deltaTables: [
          { ...TABLE('orders'), schema: 'sales' },
          { ...TABLE('Sales, EMEA'), schema: 'sales' },
        ],
      }) as any,
    );
    const map = recorded(r);
    expect(map['sales.orders']).toMatch(/\/Files\/_seed\/sales\.orders\.csv$/);
    expect(map['sales.Sales, EMEA']).toContain('Sales, EMEA');
    expect(adls.files).toContain(map['sales.Sales, EMEA']);
  });

  it('omits the key entirely when nothing seeded, rather than recording an empty map', async () => {
    const r = await lakehouseProvisioner(
      input({ deltaTables: [{ name: 'skeleton', ddl: 'CREATE TABLE skeleton ( id BIGINT )' }] }) as any,
    );
    expect(r.secondaryIds?.seedCsvPaths).toBeUndefined();
  });
});
