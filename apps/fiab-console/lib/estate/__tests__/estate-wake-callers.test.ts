/**
 * #5111 - how each caller of a guarded wake handles the refusal. None of them may
 * wake the pool, and none may claim a resume was issued when it was not (R7).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EstatePausedError } from '../estate-wake-guard';

const REFUSAL = new EstatePausedError(
  'The estate is PAUSED, paused by frank@contoso.com at 2026-10-23T22:45:00.000Z, so waking the Synapse dedicated SQL pool is refused: it would restart billing that the estate pause just stopped. Resume the estate first (Admin > Scale by SKU > Estate power), then retry.',
  'PAUSED',
  'frank@contoso.com',
  '2026-10-23T22:45:00.000Z',
);

const getPoolState = vi.fn(async () => ({ state: 'Paused', sku: 'DW200c', status: 'Paused' }));
const resumePool = vi.fn(async () => { throw REFUSAL; });
vi.mock('@/lib/azure/synapse-pool-arm', () => ({
  getPoolState: () => getPoolState(),
  resumePool: () => resumePool(),
  pausePool: vi.fn(),
  scalePool: vi.fn(),
  waitForOnline: vi.fn(),
}));
const executeQuery = vi.fn(async () => ({ recordset: [], rows: [], columns: [] }));
vi.mock('@/lib/azure/synapse-sql-client', () => ({
  dedicatedTarget: vi.fn(() => ({ server: 'ws.sql.azuresynapse.net', database: 'loompool', cacheKey: 'k' })),
  executeQuery: (...a: unknown[]) => executeQuery(...(a as [])),
}));
vi.mock('@/lib/azure/adls-client', () => ({
  grantContainerRole: vi.fn(),
  revokeContainerRoleAssignment: vi.fn(),
  listContainerRoleAssignments: vi.fn(async () => []),
}));
vi.mock('@/lib/azure/kusto-client', () => ({
  defaultDatabase: vi.fn(() => 'loomdb'),
  kustoConfigGate: vi.fn(() => null),
  addDatabasePrincipal: vi.fn(),
  dropDatabasePrincipal: vi.fn(),
  showDatabasePrincipals: vi.fn(async () => []),
}));

import { enforceAccessGrant } from '@/lib/azure/access-policy-client';
import { warehouseProvisioner } from '@/lib/install/provisioners/warehouse';
import { buildDefaultRegistry } from '@/lib/azure/copilot-orchestrator';

beforeEach(() => {
  vi.clearAllMocks();
  resumePool.mockImplementation(async () => { throw REFUSAL; });
  getPoolState.mockImplementation(async () => ({ state: 'Paused', sku: 'DW200c', status: 'Paused' }));
});

describe('access-policy-client (best-effort resume)', () => {
  const input = {
    principalId: 'oid-1',
    principalName: 'alice@contoso.com',
    principalType: 'User' as const,
    scopeType: 'warehouse' as const,
    scopeRef: 'loompool',
    permission: 'read' as const,
  };

  // Breaks if: the refusal is swallowed and the old "a resume was started" text is returned (a false claim) -
  // or if the grant proceeds over TDS against a paused pool.
  it('returns pending, says NO resume was started, and quotes the estate message', async () => {
    const r = await enforceAccessGrant(input);
    expect(r.status).toBe('pending');
    expect(resumePool).toHaveBeenCalledTimes(1);
    expect(r.detail).toContain('NO resume was started');
    expect(r.detail).toContain('The estate is PAUSED');
    expect(r.detail).not.toContain('a resume was started.');
    expect(executeQuery).not.toHaveBeenCalled();
  });

  // Positive pair / breaks if: the new branch fires on ANY resume failure (it must keep the old best-effort text).
  it('a non-estate resume failure keeps the original "a resume was started" behaviour', async () => {
    resumePool.mockImplementation(async () => { throw new Error('ARM 500'); });
    const r = await enforceAccessGrant(input);
    expect(r.status).toBe('pending');
    expect(r.detail).toContain('a resume was started');
    expect(r.detail).not.toContain('NO resume was started');
  });
});

describe('warehouse provisioner (ensurePoolOnline)', () => {
  const run = () => warehouseProvisioner({
    session: {} as never,
    target: {} as never,
    cosmosItemId: 'i-1',
    workspaceId: 'w-1',
    displayName: 'wh',
    content: { ddl: 'CREATE TABLE dbo.t (id int);' },
    appId: 'app-x',
  });

  // Breaks if: the refusal is reported with the stock RESUME_GATE ("Loom issued an ARM resume") - none was sent.
  it('returns a remediation gate that names the estate pause, not "Loom issued an ARM resume"', async () => {
    const r = await run();
    expect(r.status).toBe('remediation');
    const gate = (r as { gate: { reason: string; remediation: string; link?: string } }).gate;
    expect(gate.reason).toContain('The estate is paused');
    expect(gate.remediation).toContain('Estate power');
    expect(gate.remediation).not.toContain('Loom issued an ARM resume');
    expect(gate.link).toBe('/admin/scaling');
    expect(r.steps.join('\n')).toContain('Resume NOT sent');
    expect(r.steps.join('\n')).not.toContain('Resume accepted');
    expect(executeQuery).not.toHaveBeenCalled(); // no DDL against the paused pool
  });

  // Positive pair: a plain failed resume still gets the stock gate.
  it('a non-estate resume failure still returns the stock resume gate', async () => {
    resumePool.mockImplementation(async () => { throw new Error('ARM 500'); });
    const r = await run();
    const gate = (r as { gate: { reason: string; remediation: string } }).gate;
    expect(gate.reason).toContain('is resuming');
    expect(gate.remediation).toContain('Loom issued an ARM resume');
  });
});

describe('Copilot tool synapse_pool_resume', () => {
  const tool = () => buildDefaultRegistry().get('synapse_pool_resume')!;

  // Breaks if: the refusal escapes as a generic tool failure (the user never sees who/when/where).
  it('returns the refusal message to the user as the tool result, ok:false', async () => {
    const out = await tool().handler({} as never, {} as never) as { ok: boolean; error?: string; estatePaused?: boolean };
    expect(out.ok).toBe(false);
    expect(out.estatePaused).toBe(true);
    expect(out.error).toBe(REFUSAL.message);
  });

  // Positive pair / breaks if: every resume now reports a refusal.
  it('still returns ok:true when the resume is accepted, and rethrows non-estate errors', async () => {
    resumePool.mockImplementation((async () => undefined) as never);
    expect(await tool().handler({} as never, {} as never)).toEqual({ ok: true });
    resumePool.mockImplementation(async () => { throw new Error('ARM 500'); });
    await expect(tool().handler({} as never, {} as never)).rejects.toThrow('ARM 500');
  });
});
