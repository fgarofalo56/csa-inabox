/**
 * GHSA-v2g8-gp3r-rg4r — route-level proof that the eventhouse ADX family
 * authorizes the caller AND binds the database it acts on.
 *
 * WHAT SHIPPED. `POST [id]/purge` ran `getSession()` and nothing else. It never
 * read `[id]`, and took `database` + `table` straight from the body into ADX
 * `.purge` — PERMANENT ROW DELETION, executed as the Console's UAMI, which
 * holds AllDatabasesAdmin on the shared cluster. Any signed-in user, in any
 * tenant, could erase rows from any database on it by naming one. The GET
 * picker in the same file leaked every table and column of any database the
 * same way.
 *
 * `[id]/database` is included here because it is the adjacent instance of the
 * same class AND the reason the purge fix does not break real users: it had the
 * identical `getSession()`-only shape (so DELETE could drop ANY KQL database on
 * the cluster), and it recorded NOTHING in Loom when it created one — which is
 * exactly why purge had no item-derived scope to check against. It now
 * authorizes, and it binds the created database to the eventhouse item, so a
 * database an operator creates in the editor stays purgeable by that operator.
 *
 * MUTATION PROOF — each was executed against this suite and restored. All six
 * turn this file RED; two of them are ALSO rejected by `tsc`, which is noted
 * rather than glossed because it is a stronger property than a red test:
 *   1. `[id]/purge/route.ts` POST — keep the scope check but purge the body's
 *      database (`const database = scoped.ok ? scoped.database : requested`)
 *        → "refuses a database outside the workspace scope" and "refuses a
 *          foreign database on COMMIT too" fail. tsc-clean (exit 0).
 *   2. `[id]/purge/route.ts` POST — discard the `scopeTable` result
 *        → "refuses a table the database does not expose" and "fails CLOSED
 *          when the table list cannot be read" fail. tsc-clean (exit 0).
 *   3. `[id]/purge/route.ts` POST — pass `allowReadRoles: true` to the guard
 *        → "purge guards WRITE-scoped" fails on the extra key. tsc-clean.
 *   4. `[id]/purge/route.ts` GET — drop `if (guard.res) return guard.res;`
 *        → "a denied caller never reaches ADX" fails — AND `tsc` fails with
 *          TS18048 `'guard.ctx' is possibly 'undefined'`.
 *
 *          READ THAT NARROWLY. The type only bites because the handler goes on
 *          to DESTRUCTURE `guard.ctx`. Calling the guard and discarding the
 *          result ENTIRELY, then using `body.database`, COMPILES CLEAN (exit 0)
 *          — measured. So the two-shape return is not a substitute for the
 *          consumption check; `guardAdxItemRequest` is in
 *          `scripts/ci/_gate-consumption.mjs::RETURNED_VALUE_GATES` for exactly
 *          the case the type cannot see.
 *   5. `[id]/database/route.ts` — drop the `rebind` on create
 *        → "a database created through this item becomes purgeable" fails.
 *          tsc-clean (exit 0).
 *   6. `_lib/adx-item-scope.ts` `guardAdxItemRequest` — return a ctx instead of
 *      the 404 when the item is missing
 *        → "an id naming no eventhouse is refused" fails.
 *   7. `[id]/database/route.ts` DELETE — drop the `scopeAdxDatabase` binding
 *        → "refuses DROPPING a database outside the workspace scope" fails.
 *          tsc-clean (exit 0). This is the most destructive verb in the whole
 *          advisory surface and Layer 1 alone did not bind it.
 *   8. `[id]/database/route.ts` POST — bind unconditionally instead of on
 *      `result.created`
 *        → "an ARM 200 (already existed) is NOT bound" fails.
 *   9. `[id]/database/route.ts` POST — drop the pre-flight `listDatabases`
 *      existence refusal
 *        → "refuses creating over an existing foreign database" fails.
 *  10. `[id]/ingest/route.ts` — drop the `scopeAdxDatabase` in any of the three
 *      handlers → the corresponding "ingest refuses a foreign database" test
 *          fails and the ADX/ARM call is reached.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const SESSION = { claims: { oid: 'oid-caller', tid: 'tid-1', upn: 'u@loom.test', groups: [] } } as any;
vi.mock('@/lib/auth/session', () => ({ getSession: () => SESSION }));

const guard = vi.hoisted(() => ({ authorizeItemWorkspace: vi.fn(async () => null as any) }));
vi.mock('@/lib/auth/workspace-guard', () => guard);

/**
 * The eventhouse item owns `ehdb` (its bound database) and claims `createddb`
 * (a database created through `[id]/database`). `victim-db` is another tenant's
 * database on the same shared cluster — it exists, and it really does have a
 * `Customers` table, so the table-existence check cannot be what refuses it.
 */
const OWN_DB = 'ehdb';
const CREATED_DB = 'createddb';
const VICTIM_DB = 'victim-db';

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
    'victim-db': ['Customers', 'Secrets'],
  };
  return {
    KustoError: FakeKustoError,
    tablesByDb,
    savedState: [] as any[],
    listTables: vi.fn(async (db: string) => (tablesByDb[db] || []).map((name) => ({ name }))),
    listDatabases: vi.fn(async () => Object.keys(tablesByDb).map((name) => ({ name }))),
    getTableSchema: vi.fn(async () => ({ OrderedColumns: [{ Name: 'id', CslType: 'string' }] })),
    executeQuery: vi.fn(async () => ({ columns: ['Count'], rows: [[0]] })),
    executeMgmtCommand: vi.fn(async (_db: string, _cmd: string) => ({ columns: ['x'], rows: [[1]], rowCount: 1, executionMs: 3 })),
    ingestInline: vi.fn(async (_db: string, _table: string, _rows: unknown[][]) => ({ executionMs: 7 })),
    buildPurgeWhere: vi.fn(() => "where id == 'x'"),
    executePurgeVerify: vi.fn(async () => ({
      numRecordsToPurge: 4, estimatedPurgeExecutionTime: '00:01:00', verificationToken: 'vt',
    })),
    executePurgeCommit: vi.fn(async () => ({ operationId: 'op-1', state: 'Scheduled', scheduledTime: 'now' })),
    PURGE_ALLOWED_OPS: ['==', '!=', 'contains'] as const,
    createDatabase: vi.fn(async (_name: string) => ({ provisioningState: 'Succeeded', id: '/x', created: true })),
    saveItemState: vi.fn(async (item: any, patch: any) => {
      kusto.savedState.push(patch);
      return { ...item, state: { ...item.state, ...patch } };
    }),
    defaultDatabase: vi.fn(() => 'loomdb-default'),
  };
});
vi.mock('@/lib/azure/kusto-client', () => kusto);

const arm = vi.hoisted(() => ({
  deleteKustoDatabase: vi.fn(async () => ({ ok: true })),
  KustoArmError: class extends Error { status = 502; },
  KustoNotConfiguredError: class extends Error { missing = 'X'; },
}));
vi.mock('@/lib/azure/kusto-arm-client', () => arm);

import { GET as purgeGET, POST as purgePOST } from '../purge/route';
import { POST as dbPOST, DELETE as dbDELETE } from '../database/route';
import { POST as ingestPOST } from '../ingest/route';

const ctx = { params: Promise.resolve({ id: 'eh-1' }) } as any;

function req(body: any = {}, query: Record<string, string> = {}) {
  const url = new URL('http://x/');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return {
    url: url.toString(),
    nextUrl: url,
    json: async () => body,
    headers: { get: () => 'application/json' },
  } as any;
}

/** A multipart ingest request carrying a caller-chosen database + table. */
function formReq(fields: Record<string, string>, file: { name: string; size: number; text: string }) {
  const map = new Map<string, unknown>(Object.entries(fields));
  map.set('file', {
    name: file.name,
    size: file.size,
    arrayBuffer: async () => new TextEncoder().encode(file.text).buffer,
  });
  const url = new URL('http://x/');
  return {
    url: url.toString(),
    nextUrl: url,
    headers: { get: () => 'multipart/form-data; boundary=x' },
    formData: async () => ({ get: (k: string) => map.get(k) ?? null }),
  } as any;
}

const PREDICATES = [{ column: 'id', op: '==', value: 'x' }];

/** The EXACT write-scoped guard argument the destructive handlers must produce. */
const EXPECTED_WRITE_GUARD = {
  workspaceId: null,
  itemId: 'eh-1',
  itemType: 'eventhouse',
  notFound: 'eventhouse not found',
};

beforeEach(() => {
  vi.clearAllMocks();
  kusto.savedState.length = 0;
  guard.authorizeItemWorkspace.mockResolvedValue(null as any);
  kusto.listTables.mockImplementation(
    async (db: string) => (kusto.tablesByDb[db] || []).map((name) => ({ name })),
  );
  kusto.listDatabases.mockImplementation(
    async () => Object.keys(kusto.tablesByDb).map((name) => ({ name })),
  );
  kusto.createDatabase.mockResolvedValue({ provisioningState: 'Succeeded', id: '/x', created: true } as any);
  cosmos.byId = [ITEM];
  cosmos.byWorkspace = [ITEM];
});

// ── LAYER 1 — the caller is authorized against the item ──────────────────────

describe('layer 1 — caller authorization', () => {
  it('a denied caller never reaches ADX (purge GET / purge POST / database POST+DELETE)', async () => {
    const { NextResponse } = await import('next/server');
    guard.authorizeItemWorkspace.mockResolvedValue(
      NextResponse.json({ ok: false, error: 'eventhouse not found' }, { status: 404 }) as any,
    );

    expect((await purgeGET(req({}, { database: OWN_DB }), ctx)).status).toBe(404);
    expect((await purgePOST(req({ database: OWN_DB, table: 'Events', step: 'verify', predicates: PREDICATES }), ctx)).status).toBe(404);
    expect((await dbPOST(req({ name: 'newdb' }), ctx)).status).toBe(404);
    expect((await dbDELETE(req({}, { name: CREATED_DB }), ctx)).status).toBe(404);

    expect(kusto.listTables).not.toHaveBeenCalled();
    expect(kusto.executePurgeVerify).not.toHaveBeenCalled();
    expect(kusto.createDatabase).not.toHaveBeenCalled();
    expect(arm.deleteKustoDatabase).not.toHaveBeenCalled();
  });

  it('purge guards WRITE-scoped — the argument carries no allowReadRoles key', async () => {
    await purgePOST(req({ database: OWN_DB, table: 'Events', step: 'verify', predicates: PREDICATES }), ctx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, EXPECTED_WRITE_GUARD);
  });

  it('the read-only picker admits shared read roles', async () => {
    await purgeGET(req({}, { database: OWN_DB }), ctx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, {
      ...EXPECTED_WRITE_GUARD, allowReadRoles: true,
    });
  });

  it('database create/delete guard WRITE-scoped', async () => {
    await dbPOST(req({ name: 'newdb' }), ctx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, EXPECTED_WRITE_GUARD);
    vi.clearAllMocks();
    guard.authorizeItemWorkspace.mockResolvedValue(null as any);
    await dbDELETE(req({}, { name: CREATED_DB }), ctx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, EXPECTED_WRITE_GUARD);
  });

  it('an id naming no eventhouse is refused, not fallen through to ADX', async () => {
    cosmos.byId = [];
    expect((await purgePOST(req({ database: OWN_DB, table: 'Events', step: 'verify', predicates: PREDICATES }), ctx)).status).toBe(404);
    expect(kusto.executePurgeVerify).not.toHaveBeenCalled();
  });
});

// ── LAYER 2 — the database coordinate is bound to the item ───────────────────

describe('layer 2 — database binding', () => {
  it('refuses a database outside the workspace scope — nothing is purged', async () => {
    const res = await purgePOST(
      req({ database: VICTIM_DB, table: 'Customers', step: 'verify', predicates: PREDICATES }),
      ctx,
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/not bound to any item in this workspace/i);
    expect(kusto.executePurgeVerify).not.toHaveBeenCalled();
    expect(kusto.executePurgeCommit).not.toHaveBeenCalled();
  });

  it('refuses a foreign database on COMMIT too, not only on verify', async () => {
    const res = await purgePOST(
      req({
        database: VICTIM_DB, table: 'Customers', step: 'commit',
        predicates: PREDICATES, verificationToken: 'vt',
      }),
      ctx,
    );
    expect(res.status).toBe(403);
    expect(kusto.executePurgeCommit).not.toHaveBeenCalled();
  });

  it('refuses a foreign database on the GET picker (no table/column disclosure)', async () => {
    const res = await purgeGET(req({}, { database: VICTIM_DB }), ctx);
    expect(res.status).toBe(403);
    expect(kusto.listTables).not.toHaveBeenCalled();
    expect(kusto.getTableSchema).not.toHaveBeenCalled();
  });

  it('refuses a table the resolved database does not expose', async () => {
    const res = await purgePOST(
      req({ database: OWN_DB, table: 'Secrets', step: 'verify', predicates: PREDICATES }),
      ctx,
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/does not exist in database/i);
    expect(kusto.executePurgeVerify).not.toHaveBeenCalled();
  });

  it('fails CLOSED when the table list cannot be read', async () => {
    kusto.listTables.mockRejectedValue(new kusto.KustoError('Forbidden', 403));
    const res = await purgePOST(
      req({ database: OWN_DB, table: 'Events', step: 'verify', predicates: PREDICATES }),
      ctx,
    );
    expect(res.status).toBe(403);
    expect(kusto.executePurgeVerify).not.toHaveBeenCalled();
  });
});

// ── The legitimate owner is NOT refused ──────────────────────────────────────

describe('a legitimate owner still succeeds', () => {
  it('verifies a purge on the item’s own database', async () => {
    const res = await purgePOST(
      req({ database: OWN_DB, table: 'Events', step: 'verify', predicates: PREDICATES }),
      ctx,
    );
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.database).toBe(OWN_DB);
    expect(j.numRecordsToPurge).toBe(4);
    expect(kusto.executePurgeVerify).toHaveBeenCalledWith(OWN_DB, 'Events', "where id == 'x'");
  });

  it('commits a purge on the item’s own database', async () => {
    const res = await purgePOST(
      req({
        database: OWN_DB, table: 'Events', step: 'commit',
        predicates: PREDICATES, verificationToken: 'vt',
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect((await res.json()).operationId).toBe('op-1');
    expect(kusto.executePurgeCommit).toHaveBeenCalledWith(OWN_DB, 'Events', "where id == 'x'", 'vt');
  });

  it('a database created through this item is inside the scope (auto-bind)', async () => {
    const res = await purgePOST(
      req({ database: CREATED_DB, table: 'Events', step: 'verify', predicates: PREDICATES }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(kusto.executePurgeVerify).toHaveBeenCalledWith(CREATED_DB, 'Events', "where id == 'x'");
  });

  it('a kql-database SIBLING in the same workspace is inside the scope', async () => {
    cosmos.byWorkspace = [ITEM, {
      id: 'kql-9', itemType: 'kql-database', workspaceId: 'ws-1',
      displayName: 'Sales', state: { databaseName: 'siblingdb' },
    }];
    kusto.tablesByDb.siblingdb = ['Events'];
    const res = await purgePOST(
      req({ database: 'siblingdb', table: 'Events', step: 'verify', predicates: PREDICATES }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(kusto.executePurgeVerify).toHaveBeenCalledWith('siblingdb', 'Events', "where id == 'x'");
  });

  it('lists tables for an in-scope database through the picker', async () => {
    const res = await purgeGET(req({}, { database: OWN_DB }), ctx);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.tables.map((t: any) => t.name)).toEqual(['Events', 'Customers']);
  });
});

// ── AUTO-BIND — creating a database through the item makes it purgeable ──────

describe('auto-bind on create/delete', () => {
  it('a database created through this item becomes purgeable by it', async () => {
    const res = await dbPOST(req({ name: 'freshdb' }), ctx);
    expect(res.status).toBe(200);
    expect(kusto.createDatabase).toHaveBeenCalled();
    expect(kusto.savedState.at(-1)).toEqual({ databases: [CREATED_DB, 'freshdb'].sort() });
  });

  it('deleting a database unbinds it from the item', async () => {
    const res = await dbDELETE(req({}, { name: CREATED_DB }), ctx);
    expect(res.status).toBe(200);
    expect(arm.deleteKustoDatabase).toHaveBeenCalledWith(CREATED_DB);
    expect(kusto.savedState.at(-1)).toEqual({ databases: [] });
  });

  it('a failed create does NOT bind the name', async () => {
    kusto.createDatabase.mockRejectedValueOnce(new kusto.KustoError('quota', 429));
    const res = await dbPOST(req({ name: 'freshdb' }), ctx);
    expect(res.status).toBe(429);
    expect(kusto.savedState.length).toBe(0);
  });
});

// ── The auto-bind must not become a SCOPE-INJECTION primitive ────────────────

describe('create cannot claim a database this workspace does not own', () => {
  /**
   * `createDatabase` is an ARM PUT — Create *Or Update* — so naming an existing
   * database SUCCEEDS and rewrites its retention rather than conflicting. If the
   * created name were bound unconditionally, a caller could POST the victim's
   * database name, land it in their own item's `state.databases`, and thereby
   * widen `workspaceAdxScope` for that item AND every ADX-backed sibling —
   * re-admitting the `.purge` and cross-database `.set-or-append` this advisory
   * closes. The whole chain is asserted here, end to end.
   */
  it('refuses creating over an existing foreign database — and never calls ARM', async () => {
    const res = await dbPOST(req({ name: VICTIM_DB }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already exists .* not bound to this workspace/i);
    // The retention/hot-cache overwrite must not have happened either.
    expect(kusto.createDatabase).not.toHaveBeenCalled();
    expect(kusto.savedState.length).toBe(0);
  });

  it('an ARM 200 (already existed) is NOT bound — the race backstop', async () => {
    // The pre-flight list does not yet know about it, but ARM reports UPDATE.
    kusto.listDatabases.mockResolvedValue([{ name: OWN_DB }] as any);
    kusto.createDatabase.mockResolvedValue(
      { provisioningState: 'Succeeded', id: '/x', created: false } as any,
    );
    const res = await dbPOST(req({ name: VICTIM_DB }), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).created).toBe(false);
    expect(kusto.savedState.length).toBe(0);
  });

  it('the full injection chain is dead: create-then-purge a foreign database', async () => {
    await dbPOST(req({ name: VICTIM_DB }), ctx); // refused above
    // The item's state is unchanged, so purge still refuses the same name.
    const res = await purgePOST(
      req({ database: VICTIM_DB, table: 'Customers', step: 'verify', predicates: PREDICATES }),
      ctx,
    );
    expect(res.status).toBe(403);
    expect(kusto.executePurgeVerify).not.toHaveBeenCalled();
  });

  it('fails CLOSED when the cluster database list cannot be read', async () => {
    kusto.listDatabases.mockRejectedValue(new kusto.KustoError('Forbidden', 403));
    const res = await dbPOST(req({ name: 'freshdb' }), ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/could not verify/i);
    expect(kusto.createDatabase).not.toHaveBeenCalled();
  });

  it('re-creating a database this item ALREADY owns is still allowed', async () => {
    const res = await dbPOST(req({ name: CREATED_DB }), ctx);
    expect(res.status).toBe(200);
    // In scope, so no existence pre-flight was needed at all.
    expect(kusto.listDatabases).not.toHaveBeenCalled();
    expect(kusto.createDatabase).toHaveBeenCalled();
  });
});

// ── DELETE is the most destructive verb in this surface ─────────────────────

describe('DELETE binds the database, not just the caller', () => {
  it('refuses DROPPING a database outside the workspace scope', async () => {
    const res = await dbDELETE(req({}, { name: VICTIM_DB }), ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/not bound to any item in this workspace/i);
    expect(arm.deleteKustoDatabase).not.toHaveBeenCalled();
  });

  it('still drops a database this workspace owns', async () => {
    const res = await dbDELETE(req({}, { name: OWN_DB }), ctx);
    expect(res.status).toBe(200);
    expect(arm.deleteKustoDatabase).toHaveBeenCalledWith(OWN_DB);
  });
});

// ── The WRITE half: ingest ──────────────────────────────────────────────────

describe('ingest binds its write target', () => {
  const CSV = { name: 'rows.csv', size: 40, text: 'id,name\n1,a\n2,b' };

  it('a denied caller never reaches ADX', async () => {
    const { NextResponse } = await import('next/server');
    guard.authorizeItemWorkspace.mockResolvedValue(
      NextResponse.json({ ok: false, error: 'eventhouse not found' }, { status: 404 }) as any,
    );
    expect((await ingestPOST(formReq({ database: OWN_DB, table: 'Events' }, CSV), ctx)).status).toBe(404);
    expect(kusto.ingestInline).not.toHaveBeenCalled();
  });

  it('ingest guards WRITE-scoped', async () => {
    await ingestPOST(formReq({ database: OWN_DB, table: 'Events' }, CSV), ctx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, EXPECTED_WRITE_GUARD);
  });

  it('refuses a FILE ingest into a foreign database', async () => {
    const res = await ingestPOST(formReq({ database: VICTIM_DB, table: 'Customers' }, CSV), ctx);
    expect(res.status).toBe(403);
    expect(kusto.ingestInline).not.toHaveBeenCalled();
  });

  it('refuses a ONELAKE ingest into a foreign database — no .ingest is issued', async () => {
    const res = await ingestPOST(
      req({ kind: 'onelake', database: VICTIM_DB, table: 'Customers', oneLakePath: 'https://evil.example/x.csv' }),
      ctx,
    );
    expect(res.status).toBe(403);
    expect(kusto.executeMgmtCommand).not.toHaveBeenCalled();
  });

  it('refuses an EVENTHUB data connection on a foreign database — no ARM PUT', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await ingestPOST(
      req({ kind: 'eventhub', database: VICTIM_DB, table: 'Customers', eventHubName: 'eh' }),
      ctx,
    );
    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('an authorized owner can still ingest into their own database', async () => {
    const res = await ingestPOST(formReq({ database: OWN_DB, table: 'Events' }, CSV), ctx);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.rows).toBe(2);
    expect(kusto.ingestInline).toHaveBeenCalledWith(OWN_DB, 'Events', [['1', 'a'], ['2', 'b']]);
  });
});
