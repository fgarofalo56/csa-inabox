/**
 * The four surfaces that list a storage container directly, as a caller who is
 * NOT a tenant admin.
 *
 * `GET /api/lakehouse/paths?container=…` without a `lakehouseId` answers 403 for
 * such a caller. Each surface below used to treat any non-ok body as "nothing
 * here", so the caller saw an empty folder and no way forward. The fence is the
 * same on all four: the route's own reason is shown, and the surface still offers
 * a working route to finish the task.
 *
 *   - governance policies, restrict-access ADLS path picker: the path can be typed
 *   - Foundry data-URI picker (ADLS tab): a jump to the "Datastore path" tab
 *   - shortcut wizard: browse a source lakehouse through its own item
 *   - OneLake security, mirrored item: "Selected folders" disabled with the reason
 *
 * The fetch mock answers with the real HTTP status (the shared `installFetchMock`
 * always answers 200, which cannot reach a `status === 403` branch).
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

/** A refusal body in the shape the paths route returns. The text is distinctive so
 *  an assertion on it can only pass if the surface rendered the route's reason. */
const REFUSAL = 'Listing a storage container directly is limited to tenant admins. Open the lakehouse and browse from its editor.';

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown };
let calls: string[] = [];

/** URL-routed fetch mock that answers with each handler's STATUS. Longest key wins. */
function installStatusFetch(handlers: Record<string, Handler>) {
  calls = [];
  const keys = Object.keys(handlers).sort((a, b) => b.length - a.length);
  vi.spyOn(global, 'fetch').mockImplementation((async (input: any, init?: RequestInit) => {
    const u = typeof input === 'string' ? input : String(input?.url ?? input);
    calls.push(u);
    const key = keys.find((k) => u.includes(k));
    const { status = 200, body } = key ? handlers[key](u, init) : { body: { ok: true } };
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as any);
}
const refused: Handler = () => ({ status: 403, body: { ok: false, error: REFUSAL } });

function wrap(ui: React.ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}

beforeEach(() => { calls = []; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/* ------------------------------------------------------------------ Foundry -- */

describe('Foundry data-URI picker, ADLS tab, container listing refused', () => {
  const DATASTORES = [{ name: 'workspaceblobstore', datastoreType: 'AzureBlob', isDefault: true, accountName: 'saloomdev', containerName: 'azureml' }];

  // FAILS IF the 403 falls through to the generic `!j.ok` branch (no "Use Datastore
  // path" button, the refusal rendered as a plain error under the container crumb),
  // or if the button does not switch the dialog to the Datastore tab (the
  // datastore list never renders).
  it('shows the refusal and moves the dialog to the Datastore path tab', async () => {
    installStatusFetch({
      '/api/lakehouse/containers': () => ({ body: { ok: true, containers: [{ name: 'bronze', url: 'https://sadlz.dfs.core.windows.net/bronze' }] } }),
      '/api/lakehouse/paths': refused,
      '/api/foundry/datastores': () => ({ body: { ok: true, datastores: DATASTORES } }),
      '/api/items/dataset': () => ({ body: { ok: true, assets: [], scope: 'hub' } }),
    });
    const { DatasetEditor } = await import('../foundry-sub-editors');
    const { makeItem } = await import('./test-helpers');
    wrap(<DatasetEditor item={makeItem('dataset', 'Data asset')} id="new" />);

    fireEvent.click(await screen.findByRole('button', { name: /Browse/ }, { timeout: 5000 }));
    fireEvent.click(await screen.findByText('bronze', {}, { timeout: 5000 }));

    expect(await screen.findByText(new RegExp(REFUSAL.slice(0, 40)), {}, { timeout: 5000 })).toBeInTheDocument();
    expect(calls.some((u) => u.includes('/api/lakehouse/paths?container=bronze'))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Use Datastore path/ }));
    expect(await screen.findByText('workspaceblobstore', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Datastore path/ }).getAttribute('aria-selected')).toBe('true');
  });

  // Positive pair: an admin's successful listing still renders rows and no refusal.
  // FAILS IF the refusal state is shown for a 200 answer.
  it('still lists paths when the container listing succeeds', async () => {
    installStatusFetch({
      '/api/lakehouse/containers': () => ({ body: { ok: true, containers: [{ name: 'bronze', url: 'https://sadlz.dfs.core.windows.net/bronze' }] } }),
      '/api/lakehouse/paths': () => ({ body: { ok: true, container: 'bronze', root: null, prefix: '', paths: [{ name: 'raw', isDirectory: true, size: 0 }] } }),
      '/api/items/dataset': () => ({ body: { ok: true, assets: [], scope: 'hub' } }),
    });
    const { DatasetEditor } = await import('../foundry-sub-editors');
    const { makeItem } = await import('./test-helpers');
    wrap(<DatasetEditor item={makeItem('dataset', 'Data asset')} id="new" />);
    fireEvent.click(await screen.findByRole('button', { name: /Browse/ }, { timeout: 5000 }));
    fireEvent.click(await screen.findByText('bronze', {}, { timeout: 5000 }));
    expect(await screen.findByRole('button', { name: 'raw' }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Use Datastore path/ })).toBeNull();
  });
});

/* ----------------------------------------------------------- shortcut wizard -- */

describe('Shortcut wizard, source browse', () => {
  const SOURCES: Record<string, Handler> = {
    '/api/items/lakehouse': () => ({ body: { ok: true, items: [{ id: 'lh-src', displayName: 'Sales' }, { id: 'lh-dest', displayName: 'Dest' }] } }),
    '/api/lakehouse/containers': () => ({ body: { ok: true, containers: [{ name: 'bronze', url: 'https://sadlz.dfs.core.windows.net/bronze' }] } }),
    // The item-scoped answer: the route resolves the lakehouse to ITS container and
    // root. `gold` differs from the only container the dropdown offers (`bronze`),
    // so a target URI can only say `gold` if the wizard adopted the response.
    '/api/lakehouse/paths?lakehouseId=lh-src': () => ({
      body: { ok: true, container: 'gold', root: 'lakehouses/Sales', prefix: 'lakehouses/Sales',
        paths: [{ name: 'lakehouses/Sales/Files', isDirectory: true, size: 0 }] },
    }),
    '/api/lakehouse/paths?container=': refused,
  };

  // FAILS IF step 1 still requires a container (Next stays disabled with only a
  // lakehouse picked), if the listing is sent as `container=` instead of
  // `lakehouseId=`, or if the target keeps a container the wizard guessed rather
  // than the `gold` the route resolved.
  it('browses a picked source lakehouse through its own item and targets the resolved container', async () => {
    installStatusFetch(SOURCES);
    const { ShortcutWizard } = await import('@/lib/components/onelake/shortcut-wizard');
    wrap(<ShortcutWizard lakehouseId="lh-dest" workspaceId="ws-1" open onClose={() => {}} onCreated={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: /Sales/ }, { timeout: 5000 }));
    const next = screen.getByRole('button', { name: /^Next$/ });
    await waitFor(() => expect(next).not.toBeDisabled());
    fireEvent.click(next);

    fireEvent.click(await screen.findByRole('button', { name: /^Select$/ }, { timeout: 5000 }));
    expect(await screen.findByText('internal://gold/lakehouses/Sales/Files')).toBeInTheDocument();
    expect(calls.some((u) => u.includes('/api/lakehouse/paths?lakehouseId=lh-src'))).toBe(true);
    expect(calls.some((u) => u.includes('/api/lakehouse/paths?container='))).toBe(false);
  });

  // FAILS IF a refused container listing renders as an empty folder (the refusal
  // text absent) or gives no route forward (the lakehouse hint absent).
  it('shows the refusal for a direct container browse and points to a source lakehouse', async () => {
    installStatusFetch(SOURCES);
    const { ShortcutWizard } = await import('@/lib/components/onelake/shortcut-wizard');
    wrap(<ShortcutWizard lakehouseId="lh-dest" workspaceId="ws-1" open onClose={() => {}} onCreated={() => {}} />);

    fireEvent.click(await screen.findByRole('combobox', {}, { timeout: 5000 }));
    fireEvent.click(await screen.findByRole('option', { name: 'bronze' }, { timeout: 5000 }));
    fireEvent.click(screen.getByRole('button', { name: /^Next$/ }));

    const bar = await screen.findByTestId('shortcut-browse-error', {}, { timeout: 5000 });
    expect(bar.textContent).toContain(REFUSAL);
    expect(bar.textContent).toMatch(/pick a source lakehouse/);
    expect(screen.queryByText(/Empty folder/)).toBeNull();
  });
});

/* ------------------------------------------------------ OneLake security tab -- */

describe('OneLake security tab, folder picker', () => {
  const ROLES: Handler = () => ({ body: { ok: true, roles: [], aclEnabled: true, allowedPermissions: ['Read'] } });

  async function openStep2(itemType: 'mirrored-database' | 'lakehouse') {
    const { OneLakeSecurityTab } = await import('@/lib/editors/components/onelake-security-tab');
    wrap(<OneLakeSecurityTab itemId="it-1" itemType={itemType} container="bronze" />);
    fireEvent.click(await screen.findByRole('button', { name: /New role/i }, { timeout: 5000 }));
    fireEvent.change(await screen.findByPlaceholderText(/SalesReaders/i), { target: { value: 'FinanceReaders' } });
    fireEvent.click(screen.getByRole('button', { name: /^Next$/ }));
    fireEvent.click(await screen.findByRole('radio', { name: /Selected folders/ }));
  }

  // FAILS IF the 403 for a mirrored item stays a red error under a picker that can
  // never be filled (radio still enabled, mode still "selected", so Next stays
  // disabled), or if the route's reason is not shown.
  it('mirrored item: disables Selected folders with the route reason and keeps the wizard finishable', async () => {
    installStatusFetch({ '/security-roles': ROLES, '/api/lakehouse/paths': refused });
    await openStep2('mirrored-database');

    const bar = await screen.findByTestId('security-list-refused', {}, { timeout: 5000 });
    expect(bar.textContent).toContain(REFUSAL);
    expect(screen.getByRole('radio', { name: /Selected folders/ })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /All folders/ })).toBeChecked();
    expect(screen.getByRole('button', { name: /^Next$/ })).not.toBeDisabled();
    expect(calls.some((u) => u.includes('/api/lakehouse/paths?container=bronze'))).toBe(true);
  });

  // Positive pair for the item-type condition: a lakehouse lists through its own
  // item, so a failure there is an ordinary error and the option stays available.
  // FAILS IF the refusal branch drops its `itemType !== 'lakehouse'` guard.
  it('lakehouse: lists by lakehouseId and a failure does not disable the option', async () => {
    installStatusFetch({ '/security-roles': ROLES, '/api/lakehouse/paths': refused });
    await openStep2('lakehouse');

    expect(await screen.findByText(REFUSAL, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByTestId('security-list-refused')).toBeNull();
    expect(screen.getByRole('radio', { name: /Selected folders/ })).not.toBeDisabled();
    expect(calls.some((u) => u.includes('/api/lakehouse/paths?lakehouseId=it-1'))).toBe(true);
    expect(calls.some((u) => u.includes('/api/lakehouse/paths?container='))).toBe(false);
  });
});

/* ------------------------------------------------------- governance policies -- */

describe('Governance policies, restrict-access ADLS path picker', () => {
  // FAILS IF a refused listing shows "No sub-paths here." with no reason (the
  // pre-change behaviour), or if the path cannot be supplied by hand (the typed
  // value never reaches the `<container>/<path>` preview the POST is built from).
  it('shows the refusal and accepts a typed path', async () => {
    installStatusFetch({
      '/api/lakehouse/containers': () => ({ body: { ok: true, containers: [{ name: 'bronze', url: 'https://sadlz.dfs.core.windows.net/bronze' }] } }),
      '/api/lakehouse/paths': refused,
      '/api/governance/policies': () => ({ body: { ok: true, policies: [] } }),
    });
    const { default: PoliciesPage } = await import('@/app/governance/policies/page');
    wrap(<PoliciesPage />);

    fireEvent.click(await screen.findByRole('button', { name: /^Restrict access$/ }, { timeout: 10000 }));
    const scope = await screen.findByRole('combobox', { name: /Scope \(data plane\)/ }, { timeout: 5000 });
    fireEvent.click(scope);
    fireEvent.click(await screen.findByRole('option', { name: /ADLS path/ }));
    const container = await screen.findByRole('combobox', { name: /ADLS container/ });
    await waitFor(() => expect(container).not.toBeDisabled());
    fireEvent.click(container);
    fireEvent.click(await screen.findByRole('option', { name: 'bronze' }));

    const bar = await screen.findByTestId('rst-path-error', {}, { timeout: 5000 });
    expect(bar.textContent).toContain(REFUSAL);
    expect(screen.queryByText('No sub-paths here.')).toBeNull();

    fireEvent.change(screen.getByLabelText('Path under the container (typed)'), { target: { value: '/raw/sales' } });
    // Leading slash stripped: the restrict route takes a container-relative path.
    expect(await screen.findByText('bronze/raw/sales')).toBeInTheDocument();
  }, 20000);
});
