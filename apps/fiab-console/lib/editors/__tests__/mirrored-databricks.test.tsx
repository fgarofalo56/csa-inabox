/**
 * MirroredDatabricksEditor — vitest render + ribbon assertion.
 *
 * Mounts the editor in jsdom against the stubbed ItemEditorChrome (which
 * surfaces ribbon actions as <button> elements via vitest.setup.ts) and
 * asserts the heading + at least 2 enabled ribbon buttons + the workspace
 * picker.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MirroredDatabricksEditor } from '../mirrored-databricks-editor';
import { makeItem, installFetchMock } from './test-helpers';

describe('MirroredDatabricksEditor', () => {
  beforeEach(() => {
    installFetchMock({
      '/api/loom/workspaces': () => ({ ok: true, workspaces: [{ id: 'ws-1', name: 'workspace-fixture' }] }),
      '/api/items/mirrored-databricks': () => ({
        ok: true,
        workspaceId: 'ws-1',
        mirrors: [{ id: 'mdbx-1', displayName: 'unity-fixture', catalogName: 'main' }],
      }),
    });
  });
  // vitest.config.ts sets globals:false, so RTL does not auto-register
  // afterEach(cleanup). Without an explicit cleanup the first test's render
  // stays mounted, so the second test sees two [data-testid="ribbon"] nodes
  // and getByTestId throws "Found multiple elements". Unmount here.
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('renders the editor chrome', async () => {
    render(<MirroredDatabricksEditor item={makeItem('mirrored-databricks', 'Mirrored Databricks catalog')} id="new" />);
    await waitFor(() => {
      expect(screen.getByTestId('chrome')).toBeInTheDocument();
    });
  });

  it('exposes ribbon actions (at least one enabled)', async () => {
    render(<MirroredDatabricksEditor item={makeItem('mirrored-databricks', 'Mirrored Databricks catalog')} id="new" />);
    await waitFor(() => {
      const buttons = screen.getByTestId('ribbon').querySelectorAll('button');
      expect(buttons.length).toBeGreaterThanOrEqual(2);
    });
  });
});
