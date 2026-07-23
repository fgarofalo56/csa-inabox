/**
 * I5 — workspace-credential-factory contract tests.
 *
 * Invariants (PRP ws-identity-cloudmatrix §I5):
 *  - off mode (default): credentialFor() === the shared Console-UAMI chain,
 *    ZERO ARM/identity-client work — proves zero-regression default.
 *  - shadow mode: returns the SHARED credential (behavior unchanged; the I3
 *    hook rides this seam next in the chain).
 *  - enforce mode: resolves the per-workspace credential via
 *    getWorkspaceCredential, LRU-cached STRICTLY by workspaceId.
 *  - F14 cache-key guard: a cache MISS mints/looks-up fresh — NEVER a
 *    different workspace's cached credential.
 *  - workspaceScopedCredential adapter defers resolution to getToken time.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { uamiArmCredential, getWorkspaceCredential } = vi.hoisted(() => {
  const SHARED = { __shared: true, async getToken() { return { token: 'SHARED', expiresOnTimestamp: Date.now() + 3600_000 }; } };
  return {
    uamiArmCredential: vi.fn(() => SHARED),
    getWorkspaceCredential: vi.fn(),
  };
});
vi.mock('@/lib/azure/arm-credential', () => ({ uamiArmCredential }));
vi.mock('@/lib/azure/workspace-identity-client', () => ({
  // The real mode fn just reads env — keep that behavior so tests drive it
  // through LOOM_WORKSPACE_IDENTITY_MODE like production does.
  workspaceIdentityMode: () => {
    const v = (process.env.LOOM_WORKSPACE_IDENTITY_MODE || '').trim().toLowerCase();
    return v === 'shadow' || v === 'enforce' ? v : 'off';
  },
  getWorkspaceCredential,
}));

import {
  credentialFor, workspaceScopedCredential, __clearWorkspaceCredentialCache,
} from '../workspace-credential-factory';

beforeEach(() => {
  __clearWorkspaceCredentialCache();
  uamiArmCredential.mockClear();
  getWorkspaceCredential.mockReset();
});
afterEach(() => {
  delete process.env.LOOM_WORKSPACE_IDENTITY_MODE;
});

describe('credentialFor — off mode (the zero-regression default)', () => {
  it('returns the shared chain with NO identity-client work', async () => {
    const cred = await credentialFor({ workspaceId: 'ws1' });
    expect((cred as any).__shared).toBe(true);
    expect(getWorkspaceCredential).not.toHaveBeenCalled();
  });

  it('memoizes the shared chain — ONE construction per process', async () => {
    const a = await credentialFor();
    const b = await credentialFor({ workspaceId: 'ws1' });
    expect(a).toBe(b);
    expect(uamiArmCredential).toHaveBeenCalledTimes(1);
  });
});

describe('credentialFor — shadow mode (behavior unchanged)', () => {
  it('returns the SHARED credential for a workspace-scoped call', async () => {
    process.env.LOOM_WORKSPACE_IDENTITY_MODE = 'shadow';
    const cred = await credentialFor({ workspaceId: 'ws1', backend: 'adls-lake' });
    expect((cred as any).__shared).toBe(true);
    expect(getWorkspaceCredential).not.toHaveBeenCalled();
  });
});

describe('credentialFor — enforce mode', () => {
  it('resolves the per-workspace credential via getWorkspaceCredential', async () => {
    process.env.LOOM_WORKSPACE_IDENTITY_MODE = 'enforce';
    const WS1 = { __ws: 'ws1', async getToken() { return null; } };
    getWorkspaceCredential.mockResolvedValue(WS1);
    const cred = await credentialFor({ workspaceId: 'ws1' });
    expect(cred).toBe(WS1);
    expect(getWorkspaceCredential).toHaveBeenCalledWith('ws1');
  });

  it('no workspace context → shared credential (safe)', async () => {
    process.env.LOOM_WORKSPACE_IDENTITY_MODE = 'enforce';
    const cred = await credentialFor();
    expect((cred as any).__shared).toBe(true);
    expect(getWorkspaceCredential).not.toHaveBeenCalled();
  });

  it('caches per workspaceId — one lookup within the TTL', async () => {
    process.env.LOOM_WORKSPACE_IDENTITY_MODE = 'enforce';
    const WS1 = { __ws: 'ws1', async getToken() { return null; } };
    getWorkspaceCredential.mockResolvedValue(WS1);
    await credentialFor({ workspaceId: 'ws1' });
    await credentialFor({ workspaceId: 'ws1' });
    expect(getWorkspaceCredential).toHaveBeenCalledTimes(1);
  });

  it('F14 cache-key guard: a MISS mints fresh — never a neighbor\'s cached entry', async () => {
    process.env.LOOM_WORKSPACE_IDENTITY_MODE = 'enforce';
    const WS1 = { __ws: 'ws1', async getToken() { return null; } };
    const WS2 = { __ws: 'ws2', async getToken() { return null; } };
    getWorkspaceCredential.mockImplementation(async (id: string) => (id === 'ws1' ? WS1 : WS2));
    const a = await credentialFor({ workspaceId: 'ws1' });
    const b = await credentialFor({ workspaceId: 'ws2' }); // MISS — must look up ws2
    expect(a).toBe(WS1);
    expect(b).toBe(WS2);
    expect(b).not.toBe(a);
    expect(getWorkspaceCredential).toHaveBeenNthCalledWith(2, 'ws2');
  });

  it('fail-safes to the shared chain when the per-workspace lookup throws (I7 rollback)', async () => {
    process.env.LOOM_WORKSPACE_IDENTITY_MODE = 'enforce';
    getWorkspaceCredential.mockRejectedValue(new Error('ARM down'));
    const cred = await credentialFor({ workspaceId: 'ws1' });
    expect((cred as any).__shared).toBe(true);
  });
});

describe('workspaceScopedCredential — the lazy drop-in adapter', () => {
  it('defers resolution to getToken time and passes scopes through', async () => {
    const cred = workspaceScopedCredential({ workspaceId: 'ws1' });
    expect(getWorkspaceCredential).not.toHaveBeenCalled(); // nothing at construction
    const t = await cred.getToken('https://storage.azure.com/.default');
    expect(t?.token).toBe('SHARED'); // off mode → shared chain
  });

  it('picks up a mode flip WITHOUT re-construction (per-call resolution)', async () => {
    const cred = workspaceScopedCredential({ workspaceId: 'ws1' });
    expect((await cred.getToken('s'))?.token).toBe('SHARED');
    process.env.LOOM_WORKSPACE_IDENTITY_MODE = 'enforce';
    const WS1 = { __ws: 'ws1', async getToken() { return { token: 'WS1-TOKEN', expiresOnTimestamp: 0 }; } };
    getWorkspaceCredential.mockResolvedValue(WS1);
    expect((await cred.getToken('s'))?.token).toBe('WS1-TOKEN');
  });
});
