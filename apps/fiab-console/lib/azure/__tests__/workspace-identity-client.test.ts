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

import {
  workspaceUamiName, getWorkspaceCredential, getWorkspaceUami,
  workspaceIdentityMode, workspaceIdentityProvisioningEnabled,
  roleAssignmentGuid, workspaceLakeGrantScope, ensureWorkspaceGrants,
  cascadeDeleteWorkspaceIdentity,
} from '../workspace-identity-client';

const realFetch = global.fetch;
function mockFetch(handler: (url: string, init?: RequestInit) => any) {
  global.fetch = vi.fn(async (url: any, init?: any) => {
    const out = handler(String(url), init);
    const body = out?._body ?? out;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: out?._status ?? 200 });
  }) as any;
}

beforeEach(() => {
  process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
  process.env.LOOM_DLZ_RG = 'rg-loom';
  process.env.LOOM_WS_IDENTITY_ARM_SPACING_MS = '0'; // no throttle spacing in tests
});
afterEach(() => {
  global.fetch = realFetch;
  delete process.env.LOOM_SUBSCRIPTION_ID; delete process.env.LOOM_DLZ_RG;
  delete process.env.LOOM_WORKSPACE_IDENTITY_MODE; delete process.env.LOOM_BRONZE_URL;
  delete process.env.LOOM_ADLS_ACCOUNT; delete process.env.LOOM_WS_IDENTITY_ARM_SPACING_MS;
  vi.restoreAllMocks();
});

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

// ── I1 — provisioning gate logic ────────────────────────────────────────────

describe('workspaceIdentityMode / workspaceIdentityProvisioningEnabled (I1 gate)', () => {
  it("defaults to 'off' when unset (the sole Phase-0 default-ON exception)", () => {
    expect(workspaceIdentityMode()).toBe('off');
    expect(workspaceIdentityProvisioningEnabled()).toBe(false);
  });

  it("treats unknown values as 'off' (never throws)", () => {
    process.env.LOOM_WORKSPACE_IDENTITY_MODE = 'banana';
    expect(workspaceIdentityMode()).toBe('off');
    expect(workspaceIdentityProvisioningEnabled()).toBe(false);
  });

  it('enables ONLY when mode != off AND the sub/RG config gate is clear', () => {
    process.env.LOOM_WORKSPACE_IDENTITY_MODE = 'shadow';
    expect(workspaceIdentityProvisioningEnabled()).toBe(true);
    delete process.env.LOOM_SUBSCRIPTION_ID; // gate opens → disabled
    expect(workspaceIdentityProvisioningEnabled()).toBe(false);
  });

  it('recognizes enforce', () => {
    process.env.LOOM_WORKSPACE_IDENTITY_MODE = 'enforce';
    expect(workspaceIdentityMode()).toBe('enforce');
  });
});

// ── I1 — scoped grants (idempotent role-assignment PUTs) ────────────────────

describe('ensureWorkspaceGrants (I1)', () => {
  const uami = { principalId: 'PID-1' };

  it('derives a deterministic guid-shaped assignment name (bicep guid() contract)', () => {
    const a = roleAssignmentGuid('/scope/a', 'p1', 'r1');
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(roleAssignmentGuid('/scope/a', 'p1', 'r1')).toBe(a); // stable
    expect(roleAssignmentGuid('/scope/b', 'p1', 'r1')).not.toBe(a);
  });

  it('scopes to the lake CONTAINER parsed from LOOM_BRONZE_URL', () => {
    process.env.LOOM_BRONZE_URL = 'https://lakeacct.dfs.core.windows.net/bronze';
    const r = workspaceLakeGrantScope({});
    expect(r).toEqual({ scope: '/subscriptions/sub-1/resourceGroups/rg-loom/providers/Microsoft.Storage/storageAccounts/lakeacct/blobServices/default/containers/bronze' });
  });

  it('PUTs the Storage Blob Data Contributor assignment and records granted', async () => {
    process.env.LOOM_BRONZE_URL = 'https://lakeacct.dfs.core.windows.net/bronze';
    const puts: string[] = [];
    mockFetch((url, init) => {
      if (init?.method === 'PUT') { puts.push(url); return { properties: {} }; }
      return {};
    });
    const grants = await ensureWorkspaceGrants({ id: 'ws1' }, uami);
    expect(grants).toHaveLength(1);
    expect(grants[0].status).toBe('granted');
    expect(grants[0].roleDefinitionId).toBe('ba92f5b4-2d11-453d-a403-e96b0029c9fe');
    expect(puts[0]).toContain('/providers/Microsoft.Authorization/roleAssignments/');
    expect(puts[0]).toContain('containers/bronze');
  });

  it('second run is a no-op: 409 RoleAssignmentExists records exists, no throw', async () => {
    process.env.LOOM_BRONZE_URL = 'https://lakeacct.dfs.core.windows.net/bronze';
    mockFetch((_url, init) => (init?.method === 'PUT'
      ? { _status: 409, _body: { error: { code: 'RoleAssignmentExists', message: 'The role assignment already exists.' } } }
      : {}));
    const grants = await ensureWorkspaceGrants({ id: 'ws1' }, uami);
    expect(grants[0].status).toBe('exists');
    expect(grants[0].error).toBeUndefined();
  });

  it('records an honest failed grant when no lake scope is resolvable', async () => {
    const f = vi.fn(); global.fetch = f as any;
    const grants = await ensureWorkspaceGrants({ id: 'ws1' }, uami);
    expect(grants[0].status).toBe('failed');
    expect(grants[0].error).toContain('LOOM_BRONZE_URL');
    expect(f).not.toHaveBeenCalled(); // no blind ARM writes
  });
});

// ── I1 — delete cascade (best-effort, never throws) ─────────────────────────

describe('cascadeDeleteWorkspaceIdentity (I1)', () => {
  it('removes role assignments then deletes the UAMI', async () => {
    const calls: string[] = [];
    mockFetch((url, init) => {
      calls.push(`${init?.method || 'GET'} ${url}`);
      if (url.includes('/roleAssignments?')) return { value: [{ id: '/subscriptions/sub-1/providers/Microsoft.Authorization/roleAssignments/ra1' }] };
      return { _status: init?.method === 'DELETE' ? 200 : 200, _body: { name: 'uami-ws-ws1', properties: { clientId: 'C', principalId: 'P' } } };
    });
    const out = await cascadeDeleteWorkspaceIdentity('ws1');
    expect(out.status).toBe('deleted');
    expect(out.roleAssignmentsRemoved).toBe(1);
    expect(calls.some((c) => c.startsWith('DELETE') && c.includes('roleAssignments/ra1'))).toBe(true);
    expect(calls.some((c) => c.startsWith('DELETE') && c.includes('uami-ws-ws1'))).toBe(true);
  });

  it('skips (recorded, no throw) when ARM is unconfigured', async () => {
    delete process.env.LOOM_SUBSCRIPTION_ID;
    const out = await cascadeDeleteWorkspaceIdentity('ws1');
    expect(out.status).toBe('skipped');
    expect(out.error).toContain('LOOM_WS_IDENTITY_SUB');
  });

  it('skips when no per-workspace identity exists (404, no hint)', async () => {
    mockFetch(() => ({ _status: 404, _body: {} }));
    const out = await cascadeDeleteWorkspaceIdentity('ws1');
    expect(out.status).toBe('skipped');
  });

  it('records failed (never throws) when the UAMI delete errors — delete proceeds', async () => {
    mockFetch((url, init) => {
      if (init?.method === 'DELETE' && url.includes('uami-ws-ws1')) return { _status: 500, _body: { error: 'boom' } };
      if (url.includes('/roleAssignments?')) return { value: [] };
      return { name: 'uami-ws-ws1', properties: { clientId: 'C', principalId: 'P' } };
    });
    const out = await cascadeDeleteWorkspaceIdentity('ws1');
    expect(out.status).toBe('failed');
    expect(out.error).toContain('delete uami failed 500');
  });
});
