/**
 * /admin/workspaces — bulk select + delete.
 *
 * Mounts the REAL page (real LoomDataTable, real Fluent tree) with only the
 * data layer stubbed: `@/lib/client-fetch` for the inventory GET and
 * `@/lib/api/workspaces` for the bulk-delete client. Asserts:
 *   - the destructive affordances are HIDDEN when the server says the caller
 *     cannot bulk-delete (the probe fails closed);
 *   - select-all covers the FILTERED rows only, never rows hidden by search;
 *   - the confirm dialog defaults to the non-destructive "keep" choice;
 *   - confirming calls bulkDeleteWorkspaces with the selected ids and the
 *     cascade flag the radio actually selected;
 *   - only server-CONFIRMED deletions leave the table.
 *
 * Per .claude/rules/no-vaporware.md the data functions are stubbed (this is a
 * client-side UI change over an API route that already exists and is tested at
 * app/api/workspaces/bulk-delete), but the component tree mounts for real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

const WS_FIXTURES = [
  {
    id: 'ws-a', name: 'Alpha workspace', description: 'First',
    itemCount: 3, capacity: 'F64', domain: 'Sales',
    createdBy: 'a@example.com', lastActivity: '2026-06-01T00:00:00Z', state: 'Active',
  },
  {
    id: 'ws-b', name: 'Beta workspace', description: 'Second',
    itemCount: 0, createdBy: 'b@example.com', state: 'Active',
  },
  {
    id: 'ws-c', name: 'Gamma workspace', description: 'Third',
    itemCount: 1, createdBy: 'c@example.com', state: 'Active',
  },
];

let adminStatus = { ok: true, isAdmin: true, canBulkDelete: true };
const bulkDeleteWorkspaces = vi.fn();

vi.mock('@/lib/api/workspaces', () => ({
  getWorkspaceAdminStatus: vi.fn(async () => adminStatus),
  bulkDeleteWorkspaces: (...args: unknown[]) => bulkDeleteWorkspaces(...args),
}));

vi.mock('@/lib/client-fetch', () => ({
  clientFetch: vi.fn(async () => ({
    json: async () => ({ ok: true, workspaces: WS_FIXTURES }),
  })),
}));

// Imported AFTER the mocks so the page picks up the stubbed data layer.
import AdminWorkspacesPage from '../page';

function renderPage() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <AdminWorkspacesPage />
    </FluentProvider>,
  );
}

/** Wait for the inventory to paint. */
async function ready() {
  await waitFor(() => expect(screen.getByText('Alpha workspace')).toBeInTheDocument(), {
    timeout: 5000,
  });
}

/** The bulk bar's live count, e.g. "2 selected". */
function selectedCount(): number {
  const bar = screen.getByRole('region', { name: 'Bulk actions' });
  const m = /(\d+) selected/.exec(bar.textContent ?? '');
  return m ? Number(m[1]) : -1;
}

/**
 * The confirm dialog's "Delete N" button.
 *
 * Queried straight off the DOM rather than via `getByRole`. When Fluent's modal
 * opens it marks surrounding content `aria-hidden`, and in jsdom the portal
 * ordering makes role queries return the PAGE's buttons while excluding the
 * dialog's own — verified: at failure the dialog was open with the right title
 * and `queryAllByRole('button')` still listed only page buttons. Matching
 * `document`'s <button> elements by text sidesteps that entirely and is exactly
 * what a user clicks. The bulk-bar button reads "Delete selected (N)", so an
 * exact match on "Delete N" is unambiguous.
 */
async function confirmButton(n: number): Promise<HTMLButtonElement> {
  let found: HTMLButtonElement | undefined;
  await waitFor(() => {
    found = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === `Delete ${n}`,
    );
    if (!found) {
      throw new Error(
        `No "Delete ${n}" button yet. buttons=` +
          JSON.stringify(Array.from(document.querySelectorAll('button')).map((b) => b.textContent?.trim())),
      );
    }
  });
  return found!;
}

/** The open confirm dialog, for scoping text assertions to it. */
function confirmDialog(): HTMLElement {
  const d = document.querySelector('[role="dialog"]');
  if (!d) throw new Error('No open dialog');
  return d as HTMLElement;
}

beforeEach(() => {
  adminStatus = { ok: true, isAdmin: true, canBulkDelete: true };
  bulkDeleteWorkspaces.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('/admin/workspaces — bulk select + delete', () => {
  it('hides the bulk bar and checkboxes when the caller cannot bulk-delete', async () => {
    adminStatus = { ok: true, isAdmin: false, canBulkDelete: false };
    renderPage();
    await ready();
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Bulk actions' })).not.toBeInTheDocument(),
    );
    // No selection column at all — not merely a disabled button.
    expect(screen.queryByLabelText('Select all rows')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Select Alpha workspace')).not.toBeInTheDocument();
  });

  it('shows the bulk bar and a checkbox per row for an admin', async () => {
    renderPage();
    await ready();
    await waitFor(() => expect(screen.getByRole('region', { name: 'Bulk actions' })).toBeInTheDocument());
    expect(screen.getByLabelText('Select all rows')).toBeInTheDocument();
    for (const name of ['Alpha workspace', 'Beta workspace', 'Gamma workspace']) {
      expect(screen.getByLabelText(`Select ${name}`)).toBeInTheDocument();
    }
    expect(selectedCount()).toBe(0);
  });

  it('selects a single row and enables the delete button', async () => {
    renderPage();
    await ready();
    await waitFor(() => expect(screen.getByLabelText('Select Alpha workspace')).toBeInTheDocument());

    const del = screen.getByRole('button', { name: /Delete selected/ });
    expect(del).toBeDisabled();

    fireEvent.click(screen.getByLabelText('Select Alpha workspace'));
    await waitFor(() => expect(selectedCount()).toBe(1));
    expect(screen.getByRole('button', { name: /Delete selected \(1\)/ })).toBeEnabled();
  });

  it('select-all covers every row, and only the FILTERED rows when a search is active', async () => {
    renderPage();
    await ready();
    await waitFor(() => expect(screen.getByLabelText('Select all rows')).toBeInTheDocument());

    // Unfiltered: all three.
    fireEvent.click(screen.getByLabelText('Select all rows'));
    await waitFor(() => expect(selectedCount()).toBe(3));

    // Clear, then narrow to one row and select-all again.
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(selectedCount()).toBe(0));

    const search = screen.getByPlaceholderText(/Search by name, owner, domain, capacity/);
    fireEvent.change(search, { target: { value: 'Gamma' } });
    await waitFor(() => expect(screen.queryByText('Alpha workspace')).not.toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Select all rows'));
    // 1, not 3 — rows hidden behind the filter must never be swept in.
    await waitFor(() => expect(selectedCount()).toBe(1));
  });

  it('defaults the confirm dialog to "keep" and sends cascade:false', async () => {
    bulkDeleteWorkspaces.mockResolvedValue({ ok: true, deleted: ['ws-a'], failed: [] });
    renderPage();
    await ready();
    await waitFor(() => expect(screen.getByLabelText('Select Alpha workspace')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Select Alpha workspace'));
    await waitFor(() => expect(selectedCount()).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: /Delete selected \(1\)/ }));

    await screen.findByRole('dialog');
    // Scoped to the dialog: the workspace name also appears in the grid behind
    // it, and the radios are inside the same aria-hidden-affected subtree.
    const dlg = within(confirmDialog());
    // The safe option is pre-selected; the destructive one is not.
    expect(dlg.getByLabelText(/Keep underlying data/)).toBeChecked();
    expect(dlg.getByLabelText(/Delete everything/)).not.toBeChecked();
    // The names being deleted are listed.
    expect(dlg.getByText('Alpha workspace')).toBeInTheDocument();

    fireEvent.click(await confirmButton(1));
    await waitFor(() => expect(bulkDeleteWorkspaces).toHaveBeenCalledTimes(1));
    expect(bulkDeleteWorkspaces).toHaveBeenCalledWith(['ws-a'], { cascade: false });
  });

  it('sends cascade:true only when the destructive radio is chosen', async () => {
    bulkDeleteWorkspaces.mockResolvedValue({ ok: true, deleted: ['ws-b'], failed: [] });
    renderPage();
    await ready();
    await waitFor(() => expect(screen.getByLabelText('Select Beta workspace')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Select Beta workspace'));
    await waitFor(() => expect(selectedCount()).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: /Delete selected \(1\)/ }));

    await screen.findByRole('dialog');
    fireEvent.click(within(confirmDialog()).getByLabelText(/Delete everything/));
    fireEvent.click(await confirmButton(1));

    await waitFor(() => expect(bulkDeleteWorkspaces).toHaveBeenCalledTimes(1));
    expect(bulkDeleteWorkspaces).toHaveBeenCalledWith(['ws-b'], { cascade: true });
  });

  it('removes only server-CONFIRMED deletions and reports the failures', async () => {
    // Two selected; the server deletes one and rejects the other.
    bulkDeleteWorkspaces.mockResolvedValue({
      ok: false,
      deleted: ['ws-a'],
      failed: [{ id: 'ws-b', error: 'forbidden' }],
    });
    renderPage();
    await ready();
    await waitFor(() => expect(screen.getByLabelText('Select Alpha workspace')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Select Alpha workspace'));
    fireEvent.click(screen.getByLabelText('Select Beta workspace'));
    await waitFor(() => expect(selectedCount()).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: /Delete selected \(2\)/ }));

    await screen.findByRole('dialog');
    fireEvent.click(await confirmButton(2));

    // Confirmed row is gone from the grid; the rejected one stays put.
    await waitFor(() => expect(screen.queryByText('Alpha workspace')).not.toBeInTheDocument());
    expect(screen.getByText('Beta workspace')).toBeInTheDocument();

    // The failure is surfaced by name + reason, not swallowed.
    await waitFor(() => expect(screen.getByText(/forbidden/)).toBeInTheDocument());
    // Only the confirmed id leaves the selection, so the failure can be retried.
    await waitFor(() => expect(selectedCount()).toBe(1));
  });

  it('keeps the selection when the request itself throws', async () => {
    bulkDeleteWorkspaces.mockRejectedValue(new Error('network is down'));
    renderPage();
    await ready();
    await waitFor(() => expect(screen.getByLabelText('Select Alpha workspace')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Select Alpha workspace'));
    await waitFor(() => expect(selectedCount()).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: /Delete selected \(1\)/ }));

    await screen.findByRole('dialog');
    fireEvent.click(await confirmButton(1));

    // Nothing was confirmed, so nothing may leave the grid or the selection,
    // and the dialog stays open so the admin can retry.
    await waitFor(() => expect(screen.getByText('network is down')).toBeInTheDocument());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    // Present in BOTH the grid and the dialog's pending list — hence getAllByText.
    expect(screen.getAllByText('Alpha workspace').length).toBeGreaterThan(0);
    expect(selectedCount()).toBe(1);
  });
});
