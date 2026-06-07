/**
 * StreamAnalyticsJobEditor — vitest render + interaction.
 *
 * Verifies that the editor mounts, lists ASA jobs from the mocked BFF,
 * surfaces job state, and exposes Start/Stop/Refresh/Save in the toolbar.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { StreamAnalyticsJobEditor } from '../stream-analytics-editor';
import { makeItem, installFetchMock } from './test-helpers';

describe('StreamAnalyticsJobEditor', () => {
  beforeEach(() => {
    installFetchMock({
      '/api/items/stream-analytics-job/job-fixture': () => ({
        ok: true,
        job: {
          name: 'job-fixture',
          id: 'arm-id',
          location: 'eastus2',
          jobState: 'Stopped',
          state: 'Stopped',
          sku: 'Standard',
          streamingUnits: 3,
          inputs: [{ name: 'input-eventhub', type: 'Stream' }],
          outputs: [{ name: 'output-blob', type: 'Blob' }],
          query: 'SELECT * INTO [output-blob] FROM [input-eventhub]',
        },
      }),
      '/api/items/stream-analytics-job': () => ({
        ok: true,
        jobs: [
          { name: 'job-fixture', id: 'arm-id', location: 'eastus2', jobState: 'Stopped' },
        ],
      }),
    });
  });

  // vitest runs with globals:false, so @testing-library/react never registers
  // its automatic afterEach(cleanup). Without an explicit cleanup the first
  // test's mounted tree (showing the loaded job's query) survives into the
  // second test, which then sees two `aria-label="ASA query"` textareas and
  // breaks getByLabelText. Mirror the sibling editor specs (dataflow, dbt-job,
  // etc.) and unmount between tests.
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('lists ASA jobs and shows their state', async () => {
    render(<StreamAnalyticsJobEditor item={makeItem('stream-analytics-job', 'Stream Analytics job')} id="new" />);
    await waitFor(() => {
      expect(screen.getAllByText('job-fixture').length).toBeGreaterThan(0);
    });
    await waitFor(() => {
      expect(screen.getAllByText('Stopped').length).toBeGreaterThan(0);
    });
  });

  it('exposes Start/Stop/Refresh and the SAQL editor', async () => {
    render(<StreamAnalyticsJobEditor item={makeItem('stream-analytics-job', 'Stream Analytics job')} id="new" />);
    await waitFor(() => {
      expect(screen.getAllByText('job-fixture').length).toBeGreaterThan(0);
    });
    expect(screen.getAllByRole('button', { name: /Refresh/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /Start/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /Stop/i }).length).toBeGreaterThan(0);
    expect(screen.getByLabelText('ASA query')).toBeInTheDocument();
  });

  it('opens the guided Query Builder and shows generated SAQL', async () => {
    render(<StreamAnalyticsJobEditor item={makeItem('stream-analytics-job', 'Stream Analytics job')} id="job-fixture" />);
    await waitFor(() => {
      expect(screen.getAllByText('job-fixture').length).toBeGreaterThan(0);
    });
    // The ribbon stub surfaces actions as buttons; switch to the builder tab.
    fireEvent.click(screen.getByRole('button', { name: 'Query Builder' }));
    await waitFor(() => {
      expect(screen.getByText('Guided transform builder')).toBeInTheDocument();
    });
    // Generated-SAQL preview is wired to the compiler output.
    expect(screen.getByLabelText('Builder generated SAQL')).toBeInTheDocument();
    expect(screen.getByLabelText('Builder source alias')).toBeInTheDocument();
  });

  it('exposes the Test tab with a sample-data editor and run actions', async () => {
    render(<StreamAnalyticsJobEditor item={makeItem('stream-analytics-job', 'Stream Analytics job')} id="job-fixture" />);
    await waitFor(() => {
      expect(screen.getAllByText('job-fixture').length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test with sample' }));
    await waitFor(() => {
      expect(screen.getByLabelText('Sample events JSON')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Compile query/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Run test/i })).toBeInTheDocument();
  });
});
