/**
 * #3734 — the New monitor dialog PICKS from the catalog; it does not ask the
 * operator to type a GUID and a three-part table name from memory.
 *
 * The dialog used to be three freeform `<Input>`s: an "Item id" the operator had
 * to already know, an "Item type" pre-filled `lakehouse` and freely editable, and
 * a "Table" typed as `catalog.schema.table`. Nothing validated any of them, so a
 * typo silently created a monitor that never trips because it never matches a
 * real table. `.claude/rules/auto-bind-by-default.md` calls a field asking for an
 * id the platform could discover "a DEFECT, not a compliant state".
 *
 * What is asserted here, and why each one:
 *
 *   1. THE CASCADE IS DRIVEN BY REAL ROUTES. The fetch double answers
 *      /api/workspaces, /api/items/<type> and the publishable-tables scan, and
 *      the test asserts those URLs were actually requested. A picker rendered
 *      over a hard-coded array would pass a DOM-string check and is exactly what
 *      `no-vaporware` forbids.
 *   2. THE RESOLVED VALUES REACH THE POST. The acceptance criterion is that the
 *      itemId/table the dialog submits MATCH a real catalog entry — so the body
 *      of the create call is read back and compared against the fixture, not
 *      merely "the button was enabled".
 *   3. ITEM TYPE IS A CLOSED SET. Asserted by there being no text input for it.
 *   4. THE MANUAL PATH IS SECONDARY, not removed. It is off by default and is
 *      reachable — the rule allows it narrowly, and a dialog that cannot express
 *      a table Loom's Delta scan does not see would be a different defect.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IncidentConsole } from '../incident-console';

/** The tenant's REAL catalog, as the three routes would report it. */
const WORKSPACE = { id: 'ws-analytics', displayName: 'Analytics' };
const LAKEHOUSE = { id: 'lh-7f3a', displayName: 'Bronze lake' };
const TABLE = { name: 'orders', sizeBytes: 4096 };

/** Every URL the component asked for, so the cascade can be proven live. */
let requested: string[] = [];
/** The body of the monitor-create POST, or null if it never happened. */
let posted: Record<string, unknown> | null = null;

function catalogFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    requested.push(url);
    const method = (init?.method || 'GET').toUpperCase();
    let body: unknown = { ok: true };

    if (url.includes('/api/observability/monitors') && method === 'POST') {
      posted = JSON.parse(String(init?.body ?? '{}'));
      body = { ok: true, monitor: { id: 'm1' } };
    } else if (url.includes('/api/observability/incidents')) {
      body = { ok: true, incidents: [] };
    } else if (url.includes('/api/observability/monitors')) {
      body = { ok: true, monitors: [] };
    } else if (url.includes('/api/workspaces')) {
      body = { workspaces: [WORKSPACE] };
    } else if (url.includes('/api/items/lakehouse')) {
      body = { ok: true, items: [LAKEHOUSE] };
    } else if (url.includes('/api/marketplace/sharing/publishable-tables')) {
      body = { ok: true, tables: [TABLE] };
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  });
}

function renderPane() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <FluentProvider theme={webLightTheme}>
        <IncidentConsole />
      </FluentProvider>
    </QueryClientProvider>,
  );
}

/**
 * Open Monitors → New monitor.
 *
 * `findAllBy` because an empty tenant renders the CTA twice — once in the
 * toolbar and once as the guided EmptyState's primary action — and a singular
 * query would fail on the multiple match rather than on anything under test.
 */
async function openDialog() {
  fireEvent.click(await screen.findByRole('tab', { name: /monitors/i }));
  const buttons = await screen.findAllByRole('button', { name: /new monitor/i });
  fireEvent.click(buttons[0]);
  // The DIALOG's own heading, not the CTA text — both read "New monitor".
  expect(await screen.findByRole('heading', { name: 'New monitor' })).toBeTruthy();
}

/** Fluent's Dropdown is a combobox; open it and click the option by name. */
async function pick(label: RegExp, option: string) {
  const combo = await screen.findByRole('combobox', { name: label });
  fireEvent.click(combo);
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

beforeEach(() => {
  requested = [];
  posted = null;
  vi.restoreAllMocks();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('#3734 — New monitor picks from the real catalog', () => {
  it('cascades workspace -> item -> table off REAL routes and posts the resolved ids', async () => {
    vi.stubGlobal('fetch', catalogFetch());
    renderPane();
    await openDialog();

    // 1. The picker's first stage is a live read, not a rendered constant.
    await waitFor(() => expect(requested.some((u) => u.includes('/api/workspaces'))).toBe(true));

    await pick(/workspace/i, WORKSPACE.displayName);
    await waitFor(() =>
      expect(requested.some((u) => u.includes(`/api/items/lakehouse?workspaceId=${WORKSPACE.id}`))).toBe(true),
    );

    await pick(/^item$/i, LAKEHOUSE.displayName);
    await waitFor(() =>
      expect(
        requested.some(
          (u) =>
            u.includes('/api/marketplace/sharing/publishable-tables')
            && u.includes(`lakehouseId=${LAKEHOUSE.id}`),
        ),
      ).toBe(true),
    );

    await pick(/table/i, TABLE.name);

    // 2. THE ACCEPTANCE CRITERION: what is submitted matches the catalog entry
    // the operator picked — not a string they typed.
    fireEvent.click(await screen.findByRole('button', { name: /create monitor/i }));
    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted).toMatchObject({
      itemId: LAKEHOUSE.id,
      itemType: 'lakehouse',
      table: TABLE.name,
      workspaceId: WORKSPACE.id,
    });
  });

  it('item type is a CLOSED selector — the dialog has no freeform id/table inputs by default', async () => {
    vi.stubGlobal('fetch', catalogFetch());
    renderPane();
    await openDialog();

    // The three raw text boxes are gone from the default path. Asserted on the
    // placeholders the old dialog shipped, so this fails if either returns.
    expect(screen.queryByPlaceholderText('the data-quality / lakehouse item id')).toBeNull();
    expect(screen.queryByPlaceholderText('catalog.schema.table')).toBeNull();

    // Item type is a combobox, and its options are the closed set.
    const combo = await screen.findByRole('combobox', { name: /item type/i });
    fireEvent.click(combo);
    expect(await screen.findByRole('option', { name: 'Lakehouse' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Data quality' })).toBeTruthy();
  });

  it('the manual path is KEPT and is secondary — reachable, not the default', async () => {
    vi.stubGlobal('fetch', catalogFetch());
    renderPane();
    await openDialog();

    // Off by default…
    expect(screen.queryByPlaceholderText('catalog.schema.table')).toBeNull();
    // …and one explicit action away.
    fireEvent.click(await screen.findByRole('button', { name: /enter identifiers manually/i }));
    expect(await screen.findByPlaceholderText('catalog.schema.table')).toBeTruthy();
    expect(screen.getByText('Manual entry — nothing here is validated')).toBeTruthy();
  });
});
