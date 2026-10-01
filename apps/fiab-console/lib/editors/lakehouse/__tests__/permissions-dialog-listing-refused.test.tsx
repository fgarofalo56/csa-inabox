/**
 * Lakehouse Permissions dialog -> Object tab, after the listing fails.
 *
 *   - An empty row list after a failed listing is unknown, not empty: the
 *     error shows and the "No Storage Blob Data role assignments" sentence
 *     does not. With no error and no rows, the sentence does show.
 *   - After a 409 listing refusal (`permsListRefused`), Grant role stays
 *     focusable but inert (`aria-disabled`, no `disabled` attribute), points
 *     at a visible reason, and a click grants nothing. Without the refusal it
 *     is live.
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

const EMPTY_SENTENCE = /No Storage Blob Data role assignments at the container scope/;
const LIST_ERROR = 'Loom has no lakehouse storage binding for this item. Re-run the item provision from the lakehouse editor, then retry.';

function mount(opts: { permsError: string | null; permsListRefused: boolean; newPrincipalId?: string }) {
  const grantPerm = vi.fn();
  const ctx: any = {
    permsOpen: true, setPermsOpen: vi.fn(), permsTab: 'object', selectPermsTab: vi.fn(),
    permsBusy: false, permsError: opts.permsError, permsListRefused: opts.permsListRefused, sqlGate: null,
    permsRows: [],
    permsRoles: [{ name: 'Storage Blob Data Reader' }],
    revokePerm: vi.fn(), grantPerm,
    newPrincipalId: opts.newPrincipalId ?? '', setNewPrincipalId: vi.fn(),
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
      <SessionProvider value={{ authenticated: true, user: null, isTenantAdmin: true, loading: false }}>
        <LakehouseEditorContext.Provider value={ctx}>
          <PermissionsDialog />
        </LakehouseEditorContext.Provider>
      </SessionProvider>
    </FluentProvider>,
  );
  return { grantPerm };
}

beforeEach(() => { configure({ defaultHidden: true }); });
afterEach(() => { configure({ defaultHidden: false }); cleanup(); });

describe('PermissionsDialog — an empty list after a failed listing is not reported as empty', () => {
  it('error and no rows: the error shows and the empty sentence does not', () => {
    mount({ permsError: LIST_ERROR, permsListRefused: true });
    // Breaks if the error MessageBar is not rendered (the absence below would
    // then pass on a dialog that shows nothing at all).
    expect(screen.getByText(/Loom has no lakehouse storage binding for this item/)).toBeTruthy();
    // Breaks if the empty sentence renders whenever the row list is empty,
    // without the `!permsError` guard.
    expect(screen.queryByText(EMPTY_SENTENCE)).toBeNull();
  });

  it('no error and no rows: the empty sentence shows (positive control)', () => {
    mount({ permsError: null, permsListRefused: false });
    // Breaks if the guard hides the sentence even when the listing succeeded
    // with zero rows (for example `permsError == null` inverted).
    expect(screen.getByText(EMPTY_SENTENCE)).toBeTruthy();
  });
});

describe('PermissionsDialog — Grant role is gated after a listing refusal', () => {
  it('refused (409): Grant role is aria-disabled, describes a visible reason, and a click grants nothing', () => {
    // A principal is filled in, so the only thing that can disable the
    // button here is the refusal.
    const { grantPerm } = mount({ permsError: LIST_ERROR, permsListRefused: true, newPrincipalId: 'oid-1' });
    const btn = screen.getByRole('button', { name: /^Grant role$/ });
    // Breaks if the refusal does not disable the button (no aria-disabled),
    // or if it uses plain `disabled` (then the attribute is present and the
    // button leaves the tab order, so the reason is unreachable by keyboard).
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).not.toHaveAttribute('disabled');
    const reasonId = btn.getAttribute('aria-describedby');
    // Breaks if the reason is not wired to the button, or is not rendered.
    expect(reasonId).toBeTruthy();
    const reason = document.getElementById(reasonId as string);
    expect(reason?.textContent).toMatch(/Grant role is unavailable because Loom could not list/);
    fireEvent.click(btn);
    expect(grantPerm).not.toHaveBeenCalled();
  });

  it('not refused: Grant role is live and grants (control)', () => {
    const { grantPerm } = mount({ permsError: null, permsListRefused: false, newPrincipalId: 'oid-1' });
    const btn = screen.getByRole('button', { name: /^Grant role$/ });
    // Breaks if the gate is applied without a refusal.
    expect(btn).not.toHaveAttribute('aria-disabled');
    expect(btn).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByText(/Grant role is unavailable/)).toBeNull();
    fireEvent.click(btn);
    expect(grantPerm).toHaveBeenCalledTimes(1);
  });
});
