/**
 * Lakehouse editor shell: the handlers the shell hands its panes.
 *
 * The pane tests render each pane over a stub context, so they cannot see what
 * the SHELL puts in that context. This file mounts the real shell, replaces the
 * Files pane with a pane that captures the context, and calls the shell's own
 * handlers: drag-and-drop upload, F6, Load to Tables, the upload error text,
 * the Maintain dialog's column list, the permissions reads (the hook and the
 * dialog's predicate editor both name this lakehouse), and the reference
 * tree's empty-level note.
 *
 * What breaks each case is named at the assertion.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup, fireEvent, act } from '@testing-library/react';
import { renderWithProviders, installFetchMock, makeItem } from '../../__tests__/test-helpers';
import { LakehouseEditor } from '../lakehouse-editor-shell';
import { LAKEHOUSE_READ_ONLY_TITLE } from '../hooks/use-lakehouse-access';

const cap = vi.hoisted(() => ({ ctx: null as any }));

vi.mock('@/lib/editors/item-editor-chrome', () => ({
  ItemEditorChrome: ({ leftPanel, main }: any) => <div>{leftPanel}<main>{main}</main></div>,
}));
vi.mock('@/lib/editors/lakehouse/panes/files-pane', async () => {
  const { useLakehouseCtx } = await import('@/lib/editors/lakehouse/lakehouse-editor-context');
  return {
    FilesPane: () => { cap.ctx = useLakehouseCtx(); return <div data-testid="files-capture" />; },
  };
});
// The wizard's own dialog is tested elsewhere; here only "did the shell open it".
vi.mock('@/lib/editors/components/load-to-table-wizard', () => ({
  LoadToTableWizard: ({ open, path }: any) => (open ? <div data-testid="ltt-open">{path}</div> : null),
}));
// The permissions dialog's RLS predicate editor renders Monaco; a textarea is enough here.
vi.mock('@/lib/components/editor/monaco-textarea', () => ({
  MonacoTextarea: () => <textarea aria-label="predicate" />,
}));

const ROOT = 'lakehouses/Contoso Sales';
const FILE = { name: `${ROOT}/orders.csv`, isDirectory: false, size: 12 };
const NOTE = 'This lakehouse stores its files in the landing container.';

// Two bundle tables share the leaf name `orders`; only the schema tells them apart.
const ITEM = {
  id: 'lh-h', workspaceId: 'ws-1', itemType: 'lakehouse', displayName: 'Contoso Sales',
  state: {
    provisioning: { status: 'created', secondaryIds: { container: 'landing', rootPath: ROOT } },
    content: {
      kind: 'lakehouse', folders: [],
      deltaTables: [
        { name: 'orders', ddl: 'CREATE TABLE orders (order_id INT)' },
        { name: 'orders', schema: 'sales', ddl: 'CREATE TABLE orders (id INT, region STRING)' },
      ],
    },
  },
};

type Handler = (url: string, init?: RequestInit) => unknown;

function mount(canWrite: boolean, extra: Record<string, Handler> = {}) {
  const mock = installFetchMock({
    '/api/lakehouse/containers': () => ({ ok: true, containers: [{ name: 'landing', url: 'u' }] }),
    '/api/lakehouse/paths': () => ({ ok: true, paths: [FILE] }),
    '/api/lakehouse/access': () => ({ ok: true, lakehouseId: 'lh-h', canWrite }),
    '/api/cosmos-items/lakehouse/lh-h': () => ITEM,
    ...extra,
  });
  renderWithProviders(<LakehouseEditor item={makeItem('lakehouse', 'Lakehouse')} id="lh-h" />);
  return mock;
}

/** Wait until the access answer has rendered (the banner shows, or a writer's probe settled). */
async function settled(canWrite: boolean, calls: Array<{ url: string }>) {
  await screen.findByTestId('files-capture', {}, { timeout: 5000 });
  if (!canWrite) {
    await screen.findByTestId('lakehouse-read-only', {}, { timeout: 5000 });
  } else {
    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/lakehouse/access?lakehouseId=lh-h'))).toBe(true));
    await new Promise((r) => setTimeout(r, 200));
  }
  // Fixture witness: the container resolved, which every handler below needs.
  await waitFor(() => expect(cap.ctx?.activeContainer).toBe('landing'));
}

function dropEvent() {
  const file = new File(['a,b\n1,2\n'], 'drop.csv', { type: 'text/csv' });
  return { preventDefault() {}, dataTransfer: { items: [], files: [file] } } as any;
}

const uploadPosts = (calls: Array<{ url: string; init?: RequestInit }>) =>
  calls.filter((c) => c.url.includes('/api/lakehouse/upload') && c.init?.method === 'POST');

afterEach(() => { cleanup(); vi.restoreAllMocks(); cap.ctx = null; window.history.replaceState(null, '', '/'); });

describe('lakehouse shell: drag-and-drop upload', () => {
  it('a read-only role: the drop sends no upload and says why', async () => {
    const { calls } = mount(false);
    await settled(false, calls);
    await act(async () => { await cap.ctx.onDrop(dropEvent()); });
    // Breaks if onDrop loses its read-only term: the drop would POST the file.
    expect(uploadPosts(calls)).toEqual([]);
    expect(cap.ctx.actionError).toBe(LAKEHOUSE_READ_ONLY_TITLE);
  });

  it('a writer: the same drop uploads the file (positive arm)', async () => {
    const { calls } = mount(true);
    await settled(true, calls);
    await act(async () => { await cap.ctx.onDrop(dropEvent()); });
    // Breaks if the gate also closes the drop for a writer, or the event shape
    // above no longer reaches uploadItems (then the read-only arm proves nothing).
    const posts = uploadPosts(calls);
    expect(posts.length).toBe(1);
    expect((posts[0].init?.body as FormData).get('path')).toBe(`${ROOT}/drop.csv`);
  });
});

describe('lakehouse shell: Load to Tables (F6 and the handler)', () => {
  async function selected(canWrite: boolean) {
    const m = mount(canWrite);
    await settled(canWrite, m.calls);
    await act(async () => { await cap.ctx.selectFile(FILE); });
    // Fixture witness: F6 reads the selected file; breaks if the selection did not take.
    await waitFor(() => expect(cap.ctx.activePath?.name).toBe(FILE.name));
    return m;
  }

  it('a read-only role: F6 does not open the wizard', async () => {
    await selected(false);
    await act(async () => { fireEvent.keyDown(window, { key: 'F6' }); });
    await new Promise((r) => setTimeout(r, 50));
    // Breaks if the F6 handler loses its read-only term.
    expect(screen.queryByTestId('ltt-open')).toBeNull();
  });

  it('a writer: F6 opens the wizard on the selected file (positive arm)', async () => {
    await selected(true);
    await act(async () => { fireEvent.keyDown(window, { key: 'F6' }); });
    // Breaks if F6 is closed for a writer too, or the key no longer reaches the handler.
    expect((await screen.findByTestId('ltt-open')).textContent).toBe(FILE.name);
  });

  // Every control that calls onLoadToTables is closed for a read-only role
  // already (ribbon, row menu, Files button); this pins the handler's own term,
  // which is what stays if a new caller forgets its gate.
  it('a read-only role: calling onLoadToTables directly does not open the wizard', async () => {
    mount(false);
    await settled(false, []);
    await act(async () => { cap.ctx.onLoadToTables(FILE); });
    await new Promise((r) => setTimeout(r, 50));
    // Breaks if onLoadToTables loses `|| readOnly`.
    expect(screen.queryByTestId('ltt-open')).toBeNull();
  });

  it('a writer: onLoadToTables opens the wizard (positive arm)', async () => {
    const { calls } = mount(true);
    await settled(true, calls);
    await act(async () => { cap.ctx.onLoadToTables(FILE); });
    expect((await screen.findByTestId('ltt-open')).textContent).toBe(FILE.name);
  });
});

describe('lakehouse shell: upload error text', () => {
  it('a refused upload returns the route error AND its remediation', async () => {
    const { calls } = mount(true, {
      '/api/lakehouse/upload': () => ({ ok: false, error: 'Upload refused.', remediation: 'Ask for Edit.' }),
    });
    await settled(true, calls);
    let err: string | null = null;
    await act(async () => { err = await cap.ctx.uploadOne(`${ROOT}/x.csv`, new File(['x'], 'x.csv')); });
    // Breaks if uploadOne drops `j.remediation` ('Upload refused.' alone).
    expect(err).toBe('Upload refused. Ask for Edit.');
  });
});

describe('lakehouse shell: Maintain column list', () => {
  it('follows the `<schema>/<table>` key, not the first table with that leaf name', async () => {
    const { calls } = mount(true);
    await settled(true, calls);
    await act(async () => { cap.ctx.setMaintainTable('sales/orders'); });
    // Breaks if the shell looks the table up by name only: 'sales/orders' then
    // matches no table and the list is [] (the dbo table would give ['order_id']).
    await waitFor(() => expect(cap.ctx.maintainColumns).toEqual(['id', 'region']));
    await act(async () => { cap.ctx.setMaintainTable('orders'); });
    // Positive: the bare name still finds the first bundle table.
    await waitFor(() => expect(cap.ctx.maintainColumns).toEqual(['order_id']));
  });
});

describe('lakehouse shell: permissions reads name this lakehouse', () => {
  const TABLES = [{ objectId: 7, schema: 'dbo', name: 'orders', type: 'U' }];
  const permissions: Handler = (url) => {
    const q = new URL(url, 'http://x').searchParams;
    if (q.get('list') === 'tables') return { ok: true, tables: TABLES };
    if (q.get('list') === 'columns') return { ok: true, columns: [{ columnId: 3, name: 'region', dataType: 'varchar' }] };
    return { ok: true, assignments: [], knownRoles: [], grants: [], policies: [] };
  };
  /** Query params of every permissions GET, in call order. */
  const reads = (calls: Array<{ url: string; init?: RequestInit }>) =>
    calls
      .filter((c) => c.url.includes('/api/lakehouse/permissions?') && (c.init?.method ?? 'GET') === 'GET')
      .map((c) => Object.fromEntries(new URL(c.url, 'http://x').searchParams));

  it('opening Manage permissions reads the container roles through this item', async () => {
    const { calls } = mount(true, { '/api/lakehouse/permissions': permissions });
    await settled(true, calls);
    await act(async () => { cap.ctx.openPerms(); });
    // Fixture witness: the open fired the container-role read for the bound container.
    await waitFor(() => expect(reads(calls).some((q) => q.container === 'landing')).toBe(true));
    // Breaks if the shell hands the permissions hook any id but its own
    // (e.g. `lakehouseId: ''`): every read would then carry that value.
    expect(reads(calls).map((q) => q.lakehouseId)).toEqual(reads(calls).map(() => 'lh-h'));
  });

  it("the Row tab's predicate editor reads its column list through this item", async () => {
    const { calls } = mount(true, { '/api/lakehouse/permissions': permissions });
    await settled(true, calls);
    await act(async () => { cap.ctx.openPerms(); });
    await act(async () => { cap.ctx.selectPermsTab('row'); });
    // Anchor on the editor, not the fixed RLS form above it: both have a Table
    // picker, and the fixed form's column read comes from the hook, not the dialog.
    let root: HTMLElement | null = (await screen.findByText('Custom WHERE predicate', {}, { timeout: 5000 })).parentElement;
    while (root && !root.querySelector('[role="combobox"]')) root = root.parentElement;
    const before = reads(calls).filter((q) => q.list === 'columns').length;
    const tableDd = root!.querySelector('[role="combobox"]') as HTMLElement;
    fireEvent.click(tableDd);
    fireEvent.click(await screen.findByRole('option', { name: 'dbo.orders' }));
    // Fixture witness: picking the table fired exactly the editor's column read.
    await waitFor(() => expect(reads(calls).filter((q) => q.list === 'columns').length).toBe(before + 1));
    const read = reads(calls).filter((q) => q.list === 'columns')[before];
    // Breaks if the dialog passes the editor any id but ctx.id (e.g. `lakehouseId=""`).
    expect([read.objectId, read.lakehouseId]).toEqual(['7', 'lh-h']);
  });
});

describe('lakehouse shell: reference tree', () => {
  it('an empty reference level shows the route note, not "(empty)"', async () => {
    const { calls } = mount(true, {
      '/api/lakehouse/references': () => ({
        ok: true, references: [{ id: 'ref-1', displayName: 'Contoso Raw', containers: ['bronze'], reachable: true }],
      }),
      '/api/lakehouse/references/paths': () => ({ ok: true, paths: [], note: NOTE }),
    });
    await settled(true, calls);
    fireEvent.click(await screen.findByText('Contoso Raw', {}, { timeout: 5000 }));
    fireEvent.click(await screen.findByText('bronze'));
    // Fixture witness: the level was listed through the route.
    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/lakehouse/references/paths?refId=ref-1&container=bronze'))).toBe(true));
    // Breaks if the shell stops passing `notes` to the tree ('(empty)' shows instead).
    expect(await screen.findByText(NOTE)).toBeTruthy();
    expect(screen.queryByText('(empty)')).toBeNull();
  });
});
