/**
 * I3 — identity.shadow divergence-audit contract tests.
 *
 * Invariants (PRP ws-identity-cloudmatrix §I3):
 *  - Row shape parallels pdp.shadow (kind identity.shadow, workspaceId,
 *    backend, wsWouldAllow, divergence) and carries the F8 90-day TTL.
 *  - divergence=true ONLY when the shared call was allowed AND the workspace
 *    UAMI would have been DENIED; unresolvable (null) is never counted.
 *  - Sampling via LOOM_WS_IDENTITY_SHADOW_SAMPLE (0 → no write).
 *  - NEVER throws — a Cosmos failure is swallowed (shadow can't break calls).
 *  - observeWorkspaceContext resolves the UAMI (cached) + the REAL grant
 *    evaluation, and records a would-be-denied row when the UAMI is missing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { create, getWorkspaceUami, evaluateWorkspaceGrant } = vi.hoisted(() => ({
  create: vi.fn(),
  getWorkspaceUami: vi.fn(),
  evaluateWorkspaceGrant: vi.fn(),
}));
vi.mock('@/lib/azure/cosmos-client', () => ({
  auditLogContainer: async () => ({ items: { create } }),
}));
vi.mock('@/lib/azure/workspace-identity-client', () => ({
  getWorkspaceUami,
  workspaceUamiName: (id: string) => `uami-ws-${id}`,
}));
vi.mock('@/lib/azure/workspace-grants', () => ({ evaluateWorkspaceGrant }));

import {
  recordIdentityShadow, observeWorkspaceContext, identityShadowSampleRate,
  IDENTITY_SHADOW_TTL_SECONDS, __clearIdentityShadowCache,
} from '../workspace-identity-shadow';

beforeEach(() => {
  __clearIdentityShadowCache();
  create.mockReset().mockResolvedValue({});
  getWorkspaceUami.mockReset();
  evaluateWorkspaceGrant.mockReset();
});
afterEach(() => {
  delete process.env.LOOM_WS_IDENTITY_SHADOW_SAMPLE;
});

describe('identityShadowSampleRate', () => {
  it('defaults to 1.0, clamps to 0..1, tolerates garbage', () => {
    expect(identityShadowSampleRate()).toBe(1.0);
    process.env.LOOM_WS_IDENTITY_SHADOW_SAMPLE = '0.25';
    expect(identityShadowSampleRate()).toBe(0.25);
    process.env.LOOM_WS_IDENTITY_SHADOW_SAMPLE = '7';
    expect(identityShadowSampleRate()).toBe(1);
    process.env.LOOM_WS_IDENTITY_SHADOW_SAMPLE = 'banana';
    expect(identityShadowSampleRate()).toBe(1.0);
  });
});

describe('recordIdentityShadow — row shape + retention', () => {
  it('writes ONE identity.shadow row with the F8 90d TTL and divergence flag', async () => {
    await recordIdentityShadow({
      workspaceId: 'ws1', backend: 'adls-lake', wsWouldAllow: false,
      reason: 'no covering assignment',
    });
    expect(create).toHaveBeenCalledTimes(1);
    const row = create.mock.calls[0][0];
    expect(row.kind).toBe('identity.shadow');
    expect(row.itemId).toBe('ws1'); // PK = workspaceId (single-partition reads)
    expect(row.workspaceId).toBe('ws1');
    expect(row.backend).toBe('adls-lake');
    expect(row.wsIdentity).toBe('uami-ws-ws1');
    expect(row.wsWouldAllow).toBe(false);
    expect(row.divergence).toBe(true); // shared allowed + ws denied = THE case
    expect(row.ttl).toBe(IDENTITY_SHADOW_TTL_SECONDS);
    expect(row.ttl).toBe(90 * 24 * 3600);
  });

  it('divergence=false when the workspace UAMI holds the grant', async () => {
    await recordIdentityShadow({ workspaceId: 'ws1', backend: 'adls-lake', wsWouldAllow: true });
    expect(create.mock.calls[0][0].divergence).toBe(false);
  });

  it('unresolvable (null) is recorded but never divergence-counted', async () => {
    await recordIdentityShadow({ workspaceId: 'ws1', backend: 'key-vault', wsWouldAllow: null });
    const row = create.mock.calls[0][0];
    expect(row.wsWouldAllow).toBeNull();
    expect(row.divergence).toBeUndefined();
  });

  it('sampling 0 → NO write', async () => {
    process.env.LOOM_WS_IDENTITY_SHADOW_SAMPLE = '0';
    await recordIdentityShadow({ workspaceId: 'ws1', backend: 'adls-lake', wsWouldAllow: false });
    expect(create).not.toHaveBeenCalled();
  });

  it('NEVER throws — a Cosmos failure is swallowed', async () => {
    create.mockRejectedValue(new Error('cosmos down'));
    await expect(
      recordIdentityShadow({ workspaceId: 'ws1', backend: 'adls-lake', wsWouldAllow: false }),
    ).resolves.toBeUndefined();
  });
});

describe('observeWorkspaceContext — the factory hook', () => {
  it('evaluates the REAL grant and records the observation', async () => {
    getWorkspaceUami.mockResolvedValue({ id: '/x', name: 'uami-ws-ws1', clientId: 'CID', principalId: 'PID' });
    evaluateWorkspaceGrant.mockResolvedValue({
      backend: 'adls-lake', wouldAllow: true, reason: 'role assigned', source: 'arm', checkedAt: 'T',
    });
    await observeWorkspaceContext({ workspaceId: 'ws1', backend: 'adls-lake' });
    expect(evaluateWorkspaceGrant).toHaveBeenCalledWith(
      { id: 'ws1' }, { principalId: 'PID', clientId: 'CID', name: 'uami-ws-ws1' }, 'adls-lake',
    );
    const row = create.mock.calls[0][0];
    expect(row.wsWouldAllow).toBe(true);
    expect(row.divergence).toBe(false);
  });

  it('missing UAMI → would-be-DENIED divergence row (the un-provisioned case)', async () => {
    getWorkspaceUami.mockResolvedValue(null);
    await observeWorkspaceContext({ workspaceId: 'ws-new', backend: 'adls-lake' });
    const row = create.mock.calls[0][0];
    expect(row.wsWouldAllow).toBe(false);
    expect(row.divergence).toBe(true);
    expect(row.reason).toContain('not provisioned');
    expect(evaluateWorkspaceGrant).not.toHaveBeenCalled();
  });

  it('caches the UAMI lookup per workspace (one ARM GET within the TTL)', async () => {
    getWorkspaceUami.mockResolvedValue({ id: '/x', name: 'uami-ws-ws1', clientId: 'CID', principalId: 'PID' });
    evaluateWorkspaceGrant.mockResolvedValue({ backend: 'adls-lake', wouldAllow: true, reason: '', source: 'arm', checkedAt: 'T' });
    await observeWorkspaceContext({ workspaceId: 'ws1', backend: 'adls-lake' });
    await observeWorkspaceContext({ workspaceId: 'ws1', backend: 'adls-lake' });
    expect(getWorkspaceUami).toHaveBeenCalledTimes(1);
  });

  it('NEVER throws — evaluation blowing up is swallowed', async () => {
    getWorkspaceUami.mockResolvedValue({ id: '/x', name: 'uami-ws-ws1', clientId: 'CID', principalId: 'PID' });
    evaluateWorkspaceGrant.mockRejectedValue(new Error('ARM down'));
    await expect(observeWorkspaceContext({ workspaceId: 'ws1', backend: 'adls-lake' })).resolves.toBeUndefined();
  });
});
