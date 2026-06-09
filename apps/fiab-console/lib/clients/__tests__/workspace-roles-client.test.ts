/**
 * Unit tests for the browser-safe workspace-roles BFF client (F9 Manage Access).
 *
 * No network: the global `fetch` is stubbed per case. These assert that each
 * wrapper hits the right route + method, throws on non-ok with the BFF's
 * `json.error`, and passes through the Azure RBAC / Fabric side-effect verbatim
 * (so the UI can render 'active' / 'pending' / 'error' enforcement state).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  listRoleAssignments,
  addRoleAssignment,
  deleteRoleAssignment,
  roleBadgeColor,
  rbacBadge,
  type ListRolesResponse,
} from '../workspace-roles-client';

function mockFetchOnce(impl: (url: string, init?: RequestInit) => { status: number; body: any }) {
  const spy = vi.fn(async (url: string, init?: RequestInit) => {
    const { status, body } = impl(url, init);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  });
  // @ts-expect-error – override global for the test
  global.fetch = spy;
  return spy;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('listRoleAssignments', () => {
  it('GETs the role-assignments route and returns the parsed payload', async () => {
    const payload: ListRolesResponse = {
      ok: true,
      roleAssignments: [
        {
          id: 'ws1:grp-1', workspaceId: 'ws1', principalId: 'grp-1', principalType: 'Group',
          displayName: 'Data Engineers', role: 'Member', azureRoleStatus: 'active',
          addedBy: 'me@contoso.com', addedAt: '2026-06-09T00:00:00Z',
        },
      ],
      fabricMode: 'azure-native',
      callerRole: 'admin',
    };
    const spy = mockFetchOnce(() => ({ status: 200, body: payload }));
    const res = await listRoleAssignments('ws1');
    expect(spy).toHaveBeenCalledWith('/api/workspaces/ws1/role-assignments', { cache: 'no-store' });
    expect(res.roleAssignments).toHaveLength(1);
    expect(res.callerRole).toBe('admin');
    expect(res.fabricMode).toBe('azure-native');
  });

  it('throws with the BFF error message on a non-ok response', async () => {
    mockFetchOnce(() => ({ status: 403, body: { ok: false, error: 'no access to this workspace' } }));
    await expect(listRoleAssignments('ws1')).rejects.toThrow('no access to this workspace');
  });
});

describe('addRoleAssignment', () => {
  it('POSTs the principal + role and returns the RBAC side-effect', async () => {
    const body = {
      ok: true,
      roleAssignment: {
        id: 'ws1:grp-1', workspaceId: 'ws1', principalId: 'grp-1', principalType: 'Group',
        displayName: 'Data Engineers', role: 'Member', azureRoleStatus: 'active',
        addedBy: 'me', addedAt: '2026-06-09T00:00:00Z',
      },
      rbac: { status: 'active', detail: 'Granted Contributor on rg-dlz.' },
    };
    const spy = mockFetchOnce(() => ({ status: 201, body }));
    const res = await addRoleAssignment('ws1', {
      principalId: 'grp-1', principalType: 'Group', displayName: 'Data Engineers', role: 'Member',
    });
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('/api/workspaces/ws1/role-assignments');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toMatchObject({ principalId: 'grp-1', role: 'Member', principalType: 'Group' });
    expect(res.rbac.status).toBe('active');
  });

  it('surfaces a pending RBAC side-effect without throwing (membership still recorded)', async () => {
    const body = {
      ok: true,
      roleAssignment: {
        id: 'ws1:grp-1', workspaceId: 'ws1', principalId: 'grp-1', principalType: 'Group',
        displayName: 'Data Engineers', role: 'Member', azureRoleStatus: 'pending',
        addedBy: 'me', addedAt: '2026-06-09T00:00:00Z',
      },
      rbac: { status: 'pending', detail: 'Console UAMI lacks roleAssignments/write.' },
    };
    mockFetchOnce(() => ({ status: 201, body }));
    const res = await addRoleAssignment('ws1', {
      principalId: 'grp-1', principalType: 'Group', displayName: 'Data Engineers', role: 'Member',
    });
    expect(res.ok).toBe(true);
    expect(res.rbac.status).toBe('pending');
    expect(res.rbac.detail).toMatch(/roleAssignments\/write/);
  });

  it('throws on a 403 from a non-admin caller', async () => {
    mockFetchOnce(() => ({ status: 403, body: { ok: false, error: 'Only the workspace owner, an Admin, or a tenant admin can add members.' } }));
    await expect(addRoleAssignment('ws1', {
      principalId: 'u1', principalType: 'User', displayName: 'u', role: 'Viewer',
    })).rejects.toThrow(/tenant admin can add members/);
  });
});

describe('deleteRoleAssignment', () => {
  it('DELETEs the principal route and returns the revoke side-effect', async () => {
    const spy = mockFetchOnce(() => ({ status: 200, body: { ok: true, removed: true, rbac: { status: 'active', detail: 'Azure RBAC assignment revoked.' } } }));
    const res = await deleteRoleAssignment('ws1', 'grp-1');
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('/api/workspaces/ws1/role-assignments/grp-1');
    expect(init?.method).toBe('DELETE');
    expect(res.removed).toBe(true);
    expect(res.rbac.status).toBe('active');
  });

  it('URL-encodes principal ids containing reserved characters', async () => {
    const spy = mockFetchOnce(() => ({ status: 200, body: { ok: true, removed: true, rbac: { status: 'active' } } }));
    await deleteRoleAssignment('ws1', 'user@contoso.com');
    expect(spy.mock.calls[0][0]).toBe('/api/workspaces/ws1/role-assignments/user%40contoso.com');
  });
});

describe('badge helpers', () => {
  it('maps workspace roles to Loom accents', () => {
    expect(roleBadgeColor('Admin')).toBe('brand');
    expect(roleBadgeColor('Member')).toBe('success');
    expect(roleBadgeColor('Contributor')).toBe('informative');
    expect(roleBadgeColor('Viewer')).toBe('subtle');
  });

  it('maps RBAC side-effect status to a color + label', () => {
    expect(rbacBadge('active')).toEqual({ color: 'success', label: 'Active' });
    expect(rbacBadge('pending')).toEqual({ color: 'warning', label: 'Pending' });
    expect(rbacBadge('error')).toEqual({ color: 'danger', label: 'Error' });
    expect(rbacBadge(undefined)).toEqual({ color: 'subtle', label: '—' });
  });
});
