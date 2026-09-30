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
  showDatabasePrincipals: vi.fn(async () => []),
}));

import { enforceAccessGrant, revokeStructuredGrant, type AccessGrantInput } from '../access-policy-client';
import { executeQuery as synapseExecute } from '../synapse-sql-client';
import { getPoolState, resumePool } from '../synapse-pool-arm';
import { addDatabasePrincipal, dropDatabasePrincipal, showDatabasePrincipals } from '../kusto-client';

/** The SQL text of every synapseExecute call that GRANTS (the membership probe is a SELECT). */
const grantSql = () => (synapseExecute as any).mock.calls.map((c: any[]) => c[1] as string).filter((s: string) => /sp_addrolemember/.test(s));

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
    const sql = grantSql()[0];
    expect(sql).toContain('CREATE USER [alice@contoso.com] FROM EXTERNAL PROVIDER');
    expect(sql).toContain("EXEC sp_addrolemember N'db_datareader', N'alice@contoso.com'");
    expect(sql).not.toMatch(/ALTER ROLE/i);
  });

  it('maps write→db_datawriter and admin→db_owner', async () => {
    await enforceAccessGrant(warehouseInput('write'));
    expect(grantSql()[0]).toContain("sp_addrolemember N'db_datawriter'");
    vi.clearAllMocks();
    (getPoolState as any).mockResolvedValue({ state: 'Online', sku: 'DW100c', status: 'Online' });
    await enforceAccessGrant(warehouseInput('admin'));
    expect(grantSql()[0]).toContain("sp_addrolemember N'db_owner'");
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
    expect(grantSql()).toHaveLength(1);
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

  it('never throws on a backend error, and REPORTS it (policy delete must still succeed)', async () => {
    // Breaks if the error is swallowed into a silent success: a caller that
    // records the revoke would then mark a grant revoked that is still in place.
    (synapseExecute as any).mockRejectedValue(new Error('TDS down'));
    await expect(revokeStructuredGrant(warehouseInput('read'))).resolves.toEqual({ status: 'error', detail: 'TDS down' });
  });

  it('reports a completed revoke as revoked', async () => {
    // Positive pair for the error case.
    await expect(revokeStructuredGrant(kqlInput('read'))).resolves.toEqual({ status: 'revoked' });
  });
});

describe('enforceAccessGrant — whether the principal already held the role', () => {
  it('warehouse: a principal already in the role is reported preexisting, and nothing is granted', async () => {
    // Breaks if the membership probe is skipped: the grant would run and be
    // reported as created, so a later denial would drop the role the principal
    // already held.
    (synapseExecute as any).mockImplementation(async (_t: unknown, sql: string) => (
      /database_role_members/.test(sql) ? { rows: [[1]] } : { rows: [] }
    ));
    const res = await enforceAccessGrant(warehouseInput('read'));
    expect(res).toMatchObject({ status: 'active', preexisting: true });
    expect(grantSql()).toHaveLength(0);
    // The probe is parameter-bound (role + member), not concatenated.
    const probe = (synapseExecute as any).mock.calls[0];
    expect(probe[3]).toEqual([{ name: 'role', value: 'db_datareader' }, { name: 'member', value: 'alice@contoso.com' }]);
  });

  it('warehouse: a principal not in the role is granted and reported not preexisting', async () => {
    (synapseExecute as any).mockImplementation(async (_t: unknown, sql: string) => (
      /database_role_members/.test(sql) ? { rows: [[0]] } : { rows: [] }
    ));
    const res = await enforceAccessGrant(warehouseInput('read'));
    expect(res).toMatchObject({ status: 'active', preexisting: false });
    expect(grantSql()).toHaveLength(1);
  });

  it('warehouse: an unreadable probe leaves preexisting unknown (absent) and still grants', async () => {
    // Breaks if an unknown answer were reported as "not held" (created), which a
    // denial would then revoke.
    (synapseExecute as any).mockImplementation(async (_t: unknown, sql: string) => {
      if (/database_role_members/.test(sql)) throw new Error('probe failed');
      return { rows: [] };
    });
    const res = await enforceAccessGrant(warehouseInput('read'));
    expect(res.status).toBe('active');
    expect(res.preexisting).toBeUndefined();
  });

  it('ADX: a principal already holding the role is reported preexisting, and nothing is granted', async () => {
    // Breaks if the ADX grant reports every success as created (the `.add` command
    // succeeds for an existing member too).
    (showDatabasePrincipals as any).mockResolvedValue([
      { role: 'Database Viewer', principalType: 'AAD User', displayName: 'Alice', objectId: 'oid-1', fqn: 'aaduser=oid-1;tenant-1' },
    ]);
    const res = await enforceAccessGrant(kqlInput('read'));
    expect(res).toMatchObject({ status: 'active', preexisting: true });
    expect(addDatabasePrincipal).not.toHaveBeenCalled();
  });

  it('ADX: the same principal in a DIFFERENT role does not count, so the grant runs', async () => {
    // Pairs the test above: breaks if the probe matched on the principal alone.
    (showDatabasePrincipals as any).mockResolvedValue([
      { role: 'Database User', principalType: 'AAD User', displayName: 'Alice', objectId: 'oid-1', fqn: 'aaduser=oid-1;tenant-1' },
    ]);
    const res = await enforceAccessGrant(kqlInput('read'));
    expect(res).toMatchObject({ status: 'active', preexisting: false });
    expect(addDatabasePrincipal).toHaveBeenCalledOnce();
  });
});

describe('enforceAccessGrant — ADX membership probe compares the principal exactly', () => {
  const viewerRow = (objectId: string, fqn: string) => ({ role: 'Database Viewer', principalType: 'AAD User', displayName: 'x', objectId, fqn });

  it('a row for jalice@ does not count as alice@ holding the role', async () => {
    // Breaks with a substring compare: 'aaduser=jalice@contoso.com' contains
    // 'alice@contoso.com', which would report preexisting and skip `.add`.
    (showDatabasePrincipals as any).mockResolvedValue([viewerRow('oid-other', 'aaduser=jalice@contoso.com')]);
    const res = await enforceAccessGrant(kqlInput('read'));
    expect(res).toMatchObject({ status: 'active', preexisting: false });
    expect(addDatabasePrincipal).toHaveBeenCalledOnce();
    expect(addDatabasePrincipal).toHaveBeenCalledWith('loomdb', 'viewers', 'aaduser=alice@contoso.com');
  });

  it('a row for malice@ does not count as alice@ holding the role', async () => {
    // Same substring defect, a different prefix; breaks on `fqn.includes(upn)`.
    (showDatabasePrincipals as any).mockResolvedValue([viewerRow('oid-other', 'aaduser=malice@contoso.com;tenant-1')]);
    const res = await enforceAccessGrant(kqlInput('read'));
    expect(res).toMatchObject({ status: 'active', preexisting: false });
    expect(addDatabasePrincipal).toHaveBeenCalledOnce();
  });

  it('an object id that only CONTAINS the principal id does not count', async () => {
    // Breaks on `fqn.includes(id)`: 'aaduser=oid-10;tenant-1' contains 'oid-1'.
    (showDatabasePrincipals as any).mockResolvedValue([viewerRow('oid-10', 'aaduser=oid-10;tenant-1')]);
    const res = await enforceAccessGrant(kqlInput('read'));
    expect(res).toMatchObject({ status: 'active', preexisting: false });
    expect(addDatabasePrincipal).toHaveBeenCalledOnce();
  });

  it('an exact UPN row (any case) with a different object id counts as held, so nothing is granted', async () => {
    // The positive half: breaks if the exact compare were dropped altogether
    // (every probe answering "not held"), or made case-sensitive.
    (showDatabasePrincipals as any).mockResolvedValue([viewerRow('', 'AADUser=Alice@Contoso.com')]);
    const res = await enforceAccessGrant(kqlInput('read'));
    expect(res).toMatchObject({ status: 'active', preexisting: true });
    expect(addDatabasePrincipal).not.toHaveBeenCalled();
  });

  it('the same UPN under a different principal kind does not count', async () => {
    // Breaks if the kind prefix were ignored: a group named like the user is not the user.
    (showDatabasePrincipals as any).mockResolvedValue([viewerRow('', 'aadgroup=alice@contoso.com')]);
    const res = await enforceAccessGrant(kqlInput('read'));
    expect(res).toMatchObject({ status: 'active', preexisting: false });
    expect(addDatabasePrincipal).toHaveBeenCalledOnce();
  });
});

describe('enforceAccessGrant — an empty scopeRef is refused, never defaulted', () => {
  it('kql-database: an empty scopeRef returns an error and grants nothing on the default database', async () => {
    // Breaks if the arm fell back to defaultDatabase() ('loomdb' in this mock):
    // the grant would run `.add database loomdb viewers ...` and report active.
    const res = await enforceAccessGrant({ ...kqlInput('read'), scopeRef: '' });
    expect(res.status).toBe('error');
    expect(res.detail).toMatch(/KQL database name is required/);
    expect(addDatabasePrincipal).not.toHaveBeenCalled();
    expect(showDatabasePrincipals).not.toHaveBeenCalled();
  });

  it('kql-database: a named database is still granted on that database', async () => {
    // Pairs the refusal: breaks if the refusal fired for every input.
    (showDatabasePrincipals as any).mockResolvedValue([]);
    const res = await enforceAccessGrant({ ...kqlInput('read'), scopeRef: 'salesdb' });
    expect(res.status).toBe('active');
    expect(addDatabasePrincipal).toHaveBeenCalledWith('salesdb', 'viewers', 'aaduser=alice@contoso.com');
  });

  it('warehouse: an empty scopeRef returns an error and runs no SQL against the deployment pool', async () => {
    // Breaks if the arm ignored scopeRef and used dedicatedTarget() ('loompool'):
    // it would probe and then EXEC sp_addrolemember there.
    const res = await enforceAccessGrant({ ...warehouseInput('read'), scopeRef: '  ' });
    expect(res.status).toBe('error');
    expect(res.detail).toMatch(/warehouse \(dedicated SQL pool\) is required/);
    expect(synapseExecute).not.toHaveBeenCalled();
  });

  it('warehouse: a named pool is still granted', async () => {
    // Pairs the refusal above.
    (synapseExecute as any).mockImplementation(async () => ({ rows: [[0]] }));
    const res = await enforceAccessGrant(warehouseInput('read'));
    expect(res.status).toBe('active');
    expect(grantSql()).toHaveLength(1);
  });
});
