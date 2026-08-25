/**
 * ENGINE-level refusal of a source-type / connection-type mismatch.
 *
 * The compat unit tests prove the pair is judged incompatible and that the words
 * are honest. They would NOT catch the failure that actually hurt: the engine
 * running the SQL branch anyway. This file asserts the refusal happens BEFORE
 * any driver is touched — no change-feed DDL, no TDS catalog read, nothing
 * dialled — because that is the only position from which the message's claim
 * ("no request was sent to either system") is true (deploy-integrity.md R7).
 *
 * Harness copied from mirror-engine-credential.test.ts: the engine drags in
 * mssql / ADLS / Spark / ADF / Cosmos, all stubbed so only the dispatch is
 * exercised.
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
  listContainers: vi.fn(async () => [] as any[]),
  loadConnection: vi.fn(async () => null as any),
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
vi.mock('../cosmos-account-client', () => ({ listContainers: h.listContainers }));
vi.mock('@/lib/ingest/contract-enforcement', () => ({
  enforceOrPassThrough: vi.fn(async (_c: unknown, rows: unknown[]) => ({ rows, quarantined: 0 })),
}));
vi.mock('../connections-store', () => ({ loadConnection: h.loadConnection }));
vi.mock('../kv-secrets-client', () => ({ getKeyVaultSecretValue: vi.fn(async () => 'unused') }));

import { runMirrorSnapshot, type MirrorSource } from '../mirror-engine';
import { withSourceAuth } from '../connection-auth';

beforeEach(() => {
  for (const fn of Object.values(h)) (fn as any).mockClear?.();
  // Bronze configured, so a Gated result CANNOT be the landing-zone gate — the
  // control below proves this environment really does reach the drivers.
  process.env.LOOM_BRONZE_URL = 'https://acct.dfs.core.windows.net/bronze';
  process.env.LOOM_BRONZE_CONTAINER = 'bronze';
});

/** The operator's mirror: typed Azure SQL, bound to a Snowflake connection. */
const MISTYPED: MirrorSource = {
  sourceType: 'AzureSqlDatabase',
  // The Snowflake ACCOUNT IDENTIFIER, which has no dot — which is exactly why
  // azure-sql-client appended the Azure SQL suffix to it. Obviously fake.
  server: 'fakeorg-fakeacct999',
  database: 'SALES_DB',
  connectionId: 'conn-1',
  tenantId: 'tenant-1',
  connType: 'snowflake',
};

describe('runMirrorSnapshot refuses a mis-typed mirror before it dials anything', () => {
  it('EMBEDDED CONTROL: the same mirror WITHOUT the mismatch does reach the drivers', async () => {
    // Without this the assertions below could pass vacuously — a guard with a
    // zero population proves nothing (guard_with_zero_population_needs_embedded_control).
    const { connType, ...compatible } = MISTYPED;
    const res = await runMirrorSnapshot('m0', 'ws1', { ...compatible, tables: [{ schema: 'dbo', table: 'Orders' }] }, []);
    expect(h.enableMirroring).toHaveBeenCalled();
    expect(res.status).not.toBe('Gated');
  });

  it('returns Gated, not a driver error', async () => {
    const res = await runMirrorSnapshot('m1', 'ws1', MISTYPED, []);
    expect(res.ok).toBe(false);
    expect(res.status).toBe('Gated');
    expect(res.gate?.missing).toBe('matching source type');
  });

  it('touches NO driver — no change feed, no TDS read, no enumeration', async () => {
    await runMirrorSnapshot('m2', 'ws1', MISTYPED, []);
    expect(h.enableMirroring).not.toHaveBeenCalled();
    expect(h.executeParameterized).not.toHaveBeenCalled();
    expect(h.executeParameterizedWithAuth).not.toHaveBeenCalled();
    expect(h.listTables).not.toHaveBeenCalled();
    expect(h.listTablesWithAuth).not.toHaveBeenCalled();
  });

  it('the gate message names the real cause and carries no constructed hostname', async () => {
    const res = await runMirrorSnapshot('m3', 'ws1', MISTYPED, []);
    const msg = res.gate!.message;
    expect(msg).toMatch(/Azure SQL Database/);
    expect(msg).toMatch(/Snowflake/);
    expect(msg).toMatch(/no request was sent/i);
    // Host checks are SUBSTRING, not regex: an unanchored host regex is a
    // CodeQL js/regex/missing-regexp-anchor high, and anchoring one would
    // weaken "appears nowhere" into "is not exactly this". BOTH clouds' SQL
    // suffixes are checked — the suffix azure-sql-client appends is
    // cloud-dependent, so checking only Commercial would miss a Gov leak.
    for (const host of ['database.windows.net', 'database.usgovcloudapi.net']) {
      expect(msg, `gate message leaked the constructed host ${host}`).not.toContain(host);
    }
    for (const bad of [/getaddrinfo/i, /ENOTFOUND/i, /\b1433\b/]) {
      expect(msg, `gate message leaked ${bad}`).not.toMatch(bad);
    }
    // And never the account identifier glued to a domain.
    expect(msg).not.toContain('fakeorg-fakeacct999.');
  });

  it('refuses the ADF Copy direction too — a Snowflake mirror with an Azure SQL connection', async () => {
    // The mirror-symmetric case. The ADF Copy branch returns EARLY, so a guard
    // placed after it would miss this entirely.
    const res = await runMirrorSnapshot('m4', 'ws1', {
      ...MISTYPED, sourceType: 'Snowflake', connType: 'azure-sql',
    }, []);
    expect(res.status).toBe('Gated');
    expect(res.gate?.missing).toBe('matching source type');
    expect(res.gate?.message).toMatch(/Snowflake/);
  });

  it('a mirror with NO connection bound still runs as the Console UAMI', async () => {
    // R7 both ways: an unknown connection type is not a mismatch. This is the
    // documented no-connectionId path and must not be broken by the guard.
    const { connType, connectionId, ...noConn } = MISTYPED;
    const res = await runMirrorSnapshot('m5', 'ws1', { ...noConn, sourceType: 'AzureSqlDatabase', server: 'srv.database.windows.net', tables: [{ schema: 'dbo', table: 'Orders' }] }, []);
    expect(res.gate?.missing).not.toBe('matching source type');
    expect(h.enableMirroring).toHaveBeenCalled();
  });
});

/**
 * R9 — the DELEGATED path, end to end, with `connType` COMPUTED rather than
 * supplied by a fixture.
 *
 * Every test above hands the engine a `connType` directly, which is exactly why
 * they caught "delete the engine guard" and did NOT catch "delete the stamp that
 * feeds it". The two mirrored-database Start routes and the CDC connector route
 * all obtain `src` from `withSourceAuth`; if that stops stamping `connType`, the
 * engine's guard silently sees `undefined`, treats it as an unknown, and lets
 * all three through — with the suite green.
 *
 * So this builds `src` the way the routes do and asserts the refusal survives
 * the whole chain.
 */
describe('withSourceAuth → engine: the stamp reaches the guard', () => {
  it('a Snowflake connection under an Azure SQL mirror is refused end to end', async () => {
    h.loadConnection.mockResolvedValue({
      id: 'conn-snow', name: 'snowflake-prod', type: 'snowflake',
      authMethod: 'key-pair', secretRef: 'kv-snow',
    });
    const { src } = await withSourceAuth(
      'tenant-1',
      { sourceType: 'AzureSqlDatabase', server: 'fakeorg-fakeacct999', database: 'SALES_DB' },
      'conn-snow',
    );
    const res = await runMirrorSnapshot('m6', 'ws1', src as MirrorSource, []);
    expect(res.status, 'the connType stamp no longer reaches the engine guard').toBe('Gated');
    expect(res.gate?.missing).toBe('matching source type');
    expect(h.enableMirroring).not.toHaveBeenCalled();
    expect(h.listTablesWithAuth).not.toHaveBeenCalled();
  });

  it('EMBEDDED CONTROL: a MATCHING connection built the same way still runs', async () => {
    h.loadConnection.mockResolvedValue({
      id: 'conn-sql', name: 'azure-sql-prod', type: 'azure-sql',
      authMethod: 'sql-password', secretRef: 'kv-sql', username: 'loom_reader',
    });
    const { src } = await withSourceAuth(
      'tenant-1',
      { sourceType: 'AzureSqlDatabase', server: 'srv.database.windows.net', database: 'appdb', tables: [{ schema: 'dbo', table: 'Orders' }] },
      'conn-sql',
    );
    const res = await runMirrorSnapshot('m7', 'ws1', src as MirrorSource, []);
    expect(res.status).not.toBe('Gated');
    expect(h.enableMirroring).toHaveBeenCalled();
  });
});
