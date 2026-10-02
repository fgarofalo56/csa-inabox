/**
 * Lakehouse editor, read-only role: the write controls say why they are closed.
 *
 * `/api/lakehouse/access` answers `canWrite` with the same decision the routes
 * apply. When it is `false` the editor shows a read-only banner and the
 * controls that would write (upload, new folder, new shortcut, load to table,
 * maintain, delete) stay focusable but inert, titled with the reason. When it
 * is `true`, or the probe fails (unknown), the same controls stay open -- the
 * route still decides.
 *
 * What breaks each case is named at the assertion.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup, fireEvent, act } from '@testing-library/react';
import { renderWithProviders, installFetchMock, makeItem } from '../../__tests__/test-helpers';
import { LakehouseEditor } from '../lakehouse-editor-shell';
import { LAKEHOUSE_READ_ONLY_TITLE } from '../hooks/use-lakehouse-access';

// The global chrome stub (vitest.setup.ts) flattens the ribbon to top-level
// buttons and drops dropdown items and titles. This file needs both, so it
// captures the ribbon the shell hands the chrome and reads the actions as data.
const chrome = vi.hoisted(() => ({ ribbon: [] as any[] }));
vi.mock('@/lib/editors/item-editor-chrome', () => ({
  ItemEditorChrome: ({ ribbon, leftPanel, main }: any) => {
    chrome.ribbon = ribbon || [];
    return <div>{leftPanel}<main>{main}</main></div>;
  },
}));

type Action = { label: string; disabled?: boolean; title?: string; onClick?: unknown; dropdownItems?: Action[] };

/** A ribbon action (or a dropdown entry) by label, from the latest render. */
function ribbonAction(label: string): Action {
  for (const tab of chrome.ribbon) {
    for (const g of tab.groups || []) {
      for (const a of (g.actions || []) as Action[]) {
        if (a.label === label) return a;
        for (const mi of a.dropdownItems || []) if (mi.label === label) return mi;
      }
    }
  }
  throw new Error(`no ribbon action "${label}"`);
}

const ROOT = 'lakehouses/Contoso Sales';

const ITEM = {
  id: 'lh-ro', workspaceId: 'ws-1', itemType: 'lakehouse', displayName: 'Contoso Sales',
  state: { provisioning: { status: 'created', secondaryIds: { container: 'landing', rootPath: ROOT } } },
};

const PATHS = {
  ok: true,
  paths: [
    { name: `${ROOT}/Files`, isDirectory: true, size: 0 },
    { name: `${ROOT}/orders.csv`, isDirectory: false, size: 12 },
  ],
};

function mount(access: () => unknown) {
  const mock = installFetchMock({
    '/api/lakehouse/containers': () => ({
      ok: true,
      containers: [{ name: 'bronze', url: 'u' }, { name: 'landing', url: 'u' }],
    }),
    '/api/lakehouse/paths': () => PATHS,
    '/api/lakehouse/access': access,
    '/api/cosmos-items/lakehouse/lh-ro': () => ITEM,
  });
  renderWithProviders(<LakehouseEditor item={makeItem('lakehouse', 'Lakehouse')} id="lh-ro" />);
  return mock;
}

/** The Files-pane "Upload file" button. */
async function uploadButton() {
  return screen.findByRole('button', { name: /^Upload file$/ }, { timeout: 5000 });
}

/**
 * canWrite is null while the probe is in flight, which already leaves every
 * control OPEN -- so an "it stays open" assertion must be read after the
 * answer has rendered, or it passes on the loading render alone.
 */
async function probeSettled(calls: Array<{ url: string }>) {
  await waitFor(() => expect(calls.some((c) => c.url.includes('/api/lakehouse/access?lakehouseId=lh-ro'))).toBe(true));
  await new Promise((r) => setTimeout(r, 200));
}

/** The Files table row for a file, by text (the explorer tree shows the same name). */
async function fileRow(name: string): Promise<HTMLElement> {
  let row: HTMLElement | null = null;
  await waitFor(() => {
    row = screen.getAllByText(name).map((el) => el.closest('tr') as HTMLElement | null).find(Boolean) ?? null;
    expect(row).not.toBeNull();
  }, { timeout: 5000 });
  return row!;
}

const WRITE_ENTRIES = ['Upload', 'Upload folder', 'New folder', 'New shortcut', 'Load to table', 'Maintain…'];

// Selecting a file writes ?tab=preview&container=..&path=.. into the URL, and the
// next mount restores that deep link -- so without this reset a later test
// opens on the Preview tab and never renders the Files table.
afterEach(() => { cleanup(); vi.restoreAllMocks(); chrome.ribbon = []; window.history.replaceState(null, '', '/'); });

describe('Lakehouse editor — read-only role', () => {
  it('shows the read-only banner and closes the Files write buttons with the reason', async () => {
    mount(() => ({ ok: true, lakehouseId: 'lh-ro', canWrite: false }));

    // Breaks if the shell ignores canWrite=false (no banner rendered).
    const banner = await screen.findByTestId('lakehouse-read-only', {}, { timeout: 5000 });
    expect(banner.textContent).toContain(LAKEHOUSE_READ_ONLY_TITLE);
    expect(banner.textContent).toContain('Browsing, preview, query and download still work.');

    // Breaks if the Files-pane Upload / New folder buttons are not gated.
    const upload = await uploadButton();
    await waitFor(() => expect(upload.getAttribute('aria-disabled')).toBe('true'));
    expect(upload.getAttribute('title')).toBe(LAKEHOUSE_READ_ONLY_TITLE);
    const newFolder = screen.getByRole('button', { name: /^New folder$/ });
    expect(newFolder.getAttribute('aria-disabled')).toBe('true');
    expect(newFolder.getAttribute('title')).toBe(LAKEHOUSE_READ_ONLY_TITLE);
    // Breaks if the Upload folder button drops disabledFocusable={readOnly}.
    const uploadFolder = screen.getByRole('button', { name: /^Upload folder$/ });
    expect(uploadFolder.getAttribute('aria-disabled')).toBe('true');
    expect(uploadFolder.getAttribute('title')).toBe(LAKEHOUSE_READ_ONLY_TITLE);
    // disabledFocusable, not disabled: the reason stays reachable by keyboard.
    expect(upload.hasAttribute('disabled')).toBe(false);
  });

  it('closes the ribbon\'s write entries with the reason and leaves the read ones open', async () => {
    mount(() => ({ ok: true, lakehouseId: 'lh-ro', canWrite: false }));
    await screen.findByTestId('lakehouse-read-only', {}, { timeout: 5000 });
    // Breaks if any of these still reads writeBlocked alone (open, no title).
    for (const label of WRITE_ENTRIES) {
      const a = ribbonAction(label);
      expect(a.disabled, label).toBe(true);
      expect(a.onClick, label).toBeUndefined();
      expect(a.title, label).toBe(LAKEHOUSE_READ_ONLY_TITLE);
    }
    // Positive: reading and navigating stay open. Breaks if the gate is applied
    // to the whole ribbon. Settings opens so the values can be read; its Save is
    // what closes (settings-dialog).
    for (const label of ['Refresh', 'Settings', 'New notebook', 'SQL endpoint']) {
      expect(ribbonAction(label).disabled, label).toBeFalsy();
    }
  });

  it('leaves everything open, with no banner, when canWrite is true', async () => {
    const { calls } = mount(() => ({ ok: true, lakehouseId: 'lh-ro', canWrite: true }));
    const upload = await uploadButton();
    await probeSettled(calls);
    // Breaks if the gate treats true as read-only.
    expect(screen.queryByTestId('lakehouse-read-only')).toBeNull();
    expect(upload.getAttribute('aria-disabled')).not.toBe('true');
    expect(upload.getAttribute('title')).not.toBe(LAKEHOUSE_READ_ONLY_TITLE);
    for (const label of ['Upload', 'Upload folder', 'New folder', 'New shortcut']) {
      expect(ribbonAction(label).disabled, label).toBe(false);
      expect(ribbonAction(label).title, label).not.toBe(LAKEHOUSE_READ_ONLY_TITLE);
    }
  });

  it('leaves everything open when the access probe fails (unknown is not read-only)', async () => {
    const { calls } = mount(() => ({ ok: false, error: 'unavailable' }));
    const upload = await uploadButton();
    await probeSettled(calls);
    // Breaks if a failed probe is read as canWrite=false.
    expect(screen.queryByTestId('lakehouse-read-only')).toBeNull();
    expect(upload.getAttribute('aria-disabled')).not.toBe('true');
    expect(ribbonAction('Upload folder').disabled).toBe(false);
  });

  // Kept LAST on purpose: opening a Fluent Menu leaves the page marked aria-hidden
  // after cleanup, so a role query in any later test in this file finds nothing.
  it('closes the file row\'s Load to Tables and Delete, and leaves Download open', async () => {
    mount(() => ({ ok: true, lakehouseId: 'lh-ro', canWrite: false }));
    await screen.findByTestId('lakehouse-read-only', {}, { timeout: 5000 });

    fireEvent.click(await screen.findByRole('button', { name: 'Actions for orders.csv' }, { timeout: 5000 }));
    const load = await screen.findByRole('menuitem', { name: /Load to Tables \(Delta\)/ });
    // Breaks if the row menu's write items are not gated.
    expect(load.getAttribute('aria-disabled')).toBe('true');
    expect(load.getAttribute('title')).toBe(LAKEHOUSE_READ_ONLY_TITLE);
    const del = screen.getByRole('menuitem', { name: /^Delete$/ });
    expect(del.getAttribute('aria-disabled')).toBe('true');
    // Positive: a read action in the same menu is untouched. Breaks if the gate
    // is applied to the whole menu instead of the write items.
    const download = screen.getByRole('menuitem', { name: /^Download$/ });
    expect(download.getAttribute('aria-disabled')).not.toBe('true');
  });

  // After the menu test for the same reason; reads by text, which aria-hidden
  // does not affect. Settings OPENS for a read-only role (the values can be
  // read); only Save closes.
  it('opens Settings read-only: Save closes with the reason and does not PUT', async () => {
    const { calls } = mount(() => ({ ok: true, lakehouseId: 'lh-ro', canWrite: false }));
    await screen.findByText('Read-only access', {}, { timeout: 5000 });
    await act(async () => { (ribbonAction('Settings').onClick as () => void)(); });
    const save = (await screen.findByText('Save settings', {}, { timeout: 5000 })).closest('button') as HTMLElement;
    // Breaks if the Save button drops disabledFocusable={readOnly}.
    expect(save.getAttribute('aria-disabled')).toBe('true');
    expect(save.getAttribute('title')).toBe(LAKEHOUSE_READ_ONLY_TITLE);
    fireEvent.click(save);
    await new Promise((r) => setTimeout(r, 50));
    // Breaks if the click still reaches saveSettings (a PUT to the settings route).
    expect(calls.some((c) => c.url.includes('/api/lakehouse/settings') && c.init?.method === 'PUT')).toBe(false);
  });

  it('with canWrite=true Save is open and PUTs the settings', async () => {
    const { calls } = mount(() => ({ ok: true, lakehouseId: 'lh-ro', canWrite: true }));
    await probeSettled(calls);
    await act(async () => { (ribbonAction('Settings').onClick as () => void)(); });
    const save = (await screen.findByText('Save settings', {}, { timeout: 5000 })).closest('button') as HTMLElement;
    await waitFor(() => expect(save.getAttribute('aria-disabled')).not.toBe('true'));
    fireEvent.click(save);
    // Breaks if canWrite=true is read as read-only (no PUT would be sent).
    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/lakehouse/settings') && c.init?.method === 'PUT')).toBe(true));
  });
  // The ribbon test above reads Load to table with no file selected, where
  // `!hasFile` already closes it -- so it cannot see the read-only gate on that
  // entry (dropping `|| readOnly` left it green). These two select a file first,
  // and read Preview (gated on the selection alone) to prove the selection took.
  // Selecting a file changes the URL; the afterEach reset above keeps that from
  // reaching the next test.
  it('keeps Load to table closed for a read-only role with a file selected', async () => {
    mount(() => ({ ok: true, lakehouseId: 'lh-ro', canWrite: false }));
    await screen.findByTestId('lakehouse-read-only', {}, { timeout: 5000 });
    fireEvent.click(await fileRow('orders.csv'));
    // Fixture witness: breaks if the click did not select the file.
    await waitFor(() => expect(ribbonAction('Preview').disabled).toBe(false));
    // Breaks if Load to table reads `!hasFile` alone.
    expect(ribbonAction('Load to table').disabled).toBe(true);
    expect(ribbonAction('Load to table').onClick).toBeUndefined();
    expect(ribbonAction('Load to table').title).toBe(LAKEHOUSE_READ_ONLY_TITLE);
  });

  it('opens Load to table for a writer with a file selected', async () => {
    const { calls } = mount(() => ({ ok: true, lakehouseId: 'lh-ro', canWrite: true }));
    await probeSettled(calls);
    fireEvent.click(await fileRow('orders.csv'));
    await waitFor(() => expect(ribbonAction('Preview').disabled).toBe(false));
    // Breaks if the gate closes Load to table for a writer too (e.g. `|| true`).
    expect(ribbonAction('Load to table').disabled).toBe(false);
    expect(typeof ribbonAction('Load to table').onClick).toBe('function');
  });
});
