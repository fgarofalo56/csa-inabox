/**
 * Contract tests for workspace-identity-client (§2.4 per-workspace identity).
 *
 * Core invariant (DORMANT/fallback): getWorkspaceCredential returns the SHARED
 * UAMI credential whenever no per-workspace uami-ws-<id> exists, so the default
 * path is unchanged. Per-workspace identity only engages when ARM reports the
 * UAMI. Also covers name derivation and that the lookup hits the right ARM URL.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const SHARED = { __shared: true, async getToken() { return { token: 'SHARED', expiresOnTimestamp: Date.now() + 3600_000 }; } };
vi.mock('@/lib/azure/arm-credential', () => ({ uamiArmCredential: () => SHARED }));

class MiCred { clientId: string; constructor(o: { clientId: string }) { this.clientId = o.clientId; } async getToken() { return { token: 'WS', expiresOnTimestamp: Date.now() + 3600_000 }; } }
vi.mock('@azure/identity', () => ({ ManagedIdentityCredential: MiCred }));

import { workspaceUamiName, getWorkspaceCredential, getWorkspaceUami } from '../workspace-identity-client';

const realFetch = global.fetch;
function mockFetch(handler: (url: string) => any) {
  global.fetch = vi.fn(async (url: any) => {
    const out = handler(String(url));
    return new Response(JSON.stringify(out?._body ?? out), { status: out?._status ?? 200 });
  }) as any;
}

beforeEach(() => { process.env.LOOM_SUBSCRIPTION_ID = 'sub-1'; process.env.LOOM_DLZ_RG = 'rg-loom'; });
afterEach(() => { global.fetch = realFetch; delete process.env.LOOM_SUBSCRIPTION_ID; delete process.env.LOOM_DLZ_RG; vi.restoreAllMocks(); });

describe('workspaceUamiName', () => {
  it('derives uami-ws-<workspaceId> (same as the bicep module)', () => {
    expect(workspaceUamiName('ws42')).toBe('uami-ws-ws42');
  });
});

describe('getWorkspaceCredential — dormant fallback', () => {
  it('returns the SHARED UAMI when no per-workspace identity exists (404)', async () => {
    mockFetch(() => ({ _status: 404, _body: {} }));
    const cred = await getWorkspaceCredential('ws42');
    expect((cred as any).__shared).toBe(true);
  });

  it('returns the SHARED UAMI when ARM is unconfigured — no call, default unchanged', async () => {
    delete process.env.LOOM_SUBSCRIPTION_ID; delete process.env.LOOM_DLZ_RG;
    const f = vi.fn(); global.fetch = f as any;
    const cred = await getWorkspaceCredential('ws42');
    expect((cred as any).__shared).toBe(true);
    expect(f).not.toHaveBeenCalled();
  });

  it('uses the per-workspace identity when it exists', async () => {
    mockFetch((url) => { expect(url).toContain('userAssignedIdentities/uami-ws-ws42'); return { id: '/x', name: 'uami-ws-ws42', properties: { clientId: 'CID', principalId: 'PID' } }; });
    const cred = await getWorkspaceCredential('ws42');
    expect(cred).toBeInstanceOf(MiCred);
    expect((cred as unknown as MiCred).clientId).toBe('CID');
  });
});

describe('getWorkspaceUami', () => {
  it('null on 404', async () => { mockFetch(() => ({ _status: 404, _body: {} })); expect(await getWorkspaceUami('ws9')).toBeNull(); });
});
