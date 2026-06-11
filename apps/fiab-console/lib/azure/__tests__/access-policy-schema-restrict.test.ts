/**
 * Vitest specs for the DLP schema-level restrict additions in access-policy-client:
 *   - denySchemaAccess   → emits injection-safe `DENY SELECT ON SCHEMA` DDL
 *   - revokeSchemaDeny   → emits the inverse REVOKE
 *   - listWarehouseSchemas → enumerates user schemas (honest gate when unconfigured)
 *
 * Backends are mocked; we assert on the exact SQL text handed to Synapse so the
 * escaping (sqlBracket / sqlString) is verified — no real TDS connection.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const executeMock = vi.fn();
let dedicatedThrows = false;

vi.mock('../synapse-sql-client', () => ({
  dedicatedTarget: () => {
    if (dedicatedThrows) throw new Error('Missing env var: LOOM_SYNAPSE_WORKSPACE');
    return { server: 'ws.sql', database: 'pool1', cacheKey: 'k' };
  },
  executeQuery: (...args: any[]) => executeMock(...args),
}));
vi.mock('../adls-client', () => ({
  grantContainerRole: vi.fn(),
  revokeContainerRoleAssignment: vi.fn(),
}));
vi.mock('../kusto-client', () => ({
  executeMgmtCommand: vi.fn(),
  defaultDatabase: () => '',
  kustoConfigGate: () => null,
}));

describe('access-policy-client — DLP schema restrict', () => {
  beforeEach(() => { executeMock.mockReset(); dedicatedThrows = false; });
  afterEach(() => vi.restoreAllMocks());

  it('denySchemaAccess emits CREATE USER + DENY SELECT ON SCHEMA with safe escaping', async () => {
    executeMock.mockResolvedValue({ rows: [], rowCount: 0 });
    const mod = await import('../access-policy-client');
    const r = await mod.denySchemaAccess({ principalName: "o'malley@contoso.com", schema: 'sa]les' });
    expect(r.status).toBe('active');
    const sql = executeMock.mock.calls[0][1] as string;
    // Identifier escaping: ] doubled inside brackets.
    expect(sql).toContain('SCHEMA::[sa]]les]');
    expect(sql).toContain("CREATE USER [o'malley@contoso.com] FROM EXTERNAL PROVIDER");
    // String literal escaping: ' doubled.
    expect(sql).toContain("name = N'o''malley@contoso.com'");
    expect(sql).toMatch(/DENY SELECT ON SCHEMA::\[sa\]\]les\] TO \[o'malley@contoso\.com\]/);
  });

  it('denySchemaAccess returns a pending gate when the warehouse is not configured', async () => {
    dedicatedThrows = true;
    const mod = await import('../access-policy-client');
    const r = await mod.denySchemaAccess({ principalName: 'a@b.com', schema: 'dbo' });
    expect(r.status).toBe('pending');
    expect(r.detail).toMatch(/LOOM_SYNAPSE_WORKSPACE/);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('denySchemaAccess errors without a principal name or schema', async () => {
    const mod = await import('../access-policy-client');
    expect((await mod.denySchemaAccess({ principalName: '', schema: 'dbo' })).status).toBe('error');
    expect((await mod.denySchemaAccess({ principalName: 'a@b.com', schema: '' })).status).toBe('error');
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('revokeSchemaDeny emits a REVOKE SELECT ON SCHEMA statement', async () => {
    executeMock.mockResolvedValue({ rows: [], rowCount: 0 });
    const mod = await import('../access-policy-client');
    await mod.revokeSchemaDeny({ principalName: 'a@b.com', schema: 'gold' });
    const sql = executeMock.mock.calls[0][1] as string;
    expect(sql).toBe('REVOKE SELECT ON SCHEMA::[gold] TO [a@b.com];');
  });

  it('listWarehouseSchemas projects the first column of each row', async () => {
    executeMock.mockResolvedValue({ rows: [['dbo'], ['sales'], ['']], rowCount: 3 });
    const mod = await import('../access-policy-client');
    const res = await mod.listWarehouseSchemas();
    expect('schemas' in res && res.schemas).toEqual(['dbo', 'sales']);
    const sql = executeMock.mock.calls[0][1] as string;
    expect(sql).toContain('FROM sys.schemas WHERE schema_id BETWEEN 5 AND 16383');
  });

  it('listWarehouseSchemas returns an honest gate when unconfigured', async () => {
    dedicatedThrows = true;
    const mod = await import('../access-policy-client');
    const res = await mod.listWarehouseSchemas();
    expect('gate' in res && res.gate).toMatch(/LOOM_SYNAPSE_WORKSPACE/);
  });
});
