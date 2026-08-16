/**
 * GHSA-v2g8-gp3r-rg4r — RESIDUAL POPULATION, eventhouse family.
 *
 * #3600 fixed eight routes and the advisory stayed open because the measured
 * population is far larger. These three eventhouse routes were in the unaudited
 * remainder, and each is a live instance of the same class: a caller-supplied
 * database coordinate reaching a data-plane call as the Console's UAMI, which
 * holds AllDatabasesAdmin on the SHARED ADX cluster.
 *
 * WHAT SHIPPED, per route:
 *
 *   `[id]/policies`  POST took `_ctx` (never read `[id]`), `getSession()` only,
 *     and `body.database` into `.alter database ["<db>"] policy retention` /
 *     `policy caching`. This is the most DESTRUCTIVE instance left in the
 *     advisory: `{ database: '<victim>', softDeleteDays: 1 }` rewrites another
 *     tenant's data-retention period, after which ADX deletes everything older
 *     than a day on its own schedule. No purge, no confirm token — one request.
 *
 *   `[id]/continuous-export` POST/GET ran behind `withSession` with `{ id }`
 *     declared as the type argument and never read. EXPORT mode built a
 *     STANDING job: `database` + `sourceTable` named any table on the cluster,
 *     and `adlsAccount` took the BODY value in preference to the configured one,
 *     so the destination was caller-chosen too. BIND mode issued
 *     `.create-or-alter external table` and `.create-or-alter function` against
 *     any named database (create-or-ALTER overwrites an existing body).
 *
 *   `[id]/journal`   GET bound `params` and then discarded it on purpose
 *     (`params; // journal is cluster/db scoped`). With no `?database` it ran
 *     `.show journal` — the WHOLE CLUSTER's metadata history, which is what the
 *     editor actually called — and with one, any single database's. The journal
 *     carries `ChangeCommand` (verbatim DDL text) and `Principal`, i.e. a
 *     schema-and-identity map of every tenant on the cluster.
 *
 * MUTATION PROOF — each mutation below was applied to the route, this whole FILE
 * was run, and the mutation was reverted. Each turns this file RED. Run whole
 * files: `-t` with a regex metacharacter silently matches nothing and exits 0.
 *
 *   1. policies POST — keep the scope call but use the body value
 *      (`const database = scoped.ok ? scoped.database : requested`)
 *        → "refuses a policy change on a database outside the workspace scope"
 *          and "…retention specifically" FAIL. tsc-clean (exit 0) — the type
 *          does not see this, which is the whole reason the checker matters.
 *   2. policies POST — drop `if (guard.res) return guard.res;`
 *        → "a denied caller never reaches ADX" FAILS.
 *   3. policies POST — pass `allowReadRoles: true`
 *        → "policies guards WRITE-scoped" FAILS on the extra key.
 *   4. continuous-export EXPORT — drop the `scopeAdxDatabase` binding
 *        → "refuses creating an export job that READS a foreign database" FAILS
 *          and `createOrAlterContinuousExport` is reached.
 *   5. continuous-export EXPORT — restore `body.adlsAccount || env`
 *        → "refuses a caller-nominated export DESTINATION account" FAILS.
 *   6. continuous-export EXPORT — drop the `scopeSourceTable` check
 *        → "refuses a sourceTable the bound database does not expose" FAILS.
 *   7. continuous-export BIND — drop the `scopeAdxDatabase` binding
 *        → "refuses BINDing an external table into a foreign database" FAILS.
 *   8. continuous-export GET — drop the binding
 *        → "refuses disclosing export jobs for a foreign database" FAILS.
 *   9. journal — restore the cluster-wide branch
 *      (`const command = database ? … : '.show journal | take N'`)
 *        → "an absent database scopes to the ITEM's database, never the cluster"
 *          FAILS.
 *  10. journal — use the raw `?database` instead of the scoped one
 *        → "refuses another tenant's journal" FAILS.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const SESSION = { claims: { oid: 'oid-caller', tid: 'tid-1', upn: 'u@loom.test', groups: [] } } as any;
vi.mock('@/lib/auth/session', () => ({ getSession: () => SESSION }));

const guard = vi.hoisted(() => ({ authorizeItemWorkspace: vi.fn(async () => null as any) }));
vi.mock('@/lib/auth/workspace-guard', () => guard);

/**
 * The eventhouse item owns `ehdb` and claims `createddb` (auto-bound by
 * `[id]/database` when it was created through this item). `victim-db` is another
 * tenant's database on the same shared cluster — it EXISTS and it really does
 * carry the tables the tests name, so table-existence can never be what refuses
 * it. Only the scope check can be.
 */
const OWN_DB = 'ehdb';
const CREATED_DB = 'createddb';
const VICTIM_DB = 'victimdb';

const ITEM: any = {
  id: 'eh-1',
  itemType: 'eventhouse',
  workspaceId: 'ws-1',
  displayName: 'Telemetry',
  state: { databaseName: OWN_DB, databases: [CREATED_DB] },
};

const cosmos = vi.hoisted(() => ({ byId: [] as any[], byWorkspace: [] as any[] }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: {
      query: (spec: any) => ({
        fetchAll: async () => ({
          resources: String(spec?.query || '').includes('c.workspaceId')
            ? cosmos.byWorkspace
            : cosmos.byId,
        }),
      }),
    },
  }),
}));

const kusto = vi.hoisted(() => {
  class FakeKustoError extends Error {
    status: number;
    constructor(message: string, status = 502) { super(message); this.status = status; }
  }
  const tablesByDb: Record<string, string[]> = {
    ehdb: ['Events', 'Customers'],
    createddb: ['Events'],
    victimdb: ['Customers', 'Secrets'],
  };
  return {
    KustoError: FakeKustoError,
    tablesByDb,
    listTables: vi.fn(async (db: string) => (tablesByDb[db] || []).map((name) => ({ name }))),
    listDatabases: vi.fn(async () => Object.keys(tablesByDb).map((name) => ({ name }))),
    getTableSchema: vi.fn(async () => ({ OrderedColumns: [{ Name: 'id', CslType: 'string' }] })),
    executeQuery: vi.fn(async () => ({ columns: ['x'], rows: [[1]] })),
    executeMgmtCommand: vi.fn(async () => ({
      columns: ['Event', 'EventTimestamp', 'Database', 'ChangeCommand', 'Principal'],
      rows: [['ADD-TABLE', '2026-08-16T00:00:00Z', 'ehdb', '.create table Events', 'aaduser=x']],
      rowCount: 1,
      executionMs: 3,
    })),
    defaultDatabase: vi.fn(() => 'loomdb-default'),
    // continuous-export surface
    createExternalDeltaTable: vi.fn(async () => ({ ok: true })),
    setQueryAccelerationPolicy: vi.fn(async () => ({ ok: true })),
    showQueryAccelerationPolicy: vi.fn(async () => ({ policy: { IsEnabled: true } })),
    createExternalTableView: vi.fn(async () => ({ ok: true })),
    listExternalTables: vi.fn(async () => [{ name: 'ext_a', tableType: 'Delta' }]),
    listContinuousExports: vi.fn(async () => [{ name: 'exp1' }]),
    createOrAlterExternalTableDelta: vi.fn(async () => ({ ok: true })),
    createOrAlterContinuousExport: vi.fn(async () => ({ ok: true })),
  };
});
vi.mock('@/lib/azure/kusto-client', () => kusto);

const arm = vi.hoisted(() => ({
  updateKustoClusterAutoscale: vi.fn(async () => ({ optimizedAutoscale: { isEnabled: true }, provisioningState: 'Succeeded' })),
  updateKustoStreamingIngest: vi.fn(async () => ({ provisioningState: 'Succeeded' })),
  KustoArmError: class extends Error { status = 502; },
  KustoNotConfiguredError: class extends Error { missing = 'X'; },
}));
vi.mock('@/lib/azure/kusto-arm-client', () => arm);

vi.mock('@/lib/azure/adls-client', () => ({ listContainers: vi.fn(async () => [{ name: 'bronze' }]) }));

import { POST as policiesPOST, PATCH as policiesPATCH } from '../policies/route';
import { GET as journalGET } from '../journal/route';
import { GET as exportGET, POST as exportPOST } from '../continuous-export/route';

const ctx = { params: Promise.resolve({ id: 'eh-1' }) } as any;

function req(body: any = {}, query: Record<string, string> = {}) {
  const url = new URL('http://x/');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return { url: url.toString(), nextUrl: url, json: async () => body } as any;
}

/** The EXACT write-scoped guard argument the destructive handlers must produce. */
const EXPECTED_WRITE_GUARD = {
  workspaceId: null,
  itemId: 'eh-1',
  itemType: 'eventhouse',
  notFound: 'eventhouse not found',
};
const EXPECTED_READ_GUARD = { ...EXPECTED_WRITE_GUARD, allowReadRoles: true };

const EXPORT_ACCOUNT = 'loomexportacct';

const EXPORT_BODY = {
  sourceTable: 'Events',
  exportName: 'nightly',
  container: 'bronze',
  interval: '1h',
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LOOM_RTI_EXPORT_ADLS = EXPORT_ACCOUNT;
  guard.authorizeItemWorkspace.mockResolvedValue(null as any);
  kusto.listTables.mockImplementation(
    async (db: string) => (kusto.tablesByDb[db] || []).map((name) => ({ name })),
  );
  cosmos.byId = [ITEM];
  cosmos.byWorkspace = [ITEM];
});

// ── policies — the destructive one ───────────────────────────────────────────

describe('[id]/policies — retention + caching DDL is bound to the item', () => {
  it('a denied caller never reaches ADX or ARM', async () => {
    const { NextResponse } = await import('next/server');
    guard.authorizeItemWorkspace.mockResolvedValue(
      NextResponse.json({ ok: false, error: 'eventhouse not found' }, { status: 404 }) as any,
    );
    expect((await policiesPOST(req({ database: OWN_DB, hotCacheDays: 3 }), ctx)).status).toBe(404);
    expect((await policiesPATCH(req({ optimizedAutoscale: { isEnabled: true, minimum: 2, maximum: 4 } }), ctx)).status).toBe(404);
    expect(kusto.executeMgmtCommand).not.toHaveBeenCalled();
    expect(arm.updateKustoClusterAutoscale).not.toHaveBeenCalled();
  });

  it('policies guards WRITE-scoped — the argument carries no allowReadRoles key', async () => {
    await policiesPOST(req({ database: OWN_DB, hotCacheDays: 3 }), ctx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, EXPECTED_WRITE_GUARD);
  });

  it('refuses a policy change on a database outside the workspace scope', async () => {
    const res = await policiesPOST(req({ database: VICTIM_DB, hotCacheDays: 3 }), ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/not bound to any item in this workspace/i);
    expect(kusto.executeMgmtCommand).not.toHaveBeenCalled();
  });

  it('refuses a RETENTION rewrite on a foreign database — the data-loss path', async () => {
    // `softDeleteDays: 1` is the whole exploit: ADX then ages out everything
    // older than a day in the victim's database, with no purge command issued.
    const res = await policiesPOST(req({ database: VICTIM_DB, softDeleteDays: 1 }), ctx);
    expect(res.status).toBe(403);
    expect(kusto.executeMgmtCommand).not.toHaveBeenCalled();
  });

  it('refuses the CLUSTER streaming-ingest flag when the database is foreign', async () => {
    const res = await policiesPOST(req({ database: VICTIM_DB, enableStreamingIngest: true }), ctx);
    expect(res.status).toBe(403);
    expect(arm.updateKustoStreamingIngest).not.toHaveBeenCalled();
  });

  it('an id naming no eventhouse is refused, not fallen through to ADX', async () => {
    cosmos.byId = [];
    expect((await policiesPOST(req({ database: OWN_DB, hotCacheDays: 3 }), ctx)).status).toBe(404);
    expect(kusto.executeMgmtCommand).not.toHaveBeenCalled();
  });

  it('a legitimate owner still applies both policies to their own database', async () => {
    const res = await policiesPOST(req({ database: OWN_DB, hotCacheDays: 3, softDeleteDays: 30 }), ctx);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.database).toBe(OWN_DB);
    expect(j.applied).toEqual(['cache=3d', 'retention=30d']);
    const commands = kusto.executeMgmtCommand.mock.calls.map((c: any[]) => c[1]);
    expect(commands[0]).toBe(`.alter database ["${OWN_DB}"] policy caching hot = 3d`);
    expect(commands[1]).toContain(`.alter database ["${OWN_DB}"] policy retention`);
    // Every command ran AGAINST the bound database, not a body-named one.
    for (const call of kusto.executeMgmtCommand.mock.calls) expect(call[0]).toBe(OWN_DB);
  });

  it('a database auto-bound by [id]/database is in scope', async () => {
    const res = await policiesPOST(req({ database: CREATED_DB, hotCacheDays: 7 }), ctx);
    expect(res.status).toBe(200);
    expect(kusto.executeMgmtCommand).toHaveBeenCalledWith(
      CREATED_DB, `.alter database ["${CREATED_DB}"] policy caching hot = 7d`,
    );
  });

  it('PATCH auto-scale still works for an authorized owner', async () => {
    const res = await policiesPATCH(req({ optimizedAutoscale: { isEnabled: true, minimum: 2, maximum: 6 } }), ctx);
    expect(res.status).toBe(200);
    expect(arm.updateKustoClusterAutoscale).toHaveBeenCalledWith(true, 2, 6);
  });
});

// ── continuous-export — the standing exfiltration pipe ───────────────────────

describe('[id]/continuous-export — EXPORT mode binds source AND destination', () => {
  it('a denied caller never reaches ADX', async () => {
    const { NextResponse } = await import('next/server');
    guard.authorizeItemWorkspace.mockResolvedValue(
      NextResponse.json({ ok: false, error: 'eventhouse not found' }, { status: 404 }) as any,
    );
    expect((await exportPOST(req({ ...EXPORT_BODY, database: OWN_DB }), ctx)).status).toBe(404);
    expect(kusto.createOrAlterContinuousExport).not.toHaveBeenCalled();
  });

  it('export guards WRITE-scoped', async () => {
    await exportPOST(req({ ...EXPORT_BODY, database: OWN_DB }), ctx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, EXPECTED_WRITE_GUARD);
  });

  it('refuses creating an export job that READS a foreign database', async () => {
    const res = await exportPOST(req({ ...EXPORT_BODY, database: VICTIM_DB, sourceTable: 'Secrets' }), ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/not bound to any item in this workspace/i);
    expect(kusto.createOrAlterExternalTableDelta).not.toHaveBeenCalled();
    expect(kusto.createOrAlterContinuousExport).not.toHaveBeenCalled();
  });

  it('refuses a caller-nominated export DESTINATION account', async () => {
    const res = await exportPOST(
      req({ ...EXPORT_BODY, database: OWN_DB, adlsAccount: 'attackeracct' }), ctx,
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/not this deployment's export account/i);
    expect(kusto.createOrAlterContinuousExport).not.toHaveBeenCalled();
  });

  it('refuses a sourceTable the bound database does not expose', async () => {
    const res = await exportPOST(req({ ...EXPORT_BODY, database: OWN_DB, sourceTable: 'Secrets' }), ctx);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/does not exist in database/i);
    expect(kusto.createOrAlterContinuousExport).not.toHaveBeenCalled();
  });

  it('fails CLOSED when the table list cannot be read', async () => {
    kusto.listTables.mockRejectedValue(new kusto.KustoError('Forbidden', 403));
    const res = await exportPOST(req({ ...EXPORT_BODY, database: OWN_DB }), ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/could not verify tables/i);
    expect(kusto.createOrAlterContinuousExport).not.toHaveBeenCalled();
  });

  it('a legitimate owner still creates an export from their own database', async () => {
    const res = await exportPOST(req({ ...EXPORT_BODY, database: OWN_DB }), ctx);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.database).toBe(OWN_DB);
    expect(j.abfssPath).toContain(`@${EXPORT_ACCOUNT}.`);
    expect(kusto.createOrAlterContinuousExport).toHaveBeenCalledWith(
      OWN_DB, 'nightly', 'Events', 'ext_nightly', '1h',
    );
  });

  it('an EMPTY adlsAccount (the editor default) still uses the deployment account', async () => {
    const res = await exportPOST(req({ ...EXPORT_BODY, database: OWN_DB, adlsAccount: '' }), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).abfssPath).toContain(`@${EXPORT_ACCOUNT}.`);
  });
});

describe('[id]/continuous-export — BIND mode binds its DDL target', () => {
  const BIND = { tableName: 'ExtDelta', abfssUri: 'abfss://bronze@acct.dfs.core.windows.net/p' };

  it('refuses BINDing an external table into a foreign database', async () => {
    const res = await exportPOST(req({ ...BIND, database: VICTIM_DB }), ctx);
    expect(res.status).toBe(403);
    expect(kusto.createExternalDeltaTable).not.toHaveBeenCalled();
  });

  it('refuses the create-or-ALTER FUNCTION overwrite on a foreign database', async () => {
    const res = await exportPOST(req({ ...BIND, database: VICTIM_DB, createKqlView: true }), ctx);
    expect(res.status).toBe(403);
    expect(kusto.createExternalTableView).not.toHaveBeenCalled();
  });

  it('a legitimate owner still binds into their own database', async () => {
    const res = await exportPOST(req({ ...BIND, database: OWN_DB, createKqlView: true }), ctx);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.database).toBe(OWN_DB);
    expect(kusto.createExternalDeltaTable).toHaveBeenCalledWith(
      OWN_DB, 'ExtDelta', BIND.abfssUri, expect.anything(),
    );
    expect(kusto.createExternalTableView).toHaveBeenCalledWith(OWN_DB, 'ExtDelta_view', 'ExtDelta');
  });
});

describe('[id]/continuous-export — GET picker', () => {
  it('refuses disclosing export jobs for a foreign database', async () => {
    const res = await exportGET(req({}, { database: VICTIM_DB }), ctx);
    expect(res.status).toBe(403);
    expect(kusto.listContinuousExports).not.toHaveBeenCalled();
    expect(kusto.listExternalTables).not.toHaveBeenCalled();
  });

  it('admits shared read roles and lists the owner’s own jobs', async () => {
    const res = await exportGET(req({}, { database: OWN_DB }), ctx);
    expect(res.status).toBe(200);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, EXPECTED_READ_GUARD);
    const j = await res.json();
    expect(j.exports).toEqual([{ name: 'exp1' }]);
    expect(kusto.listContinuousExports).toHaveBeenCalledWith(OWN_DB);
  });
});

// ── journal — the cluster-wide default was the disclosure ───────────────────

describe('[id]/journal — the schema-change log is scoped to the item', () => {
  it('a denied caller never reaches ADX', async () => {
    const { NextResponse } = await import('next/server');
    guard.authorizeItemWorkspace.mockResolvedValue(
      NextResponse.json({ ok: false, error: 'eventhouse not found' }, { status: 404 }) as any,
    );
    expect((await journalGET(req({}, { limit: '50' }), ctx)).status).toBe(404);
    expect(kusto.executeMgmtCommand).not.toHaveBeenCalled();
  });

  it('an absent database scopes to the ITEM’s database, never the cluster', async () => {
    // This is the shipped default and what the editor actually called: no
    // `?database` used to mean `.show journal` across EVERY database.
    const res = await journalGET(req({}, { limit: '50' }), ctx);
    expect(res.status).toBe(200);
    expect(kusto.executeMgmtCommand).toHaveBeenCalledWith(
      OWN_DB, `.show database ["${OWN_DB}"] journal | take 50`,
    );
    const commands = kusto.executeMgmtCommand.mock.calls.map((c: any[]) => String(c[1]));
    for (const cmd of commands) expect(cmd).not.toMatch(/^\.show journal/);
  });

  it('refuses another tenant’s journal — no ChangeCommand or Principal leaks', async () => {
    const res = await journalGET(req({}, { database: VICTIM_DB }), ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/not bound to any item in this workspace/i);
    expect(kusto.executeMgmtCommand).not.toHaveBeenCalled();
  });

  it('a legitimate owner still reads their own journal', async () => {
    const res = await journalGET(req({}, { database: CREATED_DB, limit: '10' }), ctx);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.database).toBe(CREATED_DB);
    expect(j.entries[0].changeCommand).toBe('.create table Events');
    expect(kusto.executeMgmtCommand).toHaveBeenCalledWith(
      CREATED_DB, `.show database ["${CREATED_DB}"] journal | take 10`,
    );
  });

  it('the journal picker admits shared read roles', async () => {
    await journalGET(req({}, {}), ctx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, EXPECTED_READ_GUARD);
  });
});
