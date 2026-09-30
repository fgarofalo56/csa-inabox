/**
 * Lakehouse → Shortcuts: the "Query (SQL)" action on a shortcut row.
 *
 * The SQL tab reads only the lakehouse's own storage root for a caller who is
 * not a tenant admin, and a shortcut points outside it, so the generated query
 * would be refused. The action is therefore shown disabled with its reason for
 * such a caller, and runs as before for a tenant admin.
 *
 * Each test names the change that turns it red:
 *   - reader sees a disabled item with the short reason visible and the full
 *     sentence as its title, and a click does nothing: the admin check removed
 *     (the item enabled for everyone), or either text dropped.
 *   - admin's Files shortcut item calls queryShortcut, and the Tables shortcut
 *     item writes its SELECT: the admin path disabled too.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../__tests__/test-helpers';
import { LakehouseEditorContext } from '../lakehouse-editor-context';
import type { LakehouseEditorCtx } from '../lakehouse-editor-context';
import { SessionProvider } from '@/lib/components/session-context';
import { ShortcutsPane, SHORTCUT_QUERY_ADMIN_ONLY, SHORTCUT_QUERY_ADMIN_ONLY_SUBTEXT } from '../panes/shortcuts-pane';

const FILES_ROW = {
  id: 'sc-1', lakehouseId: 'lh-1', name: 'ext_files', kind: 'files', parentPath: '', fullPath: 'Files/ext_files',
  targetType: 'adls', targetUri: 'abfss://c@other.dfs.core.windows.net/p', abfssUri: 'abfss://c@other.dfs.core.windows.net/p',
  status: 'active', createdBy: 'u', createdAt: 'now',
};
const TABLES_ROW = {
  ...FILES_ROW, id: 'sc-2', name: 'ext_table', kind: 'tables', fullPath: 'Tables/ext_table',
  engine: 'synapse', engineObject: 'loom_lakehouse.shortcuts.sc_2',
};

function mount(isTenantAdmin: boolean, row: Record<string, unknown>) {
  const queryShortcut = vi.fn();
  const setSqlText = vi.fn();
  const setTab = vi.fn();
  const ctx = {
    shortcutLakehouseId: 'lh-1', shortcuts: [row], shortcutsBusy: false, shortcutsError: null,
    loadShortcuts: () => {}, selectedShortcut: null, setSelectedShortcut: () => {},
    openShortcutWizard: () => {}, testShortcut: () => {}, deleteShortcutRow: () => {}, queryShortcut,
    bundleShortcuts: [], regBusy: null, registerBundleShortcut: () => {}, registerAllBundleShortcuts: () => {},
    setSqlText, setTab,
  } as unknown as LakehouseEditorCtx;
  renderWithProviders(
    <SessionProvider value={{ authenticated: true, user: null, isTenantAdmin, loading: false }}>
      <LakehouseEditorContext.Provider value={ctx}>
        <ShortcutsPane />
      </LakehouseEditorContext.Provider>
    </SessionProvider>,
  );
  return { queryShortcut, setSqlText, setTab };
}

async function openQueryItem(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: '…' }));
  return waitFor(() => screen.getByRole('menuitem', { name: /Query \(SQL\)/ }));
}

afterEach(() => { cleanup(); });

describe('ShortcutsPane — Query (SQL) on a shortcut', () => {
  it('is disabled with its reason for a caller who is not a tenant admin', async () => {
    const { queryShortcut, setSqlText } = mount(false, FILES_ROW);
    const item = await openQueryItem();
    expect(item.getAttribute('aria-disabled')).toBe('true');
    // Still in the focus order, so a keyboard user reaches the reason.
    expect(item.getAttribute('tabindex')).not.toBeNull();
    // The short reason is visible (part of the accessible name) and the full sentence is the title.
    expect(item.textContent).toContain(SHORTCUT_QUERY_ADMIN_ONLY_SUBTEXT);
    expect(item.getAttribute('title')).toBe(SHORTCUT_QUERY_ADMIN_ONLY);
    fireEvent.click(item);
    expect(queryShortcut).not.toHaveBeenCalled();
    expect(setSqlText).not.toHaveBeenCalled();
  });

  it('runs queryShortcut for a tenant admin on a Files shortcut', async () => {
    const { queryShortcut } = mount(true, FILES_ROW);
    const item = await openQueryItem();
    expect(item.getAttribute('aria-disabled')).not.toBe('true');
    expect(item.textContent).not.toContain(SHORTCUT_QUERY_ADMIN_ONLY_SUBTEXT);
    expect(item.getAttribute('title')).toBeNull();
    fireEvent.click(item);
    expect(queryShortcut).toHaveBeenCalledTimes(1);
  });

  it('writes the Tables shortcut SELECT for a tenant admin', async () => {
    const { setSqlText, setTab } = mount(true, TABLES_ROW);
    fireEvent.click(await openQueryItem());
    expect(setSqlText).toHaveBeenCalledWith('SELECT TOP 100 * FROM loom_lakehouse.shortcuts.sc_2;');
    expect(setTab).toHaveBeenCalledWith('sql');
  });

  it('is disabled for a Tables shortcut too when the caller is not a tenant admin', async () => {
    const { setSqlText } = mount(false, TABLES_ROW);
    const item = await openQueryItem();
    expect(item.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(item);
    expect(setSqlText).not.toHaveBeenCalled();
  });
});
