/**
 * MountedAdfEditor — vitest render + ribbon assertion.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MountedAdfEditor } from '../mounted-adf-editor';
import { makeItem, installFetchMock } from './test-helpers';

describe('MountedAdfEditor', () => {
  beforeEach(() => {
    installFetchMock({
      '/api/loom/workspaces': () => ({ ok: true, workspaces: [{ id: 'ws-1', name: 'workspace-fixture' }] }),
      '/api/items/mounted-adf': () => ({
        ok: true,
        workspaceId: 'ws-1',
        mounts: [{ id: 'mnt-1', displayName: 'prod-adf', subscriptionId: 'sub-1', resourceGroup: 'rg-1', factoryName: 'adf-prod' }],
      }),
    });
  });
  // globals:false in vitest.config means @testing-library's auto-afterEach
  // cleanup never registers, so each render() would otherwise pile up in the
  // same jsdom document.body — making getByTestId('ribbon') find duplicates.
  // Unmount explicitly between tests.
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('renders editor chrome', async () => {
    render(<MountedAdfEditor item={makeItem('mounted-adf', 'Mounted Data Factory')} id="new" />);
    await waitFor(() => { expect(screen.getByTestId('chrome')).toBeInTheDocument(); });
  });

  it('exposes ribbon actions', async () => {
    render(<MountedAdfEditor item={makeItem('mounted-adf', 'Mounted Data Factory')} id="new" />);
    await waitFor(() => {
      const buttons = screen.getByTestId('ribbon').querySelectorAll('button');
      expect(buttons.length).toBeGreaterThanOrEqual(2);
    });
  });
});
