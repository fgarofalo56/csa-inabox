/**
 * BFF gate + contract tests for the unified Azure-database surface:
 *   - GET    /api/items/sql-databases                          (tenant inventory: SQL + MI + PG)
 *   - POST   /api/items/azure-sql-database/[id]/create-db      (ARM PUT new SQL DB)
 *   - POST   /api/items/azure-sql-database/[id]/connect        (bind connection to item state)
 *   - GET    /api/items/postgres-flexible-server               (list PG servers)
 *   - POST   /api/items/postgres-flexible-server               (provision PG server)
 *   - GET    /api/items/postgres-flexible-server/[id]/databases
 *   - GET/POST/DELETE /api/items/postgres-flexible-server/[id]/firewall
 *   - POST   /api/items/postgres-flexible-server/[id]/query    (honest 501 gate)
 *
 * Asserts the auth gate (401), input validation (400), per-family
 * resilience of the inventory aggregate, and that the happy path delegates
 * to the real azure-sql-client / postgres-flex-client helpers with the
 * right args. The clients are stubbed; their REST contract is exercised
 * elsewhere. These tests verify the route contract + gate behavior.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));

vi.mock('@/lib/azure/azure-sql-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/azure-sql-client');
  return {
    ...actual,
    listServers: vi.fn(),
    listManagedInstances: vi.fn(),
    createDatabase: vi.fn(),
    executeQueryBatch: vi.fn(),
  };
});

vi.mock('@/lib/azure/postgres-flex-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/postgres-flex-client');
  return {
    ...actual,
    listServers: vi.fn(),
    // The CREATE path's existence check calls `listServersResult()`, not
    // `listServers()`, because a name it did not see must be distinguishable
    // from a listing that stopped on its paging budget (re-review 2026-09-07).
    // Left in `actual` it would reach the real ARM walk, fail for want of
    // `LOOM_SUBSCRIPTION_ID`, and the route's fail-closed 503 would make this
    // whole file look like a route regression — MEASURED: `expected 503 to be
    // 201` on `POST create — delegates and returns 201`.
    listServersResult: vi.fn(),
    createServer: vi.fn(),
    listDatabases: vi.fn(),
    listFirewallRules: vi.fn(),
    upsertFirewallRule: vi.fn(),
    deleteFirewallRule: vi.fn(),
  };
});

// The flexible-server CREATE mints its admin password into Key Vault, so the
// route runs `kvSecretsConfigGate()` before anything else. Unmocked, that gate
// reads the (absent) vault env in the test process and returns a 503
// `kv_not_configured` — the happy path here could never reach 201. Mocked to
// "configured" so this file keeps testing DELEGATION; the vault contract itself
// (mint, KV-before-ARM ordering, no secret in any response body) is asserted in
// `postgres-flexible-server/__tests__/provision-credentials.test.ts`.
vi.mock('@/lib/azure/kv-secrets-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/kv-secrets-client');
  return {
    ...actual,
    kvSecretsConfigGate: () => null,
    putKeyVaultSecret: vi.fn(async (secretName: string) => ({ name: secretName })),
  };
});

// `loadOwnedItem` is what `withWorkspaceOwner` (route-toolkit) runs to enforce
// owner/workspace access on the `[id]` routes — #2723 moved /connect and /query
// onto that wrapper, so it must be mocked here too or the wrapper throws (500)
// / short-circuits 404 before the handler body ever runs.
vi.mock('../_lib/item-crud', () => ({
  jerr: (error: string, status = 500) => ({ status, json: async () => ({ ok: false, error }) }),
  updateOwnedItem: vi.fn(),
  loadOwnedItem: vi.fn(),
}));

import { GET as inventoryGET } from '../sql-databases/route';
import { POST as createDbPOST } from '../azure-sql-database/[id]/create-db/route';
import { POST as connectPOST } from '../azure-sql-database/[id]/connect/route';
import { POST as sqlQueryPOST } from '../azure-sql-database/[id]/query/route';
import {
  GET as pgListGET,
  POST as pgCreatePOST,
  adminSecretNameFor,
  SERVER_NAME_RE,
} from '../postgres-flexible-server/route';
import { GET as pgDbGET } from '../postgres-flexible-server/[id]/databases/route';
import { GET as pgFwGET, POST as pgFwPOST, DELETE as pgFwDELETE } from '../postgres-flexible-server/[id]/firewall/route';
import { POST as pgQueryPOST } from '../postgres-flexible-server/[id]/query/route';

import { getSession } from '@/lib/auth/session';
import { listServers as listSqlServers, listManagedInstances, createDatabase, executeQueryBatch } from '@/lib/azure/azure-sql-client';
import {
  listServers as listPgServers, listServersResult as listPgServersResult, createServer as createPgServer,
  listDatabases as listPgDatabases, listFirewallRules as listPgFw,
  upsertFirewallRule as upsertPgFw, deleteFirewallRule as deletePgFw,
} from '@/lib/azure/postgres-flex-client';
import { updateOwnedItem, loadOwnedItem } from '../_lib/item-crud';
// The mocked `putKeyVaultSecret` above. Every refusal arm below asserts it was
// NOT called: "nothing was written" is the contract, and a status code alone
// cannot establish it.
import { putKeyVaultSecret } from '@/lib/azure/kv-secrets-client';

function bodyReq(url: string, body: any) {
  return { url, nextUrl: new URL(url), json: async () => body } as any;
}
function getReq(url: string) {
  return { url, nextUrl: new URL(url), json: async () => ({}) } as any;
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
/**
 * Collection routes have no `[id]` segment, but a `withSession`-wrapped handler
 * is still a `RouteHandler` — `(req, ctx)`, both required — so a call with no
 * arguments is a type error even though it happens to run. Passing this keeps
 * the call sites honest about the signature they are exercising.
 */
const noParamsCtx = { params: Promise.resolve({}) } as any;
const session = { claims: { oid: 't1', upn: 'u@x.com' } };

beforeEach(() => { vi.resetAllMocks(); });

// ---------------------------------------------------------------
describe('GET /api/items/sql-databases (tenant inventory)', () => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await inventoryGET();
    expect(res.status).toBe(401);
  });

  it('aggregates all three families on the happy path', async () => {
    (getSession as any).mockReturnValue(session);
    (listSqlServers as any).mockResolvedValue([{ id: 's1', name: 'srv', location: 'eastus', fqdn: 'srv.database.windows.net' }]);
    (listManagedInstances as any).mockResolvedValue([{ id: 'm1', name: 'mi', location: 'eastus' }]);
    (listPgServers as any).mockResolvedValue([{ id: 'p1', name: 'pg', location: 'eastus', fqdn: 'pg.postgres.database.azure.com' }]);
    const res = await inventoryGET();
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.sql.servers).toHaveLength(1);
    expect(j.mi.instances).toHaveLength(1);
    expect(j.postgres.servers).toHaveLength(1);
  });

  it('is resilient: a failing family becomes an honest per-family error, others still return', async () => {
    (getSession as any).mockReturnValue(session);
    (listSqlServers as any).mockResolvedValue([{ id: 's1', name: 'srv' }]);
    (listManagedInstances as any).mockRejectedValue(new Error('MI provider not registered'));
    (listPgServers as any).mockRejectedValue(new Error('Reader role missing'));
    const res = await inventoryGET();
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.sql.servers).toHaveLength(1);
    expect(j.mi.error).toContain('MI provider');
    expect(j.postgres.error).toContain('Reader role');
  });
});

// ---------------------------------------------------------------
// GHSA-v8r7-c2p5-mjf2 (fourth pass) — create-db now runs `withOwnedSqlItem`, so
// every case must supply a route ctx and an owned item to reach the handler at
// all. The server stays a caller PICK (the database does not exist yet, so there
// is no binding to resolve) and is admitted against the authorized subscription
// set instead; that authorization is covered in depth by
// `azure-sql-database/[id]/create-db/__tests__/create-db-scope.test.ts`. These
// specs stay pointed at what they were always about — validation and delegation
// with the right args — plus the ownership requirement that is new.
//
// The bare server names below ('s', 'srv') are deliberately unchanged and still
// pass: `admitGovernedServer` consults the authorized-subscription set only for
// a FULL ARM ID, and a bare name is pinned tighter anyway by the client's own
// `LOOM_SUBSCRIPTION_ID`-scoped lookup. So this file needs no env setup.
describe('POST /azure-sql-database/[id]/create-db', () => {
  /** The owner-scoped item `withOwnedSqlItem` resolves for id=i1. */
  const ownedItem = { id: 'i1', itemType: 'azure-sql-database', workspaceId: 'ws1', state: {} } as any;

  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await createDbPOST(bodyReq('http://x/', { server: 's', name: 'd' }), ctx('i1'));
    expect(res.status).toBe(401);
  });

  it('404s a caller who does not own the [id] item, provisioning NOTHING', async () => {
    (getSession as any).mockReturnValue(session);
    (loadOwnedItem as any).mockResolvedValue(null);
    const res = await createDbPOST(bodyReq('http://x/', { server: 'srv', name: 'd' }), ctx('i1'));
    expect(res.status).toBe(404);
    expect(createDatabase).not.toHaveBeenCalled();
  });

  it('400 when name missing', async () => {
    (getSession as any).mockReturnValue(session);
    (loadOwnedItem as any).mockResolvedValue(ownedItem);
    const res = await createDbPOST(bodyReq('http://x/', { server: 's' }), ctx('i1'));
    expect(res.status).toBe(400);
  });

  it('delegates to createDatabase and returns 201', async () => {
    (getSession as any).mockReturnValue(session);
    (loadOwnedItem as any).mockResolvedValue(ownedItem);
    (createDatabase as any).mockResolvedValue({ ok: true, id: '/subs/.../databases/d', status: 'Creating' });
    const res = await createDbPOST(bodyReq('http://x/', { server: 'srv', name: 'd', skuName: 'S0', tier: 'Standard' }), ctx('i1'));
    const j = await res.json();
    expect(res.status).toBe(201);
    expect(j.ok).toBe(true);
    expect(createDatabase).toHaveBeenCalledWith(expect.objectContaining({ server: 'srv', name: 'd', skuName: 'S0', tier: 'Standard' }));
  });

  it('propagates the client error status (e.g. 403 missing role)', async () => {
    (getSession as any).mockReturnValue(session);
    (loadOwnedItem as any).mockResolvedValue(ownedItem);
    (createDatabase as any).mockResolvedValue({ ok: false, error: 'Authorization failed', status: 403 });
    const res = await createDbPOST(bodyReq('http://x/', { server: 'srv', name: 'd' }), ctx('i1'));
    expect(res.status).toBe(403);
  });

  it('passes collation + backup-redundancy + maintenance-config-id through to createDatabase', async () => {
    (getSession as any).mockReturnValue(session);
    (loadOwnedItem as any).mockResolvedValue(ownedItem);
    (createDatabase as any).mockResolvedValue({ ok: true, id: '/subs/.../databases/d', status: 'Creating' });
    const res = await createDbPOST(bodyReq('http://x/', {
      server: 'srv', name: 'd',
      collation: 'Latin1_General_100_CI_AS_SC_UTF8',
      requestedBackupStorageRedundancy: 'Zone',
      maintenanceConfigurationId: '/subscriptions/x/providers/Microsoft.Maintenance/publicMaintenanceConfigurations/SQL_EastUS2_DB_1',
    }), ctx('i1'));
    expect(res.status).toBe(201);
    expect(createDatabase).toHaveBeenCalledWith(expect.objectContaining({
      collation: 'Latin1_General_100_CI_AS_SC_UTF8',
      requestedBackupStorageRedundancy: 'Zone',
      maintenanceConfigurationId: '/subscriptions/x/providers/Microsoft.Maintenance/publicMaintenanceConfigurations/SQL_EastUS2_DB_1',
    }));
  });

  it('400 for an invalid collation string (route-level regex blocks before ARM)', async () => {
    (getSession as any).mockReturnValue(session);
    (loadOwnedItem as any).mockResolvedValue(ownedItem);
    const res = await createDbPOST(bodyReq('http://x/', { server: 'srv', name: 'd', collation: "'; DROP TABLE--" }), ctx('i1'));
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toMatch(/collation/i);
    expect(createDatabase).not.toHaveBeenCalled();
  });

  it('drops unknown requestedBackupStorageRedundancy values (allow-list: Geo|GeoZone|Local|Zone)', async () => {
    (getSession as any).mockReturnValue(session);
    (loadOwnedItem as any).mockResolvedValue(ownedItem);
    (createDatabase as any).mockResolvedValue({ ok: true, id: '/subs/.../databases/d', status: 'Creating' });
    await createDbPOST(bodyReq('http://x/', { server: 'srv', name: 'd', requestedBackupStorageRedundancy: 'Unknown' }), ctx('i1'));
    expect(createDatabase).toHaveBeenCalledWith(expect.objectContaining({ requestedBackupStorageRedundancy: undefined }));
  });
});

// ---------------------------------------------------------------
// #2723 — /connect is now wrapped in `withWorkspaceOwner`, so every case below
// first passes the owner check (`loadOwnedItem`) before the handler body runs.
describe('POST /azure-sql-database/[id]/connect', () => {
  /** The owner-scoped item `withWorkspaceOwner` resolves for id=i1. */
  const ownedItem = { id: 'i1', itemType: 'azure-sql-database', state: { mirror: 'kept' } } as any;

  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await connectPOST(bodyReq('http://x/', { family: 'azure-sql', server: 's' }), ctx('i1'));
    expect(res.status).toBe(401);
  });

  it('404 for id=new — the owner guard rejects before the handler (must save item first)', async () => {
    (getSession as any).mockReturnValue(session);
    // There is no item 'new' to own, so loadOwnedItem finds nothing.
    (loadOwnedItem as any).mockResolvedValue(null);
    const res = await connectPOST(bodyReq('http://x/', { family: 'azure-sql', server: 's' }), ctx('new'));
    // 404-not-400: withWorkspaceOwner uses the same 404-not-403 shape everywhere
    // so an id can't be probed for existence. Still a hard denial — the handler
    // body (and updateOwnedItem) never runs.
    expect(res.status).toBe(404);
    expect(updateOwnedItem).not.toHaveBeenCalled();
  });

  it('400 for an unknown family', async () => {
    (getSession as any).mockReturnValue(session);
    (loadOwnedItem as any).mockResolvedValue(ownedItem);
    const res = await connectPOST(bodyReq('http://x/', { family: 'oracle', server: 's' }), ctx('i1'));
    expect(res.status).toBe(400);
  });

  it('binds the connection to item state on the happy path', async () => {
    (getSession as any).mockReturnValue(session);
    (loadOwnedItem as any).mockResolvedValue(ownedItem);
    (updateOwnedItem as any).mockResolvedValue({ id: 'i1', state: { connection: {} } });
    const res = await connectPOST(bodyReq('http://x/', { family: 'postgres', server: 'pg', database: 'app' }), ctx('i1'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(updateOwnedItem).toHaveBeenCalledWith('i1', 'azure-sql-database', 't1', expect.objectContaining({
      state: expect.objectContaining({ connection: expect.objectContaining({ family: 'postgres', server: 'pg', database: 'app' }) }),
    }));
  });

  it('MERGES the connection into existing state — binding never wipes sibling state', async () => {
    (getSession as any).mockReturnValue(session);
    (loadOwnedItem as any).mockResolvedValue(ownedItem);
    (updateOwnedItem as any).mockResolvedValue({ id: 'i1', state: { connection: {} } });
    await connectPOST(bodyReq('http://x/', { family: 'azure-sql', server: 'srv', database: 'db' }), ctx('i1'));
    expect(updateOwnedItem).toHaveBeenCalledWith('i1', 'azure-sql-database', 't1', expect.objectContaining({
      state: expect.objectContaining({ mirror: 'kept' }),
    }));
  });
});

// ---------------------------------------------------------------
describe('PostgreSQL flexible server routes', () => {
  it('GET list — 401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await pgListGET(getReq('http://x/'), noParamsCtx);
    expect(res.status).toBe(401);
  });

  it('GET list — returns servers from the client', async () => {
    (getSession as any).mockReturnValue(session);
    (listPgServers as any).mockResolvedValue([{ id: 'p1', name: 'pg', location: 'eastus', fqdn: 'pg.postgres.database.azure.com' }]);
    const res = await pgListGET(getReq('http://x/'), noParamsCtx);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.servers[0].name).toBe('pg');
  });

  it('POST create — 400 when required fields missing', async () => {
    (getSession as any).mockReturnValue(session);
    const res = await pgCreatePOST(bodyReq('http://x/', { name: 'pg' }), noParamsCtx);
    expect(res.status).toBe(400);
  });

  // The create POST now RESOLVES THE NAME FIRST (blocking review, 2026-09-07):
  // flexible-server names are globally unique, so reusing one this estate
  // already created used to overwrite the LIVE server's admin password in Key
  // Vault before ARM refused. `listServers()` is therefore on the create path
  // and this happy-path case has to arrange "the name is free" — an unmocked
  // lookup is now a 503 `existence_check_failed`, which is the fix working, not
  // a regression. The 409 / 503 / nothing-minted assertions live in
  // `postgres-flexible-server/__tests__/provision-credentials.test.ts`.
  //
  // The name is `pg1`, not `pg`: the route validates against the documented
  // flexible-server rule (3-63 chars) BEFORE the vault gate, so a two-character
  // name is now a 400 (re-review 2026-09-08, below).
  it('POST create — delegates and returns 201', async () => {
    (getSession as any).mockReturnValue(session);
    (listPgServers as any).mockResolvedValue([]);
    // A COMPLETE listing that found nothing — the only shape the create path
    // treats as "the name is free". A truncated one is refused with a 503; that
    // contract is asserted in provision-credentials.test.ts.
    (listPgServersResult as any).mockResolvedValue({ servers: [], truncatedBy: null, pagesFetched: 1 });
    (createPgServer as any).mockResolvedValue({ ok: true, id: '/subs/.../pg1', provisioningState: 'Creating' });
    const res = await pgCreatePOST(bodyReq('http://x/', {
      name: 'pg1', resourceGroup: 'rg', location: 'eastus2',
      administratorLogin: 'a', administratorLoginPassword: 'Secret1!', skuName: 'Standard_B1ms', tier: 'Burstable',
    }), noParamsCtx);
    const j = await res.json();
    expect(res.status).toBe(201);
    expect(j.ok).toBe(true);
    expect(createPgServer).toHaveBeenCalledWith(expect.objectContaining({ name: 'pg1', resourceGroup: 'rg', tier: 'Burstable' }));
  });

  /**
   * THE SECRET NAME IS WHERE THE WRITE LANDS, AND THAT MAP IS MANY-TO-ONE
   * (independent re-review, 2026-09-08).
   *
   * `putKeyVaultSecret` runs its argument through `sanitizeSecretName`, which
   * replaces every character outside `[0-9a-zA-Z-]` with a hyphen and collapses
   * runs. The route's collision check used to compare the RAW request name
   * against the listing, so `prod_pg` did not equal the live `prod-pg`, took
   * the "free" branch, minted, and PUT a new version of `pg-admin-prod-pg` —
   * the live server's credential slot — before ARM rejected the underscore.
   *
   * These four cases are the arms that fail on that code. Each asserts that
   * `putKeyVaultSecret` was NOT called: the whole point is that nothing reaches
   * Key Vault, not merely that the response carries a different status.
   */
  const validCreateBody = {
    resourceGroup: 'rg', location: 'eastus2', administratorLogin: 'a',
    skuName: 'Standard_B1ms', tier: 'Burstable',
  };

  it.each([
    ['an underscore', 'prod_pg'],
    ['a dot', 'prod.pg'],
    ['a space', 'prod pg'],
    ['a percent', 'prod%pg'],
    ['an uppercase letter', 'ProdPg'],
    ['a trailing hyphen', 'prod-pg-'],
    ['fewer than 3 characters', 'pg'],
  ])('POST create — 400 invalid_name for %s, and NOTHING is written to Key Vault', async (_why, name) => {
    (getSession as any).mockReturnValue(session);
    // A live server whose slot every one of those names folds onto.
    (listPgServersResult as any).mockResolvedValue({
      servers: [{ id: '/subs/s/rg/prod-pg', name: 'prod-pg', location: 'eastus', fqdn: 'prod-pg.postgres.database.azure.com' }],
      truncatedBy: null, pagesFetched: 1,
    });
    const res = await pgCreatePOST(bodyReq('http://x/', { ...validCreateBody, name }), noParamsCtx);
    const j = await res.json();
    expect(res.status).toBe(400);
    expect(j.code).toBe('invalid_name');
    expect(putKeyVaultSecret).not.toHaveBeenCalled();
    expect(createPgServer).not.toHaveBeenCalled();
  });

  it('POST create — 400 ambiguous_secret_name for a LEGAL name that folds (repeated hyphen)', async () => {
    (getSession as any).mockReturnValue(session);
    (listPgServersResult as any).mockResolvedValue({ servers: [], truncatedBy: null, pagesFetched: 1 });
    // `prod--pg` passes the ARM charset rule, so calling it an invalid server
    // name would be false. It still collapses onto `pg-admin-prod-pg`, so it is
    // refused with its own reason, and the reason names the slot.
    const res = await pgCreatePOST(bodyReq('http://x/', { ...validCreateBody, name: 'prod--pg' }), noParamsCtx);
    const j = await res.json();
    expect(res.status).toBe(400);
    expect(j.code).toBe('ambiguous_secret_name');
    expect(j.adminSecretName).toBe('pg-admin-prod-pg');
    expect(j.error).toMatch(/legal server name/);
    expect(putKeyVaultSecret).not.toHaveBeenCalled();
    expect(createPgServer).not.toHaveBeenCalled();
  });

  it('POST create — 409 when a DIFFERENT server already owns the derived secret slot', async () => {
    (getSession as any).mockReturnValue(session);
    // `prod--pg` is a legal EXISTING server; its slot is `pg-admin-prod-pg`.
    // A brand-new, perfectly legal `prod-pg` would write over its credential,
    // and no name comparison can see that — only a slot comparison can.
    (listPgServersResult as any).mockResolvedValue({
      servers: [{ id: '/subs/s/rg/prod--pg', name: 'prod--pg', location: 'eastus', fqdn: 'x' }],
      truncatedBy: null, pagesFetched: 1,
    });
    const res = await pgCreatePOST(bodyReq('http://x/', { ...validCreateBody, name: 'prod-pg' }), noParamsCtx);
    const j = await res.json();
    expect(res.status).toBe(409);
    expect(j.code).toBe('secret_slot_taken');
    expect(j.existingName).toBe('prod--pg');
    expect(j.adminSecretName).toBe('pg-admin-prod-pg');
    expect(putKeyVaultSecret).not.toHaveBeenCalled();
    expect(createPgServer).not.toHaveBeenCalled();
  });

  it('POST create — every branch that names the secret names the SLOT the write uses (R7)', async () => {
    (getSession as any).mockReturnValue(session);
    (listPgServersResult as any).mockResolvedValue({
      servers: [{ id: '/subs/s/rg/prod-pg', name: 'prod-pg', location: 'eastus', fqdn: 'x' }],
      truncatedBy: null, pagesFetched: 1,
    });
    const res = await pgCreatePOST(bodyReq('http://x/', { ...validCreateBody, name: 'prod-pg' }), noParamsCtx);
    const j = await res.json();
    expect(res.status).toBe(409);
    expect(j.code).toBe('server_exists');
    expect(j.adminSecretName).toBe('pg-admin-prod-pg');
    // The prose and the field agree; before this round four branches printed
    // the unsanitized string and two printed the sanitized one for one slot.
    expect(j.error).toContain("'pg-admin-prod-pg'");
    expect(putKeyVaultSecret).not.toHaveBeenCalled();
  });

  /**
   * The route derives the secret slot itself (`adminSecretNameFor` collapses
   * hyphen runs) instead of importing `sanitizeSecretName`, because
   * `provision-credentials.test.ts` mocks `@/lib/azure/kv-secrets-client` and a
   * route that reached through that mock for a pure string function would
   * return `undefined` and 500 on every create. The reduction is only valid
   * over names ARM accepts, so this asserts it against the REAL sanitizer —
   * `vi.importActual`, not the spread mock — across that whole domain plus the
   * shapes just outside it. If `sanitizeSecretName` ever changes, this goes red
   * rather than the two definitions silently diverging (`deploy-integrity` R7).
   */
  it('adminSecretNameFor agrees with the REAL sanitizeSecretName on every ARM-legal name', async () => {
    const { sanitizeSecretName } = await vi.importActual<
      typeof import('@/lib/azure/kv-secrets-client')
    >('@/lib/azure/kv-secrets-client');
    const legal = [
      'abc',                          // shortest legal
      'prod-pg',
      'prod--pg',                     // legal at ARM, folds
      'a--------b',                   // a long run
      'p-r-o-d-p-g',
      '0pg9',                         // digit boundaries
      'a1b',
      'a'.repeat(63),                 // longest legal
      `a${'-'.repeat(61)}b`,          // maximal run, still legal at ARM
      'a-b'.repeat(21),               // 63 chars, alternating
    ];
    for (const n of legal) {
      expect(SERVER_NAME_RE.test(n), `${n} should be ARM-legal for this table`).toBe(true);
      expect(adminSecretNameFor(n), `slot for ${n}`).toBe(sanitizeSecretName(`pg-admin-${n}`));
    }
    // And the names the route refuses BEFORE ever calling the helper — proof the
    // domain restriction is real, not a convenient assumption.
    for (const n of ['prod_pg', 'prod.pg', 'prod pg', 'prod%pg', 'ProdPg', '-pg', 'pg-', 'pg', 'a'.repeat(64)]) {
      expect(SERVER_NAME_RE.test(n), `${n} must be refused before the helper runs`).toBe(false);
    }
  });

  // GHSA-v8r7-c2p5-mjf2 (fourth pass) — the databases DISCOVERY GET now runs
  // `withOwnedSqlItem`, so it needs a route ctx and an owned item. The server
  // stays a caller PICK: this call is what populates the picker, so requiring a
  // binding first would invert the flow (and race the editor's own
  // bind-on-selection effect). Authorization depth lives in
  // `postgres-flexible-server/[id]/databases/__tests__/databases-scope.test.ts`.
  const pgOwnedItem = { id: 'i1', itemType: 'postgres-flexible-server', workspaceId: 'ws1', state: {} } as any;

  it('GET databases — 404s a caller who does not own the [id] item, enumerating NOTHING', async () => {
    (getSession as any).mockReturnValue(session);
    (loadOwnedItem as any).mockResolvedValue(null);
    const res = await pgDbGET(getReq('http://x/api/items/postgres-flexible-server/i1/databases?server=pg'), ctx('i1'));
    expect(res.status).toBe(404);
    expect(listPgDatabases).not.toHaveBeenCalled();
  });

  it('GET databases — 400 without server param', async () => {
    (getSession as any).mockReturnValue(session);
    (loadOwnedItem as any).mockResolvedValue(pgOwnedItem);
    const res = await pgDbGET(getReq('http://x/api/items/postgres-flexible-server/i1/databases'), ctx('i1'));
    expect(res.status).toBe(400);
  });

  it('GET databases — returns the database list', async () => {
    (getSession as any).mockReturnValue(session);
    (loadOwnedItem as any).mockResolvedValue(pgOwnedItem);
    (listPgDatabases as any).mockResolvedValue([{ name: 'app' }, { name: 'postgres' }]);
    const res = await pgDbGET(getReq('http://x/api/items/postgres-flexible-server/i1/databases?server=pg'), ctx('i1'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.databases).toHaveLength(2);
    expect(listPgDatabases).toHaveBeenCalledWith('pg');
  });

  // GHSA-v8r7-c2p5-mjf2 (third pass) — firewall now resolves its server from the
  // OWNED `[id]` item's bound connection instead of from the request, so these
  // cases must supply a route ctx and an owned, bound item to reach the handler
  // at all. Firewall rules are a NETWORK EXPOSURE primitive: POST is an
  // idempotent PUT, so the old body-addressed shape let any signed-in caller
  // open any reachable PostgreSQL server to the internet. The authorization is
  // covered in depth by
  // `postgres-flexible-server/[id]/firewall/__tests__/firewall-scope.test.ts`;
  // this spec stays pointed at what it was always about — validation and
  // delegation with the right args — plus the ownership requirement that is new.
  const pgFwBoundItem = {
    id: 'i1', itemType: 'postgres-flexible-server', workspaceId: 'ws1',
    state: { connection: { family: 'postgres', server: 'pg' } },
  } as any;

  it('firewall — 404s a caller who does not own the [id] item, touching NO rule', async () => {
    (getSession as any).mockReturnValue(session);
    (loadOwnedItem as any).mockResolvedValue(null);
    const res = await pgFwPOST(
      bodyReq('http://x/', { server: 'pg', name: 'r', startIpAddress: '0.0.0.0', endIpAddress: '255.255.255.255' }),
      ctx('i1'),
    );
    expect(res.status).toBe(404);
    expect(upsertPgFw).not.toHaveBeenCalled();
  });

  it('firewall GET/POST/DELETE — validate + delegate', async () => {
    (getSession as any).mockReturnValue(session);
    (loadOwnedItem as any).mockResolvedValue(pgFwBoundItem);
    (listPgFw as any).mockResolvedValue([{ name: 'r', startIpAddress: '1.1.1.1', endIpAddress: '1.1.1.1' }]);
    const g = await pgFwGET(getReq('http://x/?server=pg'), ctx('i1'));
    expect((await g.json()).ok).toBe(true);

    const bad = await pgFwPOST(bodyReq('http://x/', { server: 'pg', name: 'r' }), ctx('i1'));
    expect(bad.status).toBe(400);

    (upsertPgFw as any).mockResolvedValue({ name: 'r', startIpAddress: '1.1.1.1', endIpAddress: '1.1.1.2' });
    const ok = await pgFwPOST(bodyReq('http://x/', { server: 'pg', name: 'r', startIpAddress: '1.1.1.1', endIpAddress: '1.1.1.2' }), ctx('i1'));
    expect((await ok.json()).ok).toBe(true);
    expect(upsertPgFw).toHaveBeenCalledWith('pg', { name: 'r', startIpAddress: '1.1.1.1', endIpAddress: '1.1.1.2' });

    (deletePgFw as any).mockResolvedValue(undefined);
    const del = await pgFwDELETE(getReq('http://x/?server=pg&rule=r'), ctx('i1'));
    expect((await del.json()).ok).toBe(true);
    expect(deletePgFw).toHaveBeenCalledWith('pg', 'r');
  });

  // GHSA-v8r7-c2p5-mjf2 — /query now resolves its server from the OWNED `[id]`
  // item's bound connection instead of from the body, so these cases must supply
  // a route ctx and an owned, bound item to reach the handler at all. The
  // authorization itself is covered in depth by
  // `postgres-flexible-server/[id]/query/__tests__/query-scope.test.ts`; the two
  // specs below stay pointed at what they were always about — the honest config
  // gate and the sql validation — plus the ownership requirement that is new.
  const pgBoundItem = {
    id: 'i1', itemType: 'azure-sql-database', workspaceId: 'ws1',
    state: { connection: { family: 'postgres', server: 'pg', database: 'app' } },
  } as any;

  it('query — 404s a caller who does not own the [id] item, before any gate', async () => {
    (getSession as any).mockReturnValue(session);
    (loadOwnedItem as any).mockResolvedValue(null);
    const res = await pgQueryPOST(bodyReq('http://x/', { server: 'pg', database: 'app', sql: 'SELECT 1' }), ctx('i1'));
    expect(res.status).toBe(404);
  });

  it('query — returns an honest config gate (503, never fabricates rows)', async () => {
    (getSession as any).mockReturnValue(session);
    (loadOwnedItem as any).mockResolvedValue(pgBoundItem);
    const res = await pgQueryPOST(bodyReq('http://x/', { server: 'pg', database: 'app', sql: 'SELECT 1' }), ctx('i1'));
    const j = await res.json();
    // The unprovisioned-dependency gate (UAMI not registered as a PG Entra
    // principal) is a 503 service-config gate carrying { gated:true }.
    expect(res.status).toBe(503);
    expect(j.ok).toBe(false);
    expect(j.gated).toBe(true);
    expect(j.error).toMatch(/pg/i);
  });

  it('query — 400 when sql missing', async () => {
    (getSession as any).mockReturnValue(session);
    (loadOwnedItem as any).mockResolvedValue(pgBoundItem);
    const res = await pgQueryPOST(bodyReq('http://x/', { server: 'pg', database: 'app' }), ctx('i1'));
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------
// #2723 — /query is wrapped in `withWorkspaceOwner` and derives its server +
// database from the OWNED item's bound connection. The body can no longer pick
// the target, so every case here resolves an owned, bound item first.
describe('POST /azure-sql-database/[id]/query (multi-result-set shape)', () => {
  /** Owned item bound (by POST /connect) to server 's' / database 'd'. */
  const boundItem = {
    id: 'i1', itemType: 'azure-sql-database',
    state: { connection: { family: 'azure-sql', server: 's', database: 'd' } },
  } as any;

  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await sqlQueryPOST(bodyReq('http://x/', { sql: 'SELECT 1' }), ctx('i1'));
    expect(res.status).toBe(401);
  });

  it('404 when the caller does not own the item — the guard runs before any SQL', async () => {
    (getSession as any).mockReturnValue(session);
    (loadOwnedItem as any).mockResolvedValue(null);
    const res = await sqlQueryPOST(bodyReq('http://x/', { sql: 'SELECT 1' }), ctx('i1'));
    expect(res.status).toBe(404);
    expect(executeQueryBatch).not.toHaveBeenCalled();
  });

  it('400 when sql is missing', async () => {
    (getSession as any).mockReturnValue(session);
    (loadOwnedItem as any).mockResolvedValue(boundItem);
    const res = await sqlQueryPOST(bodyReq('http://x/', {}), ctx('i1'));
    expect(res.status).toBe(400);
  });

  it('returns recordsets[] + messages[] + backward-compat fields on the happy path', async () => {
    (getSession as any).mockReturnValue(session);
    (loadOwnedItem as any).mockResolvedValue(boundItem);
    (executeQueryBatch as any).mockResolvedValue({
      recordsets: [
        { columns: ['a'], rows: [[1]], rowCount: 1, truncated: false },
        { columns: ['b', 'c'], rows: [[2, 3]], rowCount: 1, truncated: false },
      ],
      messages: [{ message: 'batch start', number: 0, severity: 0, lineNumber: 1, serverName: 'srv', procName: '' }],
      rowsAffected: [0, 1, 1],
      executionMs: 42,
    });
    // NOTE: the body carries NO server/database — the target is DERIVED from the
    // owned item's bound connection (#2723).
    const res = await sqlQueryPOST(bodyReq('http://x/', { sql: "PRINT 'x'; SELECT 1 AS a; SELECT 2 AS b, 3 AS c;" }), ctx('i1'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    // Multi-recordset shape
    expect(j.recordsets).toHaveLength(2);
    expect(j.messages).toHaveLength(1);
    expect(j.rowsAffected).toEqual([0, 1, 1]);
    expect(j.executionMs).toBe(42);
    // Backward-compat fields promoted from the first recordset
    expect(j.columns).toEqual(['a']);
    expect(j.rows).toEqual([[1]]);
    expect(j.rowCount).toBe(1);
    // 's' / 'd' came from item.state.connection, NOT the body. The route forwards
    // an optional 4th cancel-token options arg (undefined with no requestId).
    expect(executeQueryBatch).toHaveBeenCalledWith('s', 'd', "PRINT 'x'; SELECT 1 AS a; SELECT 2 AS b, 3 AS c;", undefined);
  });

  it('403s a body that names a DIFFERENT server — the body can only trigger a rejection', async () => {
    (getSession as any).mockReturnValue(session);
    (loadOwnedItem as any).mockResolvedValue(boundItem);
    const res = await sqlQueryPOST(bodyReq('http://x/', { server: 'attacker', database: 'd', sql: 'SELECT 1' }), ctx('i1'));
    expect(res.status).toBe(403);
    expect(executeQueryBatch).not.toHaveBeenCalled();
  });

  it('409s when the item has no bound connection — no implicit target', async () => {
    (getSession as any).mockReturnValue(session);
    (loadOwnedItem as any).mockResolvedValue({ id: 'i1', itemType: 'azure-sql-database', state: {} });
    const res = await sqlQueryPOST(bodyReq('http://x/', { server: 's', database: 'd', sql: 'SELECT 1' }), ctx('i1'));
    expect(res.status).toBe(409);
    expect(executeQueryBatch).not.toHaveBeenCalled();
  });

  it('propagates an AzureSqlError status (e.g. 401 token failure)', async () => {
    (getSession as any).mockReturnValue(session);
    (loadOwnedItem as any).mockResolvedValue(boundItem);
    const { AzureSqlError } = await vi.importActual<any>('@/lib/azure/azure-sql-client');
    (executeQueryBatch as any).mockRejectedValue(new AzureSqlError('Failed to acquire AAD token for Azure SQL', 401));
    const res = await sqlQueryPOST(bodyReq('http://x/', { sql: 'SELECT 1' }), ctx('i1'));
    expect(res.status).toBe(401);
    const j = await res.json();
    expect(j.ok).toBe(false);
  });
});
