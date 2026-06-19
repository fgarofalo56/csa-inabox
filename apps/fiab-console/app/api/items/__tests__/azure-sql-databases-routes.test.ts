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
    createServer: vi.fn(),
    listDatabases: vi.fn(),
    listFirewallRules: vi.fn(),
    upsertFirewallRule: vi.fn(),
    deleteFirewallRule: vi.fn(),
  };
});

vi.mock('../_lib/item-crud', () => ({
  jerr: (error: string, status = 500) => ({ status, json: async () => ({ ok: false, error }) }),
  updateOwnedItem: vi.fn(),
}));

import { GET as inventoryGET } from '../sql-databases/route';
import { POST as createDbPOST } from '../azure-sql-database/[id]/create-db/route';
import { POST as connectPOST } from '../azure-sql-database/[id]/connect/route';
import { POST as sqlQueryPOST } from '../azure-sql-database/[id]/query/route';
import { GET as pgListGET, POST as pgCreatePOST } from '../postgres-flexible-server/route';
import { GET as pgDbGET } from '../postgres-flexible-server/[id]/databases/route';
import { GET as pgFwGET, POST as pgFwPOST, DELETE as pgFwDELETE } from '../postgres-flexible-server/[id]/firewall/route';
import { POST as pgQueryPOST } from '../postgres-flexible-server/[id]/query/route';

import { getSession } from '@/lib/auth/session';
import { listServers as listSqlServers, listManagedInstances, createDatabase, executeQueryBatch } from '@/lib/azure/azure-sql-client';
import {
  listServers as listPgServers, createServer as createPgServer,
  listDatabases as listPgDatabases, listFirewallRules as listPgFw,
  upsertFirewallRule as upsertPgFw, deleteFirewallRule as deletePgFw,
} from '@/lib/azure/postgres-flex-client';
import { updateOwnedItem } from '../_lib/item-crud';

function bodyReq(url: string, body: any) {
  return { url, nextUrl: new URL(url), json: async () => body } as any;
}
function getReq(url: string) {
  return { url, nextUrl: new URL(url), json: async () => ({}) } as any;
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
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
describe('POST /azure-sql-database/[id]/create-db', () => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await createDbPOST(bodyReq('http://x/', { server: 's', name: 'd' }));
    expect(res.status).toBe(401);
  });

  it('400 when name missing', async () => {
    (getSession as any).mockReturnValue(session);
    const res = await createDbPOST(bodyReq('http://x/', { server: 's' }));
    expect(res.status).toBe(400);
  });

  it('delegates to createDatabase and returns 201', async () => {
    (getSession as any).mockReturnValue(session);
    (createDatabase as any).mockResolvedValue({ ok: true, id: '/subs/.../databases/d', status: 'Creating' });
    const res = await createDbPOST(bodyReq('http://x/', { server: 'srv', name: 'd', skuName: 'S0', tier: 'Standard' }));
    const j = await res.json();
    expect(res.status).toBe(201);
    expect(j.ok).toBe(true);
    expect(createDatabase).toHaveBeenCalledWith(expect.objectContaining({ server: 'srv', name: 'd', skuName: 'S0', tier: 'Standard' }));
  });

  it('propagates the client error status (e.g. 403 missing role)', async () => {
    (getSession as any).mockReturnValue(session);
    (createDatabase as any).mockResolvedValue({ ok: false, error: 'Authorization failed', status: 403 });
    const res = await createDbPOST(bodyReq('http://x/', { server: 'srv', name: 'd' }));
    expect(res.status).toBe(403);
  });

  it('passes collation + backup-redundancy + maintenance-config-id through to createDatabase', async () => {
    (getSession as any).mockReturnValue(session);
    (createDatabase as any).mockResolvedValue({ ok: true, id: '/subs/.../databases/d', status: 'Creating' });
    const res = await createDbPOST(bodyReq('http://x/', {
      server: 'srv', name: 'd',
      collation: 'Latin1_General_100_CI_AS_SC_UTF8',
      requestedBackupStorageRedundancy: 'Zone',
      maintenanceConfigurationId: '/subscriptions/x/providers/Microsoft.Maintenance/publicMaintenanceConfigurations/SQL_EastUS2_DB_1',
    }));
    expect(res.status).toBe(201);
    expect(createDatabase).toHaveBeenCalledWith(expect.objectContaining({
      collation: 'Latin1_General_100_CI_AS_SC_UTF8',
      requestedBackupStorageRedundancy: 'Zone',
      maintenanceConfigurationId: '/subscriptions/x/providers/Microsoft.Maintenance/publicMaintenanceConfigurations/SQL_EastUS2_DB_1',
    }));
  });

  it('400 for an invalid collation string (route-level regex blocks before ARM)', async () => {
    (getSession as any).mockReturnValue(session);
    const res = await createDbPOST(bodyReq('http://x/', { server: 'srv', name: 'd', collation: "'; DROP TABLE--" }));
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toMatch(/collation/i);
    expect(createDatabase).not.toHaveBeenCalled();
  });

  it('drops unknown requestedBackupStorageRedundancy values (allow-list: Geo|GeoZone|Local|Zone)', async () => {
    (getSession as any).mockReturnValue(session);
    (createDatabase as any).mockResolvedValue({ ok: true, id: '/subs/.../databases/d', status: 'Creating' });
    await createDbPOST(bodyReq('http://x/', { server: 'srv', name: 'd', requestedBackupStorageRedundancy: 'Unknown' }));
    expect(createDatabase).toHaveBeenCalledWith(expect.objectContaining({ requestedBackupStorageRedundancy: undefined }));
  });
});

// ---------------------------------------------------------------
describe('POST /azure-sql-database/[id]/connect', () => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await connectPOST(bodyReq('http://x/', { family: 'azure-sql', server: 's' }), ctx('i1'));
    expect(res.status).toBe(401);
  });

  it('400 for id=new (must save item first)', async () => {
    (getSession as any).mockReturnValue(session);
    const res = await connectPOST(bodyReq('http://x/', { family: 'azure-sql', server: 's' }), ctx('new'));
    expect(res.status).toBe(400);
  });

  it('400 for an unknown family', async () => {
    (getSession as any).mockReturnValue(session);
    const res = await connectPOST(bodyReq('http://x/', { family: 'oracle', server: 's' }), ctx('i1'));
    expect(res.status).toBe(400);
  });

  it('binds the connection to item state on the happy path', async () => {
    (getSession as any).mockReturnValue(session);
    (updateOwnedItem as any).mockResolvedValue({ id: 'i1', state: { connection: {} } });
    const res = await connectPOST(bodyReq('http://x/', { family: 'postgres', server: 'pg', database: 'app' }), ctx('i1'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(updateOwnedItem).toHaveBeenCalledWith('i1', 'azure-sql-database', 't1', expect.objectContaining({
      state: expect.objectContaining({ connection: expect.objectContaining({ family: 'postgres', server: 'pg', database: 'app' }) }),
    }));
  });
});

// ---------------------------------------------------------------
describe('PostgreSQL flexible server routes', () => {
  it('GET list — 401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await pgListGET();
    expect(res.status).toBe(401);
  });

  it('GET list — returns servers from the client', async () => {
    (getSession as any).mockReturnValue(session);
    (listPgServers as any).mockResolvedValue([{ id: 'p1', name: 'pg', location: 'eastus', fqdn: 'pg.postgres.database.azure.com' }]);
    const res = await pgListGET();
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.servers[0].name).toBe('pg');
  });

  it('POST create — 400 when required fields missing', async () => {
    (getSession as any).mockReturnValue(session);
    const res = await pgCreatePOST(bodyReq('http://x/', { name: 'pg' }));
    expect(res.status).toBe(400);
  });

  it('POST create — delegates and returns 201', async () => {
    (getSession as any).mockReturnValue(session);
    (createPgServer as any).mockResolvedValue({ ok: true, id: '/subs/.../pg', provisioningState: 'Creating' });
    const res = await pgCreatePOST(bodyReq('http://x/', {
      name: 'pg', resourceGroup: 'rg', location: 'eastus2',
      administratorLogin: 'a', administratorLoginPassword: 'Secret1!', skuName: 'Standard_B1ms', tier: 'Burstable',
    }));
    const j = await res.json();
    expect(res.status).toBe(201);
    expect(j.ok).toBe(true);
    expect(createPgServer).toHaveBeenCalledWith(expect.objectContaining({ name: 'pg', resourceGroup: 'rg', tier: 'Burstable' }));
  });

  it('GET databases — 400 without server param', async () => {
    (getSession as any).mockReturnValue(session);
    const res = await pgDbGET(getReq('http://x/api/items/postgres-flexible-server/i1/databases'));
    expect(res.status).toBe(400);
  });

  it('GET databases — returns the database list', async () => {
    (getSession as any).mockReturnValue(session);
    (listPgDatabases as any).mockResolvedValue([{ name: 'app' }, { name: 'postgres' }]);
    const res = await pgDbGET(getReq('http://x/api/items/postgres-flexible-server/i1/databases?server=pg'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.databases).toHaveLength(2);
    expect(listPgDatabases).toHaveBeenCalledWith('pg');
  });

  it('firewall GET/POST/DELETE — validate + delegate', async () => {
    (getSession as any).mockReturnValue(session);
    (listPgFw as any).mockResolvedValue([{ name: 'r', startIpAddress: '1.1.1.1', endIpAddress: '1.1.1.1' }]);
    const g = await pgFwGET(getReq('http://x/?server=pg'));
    expect((await g.json()).ok).toBe(true);

    const bad = await pgFwPOST(bodyReq('http://x/', { server: 'pg', name: 'r' }));
    expect(bad.status).toBe(400);

    (upsertPgFw as any).mockResolvedValue({ name: 'r', startIpAddress: '1.1.1.1', endIpAddress: '1.1.1.2' });
    const ok = await pgFwPOST(bodyReq('http://x/', { server: 'pg', name: 'r', startIpAddress: '1.1.1.1', endIpAddress: '1.1.1.2' }));
    expect((await ok.json()).ok).toBe(true);
    expect(upsertPgFw).toHaveBeenCalledWith('pg', { name: 'r', startIpAddress: '1.1.1.1', endIpAddress: '1.1.1.2' });

    (deletePgFw as any).mockResolvedValue(undefined);
    const del = await pgFwDELETE(getReq('http://x/?server=pg&rule=r'));
    expect((await del.json()).ok).toBe(true);
    expect(deletePgFw).toHaveBeenCalledWith('pg', 'r');
  });

  it('query — returns an honest config gate (503, never fabricates rows)', async () => {
    (getSession as any).mockReturnValue(session);
    const res = await pgQueryPOST(bodyReq('http://x/', { server: 'pg', database: 'app', sql: 'SELECT 1' }));
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
    const res = await pgQueryPOST(bodyReq('http://x/', { server: 'pg', database: 'app' }));
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------
describe('POST /azure-sql-database/[id]/query (multi-result-set shape)', () => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await sqlQueryPOST(bodyReq('http://x/', { server: 's', database: 'd', sql: 'SELECT 1' }));
    expect(res.status).toBe(401);
  });

  it('400 when sql is missing', async () => {
    (getSession as any).mockReturnValue(session);
    const res = await sqlQueryPOST(bodyReq('http://x/', { server: 's', database: 'd' }));
    expect(res.status).toBe(400);
  });

  it('returns recordsets[] + messages[] + backward-compat fields on the happy path', async () => {
    (getSession as any).mockReturnValue(session);
    (executeQueryBatch as any).mockResolvedValue({
      recordsets: [
        { columns: ['a'], rows: [[1]], rowCount: 1, truncated: false },
        { columns: ['b', 'c'], rows: [[2, 3]], rowCount: 1, truncated: false },
      ],
      messages: [{ message: 'batch start', number: 0, severity: 0, lineNumber: 1, serverName: 'srv', procName: '' }],
      rowsAffected: [0, 1, 1],
      executionMs: 42,
    });
    const res = await sqlQueryPOST(bodyReq('http://x/', { server: 's', database: 'd', sql: "PRINT 'x'; SELECT 1 AS a; SELECT 2 AS b, 3 AS c;" }));
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
    // The route forwards an optional 4th cancel-token options arg (undefined
    // when the body carries no requestId).
    expect(executeQueryBatch).toHaveBeenCalledWith('s', 'd', "PRINT 'x'; SELECT 1 AS a; SELECT 2 AS b, 3 AS c;", undefined);
  });

  it('propagates an AzureSqlError status (e.g. 401 token failure)', async () => {
    (getSession as any).mockReturnValue(session);
    const { AzureSqlError } = await vi.importActual<any>('@/lib/azure/azure-sql-client');
    (executeQueryBatch as any).mockRejectedValue(new AzureSqlError('Failed to acquire AAD token for Azure SQL', 401));
    const res = await sqlQueryPOST(bodyReq('http://x/', { server: 's', database: 'd', sql: 'SELECT 1' }));
    expect(res.status).toBe(401);
    const j = await res.json();
    expect(j.ok).toBe(false);
  });
});
