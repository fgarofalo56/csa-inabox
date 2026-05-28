/**
 * AirflowJobEditor — vitest render + ribbon assertion.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
  afterEach(() => { vi.restoreAllMocks(); });

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
  });
});
