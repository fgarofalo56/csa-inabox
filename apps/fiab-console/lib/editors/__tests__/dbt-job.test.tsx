/**
 * DbtJobEditor — vitest render + interaction.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { DbtJobEditor } from '../phase2-misc-editors';
import { makeItem, installFetchMock } from './test-helpers';

describe('DbtJobEditor', () => {
  beforeEach(() => {
    installFetchMock({
      '/api/items/synapse-spark-pool/list': () => ({ ok: true, pools: [] }),
      '/api/items/dbt-job/dj-1/runs': () => ({ ok: true, runs: [] }),
      '/api/items/dbt-job/dj-1': () => ({
        ok: true,
        item: {
          id: 'dj-1',
          workspaceId: 'ws-1',
          displayName: 'dbt-fixture',
          state: { spec: { projectDir: 'analytics', dbtCommand: 'run', target: 'prod' } },
        },
      }),
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('renders editor chrome', async () => {
    render(<DbtJobEditor item={makeItem('dbt-job', 'dbt job')} id="dj-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('chrome')).toBeInTheDocument();
    });
  });

  it('exposes ribbon actions', async () => {
    render(<DbtJobEditor item={makeItem('dbt-job', 'dbt job')} id="dj-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('ribbon').querySelectorAll('button').length).toBeGreaterThan(0);
    });
  });
});
