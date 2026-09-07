/**
 * #3511 — a mirrored-database must DISCOVER its source tables, not demand a
 * hand-typed list.
 *
 * At head `provisionAdfCdc` read `content.source.tables` and nothing else. An
 * empty list became the single wildcard `dbo.*`, the per-table loop SKIPPED
 * every wildcard, `activities` stayed empty, and the item's terminal state was
 * the gate "No explicit source tables to copy to Bronze." — i.e. a form asking
 * the operator to type out the catalog of a database Loom had just built two
 * linked services against. `auto-bind-by-default.md` forbids exactly that: a
 * remediation the PLATFORM could have performed is a defect, and the platform
 * can read `sys.tables` over the connection it already has (the run-time path
 * `mirror-engine.ts:1219` and the per-item tables route both already do).
 *
 * MUTATION PROOF (break the subject, watch these go red, restore):
 *   a) In `mirrored-database.ts` restore `const useTables = tables.length ?
 *      tables : ['dbo.*']` and delete the discovery block -> RED:
 *        "discovers dbo tables and authors one Copy activity each"
 *        "records the discovered table list on the item so it is inspectable"
 *        "an empty table list still means dbo, not every schema"
 *      and the gate test flips back to the old message, so
 *        "the probe FAILING is reported as a probe failure, not as a missing list"
 *      goes red too.
 *   b) Swap the `catch` to `discovered = []` without setting `discoveryError`
 *      -> RED: "the probe FAILING is reported as a probe failure…" — the arm a
 *      naive fix collapses into the empty-catalog message, which would assert a
 *      cause the code never established (deploy-integrity R7).
 *   c) Move the discovery block BELOW the `explicitTables.length === 0` guard's
 *      effect by discovering unconditionally -> RED: "an explicit list is used
 *      verbatim and never re-discovered".
 *   d) In `mirrored-database.ts` replace `const MAX_DISCOVERED_TABLES =
 *      MAX_TABLES` with any literal above the run cap (e.g. the 200 it carried
 *      at head) -> RED: "the install-time cap IS the run-time cap, and the
 *      pipeline it authors matches" and "truncates a very large discovered set
 *      and SAYS it truncated" — the arm where the item's recorded provenance
 *      overstates what a Run actually mirrors (#4315).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = {
  listTablesWithAuth: vi.fn(async (_s: string, _d: string, _a?: any) => [] as any[]),
  upsertPipeline: vi.fn(async () => ({})),
  upsertDataset: vi.fn(async () => ({})),
  upsertLinkedService: vi.fn(async () => ({})),
  runPipeline: vi.fn(async () => ({ runId: 'run-1' })),
};

vi.mock('@/lib/azure/sql-objects-client', () => ({
  listTablesWithAuth: (...a: any[]) => (h.listTablesWithAuth as any)(...a),
}));
vi.mock('@/lib/azure/adf-client', () => ({
  adfConfigGate: vi.fn(() => null),
  upsertLinkedService: (...a: any[]) => (h.upsertLinkedService as any)(...a),
  upsertDataset: (...a: any[]) => (h.upsertDataset as any)(...a),
  upsertPipeline: (...a: any[]) => (h.upsertPipeline as any)(...a),
  runPipeline: (...a: any[]) => (h.runPipeline as any)(...a),
  getDefaultFactory: vi.fn(() => ({ subscriptionId: 's', resourceGroup: 'rg', factoryName: 'adf' })),
}));
vi.mock('@/lib/azure/adls-client', () => ({ resolveAbfssRoot: vi.fn(() => null) }));
vi.mock('@/lib/azure/cloud-endpoints', () => ({
  armBase: vi.fn(() => 'https://management.azure.com'),
  armScope: vi.fn(() => 'https://management.azure.com/.default'),
  dfsUrl: vi.fn((a: string) => `https://${a}.dfs.core.windows.net`),
}));
vi.mock('@/lib/azure/arm-credential', () => ({ uamiArmCredential: vi.fn(() => ({})) }));
vi.mock('@/lib/azure/role-grant-client', () => ({
  deterministicAssignmentGuid: vi.fn(() => 'guid'),
  grantScriptFor: vi.fn(() => 'az role assignment create ...'),
}));
vi.mock('@/lib/azure/fetch-with-timeout', () => ({ fetchWithTimeout: vi.fn() }));
vi.mock('@/lib/azure/fabric-client', () => ({
  listMirroredDatabases: vi.fn(async () => []),
  createMirroredDatabase: vi.fn(async () => ({})),
  startMirroredDatabase: vi.fn(async () => ({})),
  getMirroringStatus: vi.fn(async () => ({})),
  FabricError: class extends Error { status = 500; },
  fabricHint: vi.fn(() => 'hint'),
}));

import { mirroredDatabaseProvisioner } from '../mirrored-database';
import { decodeIdList } from '@/lib/install/secondary-id-list';
// #4315 — the RUN-time cap. The install-time discovery bound is an alias of it,
// so these assertions move together with `LOOM_MIRROR_MAX_TABLES` instead of
// pinning a second literal that could drift away from what a Run mirrors.
import { MAX_TABLES } from '@/lib/azure/mirror-adf-shared';

const row = (schema: string, name: string) => ({
  objectId: 1, schema, name, fullName: `${schema}.${name}`, type: 'U',
});

function input(tables: string[]) {
  return {
    session: { claims: { oid: 'o' } } as any,
    target: { mode: 'shared' as const, mirrorBackend: 'adf-cdc' as const, adlsAccount: 'acct' },
    cosmosItemId: 'md-1',
    workspaceId: 'w',
    displayName: 'Sales Mirror',
    appId: 'app-test',
    content: {
      kind: 'mirrored-database',
      source: { kind: 'azure-sql', server: 'src.database.windows.net', database: 'salesdb', tables },
    },
  } as any;
}

/** Every `Copy_<schema>_<table>` activity the provisioner handed upsertPipeline. */
function copiedTables(): string[] {
  const call = h.upsertPipeline.mock.calls.at(-1) as unknown as any[] | undefined;
  const acts = (call?.[1] as any)?.properties?.activities || [];
  return acts.map((a: any) => `${a.typeProperties?.source?.type}::${a.name}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.listTablesWithAuth.mockImplementation(async () => []);
  h.runPipeline.mockImplementation(async () => ({ runId: 'run-1' }));
  process.env.LOOM_ADLS_ACCOUNT = 'acct';
});

describe('mirrored-database — the source table list is discovered, not demanded', () => {
  it('discovers dbo tables and authors one Copy activity each', async () => {
    h.listTablesWithAuth.mockImplementation(async () => [row('dbo', 'orders')]);
    const r = await mirroredDatabaseProvisioner(input([]));

    expect(r.status).toBe('created');
    // It really enumerated the SOURCE the linked service points at.
    expect(h.listTablesWithAuth).toHaveBeenCalledWith('src.database.windows.net', 'salesdb', undefined);
    // …and the pipeline it authored copies exactly that table.
    expect(copiedTables()).toEqual(['AzureSqlSource::Copy_dbo_orders']);
  });

  it('records the discovered table list on the item so it is inspectable', async () => {
    // auto-bind §2 — a name the platform CHOSE has to be readable back off the
    // item, or the binding is a guess the operator cannot audit.
    h.listTablesWithAuth.mockImplementation(async () => [row('dbo', 'orders'), row('dbo', 'returns')]);
    const r = await mirroredDatabaseProvisioner(input([]));

    expect(r.status).toBe('created');
    expect(decodeIdList(r.secondaryIds?.discoveredTables)).toEqual(['dbo.orders', 'dbo.returns']);
    expect(r.secondaryIds?.tableSource).toBe('auto-discovered');
  });

  it('an empty table list still means dbo, not every schema', async () => {
    // The historical default was `dbo.*`; discovery must not silently widen the
    // blast radius of an item that was created before this change.
    h.listTablesWithAuth.mockImplementation(async () => [row('dbo', 'orders'), row('audit', 'events')]);
    const r = await mirroredDatabaseProvisioner(input([]));

    expect(r.status).toBe('created');
    expect(decodeIdList(r.secondaryIds?.discoveredTables)).toEqual(['dbo.orders']);
  });

  it("'*.*' opts into every user schema", async () => {
    h.listTablesWithAuth.mockImplementation(async () => [row('dbo', 'orders'), row('audit', 'events')]);
    const r = await mirroredDatabaseProvisioner(input(['*.*']));

    expect(r.status).toBe('created');
    expect(decodeIdList(r.secondaryIds?.discoveredTables)).toEqual(['dbo.orders', 'audit.events']);
  });

  it('an explicit list is used verbatim and never re-discovered', async () => {
    h.listTablesWithAuth.mockImplementation(async () => [row('dbo', 'everything_else')]);
    const r = await mirroredDatabaseProvisioner(input(['sales.orders']));

    expect(r.status).toBe('created');
    expect(h.listTablesWithAuth).not.toHaveBeenCalled();
    expect(copiedTables()).toEqual(['AzureSqlSource::Copy_sales_orders']);
    expect(r.secondaryIds?.discoveredTables).toBeUndefined();
  });

  it('the probe FAILING is reported as a probe failure, not as a missing list', async () => {
    // R7 — the message states what the code ESTABLISHED. A probe that threw
    // establishes "could not read the catalog", never "the catalog is empty"
    // and never "you did not type a list".
    h.listTablesWithAuth.mockImplementation(async () => { throw new Error('Login failed for user <token-identified principal>.'); });
    const r = await mirroredDatabaseProvisioner(input([]));

    expect(r.status).toBe('remediation');
    expect(r.gate?.reason).toMatch(/Could not read the source table catalog of src\.database\.windows\.net\/salesdb/);
    expect(r.gate?.reason).toMatch(/Login failed for user/);
    expect(r.gate?.reason).not.toMatch(/returned no user tables/);
    expect(r.gate?.remediation).toMatch(/db_datareader/);
    expect(h.upsertPipeline).not.toHaveBeenCalled();
  });

  it('a genuinely EMPTY catalog says so, and says what it probed', async () => {
    h.listTablesWithAuth.mockImplementation(async () => []);
    const r = await mirroredDatabaseProvisioner(input([]));

    expect(r.status).toBe('remediation');
    expect(r.gate?.reason).toMatch(/read successfully and returned no user tables matching dbo\.\*/);
    expect(r.gate?.reason).not.toMatch(/Could not read/);
  });

  it('truncates a very large discovered set and SAYS it truncated', async () => {
    h.listTablesWithAuth.mockImplementation(async () =>
      Array.from({ length: MAX_TABLES + 50 }, (_, i) => row('dbo', `t${i}`)));
    const r = await mirroredDatabaseProvisioner(input([]));

    expect(r.status).toBe('created');
    expect(decodeIdList(r.secondaryIds?.discoveredTables)).toHaveLength(MAX_TABLES);
    expect(r.secondaryIds?.tableSource).toBe('auto-discovered-truncated');
    expect((r.steps || []).join('\n')).toMatch(new RegExp(`Mirroring the first ${MAX_TABLES}`));
  });

  it('the install-time cap IS the run-time cap, and the pipeline it authors matches', async () => {
    // #4315 — the arm a divergent literal breaks. Discovery persists to
    // `secondaryIds.discoveredTables`, NEVER to `content.source.tables`, so
    // mirror-engine.ts re-enumerates and re-slices to MAX_TABLES on every Run.
    // A larger install cap is a guaranteed disagreement above the run cap: the
    // item would claim N tables and the pipeline would carry N Copy activities
    // while a Run mirrors MAX_TABLES. Assert the OUTCOME (recorded set and
    // authored activity count), not the constant, so a re-introduced literal
    // cannot pass by coincidence.
    h.listTablesWithAuth.mockImplementation(async () =>
      Array.from({ length: MAX_TABLES * 4 }, (_, i) => row('dbo', `t${i}`)));
    const r = await mirroredDatabaseProvisioner(input([]));

    expect(r.status).toBe('created');
    const recorded = decodeIdList(r.secondaryIds?.discoveredTables);
    expect(recorded).toHaveLength(MAX_TABLES);
    // What a Run would mirror, computed the way mirror-engine.ts computes it.
    const runWouldMirror = Array.from({ length: MAX_TABLES * 4 }, (_, i) => `dbo.t${i}`).slice(0, MAX_TABLES);
    expect(recorded).toEqual(runWouldMirror);

    expect(copiedTables()).toHaveLength(MAX_TABLES);
  });
});
