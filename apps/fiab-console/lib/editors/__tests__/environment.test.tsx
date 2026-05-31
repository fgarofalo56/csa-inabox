/**
 * EnvironmentEditor — vitest render + interaction.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { EnvironmentEditor } from '../phase2-misc-editors';
import { makeItem, installFetchMock } from './test-helpers';

describe('EnvironmentEditor', () => {
  beforeEach(() => {
    installFetchMock({
      '/api/items/synapse-spark-pool/list': () => ({
        ok: true,
        pools: [{ name: 'pool-fixture', state: 'Online' }],
      }),
      '/api/items/environment/env-1': () => ({
        ok: true,
        item: {
          id: 'env-1',
          workspaceId: 'ws-1',
          displayName: 'env-fixture',
          state: { requirements: 'pandas==2.0.0', conf: {}, jars: [] },
        },
      }),
    });
  });
  // vitest.config.ts sets globals:false, so RTL does not auto-register
  // afterEach(cleanup). Without an explicit cleanup the first render's DOM
  // tree stays mounted, so the second test sees two [data-testid="ribbon"]
  // nodes and getByTestId throws "Found multiple elements". Unmount here.
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('renders editor chrome', async () => {
    render(<EnvironmentEditor item={makeItem('environment', 'Environment')} id="env-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('chrome')).toBeInTheDocument();
    });
  });

  it('exposes ribbon actions', async () => {
    render(<EnvironmentEditor item={makeItem('environment', 'Environment')} id="env-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('ribbon').querySelectorAll('button').length).toBeGreaterThan(0);
    });
  });
});
