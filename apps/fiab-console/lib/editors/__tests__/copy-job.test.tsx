/**
 * CopyJobEditor — vitest render + interaction.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { CopyJobEditor } from '../phase2-misc-editors';
import { makeItem, installFetchMock } from './test-helpers';

describe('CopyJobEditor', () => {
  beforeEach(() => {
    installFetchMock({
      '/api/items/synapse-spark-pool/list': () => ({ ok: true, pools: [] }),
      '/api/adf/linked-services': () => ({
        ok: true,
        linkedServices: [
          { name: 'AzureBlob_src', properties: { type: 'AzureBlobStorage' } },
          { name: 'AzureSql_sink', properties: { type: 'AzureSqlDatabase' } },
        ],
      }),
      '/api/items/copy-job/cj-1/runs': () => ({ ok: true, runs: [] }),
      '/api/items/copy-job/cj-1': () => ({
        ok: true,
        item: {
          id: 'cj-1',
          workspaceId: 'ws-1',
          displayName: 'copy-fixture',
          state: {
            spec: {
              source: { linkedService: 'AzureBlob_src', folderPath: 'in/' },
              sink: { linkedService: 'AzureSql_sink', tableName: 'dbo.target' },
            },
          },
        },
      }),
    });
  });
  // vitest runs with globals:false, so React Testing Library's automatic
  // afterEach(cleanup) is never registered. Without an explicit cleanup the
  // first test's mounted tree persists into the next test, so the second
  // render leaves two <CopyJobEditor> trees in the DOM — getByTestId('ribbon')
  // then throws "Found multiple elements" and the waitFor times out. Unmount
  // explicitly so each test starts from a clean DOM.
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('renders editor chrome', async () => {
    render(<CopyJobEditor item={makeItem('copy-job', 'Copy Job')} id="cj-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('chrome')).toBeInTheDocument();
    });
  });

  it('exposes ribbon actions', async () => {
    render(<CopyJobEditor item={makeItem('copy-job', 'Copy Job')} id="cj-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('ribbon').querySelectorAll('button').length).toBeGreaterThan(0);
    });
  });
});
