/**
 * Unit tests for enforceAccessGrant / revokeStructuredGrant — the non-ADLS
 * (warehouse + KQL) access-policy enforcement paths.
 *
 * Asserts the load-bearing correctness contract:
 *   - warehouse GRANT emits `sp_addrolemember` (NOT `ALTER ROLE ... ADD MEMBER`,
 *     which Synapse **Dedicated** SQL pools reject) and keeps `CREATE USER ...
 *     FROM EXTERNAL PROVIDER`.
 *   - warehouse REVOKE emits `sp_droprolemember` (NOT `ALTER ROLE ... DROP MEMBER`).
 *   - a paused Dedicated pool yields status 'pending' (resume kicked off) — never
 *     a silent success (no-vaporware.md).
 *   - kql-database GRANT/REVOKE route through the typed ADX helpers with the
 *     permission→role mapping (read→viewers, write→users, admin→admins).
 *
 * All Azure clients are mocked so we assert the emitted commands, not live REST.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../adls-client', () => ({
  grantContainerRole: vi.fn(),
  revokeContainerRoleAssignment: vi.fn(),
}));
vi.mock('../synapse-sql-client', () => ({
  dedicatedTarget: vi.fn(() => ({ server: 'ws.sql.azuresynapse.net', database: 'loompool', cacheKey: 'k' })),
  executeQuery: vi.fn(async () => ({ recordset: [] })),
}));
vi.mock('../synapse-pool-arm', () => ({
  getPoolState: vi.fn(async () => ({ state: 'Online', sku: 'DW100c', status: 'Online' })),
  resumePool: vi.fn(async () => {}),
}));
vi.mock('../kusto-client', () => ({
  defaultDatabase: vi.fn(() => 'loomdb'),
  kustoConfigGate: vi.fn(() => null),
  addDatabasePrincipal: vi.fn(async () => ({ columns: [], rows: [] })),
  dropDatabasePrincipal: vi.fn(async () => ({ columns: [], rows: [] })),
}));

import { enforceAccessGrant, revokeStructuredGrant, type AccessGrantInput } from '../access-policy-client';
import { executeQuery as synapseExecute } from '../synapse-sql-client';
import { getPoolState, resumePool } from '../synapse-pool-arm';
import { addDatabasePrincipal, dropDatabasePrincipal } from '../kusto-client';

const warehouseInput = (perm: AccessGrantInput['permission'] = 'read'): AccessGrantInput => ({
  principalId: 'oid-1',
  principalName: 'alice@contoso.com',
  principalType: 'User',
  scopeType: 'warehouse',
  scopeRef: 'loompool',
  permission: perm,
});

const kqlInput = (perm: AccessGrantInput['permission'] = 'read'): AccessGrantInput => ({
  principalId: 'oid-1',
  principalName: 'alice@contoso.com',
  principalType: 'User',
  scopeType: 'kql-database',
  scopeRef: 'loomdb',
  permission: perm,
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AZURE_TENANT_ID = 'tenant-1';
  (getPoolState as any).mockResolvedValue({ state: 'Online', sku: 'DW100c', status: 'Online' });
});

describe('enforceAccessGrant — warehouse (Synapse Dedicated SQL)', () => {
  it('emits sp_addrolemember and CREATE USER, never ALTER ROLE ... ADD MEMBER', async () => {
    const res = await enforceAccessGrant(warehouseInput('read'));
    expect(res.status).toBe('active');
    expect(res.roleName).toBe('db_datareader');
    const sql = (synapseExecute as any).mock.calls[0][1] as string;
    expect(sql).toContain('CREATE USER [alice@contoso.com] FROM EXTERNAL PROVIDER');
    expect(sql).toContain("EXEC sp_addrolemember N'db_datareader', N'alice@contoso.com'");
    expect(sql).not.toMatch(/ALTER ROLE/i);
  });

  it('maps write→db_datawriter and admin→db_owner', async () => {
    await enforceAccessGrant(warehouseInput('write'));
    expect((synapseExecute as any).mock.calls[0][1]).toContain("sp_addrolemember N'db_datawriter'");
    vi.clearAllMocks();
    (getPoolState as any).mockResolvedValue({ state: 'Online', sku: 'DW100c', status: 'Online' });
    await enforceAccessGrant(warehouseInput('admin'));
    expect((synapseExecute as any).mock.calls[0][1]).toContain("sp_addrolemember N'db_owner'");
  });

  it('returns pending and starts a resume when the pool is paused (no silent success)', async () => {
    (getPoolState as any).mockResolvedValue({ state: 'Paused', sku: 'DW100c', status: 'Paused' });
    const res = await enforceAccessGrant(warehouseInput('read'));
    expect(res.status).toBe('pending');
    expect(res.detail).toMatch(/paused/i);
    expect(resumePool).toHaveBeenCalledOnce();
    expect(synapseExecute).not.toHaveBeenCalled();
  });

  it('returns pending while the pool is Resuming/Scaling without granting', async () => {
    (getPoolState as any).mockResolvedValue({ state: 'Resuming', sku: 'DW100c', status: 'Resuming' });
    const res = await enforceAccessGrant(warehouseInput('read'));
    expect(res.status).toBe('pending');
    expect(synapseExecute).not.toHaveBeenCalled();
  });

  it('proceeds to grant when the ARM state probe is unavailable', async () => {
    (getPoolState as any).mockRejectedValue(new Error('Missing env var: LOOM_SUBSCRIPTION_ID'));
    const res = await enforceAccessGrant(warehouseInput('read'));
    expect(res.status).toBe('active');
    expect(synapseExecute).toHaveBeenCalledOnce();
  });

  it('requires a principal name', async () => {
    const res = await enforceAccessGrant({ ...warehouseInput(), principalName: '   ' });
    expect(res.status).toBe('error');
    expect(res.detail).toMatch(/UPN \/ name is required/i);
  });
});

describe('enforceAccessGrant — kql-database (ADX)', () => {
  it('routes through addDatabasePrincipal with read→viewers and the UPN FQN', async () => {
    const res = await enforceAccessGrant(kqlInput('read'));
    expect(res.status).toBe('active');
    expect(res.roleName).toBe('viewers');
    expect(addDatabasePrincipal).toHaveBeenCalledWith('loomdb', 'viewers', 'aaduser=alice@contoso.com');
  });

  it('maps write→users and admin→admins', async () => {
    await enforceAccessGrant(kqlInput('write'));
    expect(addDatabasePrincipal).toHaveBeenCalledWith('loomdb', 'users', expect.any(String));
    vi.clearAllMocks();
    await enforceAccessGrant(kqlInput('admin'));
    expect(addDatabasePrincipal).toHaveBeenCalledWith('loomdb', 'admins', expect.any(String));
  });
});

describe('revokeStructuredGrant', () => {
  it('emits sp_droprolemember for warehouse (never ALTER ROLE ... DROP MEMBER)', async () => {
    await revokeStructuredGrant(warehouseInput('write'));
    const sql = (synapseExecute as any).mock.calls[0][1] as string;
    expect(sql).toContain("EXEC sp_droprolemember N'db_datawriter', N'alice@contoso.com'");
    expect(sql).not.toMatch(/ALTER ROLE/i);
  });

  it('routes ADX revoke through dropDatabasePrincipal', async () => {
    await revokeStructuredGrant(kqlInput('read'));
    expect(dropDatabasePrincipal).toHaveBeenCalledWith('loomdb', 'viewers', 'aaduser=alice@contoso.com');
  });

  it('never throws on a backend error (policy delete must still succeed)', async () => {
    (synapseExecute as any).mockRejectedValue(new Error('TDS down'));
    await expect(revokeStructuredGrant(warehouseInput('read'))).resolves.toBeUndefined();
  });
});
