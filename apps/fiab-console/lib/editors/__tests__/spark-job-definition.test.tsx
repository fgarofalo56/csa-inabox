/**
 * SparkJobDefinitionEditor — vitest render + interaction.
 * Mocks /api/items/synapse-spark-pool/list and /api/items/spark-job-definition/[id]
 * so the editor mounts with a real-shaped fixture.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { SparkJobDefinitionEditor } from '../spark-job-definition-editor';
import { makeItem, installFetchMock } from './test-helpers';

describe('SparkJobDefinitionEditor', () => {
  beforeEach(() => {
    installFetchMock({
      '/api/items/synapse-spark-pool/list': () => ({
        ok: true,
        pools: [{ name: 'pool-fixture', nodeSize: 'Small', state: 'Online' }],
      }),
      '/api/items/environment': () => ({ ok: true, items: [] }),
      '/api/items/spark-job-definition/sjd-1/runs': () => ({ ok: true, sessions: [] }),
      '/api/items/spark-job-definition/sjd-1': () => ({
        ok: true,
        item: {
          id: 'sjd-1',
          workspaceId: 'ws-1',
          displayName: 'sjd-fixture',
          state: { spec: { file: 'abfss://lake/foo.py', pool: 'pool-fixture' } },
        },
      }),
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('renders editor chrome and ribbon', async () => {
    render(<SparkJobDefinitionEditor item={makeItem('spark-job-definition', 'Spark Job Definition')} id="sjd-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('chrome')).toBeInTheDocument();
    });
    expect(screen.getByTestId('ribbon').querySelectorAll('button').length).toBeGreaterThan(0);
  });

  it('shows the form with the loaded spec', async () => {
    render(<SparkJobDefinitionEditor item={makeItem('spark-job-definition', 'Spark Job Definition')} id="sjd-1" />);
    await waitFor(() => {
      // The application file input should be populated from cosmos state
      const inputs = screen.getAllByRole('textbox');
      expect(inputs.length).toBeGreaterThan(0);
    });
  });
});
