/**
 * #4619 — a workspace's storage account binding (`storageAccountId`) is a
 * tenant-admin field on POST /api/workspaces and PATCH /api/workspaces/[id].
 * The three surfaces that edit it read tenant-admin standing from the shell
 * session (`useTenantAdminGate`) and:
 *
 *   - never send the field for a non-admin (the create wizard, the settings
 *     pane's OneLake tab, the drawer's StorageBindingSection);
 *   - show the binding read-only, with the reason, instead of a picker;
 *   - still let an admin set, change and clear it, and send the field only
 *     when an admin changed it;
 *   - in the drawer, bind through the picker only: a failed or empty account
 *     list renders a guided MessageBar, never a free-text ARM-id input.
 *
 * Every load-bearing assertion names the input that breaks it. The routes are
 * the enforcement point and have their own suites.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';

import { SessionProvider } from '@/lib/components/session-context';
import { WorkspaceCreateWizard } from '@/lib/wizards/workspace-create';
import { OneLakeTab } from '@/lib/panes/workspace-settings';
import { StorageBindingSection } from '@/lib/components/workspace-settings-drawer';
import { WORKSPACE_STORAGE_ADMIN_ONLY } from '@/lib/util/admin-only-copy';

const ACCT_A = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/lakea';
const ACCT_B = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/lakeb';
const ACCOUNTS = { ok: true, accounts: [
  { id: ACCT_A, name: 'lakea', isHns: true, resourceGroup: 'rg' },
  { id: ACCT_B, name: 'lakeb', isHns: true, resourceGroup: 'rg' },
] };
const ENVELOPE = {
  ok: false, error: 'forbidden', code: 'admin_only',
  reason: 'SERVER-REASON-3c1', remediation: 'SERVER-REMEDIATION-3c1', gateId: 'bootstrap-admin',
};

type Call = { url: string; method: string; body: any };
type Route = { status?: number; body: unknown };

/** fetch stub: longest matching key wins; a key may be prefixed with a method. */
function stubFetch(routes: Record<string, Route>): Call[] {
  const calls: Call[] = [];
  vi.spyOn(global, 'fetch').mockImplementation((async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = (init?.method || 'GET').toUpperCase();
    let body: any;
    try { body = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { body = init?.body; }
    calls.push({ url, method, body });
    const keys = Object.keys(routes).sort((a, b) => b.length - a.length);
    for (const k of keys) {
      const [m, path] = k.includes(' ') ? k.split(' ') : ['', k];
      if ((m && m !== method) || !url.includes(path)) continue;
      const hit = routes[k];
      return new Response(JSON.stringify(hit.body), { status: hit.status ?? 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any);
  return calls;
}

function withSession(isTenantAdmin: boolean, node: ReactNode) {
  return (
    <SessionProvider value={{ authenticated: true, user: null, isTenantAdmin, loading: false }}>
      {node}
    </SessionProvider>
  );
}

async function pick(combobox: HTMLElement, option: RegExp) {
  fireEvent.click(combobox);
  await waitFor(() => expect(screen.getByRole('option', { name: option })).toBeTruthy());
  fireEvent.click(screen.getByRole('option', { name: option }));
}

const writes = (calls: Call[], method: string) => calls.filter((c) => c.method === method);

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// ── Create wizard ────────────────────────────────────────────────────────────

const WIZARD_ROUTES: Record<string, Route> = {
  '/api/admin/domains': { body: { ok: true, domains: [{ id: 'default', name: 'Default' }] } },
  '/api/storage/accounts': { body: ACCOUNTS },
  'POST /api/workspaces': { status: 201, body: { id: 'ws-new', name: 'W' } },
};

const wizard = () => <WorkspaceCreateWizard open onClose={() => {}} onCreated={() => {}} />;

async function toAdvanced() {
  fireEvent.change(screen.getByPlaceholderText('e.g. Finance Analytics'), { target: { value: 'W' } });
  fireEvent.click(screen.getByRole('button', { name: /Advanced/ }));
  // The domain preselects to `default`, which enables Create.
  await waitFor(() => expect((screen.getByRole('button', { name: 'Create workspace' }) as HTMLButtonElement).disabled).toBe(false));
}

describe('WorkspaceCreateWizard — storage account (#4619)', () => {
  it('a non-admin sees the default read-only with the reason, and no storage picker', async () => {
    // Breaks if the picker is rendered for a non-admin (the combobox is found)
    // or the reason is dropped (the caption text is missing).
    stubFetch(WIZARD_ROUTES);
    render(withSession(false, wizard()));
    await toAdvanced();
    expect(screen.getByTestId('storage-readonly').textContent).toBe('Deployment default');
    expect(screen.getByTestId('storage-admin-reason').textContent).toContain(WORKSPACE_STORAGE_ADMIN_ONLY.reason);
    expect(screen.queryByRole('combobox', { name: /OneLake storage account/ })).toBeNull();
  });

  it('a tenant admin picks an account and the create sends it (positive pair)', async () => {
    // Breaks if admins lost the picker, or the send dropped the value.
    const calls = stubFetch(WIZARD_ROUTES);
    render(withSession(true, wizard()));
    await toAdvanced();
    await pick(screen.getByRole('combobox', { name: /OneLake storage account/ }), /^lakeb/);
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));
    await waitFor(() => expect(writes(calls, 'POST')).toHaveLength(1));
    expect(writes(calls, 'POST')[0].body.storageAccountId).toBe(ACCT_B);
  });

  it('an account picked as admin is not sent once admin standing is gone', async () => {
    // The send-side check, witnessed. The picker is gone for a non-admin, so
    // only a standing change can leave a picked value in state. Breaks if the
    // create sends the picked state regardless of standing (the body would
    // carry ACCT_B).
    const calls = stubFetch(WIZARD_ROUTES);
    const { rerender } = render(withSession(true, wizard()));
    await toAdvanced();
    await pick(screen.getByRole('combobox', { name: /OneLake storage account/ }), /^lakeb/);
    rerender(withSession(false, wizard()));
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));
    await waitFor(() => expect(writes(calls, 'POST')).toHaveLength(1));
    expect(writes(calls, 'POST')[0].body.name).toBe('W');
    expect('storageAccountId' in writes(calls, 'POST')[0].body).toBe(false);
  });

  it('a refused create shows the server reason, not the bare token', async () => {
    // Breaks if the wizard renders `j.error` ("forbidden") for admin_only.
    stubFetch({ ...WIZARD_ROUTES, 'POST /api/workspaces': { status: 403, body: ENVELOPE } });
    render(withSession(true, wizard()));
    await toAdvanced();
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));
    await waitFor(() => expect(screen.getByText(/SERVER-REASON-3c1/)).toBeTruthy());
  });
});

// ── Settings pane, OneLake tab ───────────────────────────────────────────────

const PANE_ROUTES: Record<string, Route> = {
  'storage-metrics': { body: { ok: false, error: 'metrics off' } },
  '/api/storage/accounts': { body: ACCOUNTS },
  'PATCH /api/workspaces/ws-1': { body: { id: 'ws-1', name: 'W' } },
};
const WS = { id: 'ws-1', name: 'W', storageAccountId: ACCT_A } as any;
const pane = () => <OneLakeTab ws={WS} onSaved={() => {}} />;
const saveBinding = () => screen.getByRole('button', { name: 'Save binding' }) as HTMLButtonElement;

describe('Workspace settings pane, OneLake tab — storage binding (#4619)', () => {
  it('a non-admin sees the binding disabled with the reason, and Save is disabled', async () => {
    // Breaks if the picker or Save is enabled for a non-admin, or the notice
    // is dropped.
    const calls = stubFetch(PANE_ROUTES);
    render(withSession(false, pane()));
    await waitFor(() => expect(screen.getByRole('combobox')).toBeTruthy());
    expect(screen.getByRole('combobox').hasAttribute('disabled') || screen.getByRole('combobox').getAttribute('aria-disabled') === 'true').toBe(true);
    expect(screen.getByTestId('admin-only-notice').textContent).toContain(WORKSPACE_STORAGE_ADMIN_ONLY.reason);
    expect(saveBinding().disabled).toBe(true);
    fireEvent.click(saveBinding());
    expect(writes(calls, 'PATCH')).toHaveLength(0);
  });

  it('an admin who clears the binding sends an empty string (positive pair)', async () => {
    // Breaks if an admin clear is not sent, or is sent as something other
    // than '' (the route reads '' as "clear").
    const calls = stubFetch(PANE_ROUTES);
    render(withSession(true, pane()));
    await waitFor(() => expect(screen.getByRole('combobox').getAttribute('aria-disabled')).not.toBe('true'));
    await pick(screen.getByRole('combobox'), /^Deployment default/);
    fireEvent.click(saveBinding());
    await waitFor(() => expect(writes(calls, 'PATCH')).toHaveLength(1));
    expect(writes(calls, 'PATCH')[0].body).toEqual({ storageAccountId: '' });
  });

  it('an admin who changes the account sends the new id, and Save is off while unchanged', async () => {
    // Breaks if Save is enabled with nothing changed (it would PATCH the
    // current value), or the new id is not the one sent.
    const calls = stubFetch(PANE_ROUTES);
    render(withSession(true, pane()));
    await waitFor(() => expect(screen.getByRole('combobox').getAttribute('aria-disabled')).not.toBe('true'));
    expect(saveBinding().disabled).toBe(true);
    await pick(screen.getByRole('combobox'), /^lakeb/);
    expect(saveBinding().disabled).toBe(false);
    fireEvent.click(saveBinding());
    await waitFor(() => expect(writes(calls, 'PATCH')).toHaveLength(1));
    expect(writes(calls, 'PATCH')[0].body).toEqual({ storageAccountId: ACCT_B });
  });

  it('a clear picked as admin is not sent once admin standing is gone', async () => {
    // Breaks if Save stays enabled after standing is lost: the click would
    // PATCH `{ storageAccountId: '' }`.
    const calls = stubFetch(PANE_ROUTES);
    const { rerender } = render(withSession(true, pane()));
    await waitFor(() => expect(screen.getByRole('combobox').getAttribute('aria-disabled')).not.toBe('true'));
    await pick(screen.getByRole('combobox'), /^Deployment default/);
    rerender(withSession(false, pane()));
    expect(saveBinding().disabled).toBe(true);
    fireEvent.click(saveBinding());
    expect(writes(calls, 'PATCH')).toHaveLength(0);
  });

  it('a refused save shows the server reason', async () => {
    // Breaks if the pane's patch helper throws `j.error` ("forbidden").
    stubFetch({ ...PANE_ROUTES, 'PATCH /api/workspaces/ws-1': { status: 403, body: ENVELOPE } });
    render(withSession(true, pane()));
    await waitFor(() => expect(screen.getByRole('combobox').getAttribute('aria-disabled')).not.toBe('true'));
    await pick(screen.getByRole('combobox'), /^lakeb/);
    fireEvent.click(saveBinding());
    await waitFor(() => expect(screen.getByText(/SERVER-REASON-3c1/)).toBeTruthy());
  });
});

// ── Settings drawer, StorageBindingSection ───────────────────────────────────

const DRAWER_ROUTES: Record<string, Route> = {
  '/api/storage/accounts': { body: ACCOUNTS },
  'PATCH /api/workspaces/ws-1': { body: { id: 'ws-1', name: 'W' } },
};
const drawer = () => <StorageBindingSection workspace={WS} />;

describe('Workspace settings drawer, StorageBindingSection (#4619)', () => {
  it('a non-admin sees the binding read-only with the reason, and Save is disabled', async () => {
    // Breaks if the picker or Save is enabled for a non-admin, or the notice
    // is dropped.
    const calls = stubFetch(DRAWER_ROUTES);
    render(withSession(false, drawer()));
    await waitFor(() => expect(screen.getByRole('combobox')).toBeTruthy());
    const combo = screen.getByRole('combobox');
    expect(combo.hasAttribute('disabled') || combo.getAttribute('aria-disabled') === 'true').toBe(true);
    expect(screen.getByTestId('admin-only-notice').textContent).toContain(WORKSPACE_STORAGE_ADMIN_ONLY.reason);
    expect(saveBinding().disabled).toBe(true);
    fireEvent.click(saveBinding());
    expect(writes(calls, 'PATCH')).toHaveLength(0);
  });

  it('an admin who picks "Not bound" sends an empty string (positive pair)', async () => {
    // Breaks if the clear is dropped from the body (the old
    // `storageAccountId || undefined` sent `{}`, which the route ignores).
    const calls = stubFetch(DRAWER_ROUTES);
    render(withSession(true, drawer()));
    await waitFor(() => expect(screen.getByRole('combobox')).toBeTruthy());
    await pick(screen.getByRole('combobox'), /^Not bound/);
    fireEvent.click(saveBinding());
    await waitFor(() => expect(writes(calls, 'PATCH')).toHaveLength(1));
    expect(writes(calls, 'PATCH')[0].body).toEqual({ storageAccountId: '' });
  });

  it('an admin who changes the account sends the new id (positive pair)', async () => {
    // Breaks if admins lost the picker or the new id is not the one sent.
    const calls = stubFetch(DRAWER_ROUTES);
    render(withSession(true, drawer()));
    await waitFor(() => expect(screen.getByRole('combobox')).toBeTruthy());
    expect(saveBinding().disabled).toBe(true);
    await pick(screen.getByRole('combobox'), /^lakeb/);
    fireEvent.click(saveBinding());
    await waitFor(() => expect(writes(calls, 'PATCH')).toHaveLength(1));
    expect(writes(calls, 'PATCH')[0].body).toEqual({ storageAccountId: ACCT_B });
  });

  it('a change picked as admin is not sent once admin standing is gone', async () => {
    // Breaks if Save stays enabled after standing is lost: the click would
    // PATCH `{ storageAccountId: ACCT_B }`.
    const calls = stubFetch(DRAWER_ROUTES);
    const { rerender } = render(withSession(true, drawer()));
    await waitFor(() => expect(screen.getByRole('combobox')).toBeTruthy());
    await pick(screen.getByRole('combobox'), /^lakeb/);
    rerender(withSession(false, drawer()));
    expect(saveBinding().disabled).toBe(true);
    fireEvent.click(saveBinding());
    expect(writes(calls, 'PATCH')).toHaveLength(0);
  });

  it('a refused save shows the server reason through the api helper', async () => {
    // Breaks if lib/api/workspaces reports `error` ("forbidden") for admin_only.
    stubFetch({ ...DRAWER_ROUTES, 'PATCH /api/workspaces/ws-1': { status: 403, body: ENVELOPE } });
    render(withSession(true, drawer()));
    await waitFor(() => expect(screen.getByRole('combobox')).toBeTruthy());
    await pick(screen.getByRole('combobox'), /^lakeb/);
    fireEvent.click(saveBinding());
    await waitFor(() => expect(screen.getByText(/SERVER-REASON-3c1/)).toBeTruthy());
    expect(screen.queryByText(/^forbidden \(HTTP 403\)$/)).toBeNull();
  });

  // The binding is picker-only. The free-text ARM-id box only ever rendered
  // when the account list could NOT be read, so these fixtures fail the list:
  // with a successful list, restoring the box would change nothing on screen.
  const LIST_FAILED: Route = {
    body: { ok: false, error: 'LIST-ERROR-3d', hint: 'LIST-HINT-3d or enter the storage URI manually.' },
  };

  for (const admin of [false, true]) {
    it(`a failed account list renders no free-text ARM-id input (${admin ? 'admin' : 'non-admin'})`, async () => {
      // Breaks if the manual fallback returns: a textbox (the ARM-id Input)
      // would render and the /subscriptions/ placeholder would be present.
      // Also breaks if the route's hint, which offers that manual entry, is
      // shown instead of the error detail.
      const calls = stubFetch({ ...DRAWER_ROUTES, '/api/storage/accounts': LIST_FAILED });
      render(withSession(admin, drawer()));
      const bar = await screen.findByTestId('storage-accounts-unavailable');
      expect(bar.textContent).toContain('LIST-ERROR-3d');
      expect(bar.textContent).not.toContain('LIST-HINT-3d');
      expect(screen.queryAllByRole('textbox')).toHaveLength(0);
      expect(screen.queryByPlaceholderText(/subscriptions/)).toBeNull();
      expect(saveBinding().disabled).toBe(true);
      fireEvent.click(saveBinding());
      expect(writes(calls, 'PATCH')).toHaveLength(0);
    });
  }

  it('Retry re-reads the account list and brings the picker back (positive pair)', async () => {
    // Pairs the absence test above: breaks if the guided state is a dead end,
    // i.e. Retry does not re-fetch, so no combobox appears and nothing can be
    // bound once the list is readable again.
    const routes: Record<string, Route> = { ...DRAWER_ROUTES, '/api/storage/accounts': LIST_FAILED };
    const calls = stubFetch(routes);
    render(withSession(true, drawer()));
    await screen.findByTestId('storage-accounts-unavailable');
    routes['/api/storage/accounts'] = { body: ACCOUNTS };
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('combobox')).toBeTruthy());
    expect(calls.filter((c) => c.url.includes('/api/storage/accounts'))).toHaveLength(2);
    await pick(screen.getByRole('combobox'), /^lakeb/);
    fireEvent.click(saveBinding());
    await waitFor(() => expect(writes(calls, 'PATCH')).toHaveLength(1));
    expect(writes(calls, 'PATCH')[0].body).toEqual({ storageAccountId: ACCT_B });
  });

  it('an empty account list explains itself and still offers "Not bound"', async () => {
    // Breaks if the empty list renders a bare picker with no explanation
    // (the empty-state bar is missing), or if it drops the picker entirely,
    // so an admin could not clear a stale binding.
    const calls = stubFetch({ ...DRAWER_ROUTES, '/api/storage/accounts': { body: { ok: true, accounts: [] } } });
    render(withSession(true, drawer()));
    expect((await screen.findByTestId('storage-accounts-empty')).textContent).toMatch(/deployment-default/);
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    await pick(screen.getByRole('combobox'), /^Not bound/);
    fireEvent.click(saveBinding());
    await waitFor(() => expect(writes(calls, 'PATCH')).toHaveLength(1));
    expect(writes(calls, 'PATCH')[0].body).toEqual({ storageAccountId: '' });
  });
});
