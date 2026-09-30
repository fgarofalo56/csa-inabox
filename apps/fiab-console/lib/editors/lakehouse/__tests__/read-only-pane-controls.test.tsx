/**
 * Lakehouse panes, read-only role: every control that writes closes with the
 * reason, and opens again when the role can write.
 *
 * Each pane reads `/api/lakehouse/access` itself (useLakehouseReadOnly). For
 * each gated control there are two arms:
 *
 *   canWrite=false -> aria-disabled="true", the read-only title, and a click
 *                     does NOT reach the handler.
 *   canWrite=true  -> a click DOES reach the handler (read after the probe has
 *                     answered, so the open state is not just the loading state).
 *
 * The false arm breaks if a pane drops its `disabledFocusable={readOnly}` (or
 * the Switch's `readOnly` term); the true arm breaks if a pane treats true as
 * read-only, or gates on the wrong value. What breaks each case is named at
 * the assertion.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { renderWithProviders, installFetchMock } from '../../__tests__/test-helpers';
import { LakehouseEditorContext } from '../lakehouse-editor-context';
import type { LakehouseEditorCtx } from '../lakehouse-editor-context';
import { ShortcutsPane } from '../panes/shortcuts-pane';
import { SchemasPane } from '../panes/schemas-pane';
import { InteropPane } from '../panes/interop-pane';
import { TablesPane } from '../panes/tables-pane';
import { LAKEHOUSE_READ_ONLY_TITLE } from '../hooks/use-lakehouse-access';

type Access = 'read' | 'write';

const ACCESS_URL = '/api/lakehouse/access?lakehouseId=lh-1';

function mount(pane: React.ReactElement, ctx: Record<string, unknown>, access: Access, extra: Record<string, () => unknown> = {}) {
  const mock = installFetchMock({
    '/api/lakehouse/access': () => ({ ok: true, lakehouseId: 'lh-1', canWrite: access === 'write' }),
    ...extra,
  });
  const value = {
    id: 'lh-1',
    isNewItem: false,
    setActionError: () => {},
    setActionStatus: () => {},
    ...ctx,
  } as unknown as LakehouseEditorCtx;
  renderWithProviders(
    <LakehouseEditorContext.Provider value={value}>{pane}</LakehouseEditorContext.Provider>,
  );
  return mock;
}

/** canWrite is null (open) while the probe is in flight; wait for the answer. */
async function probeSettled(calls: Array<{ url: string }>) {
  await waitFor(() => expect(calls.some((c) => c.url.includes(ACCESS_URL))).toBe(true));
  await new Promise((r) => setTimeout(r, 200));
}

/** Closed with the reason: breaks if the control is left open, or closed with no title. */
async function expectClosed(el: HTMLElement) {
  await waitFor(() => expect(el.getAttribute('aria-disabled')).toBe('true'));
  expect(el.getAttribute('title')).toBe(LAKEHOUSE_READ_ONLY_TITLE);
}

const button = (name: RegExp) => screen.findByRole('button', { name }, { timeout: 5000 });

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// ---------------------------------------------------------------- Shortcuts

const BROKEN = {
  id: 'sc-1', name: 'ext_orders', fullPath: 'Files/ext_orders', targetType: 's3',
  engine: 'none', status: 'error', statusDetail: 'credential expired', kind: 'files',
};

function shortcutsCtx(over: Record<string, unknown> = {}) {
  return {
    shortcutLakehouseId: 'lh-1', shortcuts: [BROKEN], shortcutsBusy: false, shortcutsError: null,
    loadShortcuts: vi.fn(), selectedShortcut: null, setSelectedShortcut: vi.fn(),
    openShortcutWizard: vi.fn(), testShortcut: vi.fn(), deleteShortcutRow: vi.fn(), queryShortcut: vi.fn(),
    bundleShortcuts: [], regBusy: null, registerBundleShortcut: vi.fn(), registerAllBundleShortcuts: vi.fn(),
    setSqlText: vi.fn(), setTab: vi.fn(),
    ...over,
  };
}

const PLANNED = { name: 'planned_sales', target: 'abfss://bronze@acct.dfs.core.windows.net/sales', description: 'Sales feed' };

describe('ShortcutsPane — read-only role', () => {
  it('closes New shortcut and Retry, and neither click reaches its handler', async () => {
    const ctx = shortcutsCtx();
    mount(<ShortcutsPane />, ctx, 'read');
    const create = await button(/^New shortcut$/);
    await expectClosed(create);
    const retry = await button(/^Retry$/);
    await expectClosed(retry);
    fireEvent.click(create);
    fireEvent.click(retry);
    // Breaks if disabledFocusable is dropped: the click would open the wizard / re-test.
    expect(ctx.openShortcutWizard).not.toHaveBeenCalled();
    expect(ctx.testShortcut).not.toHaveBeenCalled();
    // Positive: Refresh (a read) stays open. Breaks if the whole toolbar is gated.
    expect((await button(/^Refresh$/)).getAttribute('aria-disabled')).not.toBe('true');
  });

  it('F11 does not re-test the selected broken shortcut', async () => {
    const ctx = shortcutsCtx({ selectedShortcut: BROKEN });
    const { calls } = mount(<ShortcutsPane />, ctx, 'read');
    await probeSettled(calls);
    const create = await button(/^New shortcut$/);
    await expectClosed(create);
    // Breaks if the F11 handler loses its `!readOnly` term.
    fireEvent.keyDown(create, { key: 'F11' });
    expect(ctx.testShortcut).not.toHaveBeenCalled();
  });

  it('closes Register all and Register for planned shortcuts', async () => {
    const ctx = shortcutsCtx({ shortcuts: [], bundleShortcuts: [PLANNED] });
    mount(<ShortcutsPane />, ctx, 'read');
    const all = await button(/^Register all$/);
    await expectClosed(all);
    const one = await button(/^Register$/);
    await expectClosed(one);
    fireEvent.click(all);
    fireEvent.click(one);
    expect(ctx.registerAllBundleShortcuts).not.toHaveBeenCalled();
    expect(ctx.registerBundleShortcut).not.toHaveBeenCalled();
  });

  it('with canWrite=true every one of those controls reaches its handler', async () => {
    const ctx = shortcutsCtx({ selectedShortcut: BROKEN });
    const { calls } = mount(<ShortcutsPane />, ctx, 'write');
    await probeSettled(calls);
    const create = await button(/^New shortcut$/);
    // Breaks if the pane treats canWrite=true as read-only.
    expect(create.getAttribute('title')).not.toBe(LAKEHOUSE_READ_ONLY_TITLE);
    fireEvent.click(create);
    fireEvent.click(await button(/^Retry$/));
    fireEvent.keyDown(create, { key: 'F11' });
    expect(ctx.openShortcutWizard).toHaveBeenCalledTimes(1);
    expect(ctx.testShortcut).toHaveBeenCalledTimes(2); // Retry + F11
    cleanup();

    const ctx2 = shortcutsCtx({ shortcuts: [], bundleShortcuts: [PLANNED] });
    const m2 = mount(<ShortcutsPane />, ctx2, 'write');
    await probeSettled(m2.calls);
    fireEvent.click(await button(/^Register all$/));
    fireEvent.click(await button(/^Register$/));
    expect(ctx2.registerAllBundleShortcuts).toHaveBeenCalledTimes(1);
    expect(ctx2.registerBundleShortcut).toHaveBeenCalledWith(PLANNED);
  });
});

// ---------------------------------------------------------------- Schemas

function schemasCtx(over: Record<string, unknown> = {}) {
  return {
    shortcutLakehouseId: 'lh-1', schemasEnabled: true,
    schemas: [
      { name: 'dbo', isDefault: true, status: 'active' },
      { name: 'sales', status: 'active', sparkDatabase: 'lh_1_sales' },
    ],
    schemasBusy: false, schemasError: null, schemasNotice: null,
    loadSchemas: vi.fn(), deleteSchema: vi.fn(),
    newSchemaOpen: false, setNewSchemaOpen: vi.fn(), newSchemaName: '', setNewSchemaName: vi.fn(),
    newSchemaDesc: '', setNewSchemaDesc: vi.fn(), newSchemaBusy: false, newSchemaError: null, createSchema: vi.fn(),
    ...over,
  };
}

describe('SchemasPane — read-only role', () => {
  it('closes New schema and the row Delete', async () => {
    const ctx = schemasCtx();
    mount(<SchemasPane />, ctx, 'read');
    const create = await button(/^New schema$/);
    await expectClosed(create);
    const del = await button(/^Delete$/);
    await expectClosed(del);
    fireEvent.click(create);
    fireEvent.click(del);
    // Breaks if either button is left open: the dialog would open / the schema would be dropped.
    expect(ctx.setNewSchemaOpen).not.toHaveBeenCalled();
    expect(ctx.deleteSchema).not.toHaveBeenCalled();
  });

  it('with canWrite=true New schema and Delete reach their handlers', async () => {
    const ctx = schemasCtx();
    const { calls } = mount(<SchemasPane />, ctx, 'write');
    await probeSettled(calls);
    fireEvent.click(await button(/^New schema$/));
    fireEvent.click(await button(/^Delete$/));
    expect(ctx.setNewSchemaOpen).toHaveBeenCalledWith(true);
    expect(ctx.deleteSchema).toHaveBeenCalledWith('sales');
  });
});

// ---------------------------------------------------------------- Tables (schema-enabled)

function tablesCtx() {
  return {
    activeContainer: 'gold', schemasEnabled: true, shortcutLakehouseId: 'lh-1', tablesPrefix: 'Tables',
    liveTables: [{ name: 'Tables/sales' }], liveTablesLoading: false, liveTablesError: null, liveTablesGate: null,
    loadLiveTables: vi.fn(), seededTableInfo: {}, bundleDeltaTables: [],
    openPrefixes: { 'gold::Tables/sales': [{ name: 'Tables/sales/orders', isDirectory: true, size: 0 }] },
    cacheKey: (c: string, p: string) => `${c}::${p}`, loadPaths: vi.fn(),
    previewTable: vi.fn(), setSqlText: vi.fn(), setTab: vi.fn(), openTableHistory: vi.fn(),
    setMaintainTable: vi.fn(), setMaintainOpen: vi.fn(), openMoveTable: vi.fn(),
  };
}

describe('TablesPane (schema-enabled) — read-only role', () => {
  it('closes Move to schema… and Maintain…, and leaves Preview and History open', async () => {
    const ctx = tablesCtx();
    mount(<TablesPane />, ctx, 'read');
    const move = await button(/^Move to schema…$/);
    await expectClosed(move);
    const maintain = await button(/^Maintain…$/);
    await expectClosed(maintain);
    fireEvent.click(move);
    fireEvent.click(maintain);
    expect(ctx.openMoveTable).not.toHaveBeenCalled();
    expect(ctx.setMaintainOpen).not.toHaveBeenCalled();
    // Positive: reads in the same row stay open. Breaks if the whole row is gated.
    fireEvent.click(await button(/^History$/));
    expect(ctx.openTableHistory).toHaveBeenCalledWith('Tables/sales/orders');
  });

  it('with canWrite=true Move to schema… and Maintain… reach their handlers', async () => {
    const ctx = tablesCtx();
    const { calls } = mount(<TablesPane />, ctx, 'write');
    await probeSettled(calls);
    fireEvent.click(await button(/^Move to schema…$/));
    fireEvent.click(await button(/^Maintain…$/));
    expect(ctx.openMoveTable).toHaveBeenCalledWith('orders', 'sales');
    expect(ctx.setMaintainTable).toHaveBeenCalledWith('sales/orders');
    expect(ctx.setMaintainOpen).toHaveBeenCalledWith(true);
  });
});

// ---------------------------------------------------------------- Interop

const INTEROP = {
  ok: true, container: 'gold', account: 'stloom', defaultPool: 'loompool',
  catalog: { configured: true, uri: 'https://loom.test/api/catalog/iceberg', warehouse: 'loom' },
  tables: [],
};

function interopCtx() {
  return {
    activeContainer: 'gold',
    liveTables: [
      { schema: 'dbo', name: 'orders', adlsPath: 'Tables/orders', bulkUrl: '', format: 'delta', status: 'ok', latestVersion: 3, rowCount: 10, sizeBytes: 1, lastModified: null },
    ],
    liveTablesLoading: false, liveTablesError: null, liveTablesGate: null,
  };
}

describe('InteropPane — read-only role', () => {
  it('disables the Iceberg switch with the reason, and a click does not PUT', async () => {
    const { calls } = mount(<InteropPane />, interopCtx(), 'read', { '/api/lakehouse/interop': () => INTEROP });
    const sw = await screen.findByRole('switch', { name: 'Expose orders as Iceberg' }, { timeout: 5000 });
    // Breaks if the Switch's `|| readOnly` term is dropped.
    await waitFor(() => expect((sw as HTMLInputElement).disabled).toBe(true));
    expect(sw.closest('[title]')?.getAttribute('title')).toBe(LAKEHOUSE_READ_ONLY_TITLE);
    // jsdom (unlike a browser) still fires change on a disabled checkbox, so this
    // click arm witnesses the handler's own `!readOnly` guard, not `disabled`.
    fireEvent.click(sw);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.some((c) => c.url.includes('/api/lakehouse/interop') && c.init?.method === 'PUT')).toBe(false);
  });

  it('with canWrite=true the switch is enabled and a click PUTs', async () => {
    const { calls } = mount(<InteropPane />, interopCtx(), 'write', { '/api/lakehouse/interop': () => INTEROP });
    await probeSettled(calls);
    const sw = await screen.findByRole('switch', { name: 'Expose orders as Iceberg' });
    expect((sw as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(sw);
    // Breaks if canWrite=true is read as read-only (no PUT would be sent).
    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/lakehouse/interop') && c.init?.method === 'PUT')).toBe(true));
  });
});

// ---------------------------------------------------------------- Schemas dialog
// Kept LAST: an open Fluent Dialog can leave the rest of the page aria-hidden
// after cleanup, so these read the Create button by its text, not its role.

function createButton(): HTMLElement {
  const b = screen.getByText('Create').closest('button');
  if (!b) throw new Error('no Create button');
  return b as HTMLElement;
}

describe('SchemasPane new-schema dialog — read-only role', () => {
  it('closes Create even with a valid name', async () => {
    const ctx = schemasCtx({ newSchemaOpen: true, newSchemaName: 'marketing' });
    mount(<SchemasPane />, ctx, 'read');
    await waitFor(() => expect(createButton().getAttribute('aria-disabled')).toBe('true'));
    expect(createButton().getAttribute('title')).toBe(LAKEHOUSE_READ_ONLY_TITLE);
    fireEvent.click(createButton());
    expect(ctx.createSchema).not.toHaveBeenCalled();
  });

  it('with canWrite=true Create reaches createSchema', async () => {
    const ctx = schemasCtx({ newSchemaOpen: true, newSchemaName: 'marketing' });
    const { calls } = mount(<SchemasPane />, ctx, 'write');
    await probeSettled(calls);
    fireEvent.click(createButton());
    expect(ctx.createSchema).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------- Right-click menu
// Also after everything role-based: the menu is open from the first render.

const FILE = { name: 'lakehouses/Contoso Sales/orders.csv', isDirectory: false, size: 12 };
const FOLDER = { name: 'Files/raw', isDirectory: true, size: 0 };

function ctxMenuCtx(entry: typeof FILE) {
  return {
    ctxOpen: true, setCtxOpen: vi.fn(), ctxEntry: entry, ctxPos: { x: 10, y: 10 },
    selectFile: vi.fn(), setTab: vi.fn(), onOpenInNotebook: vi.fn(), onLoadToTables: vi.fn(),
    onDownload: vi.fn(), openLabelDialog: vi.fn(), loadPaths: vi.fn(), activeContainer: 'landing',
    openShortcutWizard: vi.fn(), onDelete: vi.fn(), setPropsEntry: vi.fn(),
  };
}

/** A menu item by its exact text; text queries are not affected by aria-hidden. */
async function menuItem(text: string): Promise<HTMLElement> {
  const label = await screen.findByText(text, {}, { timeout: 5000 });
  const item = label.closest('[role="menuitem"]');
  if (!item) throw new Error(`no menuitem "${text}"`);
  return item as HTMLElement;
}

describe('Files right-click menu — read-only role', () => {
  it('closes Load to Tables and Delete for a file, and leaves Download open', async () => {
    const { ContextMenu } = await import('../dialogs/small-dialogs');
    const ctx = ctxMenuCtx(FILE);
    mount(<ContextMenu />, ctx, 'read');
    const load = await menuItem('Load to Tables (Delta)');
    await expectClosed(load);
    const del = await menuItem('Delete');
    await expectClosed(del);
    fireEvent.click(load);
    fireEvent.click(del);
    // Breaks if either MenuItem loses disabled={readOnly}.
    expect(ctx.onLoadToTables).not.toHaveBeenCalled();
    expect(ctx.onDelete).not.toHaveBeenCalled();
    // Positive: a read in the same menu still runs. Breaks if the whole menu is gated.
    fireEvent.click(await menuItem('Download'));
    expect(ctx.onDownload).toHaveBeenCalledWith(FILE);
  });

  it('closes New shortcut… for a folder', async () => {
    const { ContextMenu } = await import('../dialogs/small-dialogs');
    const ctx = ctxMenuCtx(FOLDER);
    mount(<ContextMenu />, ctx, 'read');
    const sc = await menuItem('New shortcut…');
    await expectClosed(sc);
    fireEvent.click(sc);
    expect(ctx.openShortcutWizard).not.toHaveBeenCalled();
  });

  it('with canWrite=true Load to Tables, New shortcut… and Delete reach their handlers', async () => {
    const { ContextMenu } = await import('../dialogs/small-dialogs');
    const ctx = ctxMenuCtx(FILE);
    const { calls } = mount(<ContextMenu />, ctx, 'write');
    await probeSettled(calls);
    fireEvent.click(await menuItem('Load to Tables (Delta)'));
    fireEvent.click(await menuItem('Delete'));
    expect(ctx.onLoadToTables).toHaveBeenCalledWith(FILE);
    expect(ctx.onDelete).toHaveBeenCalledWith(FILE);
    cleanup();

    const ctx2 = ctxMenuCtx(FOLDER);
    const m2 = mount(<ContextMenu />, ctx2, 'write');
    await probeSettled(m2.calls);
    fireEvent.click(await menuItem('New shortcut…'));
    expect(ctx2.openShortcutWizard).toHaveBeenCalledWith('files', 'raw');
  });
});
