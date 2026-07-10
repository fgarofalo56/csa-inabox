/**
 * LakehouseShortcutEditor — vitest render + UX-baseline (SC-4/SC-6/SC-9) checks.
 *
 * Verifies the editor mounts, exposes its ribbon actions, renders the SC-6
 * teaching banner, and shows the SC-4 guided empty-state launcher (with real
 * per-source cards) once a workspace with zero shortcuts is selected.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { LakehouseShortcutEditor } from '../lakehouse-shortcut-editor';
import { makeItem, installFetchMock } from './test-helpers';

describe('LakehouseShortcutEditor', () => {
  beforeEach(() => {
    installFetchMock({
      '/api/loom/workspaces': () => ({ ok: true, workspaces: [{ id: 'ws-1', name: 'workspace-fixture' }] }),
      '/api/items/lakehouse-shortcut': () => ({ ok: true, shortcuts: [], adlsConfigured: true, kvConfigured: true }),
    });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('renders editor chrome and the teaching banner', async () => {
    render(<LakehouseShortcutEditor item={makeItem('lakehouse-shortcut', 'Lakehouse shortcut')} id="new" />);
    await waitFor(() => { expect(screen.getByTestId('chrome')).toBeInTheDocument(); });
    // SC-6 teaching banner keyed per surface.
    expect(document.querySelector('[data-teaching-banner="lakehouse-shortcut-inplace"]')).toBeTruthy();
  });

  it('exposes ribbon actions', async () => {
    render(<LakehouseShortcutEditor item={makeItem('lakehouse-shortcut', 'Lakehouse shortcut')} id="new" />);
    await waitFor(() => {
      const buttons = screen.getByTestId('ribbon').querySelectorAll('button');
      expect(buttons.length).toBeGreaterThanOrEqual(2);
    });
    const labels = Array.from(screen.getByTestId('ribbon').querySelectorAll('button')).map(b => b.getAttribute('aria-label'));
    expect(labels).toEqual(expect.arrayContaining(['New shortcut', 'Refresh']));
  });

  it('renders the SC-4 guided empty state with per-source launcher cards', async () => {
    render(<LakehouseShortcutEditor item={makeItem('lakehouse-shortcut', 'Lakehouse shortcut')} id="new" />);
    // Select the fixture workspace so the (empty) shortcut list loads.
    const select = await screen.findByRole('combobox');
    fireEvent.change(select, { target: { value: 'ws-1' } });
    await waitFor(() => {
      expect(document.querySelector('[data-guided-empty-state]')).toBeTruthy();
    });
    // Each launcher card is a real, keyboarded action tile.
    expect(document.querySelector('[data-launch-card="internal"]')).toBeTruthy();
    expect(document.querySelector('[data-launch-card="adls"]')).toBeTruthy();
    expect(document.querySelector('[data-launch-card="dataverse"]')).toBeTruthy();
  });
});
