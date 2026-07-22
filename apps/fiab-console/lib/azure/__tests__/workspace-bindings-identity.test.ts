/**
 * I1 — applyWorkspaceIdentity provisioning-gate + best-effort contract tests.
 *
 * Invariants under test (loom-next-level I1):
 *  - mode 'off' (the default; sole Phase-0 default-ON exception) → status
 *    'skipped', ZERO ARM calls — regression guard for "behavior identical to
 *    today".
 *  - mode set but the sub/RG config gate open → 'skipped' with the exact
 *    missing var recorded (honest, never blocking).
 *  - shadow + configured → 'provisioned' with real uami fields + grant
 *    outcomes recorded.
 *  - ANY failure → 'failed' recorded on the status block; applyWorkspaceBindings
 *    NEVER throws (workspace create proceeds).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/azure/fabric-client', () => ({
  assignWorkspaceToCapacity: vi.fn(),
  FabricError: class FabricError extends Error {},
}));
vi.mock('@/lib/azure/purview-client', () => ({
  registerAtlasEntity: vi.fn(),
  PurviewError: class PurviewError extends Error {},
  PurviewNotConfiguredError: class PurviewNotConfiguredError extends Error {},
}));
vi.mock('@/lib/azure/cosmos-client', () => ({ marketplaceListingsContainer: vi.fn() }));
vi.mock('@/lib/azure/aca-managed-identity', () => ({
  AcaManagedIdentityCredential: class { async getToken() { return null; } },
}));
vi.mock('@azure/identity', () => ({
  ChainedTokenCredential: class { async getToken() { return null; } },
  DefaultAzureCredential: class { async getToken() { return null; } },
  ManagedIdentityCredential: class { async getToken() { return null; } },
}));
vi.mock('@/lib/azure/workspace-identity-client', () => ({
  createWorkspaceUami: vi.fn(),
  ensureWorkspaceGrants: vi.fn(),
  workspaceIdentityConfigGate: vi.fn(() => null),
  workspaceIdentityMode: vi.fn(() => 'off'),
  workspaceIdentityProvisioningEnabled: vi.fn(() => false),
  workspaceUamiName: (id: string) => `uami-ws-${id}`,
}));

import {
  createWorkspaceUami,
  ensureWorkspaceGrants,
  workspaceIdentityConfigGate,
  workspaceIdentityMode,
} from '@/lib/azure/workspace-identity-client';
import { applyWorkspaceBindings, applyWorkspaceIdentity } from '../workspace-bindings';
import type { Workspace } from '@/lib/types/workspace';

const mode = vi.mocked(workspaceIdentityMode);
const gate = vi.mocked(workspaceIdentityConfigGate);
const create = vi.mocked(createWorkspaceUami);
const grants = vi.mocked(ensureWorkspaceGrants);

const ws: Workspace = {
  id: 'ws-1', tenantId: 'oid-1', name: 'Test', createdBy: 'u',
  createdAt: '2026-07-22T00:00:00Z', updatedAt: '2026-07-22T00:00:00Z',
};

beforeEach(() => {
  process.env.LOOM_LOCATION = 'centralus';
  mode.mockReturnValue('off');
  gate.mockReturnValue(null);
  create.mockReset();
  grants.mockReset();
});
afterEach(() => { delete process.env.LOOM_LOCATION; });

describe('applyWorkspaceIdentity — provisioning gate (I1)', () => {
  it("mode off (default) → skipped, ZERO provisioning calls (regression guard)", async () => {
    const out = await applyWorkspaceIdentity(ws);
    expect(out).toMatchObject({ status: 'skipped' });
    expect(out?.mode).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    expect(grants).not.toHaveBeenCalled();
  });

  it('mode shadow but config gate open → skipped with the exact missing var', async () => {
    mode.mockReturnValue('shadow');
    gate.mockReturnValue({ missing: 'LOOM_WS_IDENTITY_SUB (or LOOM_SUBSCRIPTION_ID)' });
    const out = await applyWorkspaceIdentity(ws);
    expect(out?.status).toBe('skipped');
    expect(out?.error).toContain('LOOM_WS_IDENTITY_SUB');
    expect(create).not.toHaveBeenCalled();
  });

  it('mode shadow + configured → provisioned with uami fields + grant outcomes', async () => {
    mode.mockReturnValue('shadow');
    create.mockResolvedValue({ id: '/x', name: 'uami-ws-ws-1', clientId: 'CID', principalId: 'PID' });
    grants.mockResolvedValue([{ backend: 'adls-lake', roleDefinitionId: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe', scope: '/s', status: 'granted' }]);
    const out = await applyWorkspaceIdentity(ws);
    expect(out).toMatchObject({
      status: 'provisioned', uamiName: 'uami-ws-ws-1', uamiClientId: 'CID', principalId: 'PID', mode: 'shadow',
    });
    expect(out?.grants?.[0].status).toBe('granted');
    expect(create).toHaveBeenCalledWith('ws-1', 'centralus');
  });

  it('missing LOOM_LOCATION → failed with the exact env var named', async () => {
    mode.mockReturnValue('shadow');
    delete process.env.LOOM_LOCATION;
    const out = await applyWorkspaceIdentity(ws);
    expect(out?.status).toBe('failed');
    expect(out?.error).toContain('LOOM_LOCATION');
    expect(create).not.toHaveBeenCalled();
  });

  it('UAMI create failure → failed recorded, never throws', async () => {
    mode.mockReturnValue('shadow');
    create.mockRejectedValue(new Error('create uami failed 403'));
    const out = await applyWorkspaceIdentity(ws);
    expect(out?.status).toBe('failed');
    expect(out?.error).toContain('403');
  });
});

describe('applyWorkspaceBindings — identity side-effect wiring (I1)', () => {
  it('always records workspaceIdentity (skipped receipt with mode off)', async () => {
    const out = await applyWorkspaceBindings(ws);
    expect(out.workspaceIdentity?.status).toBe('skipped');
  });

  it('identity failure is captured, applyWorkspaceBindings resolves (best-effort)', async () => {
    mode.mockReturnValue('shadow');
    create.mockRejectedValue(new Error('ARM down'));
    const out = await applyWorkspaceBindings(ws);
    expect(out.workspaceIdentity?.status).toBe('failed');
    expect(out.workspaceIdentity?.error).toContain('ARM down');
  });
});
