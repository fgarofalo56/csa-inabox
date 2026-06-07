/**
 * SparkEnvironmentEditor — vitest render + interaction.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { SparkEnvironmentEditor } from '../spark-environment-editor';
import { makeItem, installFetchMock } from './test-helpers';

describe('SparkEnvironmentEditor', () => {
  beforeEach(() => {
    installFetchMock({
      '/api/items/synapse-spark-pool/list': () => ({
        ok: true,
        pools: [{ name: 'loompool', properties: { sparkVersion: '3.5' } }],
      }),
      '/api/items/spark-environment/env-1': () => ({
        ok: true,
        item: {
          id: 'env-1',
          workspaceId: 'ws-1',
          displayName: 'env-fixture',
          state: {
            sparkVersion: '3.5',
            nodeSize: 'Small',
            autoscaleEnabled: true,
            requirementsType: 'pip',
            requirementsContent: 'pandas==2.2.2',
            customLibraries: [{ name: 'udf.whl', path: 'spark-env-libs/env-1/udf.whl', containerName: 'landing', type: 'whl' }],
            sparkProperties: { 'spark.sql.shuffle.partitions': '200' },
          },
        },
      }),
    });
  });
  // vitest.config sets globals:false → RTL does not auto-cleanup. Unmount here.
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('renders editor chrome', async () => {
    render(<SparkEnvironmentEditor item={makeItem('spark-environment', 'Spark environment')} id="env-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('chrome')).toBeInTheDocument();
    });
  });

  it('exposes ribbon actions', async () => {
    render(<SparkEnvironmentEditor item={makeItem('spark-environment', 'Spark environment')} id="env-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('ribbon').querySelectorAll('button').length).toBeGreaterThan(0);
    });
  });

  it('renders the five lifecycle tabs', async () => {
    render(<SparkEnvironmentEditor item={makeItem('spark-environment', 'Spark environment')} id="env-1" />);
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Runtime' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Compute' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Public libraries' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Custom libraries' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Spark properties' })).toBeInTheDocument();
    });
  });

  it('shows the Publish action', async () => {
    render(<SparkEnvironmentEditor item={makeItem('spark-environment', 'Spark environment')} id="env-1" />);
    await waitFor(() => {
      expect(screen.getAllByText('Publish').length).toBeGreaterThan(0);
    });
  });
});
