/**
 * CONSUMPTION test for the mirroring credential.
 *
 * The resolver tests in `connection-auth.test.ts` prove a Loom Connection can
 * be turned into a driver credential. They would NOT have caught the actual
 * bug, which was one layer further out: the credential existed and was
 * resolvable, but the mirror engine never received it — `MirrorSource` had no
 * field for it, so the SQL/PG driver calls always ran as the Console UAMI.
 *
 * These tests assert that a credential placed on `MirrorSource` REACHES the
 * driver. They fail if anyone drops the `src.auth` / `src.pgAuth` argument from
 * an engine call site — which is precisely the regression that shipped before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  executeParameterized: vi.fn(async () => [] as any[]),
  executeParameterizedWithAuth: vi.fn(async () => [] as any[]),
  enableMirroring: vi.fn(async () => ({ enabled: true, backend: 'azure-native-cdc', state: 'Running' })),
  listTables: vi.fn(async () => [] as any[]),
  listTablesWithAuth: vi.fn(async () => [] as any[]),
  executePostgresQuery: vi.fn(async () => ({ columns: [] as string[], rows: [] as unknown[][], executionMs: 1 })),
  listPostgresTables: vi.fn(async () => [] as any[]),
}));

vi.mock('../azure-sql-client', () => ({
  executeParameterized: h.executeParameterized,
  executeParameterizedWithAuth: h.executeParameterizedWithAuth,
  enableMirroring: h.enableMirroring,
}));
vi.mock('../sql-objects-client', () => ({
  listTables: h.listTables,
  listTablesWithAuth: h.listTablesWithAuth,
  sqlConfigGate: () => null,
}));
vi.mock('../postgres-flex-client', () => ({
  executePostgresQuery: h.executePostgresQuery,
  listPostgresTables: h.listPostgresTables,
  postgresQueryGate: () => null,
}));

// The engine pulls in ADLS / Spark / ADF / Cosmos / contract enforcement; stub
// them so this test exercises only the credential threading.
vi.mock('../adls-client', () => ({
  uploadFile: vi.fn(async () => undefined),
  pathToHttpsUrl: (_c: string, p: string) => `https://acct.dfs.core.windows.net/bronze/${p}`,
  getAccountName: () => 'acct',
  listPaths: vi.fn(async () => []),
  resolveAbfssRoot: vi.fn(async () => 'abfss://bronze@acct.dfs.core.windows.net'),
}));
vi.mock('../synapse-dev-client', () => ({ submitSparkBatchJob: vi.fn(async () => ({})) }));
vi.mock('../adf-client', () => ({
  listPipelineRuns: vi.fn(async () => []), adfConfigGate: () => ({ missing: 'LOOM_ADF_NAME' }),
  upsertAdfCdc: vi.fn(), startAdfCdc: vi.fn(), adfCdcConfigGate: () => ({ missing: 'LOOM_ADF_NAME' }),
  upsertPipeline: vi.fn(), upsertDataset: vi.fn(), runPipeline: vi.fn(),
  upsertTrigger: vi.fn(), startTrigger: vi.fn(),
}));
vi.mock('../cosmos-data-client', () => ({ queryItems: vi.fn(async () => ({ items: [] })) }));
vi.mock('../cosmos-account-client', () => ({ listContainers: vi.fn(async () => []) }));
vi.mock('@/lib/ingest/contract-enforcement', () => ({
  enforceOrPassThrough: vi.fn(async (_c: unknown, rows: unknown[]) => ({ rows, quarantined: 0 })),
}));

import { runMirrorSnapshot, type MirrorSource } from '../mirror-engine';

const SQL_AUTH = { user: 'loom_reader', password: 'p@ss' };
const PG_AUTH = { user: 'pguser', password: 'pgpass' };

beforeEach(() => {
  for (const fn of Object.values(h)) (fn as any).mockClear?.();
  // The engine returns a Gated result before touching any driver when the
  // Bronze landing zone is unconfigured. Without these, every assertion below
  // would pass VACUOUSLY (no driver call = no wrong credential), which is
  // exactly the "test that cannot fail" shape this repo keeps getting bitten
  // by — the `expect(...).toHaveBeenCalled()` lines are what force a real run.
  process.env.LOOM_BRONZE_URL = 'https://acct.dfs.core.windows.net/bronze';
  process.env.LOOM_BRONZE_CONTAINER = 'bronze';
});

/** Every call recorded on a mock, flattened, for "was the credential anywhere" checks. */
function allArgs(mock: { mock: { calls: any[][] } }): any[] {
  return mock.mock.calls.flat();
}

describe('mirror engine consumes MirrorSource.auth (SQL family)', () => {
  const base: MirrorSource = {
    sourceType: 'AzureSqlDatabase',
    server: 'srv.database.windows.net',
    database: 'appdb',
    tables: [{ schema: 'dbo', table: 'Orders' }],
  };

  it('passes the stored SQL credential to the change-feed enable', async () => {
    await runMirrorSnapshot('m1', 'ws1', { ...base, auth: SQL_AUTH }, []);
    expect(h.enableMirroring).toHaveBeenCalled();
    // enableMirroring(server, database, legacyEndpoint, auth)
    expect(h.enableMirroring.mock.calls[0][3]).toEqual(SQL_AUTH);
  });

  it('passes the stored SQL credential to the parameterized reads', async () => {
    await runMirrorSnapshot('m1', 'ws1', { ...base, auth: SQL_AUTH }, []);
    expect(h.executeParameterizedWithAuth).toHaveBeenCalled();
    // At least one read must carry the credential — if the threading is
    // dropped, every call has `undefined` in the auth slot and this fails.
    const carried = h.executeParameterizedWithAuth.mock.calls.some((c: any[]) => c[4] === SQL_AUTH);
    expect(carried).toBe(true);
  });

  it('uses listTablesWithAuth (credential-aware) rather than the UAMI-only listTables', async () => {
    await runMirrorSnapshot('m2', 'ws1', { ...base, tables: [], auth: SQL_AUTH }, []);
    // The UAMI-only enumerator must not be the one the engine reaches for.
    expect(h.listTables).not.toHaveBeenCalled();
    expect(h.listTablesWithAuth).toHaveBeenCalled();
    expect(h.listTablesWithAuth.mock.calls[0][2]).toEqual(SQL_AUTH);
  });

  it('still runs as the Console UAMI (auth undefined) when no connection is bound', async () => {
    await runMirrorSnapshot('m3', 'ws1', base, []);
    // Every auth slot is undefined — the unchanged default behaviour.
    for (const call of h.executeParameterizedWithAuth.mock.calls) expect(call[4]).toBeUndefined();
    expect(h.enableMirroring.mock.calls[0]?.[3]).toBeUndefined();
  });

  it('never leaks the SQL password into a PostgreSQL call path', async () => {
    await runMirrorSnapshot('m4', 'ws1', { ...base, auth: SQL_AUTH }, []);
    expect(allArgs(h.executePostgresQuery)).not.toContainEqual(SQL_AUTH);
  });
});

describe('mirror engine consumes MirrorSource.pgAuth (PostgreSQL family)', () => {
  const pgBase: MirrorSource = {
    sourceType: 'AzurePostgreSql',
    server: 'pg.postgres.database.azure.com',
    database: 'appdb',
    tables: [{ schema: 'public', table: 'orders' }],
  };

  it('passes the stored PG credential to the wire-protocol reads', async () => {
    await runMirrorSnapshot('m5', 'ws1', { ...pgBase, pgAuth: PG_AUTH }, []);
    expect(h.executePostgresQuery).toHaveBeenCalled();
    const carried = h.executePostgresQuery.mock.calls.some((c: any[]) => c[3] === PG_AUTH);
    expect(carried).toBe(true);
  });

  it('passes the stored PG credential to table enumeration', async () => {
    await runMirrorSnapshot('m6', 'ws1', { ...pgBase, tables: [], pgAuth: PG_AUTH }, []);
    expect(h.listPostgresTables).toHaveBeenCalled();
    expect(h.listPostgresTables.mock.calls[0][2]).toEqual(PG_AUTH);
  });

  it('still runs as the Console UAMI when no connection is bound', async () => {
    await runMirrorSnapshot('m7', 'ws1', pgBase, []);
    for (const call of h.executePostgresQuery.mock.calls) expect(call[3]).toBeUndefined();
  });
});
