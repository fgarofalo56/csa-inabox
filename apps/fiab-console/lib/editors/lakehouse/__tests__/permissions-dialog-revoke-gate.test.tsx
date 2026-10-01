/**
 * Lakehouse Permissions dialog -> Object tab: the per-row Revoke action is
 * tenant-admin only on the server (DELETE /api/lakehouse/permissions answers
 * 403 `admin_only`). The dialog says so BEFORE the click:
 *
 *   - non-admin: Revoke stays focusable but inert (`aria-disabled`, no
 *     `disabled` attribute), points at a visible reason via
 *     `aria-describedby`, and a click does not call `revokePerm`.
 *   - tenant admin: Revoke is live and a click revokes that row's id.
 *
 * The admin flag comes from the shell SessionProvider, exactly as in the app.
 */
import React from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, configure } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

vi.mock('@/lib/client-fetch', () => ({
  clientFetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, results: [] }) })),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

import { PermissionsDialog } from '../dialogs/permissions-dialog';
import { LakehouseEditorContext } from '../lakehouse-editor-context';
import { SessionProvider } from '@/lib/components/session-context';

const ROW_ID = '/subscriptions/s/providers/Microsoft.Authorization/roleAssignments/ra-1';

function mount(isTenantAdmin: boolean) {
  const revokePerm = vi.fn();
  const ctx: any = {
    permsOpen: true, setPermsOpen: vi.fn(), permsTab: 'object', selectPermsTab: vi.fn(),
    permsBusy: false, permsError: null, sqlGate: null,
    permsRows: [{ id: ROW_ID, upn: 'someone@contoso.com', principalType: 'User', roleName: 'Storage Blob Data Reader' }],
    permsRoles: [{ name: 'Storage Blob Data Reader' }],
    revokePerm, grantPerm: vi.fn(),
    newPrincipalId: '', setNewPrincipalId: vi.fn(),
    newPrincipalType: 'User', setNewPrincipalType: vi.fn(),
    newRole: 'Storage Blob Data Reader', setNewRole: vi.fn(),
    sqlGrants: [], revokeSqlGrant: vi.fn(), grantSqlTable: vi.fn(), grantSqlColumn: vi.fn(),
    sqlTables: [], selTableId: null, onPickTable: vi.fn(),
    sqlCols: [], selColIds: [], toggleCol: vi.fn(),
    rlsPolicies: [], rlsFilterColId: null, setRlsFilterColId: vi.fn(),
    rlsSubject: 'USER_NAME()', setRlsSubject: vi.fn(),
    createRls: vi.fn(), dropRls: vi.fn(), loadSqlPerms: vi.fn(),
    selectedPrincipal: null, setSelectedPrincipal: vi.fn(),
    principalQuery: '', setPrincipalQuery: vi.fn(),
    principalBusy: false, principalResults: [], setPrincipalResults: vi.fn(),
    activeContainer: 'landing',
  };
  render(
    <FluentProvider theme={webLightTheme}>
      <SessionProvider value={{ authenticated: true, user: null, isTenantAdmin, loading: false }}>
        <LakehouseEditorContext.Provider value={ctx}>
          <PermissionsDialog />
        </LakehouseEditorContext.Provider>
      </SessionProvider>
    </FluentProvider>,
  );
  return { revokePerm };
}

beforeEach(() => { configure({ defaultHidden: true }); });
afterEach(() => { configure({ defaultHidden: false }); cleanup(); });

describe('PermissionsDialog — Revoke is gated up front for non-admins', () => {
  it('non-admin: Revoke is aria-disabled, describes a visible reason, and a click revokes nothing', () => {
    const { revokePerm } = mount(false);
    const btn = screen.getByRole('button', { name: /^Revoke$/ });
    // Breaks if the gate is removed (no aria-disabled), or if it uses plain
    // `disabled` (then the `disabled` attribute is present and the button
    // leaves the tab order, so the reason is unreachable by keyboard).
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).not.toHaveAttribute('disabled');
    const reasonId = btn.getAttribute('aria-describedby');
    // Breaks if the reason is not wired to the button, or is not rendered.
    expect(reasonId).toBeTruthy();
    const reason = document.getElementById(reasonId as string);
    expect(reason?.textContent).toMatch(/requires tenant-admin/);
    fireEvent.click(btn);
    expect(revokePerm).not.toHaveBeenCalled();
  });

  it('tenant admin: Revoke is live and revokes the row it sits on', () => {
    const { revokePerm } = mount(true);
    const btn = screen.getByRole('button', { name: /^Revoke$/ });
    // Breaks if the gate is inverted or applied to everyone.
    expect(btn).not.toHaveAttribute('aria-disabled');
    expect(btn).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByText(/requires tenant-admin/)).toBeNull();
    fireEvent.click(btn);
    expect(revokePerm).toHaveBeenCalledWith(ROW_ID);
  });
});
