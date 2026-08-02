/**
 * Data-shares publish dialogs — issue #2618 (LU-9).
 *
 * The Loom (Azure-native) branch of both publish dialogs used to be free text:
 * a hand-typed `abfss://…` root plus schema/table, and a comma-separated
 * textarea of Entra GUIDs. That violates the BLOCKING `loom_no_freeform_config`
 * rule, and it was also a parity regression against the Databricks branch of
 * the SAME dialog, which has always been a cascading picker.
 *
 * These tests mount the real surface and assert the free-text fields are gone
 * and real pickers stand in their place. They fail on the pre-fix tree.
 *
 * The Databricks branch is exercised as a CONTROL: it was already compliant and
 * must be unchanged, so those assertions hold both before and after the fix.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, within, configure } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

/**
 * This surface mounts SEVERAL Fluent <Dialog>s at once (New share, New
 * recipient, the share explorer, plus one Add-object dialog per ShareCard).
 * Fluent's modal bookkeeping then marks non-active `DialogSurface`s
 * `aria-hidden="true"`, and in jsdom — which has no top-layer or real focus
 * management — the surface under test intermittently keeps that attribute even
 * while it is the open one.
 *
 * `*ByRole` defaults to `hidden:false`, i.e. it consults the accessibility
 * tree, so every query inside the dialog then finds nothing. That is what made
 * this spec pass locally and fail on a loaded CI runner: verified by dumping
 * the DOM in the failing state, where `<label for>` and the control `id` were
 * correctly paired and the ONLY hidden ancestor was
 * `DIV.fui-DialogSurface{aria-hidden=true}`.
 *
 * So: opt role queries out of the a11y-tree filter, and assert the cascade via
 * `*ByLabelText`, which both is deterministic here and is the stronger claim —
 * it proves each control is actually labelled.
 *
 * `configure` is a global singleton in @testing-library/dom, so it is set and
 * restored per test rather than at module scope — otherwise it would leak into
 * any other spec sharing this worker.
 */

const clientFetchMock = vi.fn();
vi.mock('@/lib/client-fetch', () => ({
  clientFetch: (...a: unknown[]) => clientFetchMock(...a),
}));

/** A location that no lakehouse scan would return — the "already saved" case. */
const LEGACY_LOCATION = 'abfss://archive@stlegacy.dfs.core.usgovcloudapi.net/retired/orders';

function json(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

function shareListFor(backend: 'loom' | 'databricks') {
  return {
    ok: true,
    backend,
    host: backend === 'loom' ? 'loom-sharing.internal' : 'adb-123.azuredatabricks.net',
    shares: [{
      name: 'sales_2026',
      comment: 'FY26 sales',
      objects: [{
        name: 'gold.orders', shared_as: 'gold.orders',
        data_object_type: 'TABLE', location: LEGACY_LOCATION,
      }],
    }],
  };
}

let backend: 'loom' | 'databricks' = 'loom';

beforeEach(() => {
  configure({ defaultHidden: true });
  backend = 'loom';
  clientFetchMock.mockReset();
  clientFetchMock.mockImplementation(async (url: string) => {
    if (url === '/api/workspaces') return json([{ id: 'ws-1', displayName: 'Sales WS' }]);
    if (url.startsWith('/api/items/lakehouse')) return json({ ok: true, items: [] });
    if (url.startsWith('/api/marketplace/sharing/publishable-tables')) return json({ ok: true, tables: [] });
    return json({ ok: true });
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (u.startsWith('/api/marketplace/sharing/shares')) {
      return { ok: true, status: 200, json: async () => shareListFor(backend) };
    }
    if (u.startsWith('/api/marketplace/sharing/recipients')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, recipients: [] }) };
    }
    if (u.startsWith('/api/marketplace/sharing/providers')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, providers: [] }) };
    }
    if (u.startsWith('/api/catalog/browse')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, nodes: [{ id: 'main', kind: 'catalog' }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }));
});
afterEach(() => { configure({ defaultHidden: false }); cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

async function openOutbound() {
  const { DataShares } = await import('../data-shares');
  render(<FluentProvider theme={webLightTheme}><DataShares /></FluentProvider>);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('tab', { name: /Shared by me/i }));
  await screen.findByText('sales_2026');
  return user;
}

async function openAddTable() {
  const user = await openOutbound();
  await user.click(await screen.findByRole('button', { name: /Add table/i }));
  await screen.findByText(/Add a table to sales_2026/i);
  return user;
}

/** The open dialog, so a selector never collides with the card behind it. */
function dialog() {
  return within(screen.getByRole('dialog'));
}

describe('AddObjectDialog — Loom backend (issue #2618)', () => {
  it('no longer asks the operator to type an abfss:// Delta root', async () => {
    await openAddTable();
    // The pre-fix field. Its absence is the fix.
    expect(screen.queryByLabelText(/ADLS Delta location/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/^abfss:\/\//)).toBeNull();
  });

  it('replaces it with a Workspace -> Lakehouse -> Delta table cascade', async () => {
    await openAddTable();
    // By LABEL, not by role-name: this asserts the control exists AND is
    // labelled, and does not depend on Fluent's modal aria-hidden bookkeeping.
    expect(await screen.findByLabelText(/^Workspace/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Lakehouse/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Delta table/)).toBeInTheDocument();
  });

  it('stays assertable when Fluent marks the dialog surface aria-hidden (the CI failure mode)', async () => {
    await openAddTable();
    // Reproduce the exact condition that made this spec red on a 4-core runner:
    // several Dialogs are mounted on this surface at once, and Fluent's modal
    // bookkeeping intermittently leaves `aria-hidden` on the open one under
    // jsdom (no top layer, no real focus management). Under that attribute the
    // whole subtree drops out of the accessibility tree, so `*ByRole` with the
    // default `hidden:false` finds nothing — while the DOM, and the
    // `<label for>` -> control `id` wiring, are entirely correct.
    const surface = document.querySelector('.fui-DialogSurface');
    expect(surface).not.toBeNull();
    surface!.setAttribute('aria-hidden', 'true');

    expect(screen.getByLabelText(/^Workspace/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Lakehouse/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Delta table/)).toBeInTheDocument();
    // And the pre-fix free-text field is still absent under the same condition,
    // so the issue-#2618 assertion cannot silently pass by finding nothing.
    expect(screen.queryByLabelText(/ADLS Delta location/i)).toBeNull();
  });

  it('enumerates lakehouses from the real backend rather than a built-in list', async () => {
    await openAddTable();
    await waitFor(() => expect(
      clientFetchMock.mock.calls.map((c) => String(c[0])),
    ).toContain('/api/workspaces'));
  });

  it('offers the schemas this share already publishes, so the second table reuses the first', async () => {
    const user = await openAddTable();
    // The share fixture publishes `gold.orders`, so `gold` is a real, enumerated
    // option — not something the operator has to retype.
    await user.click(await screen.findByLabelText(/^Schema/));
    expect(await screen.findByRole('option', { name: 'gold' })).toBeInTheDocument();
  });

  it('cannot submit until a real Delta table has been picked', async () => {
    await openAddTable();
    const add = dialog().getByRole('button', { name: /^Add table$/i });
    // Nothing picked (the stubbed lakehouse list is empty) -> the primary stays
    // disabled, so no PATCH can carry a location the operator invented.
    expect(add).toBeDisabled();
  });

  it('keeps a previously saved location that no scan would return', async () => {
    const user = await openAddTable();
    // Opening + cancelling the ADD dialog must not rewrite the share. The
    // existing `gold.orders` entry points at a legacy root outside any lakehouse
    // and has to survive the migration to pickers untouched.
    await user.click(screen.getByRole('button', { name: /^Cancel$/i }));
    expect(screen.getByText('gold.orders')).toBeInTheDocument();
    const patched = clientFetchMock.mock.calls.filter(
      (c) => String(c[0]).includes('/sharing/shares/') && (c[1] as { method?: string })?.method === 'PATCH',
    );
    expect(patched).toHaveLength(0);
  });
});

describe('NewRecipientDialog — Loom backend (issue #2618)', () => {
  async function openNewRecipient() {
    const user = await openOutbound();
    // The section header button and the empty-state CTA share this label.
    await user.click((await screen.findAllByRole('button', { name: /New recipient/i }))[0]);
    await screen.findByRole('dialog');
    return user;
  }

  it('no longer takes comma-separated Entra GUIDs as free text', async () => {
    await openNewRecipient();
    expect(screen.queryByLabelText(/Entra principal id/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/00000000-0000-0000-0000-000000000000/)).toBeNull();
  });

  it('replaces it with the shared Entra principal picker', async () => {
    await openNewRecipient();
    expect(await screen.findByText(/Recipient principals/i)).toBeInTheDocument();
    expect(screen.getByText(/Search Entra for the recipient/i)).toBeInTheDocument();
    // Empty-state copy from the picker — a recipient still needs >= 1 principal.
    expect(screen.getByText(/No principals selected yet/i)).toBeInTheDocument();
  });

  it('cannot create a recipient with no principals picked', async () => {
    const user = await openNewRecipient();
    await user.type(dialog().getByRole('textbox', { name: /Recipient name/i }), 'partner-acme');
    expect(dialog().getByRole('button', { name: /^Create$/i })).toBeDisabled();
  });
});

describe('CONTROL — Databricks backend is unchanged', () => {
  it('still renders its Catalog -> Schema -> Table cascade and the alias field', async () => {
    backend = 'databricks';
    await openAddTable();
    // Pre-existing, already-compliant behaviour: passes before AND after the fix.
    expect(screen.getByText('Catalog')).toBeInTheDocument();
    expect(screen.getByText('Shared as (alias)')).toBeInTheDocument();
    // The Loom-only pickers must not leak onto this branch.
    expect(screen.queryByLabelText(/^Workspace/)).toBeNull();
    expect(screen.queryByLabelText(/^Delta table/)).toBeNull();
  });

  it('still offers the TOKEN / DATABRICKS authentication choice', async () => {
    backend = 'databricks';
    const user = await openOutbound();
    await user.click((await screen.findAllByRole('button', { name: /New recipient/i }))[0]);
    expect(await screen.findByText('Authentication')).toBeInTheDocument();
  });
});
