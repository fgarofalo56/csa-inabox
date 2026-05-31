/**
 * AirflowJobEditor — vitest render + ribbon assertion.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { AirflowJobEditor } from '../airflow-job-editor';
import { makeItem, installFetchMock } from './test-helpers';

describe('AirflowJobEditor', () => {
  beforeEach(() => {
    installFetchMock({
      '/api/loom/workspaces': () => ({ ok: true, workspaces: [{ id: 'ws-1', name: 'workspace-fixture' }] }),
      '/api/items/airflow-job': () => ({
        ok: true,
        workspaceId: 'ws-1',
        jobs: [{ id: 'air-1', displayName: 'ml-ingest', webserverUrl: null, gitRepo: null }],
      }),
    });
  });
  // globals:false in vitest.config means @testing-library's auto-afterEach
  // cleanup never registers, so each render() would otherwise pile up in the
  // same jsdom document.body — making getByTestId('ribbon') find duplicates.
  // Unmount explicitly between tests.
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('renders editor chrome', async () => {
    render(<AirflowJobEditor item={makeItem('airflow-job', 'Apache Airflow job')} id="new" />);
    await waitFor(() => { expect(screen.getByTestId('chrome')).toBeInTheDocument(); });
  });

  it('exposes ribbon actions', async () => {
    render(<AirflowJobEditor item={makeItem('airflow-job', 'Apache Airflow job')} id="new" />);
    await waitFor(() => {
      const buttons = screen.getByTestId('ribbon').querySelectorAll('button');
      expect(buttons.length).toBeGreaterThanOrEqual(2);
    });
    // Assert the actual current ribbon surface: the editor builds Job
    // (New job / Refresh), DAGs (Refresh DAGs), and View (DAGs/Runs/Connections)
    // groups. Scope to the ribbon element because the editor also renders
    // some of these labels in the main toolbar / tab strip.
    const ribbon = screen.getByTestId('ribbon');
    const labels = Array.from(ribbon.querySelectorAll('button')).map(
      b => b.getAttribute('aria-label'),
    );
    expect(labels).toEqual(
      expect.arrayContaining(['New job', 'Refresh', 'Refresh DAGs', 'DAGs', 'Runs', 'Connections']),
    );
  });
});
