/**
 * Lakehouse panes show the lakehouse's NAME where a person reads it, and keep
 * the item id for requests only.
 *
 * `shortcutLakehouseId` is the lakehouse ITEM id: the shortcut, schema and
 * browse requests are authorized against it. It is not a name a person knows,
 * so the shortcut wizard's caption, the Tables pane's 4-part name cell and the
 * Query template's 4-part name comment render `lakehouseName` instead.
 *
 * The fixture gives the three candidate values distinct strings, so each
 * assertion names the value that turns it red:
 *   lakehouseName        'Contoso Sales'  (expected)
 *   shortcutLakehouseId  'lh-1'           (the item id: the defect this pins)
 *   activeContainer      'gold'           (the container name, the old display)
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, cleanup, fireEvent } from '@testing-library/react';
import { renderWithProviders, installFetchMock } from '../../__tests__/test-helpers';
import { LakehouseEditorContext } from '../lakehouse-editor-context';
import type { LakehouseEditorCtx } from '../lakehouse-editor-context';
import { TablesPane } from '../panes/tables-pane';
import { ShortcutWizardDialog } from '../dialogs/shortcut-wizard-dialog';

const NAME = 'Contoso Sales';
const ITEM_ID = 'lh-1';
const CONTAINER = 'gold';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function mount(pane: React.ReactElement, ctx: Record<string, unknown>) {
  installFetchMock({
    '/api/lakehouse/access': () => ({ ok: true, lakehouseId: ITEM_ID, canWrite: true }),
  });
  const value = {
    id: ITEM_ID, isNewItem: false, setActionError: () => {}, setActionStatus: () => {},
    lakehouseName: NAME, shortcutLakehouseId: ITEM_ID, activeContainer: CONTAINER,
    ...ctx,
  } as unknown as LakehouseEditorCtx;
  renderWithProviders(<LakehouseEditorContext.Provider value={value}>{pane}</LakehouseEditorContext.Provider>);
}

function tablesCtx() {
  return {
    schemasEnabled: true, tablesPrefix: 'Tables',
    liveTables: [{ name: 'Tables/sales' }], liveTablesLoading: false, liveTablesError: null, liveTablesGate: null,
    loadLiveTables: vi.fn(), seededTableInfo: {}, bundleDeltaTables: [],
    openPrefixes: { 'gold::Tables/sales': [{ name: 'Tables/sales/orders', isDirectory: true, size: 0 }] },
    cacheKey: (c: string, p: string) => `${c}::${p}`, loadPaths: vi.fn(),
    previewTable: vi.fn(), setSqlText: vi.fn(), setTab: vi.fn(), openTableHistory: vi.fn(),
    setMaintainTable: vi.fn(), setMaintainOpen: vi.fn(), openMoveTable: vi.fn(),
  };
}

describe('TablesPane (schema-enabled): the 4-part name names the lakehouse', () => {
  it('the 4-part name cell shows the lakehouse name', async () => {
    mount(<TablesPane />, tablesCtx());
    const table = await screen.findByRole('table', { name: 'Tables in sales' });
    // Breaks if the cell renders shortcutLakehouseId ('lh-1.sales.orders') or
    // the container ('gold.sales.orders').
    expect(table.querySelector('code')?.textContent).toBe(`${NAME}.sales.orders`);
  });

  it("Query writes the lakehouse name into the template's 4-part name comment", async () => {
    const ctx = tablesCtx();
    mount(<TablesPane />, ctx);
    const table = await screen.findByRole('table', { name: 'Tables in sales' });
    const query = Array.from(table.querySelectorAll('button')).find((b) => b.textContent === 'Query');
    fireEvent.click(query!);
    expect(ctx.setSqlText).toHaveBeenCalledTimes(1);
    const sql = String(ctx.setSqlText.mock.calls[0][0]);
    // Breaks if the comment names shortcutLakehouseId ('-- 4-part name: lh-1.sales.orders').
    expect(sql.split('\n')[0]).toBe(`-- 4-part name: ${NAME}.sales.orders`);
    // Positive: the template still reads the table from the active container.
    // Breaks if the edit also replaced the storage path with the name.
    expect(sql).toContain(`/${CONTAINER}/Tables/sales/orders'`);
  });
});

function wizardCtx() {
  const noop = vi.fn();
  return {
    scWizardOpen: true, setScWizardOpen: noop, scStep: 1, setScStep: noop,
    scType: 'internal', setScType: noop,
    scAdlsMode: 'picker', setScAdlsMode: noop,
    scAcctHost: '', setScAcctHost: noop, storageAccts: [], storageAcctsLoading: false,
    scAdlsContainer: '', setScAdlsContainer: noop, scAdlsPath: '', setScAdlsPath: noop,
    scInternalContainer: '', setScInternalContainer: noop, scInternalPath: '', setScInternalPath: noop, containers: [],
    scTargetUri: '', setScTargetUri: noop,
    scExtSas: '', setScExtSas: noop, scExtSasBusy: false, scExtSasErr: null, stashExternalSas: noop,
    scKvSecret: '', setScKvSecret: noop,
    extCreds: {}, setExtCreds: noop,
    scSpSelection: null, setScSpSelection: noop,
    scKind: 'files', setScKind: noop,
    scParentPath: '', setScParentPath: noop,
    scName: '', setScName: noop,
    scFormat: 'delta', setScFormat: noop,
    scTargetSchema: 'dbo', setScTargetSchema: noop,
    scSubmitError: null, scSubmitting: false, submitShortcut: noop,
    schemas: [], schemasEnabled: false,
  };
}

describe('Shortcut wizard: step 1 names the lakehouse', () => {
  it('the caption names the lakehouse, not its item id', async () => {
    mount(<ShortcutWizardDialog />, wizardCtx());
    const caption = await screen.findByText(/Choose the source to virtualize into/);
    // Breaks if the caption renders shortcutLakehouseId ('lh-1').
    expect(caption.querySelector('strong')?.textContent).toBe(NAME);
  });
});
