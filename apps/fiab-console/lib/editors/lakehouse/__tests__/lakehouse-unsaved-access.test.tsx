/**
 * Lakehouse editor, unsaved item (`id === 'new'`): Permissions and Share are closed.
 *
 * The permissions reads are authorized against the lakehouse item, and an
 * unsaved lakehouse has no item yet, so a read would name `new` and answer
 * "not found" for everyone. The ribbon closes both actions with a "save first"
 * title, and the permissions hook reads nothing without a saved id.
 *
 * What breaks each case is named at the assertion.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup, act } from '@testing-library/react';
import { renderWithProviders, installFetchMock, makeItem } from '../../__tests__/test-helpers';
import { LakehouseEditor } from '../lakehouse-editor-shell';
import { LAKEHOUSE_SAVE_FIRST_TITLE } from '../lakehouse-ribbon';

const cap = vi.hoisted(() => ({ ribbon: [] as any[], ctx: null as any }));
vi.mock('@/lib/editors/item-editor-chrome', () => ({
  ItemEditorChrome: ({ ribbon, leftPanel, main }: any) => {
    cap.ribbon = ribbon || [];
    return <div>{leftPanel}<main>{main}</main></div>;
  },
}));
vi.mock('@/lib/editors/lakehouse/panes/files-pane', async () => {
  const { useLakehouseCtx } = await import('@/lib/editors/lakehouse/lakehouse-editor-context');
  return {
    FilesPane: () => { cap.ctx = useLakehouseCtx(); return <div data-testid="files-capture" />; },
  };
});

type Action = { label: string; disabled?: boolean; title?: string; onClick?: unknown };

function ribbonAction(label: string): Action {
  for (const tab of cap.ribbon) {
    for (const g of tab.groups || []) {
      for (const a of (g.actions || []) as Action[]) if (a.label === label) return a;
    }
  }
  throw new Error(`no ribbon action "${label}"`);
}

const ITEM = {
  id: 'lh-s', workspaceId: 'ws-1', itemType: 'lakehouse', displayName: 'Contoso Sales',
  state: { provisioning: { status: 'created', secondaryIds: { container: 'landing', rootPath: 'lakehouses/Contoso Sales' } } },
};

function mount(id: string) {
  const mock = installFetchMock({
    '/api/lakehouse/containers': () => ({ ok: true, containers: [{ name: 'landing', url: 'u' }] }),
    '/api/lakehouse/paths': () => ({ ok: true, paths: [] }),
    '/api/lakehouse/access': () => ({ ok: true, lakehouseId: id, canWrite: true }),
    '/api/lakehouse/permissions': () => ({ ok: true, assignments: [], knownRoles: [] }),
    '/api/cosmos-items/lakehouse/lh-s': () => ITEM,
  });
  renderWithProviders(<LakehouseEditor item={makeItem('lakehouse', 'Lakehouse')} id={id} />);
  return mock;
}

async function containerResolved() {
  await screen.findByTestId('files-capture', {}, { timeout: 5000 });
  // Fixture witness: a container is selected, so "Select a container first" is
  // not what closes the actions below.
  await waitFor(() => expect(cap.ctx?.activeContainer).toBe('landing'), { timeout: 5000 });
}

const permissionReads = (calls: Array<{ url: string }>) => calls.filter((c) => c.url.includes('/api/lakehouse/permissions'));

afterEach(() => { cleanup(); vi.restoreAllMocks(); cap.ribbon = []; cap.ctx = null; window.history.replaceState(null, '', '/'); });

describe('lakehouse editor: unsaved item', () => {
  it('closes Permissions and Share with the save-first reason', async () => {
    mount('new');
    await containerResolved();
    for (const label of ['Permissions', 'Share']) {
      const a = ribbonAction(label);
      // Breaks if the ribbon gates these on the container alone (the code before
      // this change): with 'landing' selected they would be open, with an onClick.
      expect([a.disabled, a.onClick, a.title], label).toEqual([true, undefined, LAKEHOUSE_SAVE_FIRST_TITLE]);
    }
  });

  it('opening permissions directly sends no permissions read', async () => {
    const { calls } = mount('new');
    await containerResolved();
    await act(async () => { cap.ctx.openPerms(); });
    await new Promise((r) => setTimeout(r, 100));
    // Breaks if the hook's openPerms loses its saved-id check (it would read with
    // lakehouseId ''), or if the shell hands the hook `id` for an unsaved item
    // (it would read with lakehouseId 'new').
    expect(permissionReads(calls)).toEqual([]);
    expect(cap.ctx.permsOpen).toBe(false);
  });

  it('a saved lakehouse: Permissions and Share are open, and Permissions reads (positive arm)', async () => {
    const { calls } = mount('lh-s');
    await containerResolved();
    for (const label of ['Permissions', 'Share']) {
      const a = ribbonAction(label);
      // Breaks if the save-first gate also closes a saved item.
      expect([a.disabled, typeof a.onClick, a.title], label).toEqual([false, 'function', undefined]);
    }
    await act(async () => { (ribbonAction('Permissions').onClick as () => void)(); });
    // Breaks if openPerms no longer reads for a saved item; then the empty list
    // above would prove nothing.
    await waitFor(() => expect(permissionReads(calls).map((c) => new URL(c.url, 'http://x').searchParams.get('lakehouseId'))).toEqual(['lh-s']));
    expect(cap.ctx.permsOpen).toBe(true);
  });
});
