/**
 * ActivatorEditor — vitest render + interaction.
 *
 * Mounts the editor with mocked /api/loom/workspaces + /api/items/activator
 * responses and confirms:
 *   - workspace fetch fires on mount (Loom workspaces, not Power BI groups)
 *   - the workspace picker renders
 *   - the "New reflex" primary button is present (disabled until a workspace
 *     is selected — the editor doesn't auto-pick)
 *   - reflex list fetch fires once the user selects a workspace
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within, cleanup } from '@testing-library/react';
import { ActivatorEditor } from '../phase3-editors';
import { makeItem, installFetchMock } from './test-helpers';

describe('ActivatorEditor', () => {
  let calls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    const m = installFetchMock({
      '/api/loom/workspaces': () => ({
        ok: true,
        workspaces: [{ id: 'ws-1', name: 'Default Workspace' }],
      }),
      '/api/items/activator?workspaceId=': () => ({
        ok: true,
        activators: [
          { id: 'reflex-1', displayName: 'Orders SLA' },
          { id: 'reflex-2', displayName: 'IoT temperature' },
        ],
      }),
      '/api/items/activator/reflex-1/rules': () => ({
        ok: true,
        rules: [{ id: 'r-1', name: 'Alert on overdue', state: 'Active' }],
      }),
    });
    calls = m.calls;
  });

  // vitest.config has globals:false, so @testing-library/react does NOT
  // auto-register afterEach(cleanup). Without this each render() left its tree
  // mounted in document.body, so by the 2nd/3rd test there were multiple
  // editor copies — getByText/getByRole then threw "found multiple elements".
  // Unmount explicitly so every test asserts against a single fresh tree.
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('fetches Loom workspaces on mount + renders the picker', async () => {
    render(<ActivatorEditor item={makeItem('activator', 'Activator')} id="act-fixture" />);
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/api/loom/workspaces'))).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByText(/Activator \(Reflex\)/i)).toBeInTheDocument();
    });
  });

  it('exposes a "New reflex" primary button (the editor renders it disabled until a workspace is chosen)', async () => {
    render(<ActivatorEditor item={makeItem('activator', 'Activator')} id="act-fixture" />);
    await waitFor(() => expect(screen.getByText(/Activator \(Reflex\)/i)).toBeInTheDocument());
    const btns = screen.getAllByRole('button', { name: /New reflex/i });
    expect(btns.length).toBeGreaterThan(0);
  });

  it('loads reflexes after a workspace is selected', async () => {
    const { container } = render(<ActivatorEditor item={makeItem('activator', 'Activator')} id="act-fixture" />);
    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/loom/workspaces'))).toBe(true));
    // Pick the workspace by changing the WorkspacePicker's Select value. Scope
    // to this render's container so the query is unambiguous.
    const select = within(container).getByRole('combobox');
    fireEvent.change(select, { target: { value: 'ws-1' } });
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/api/items/activator?workspaceId=ws-1'))).toBe(true);
    });
  });
});
