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
      // Longest-key-wins in the mock matcher, so the /metrics handler is
      // selected over the bare detail handler for the metrics endpoint.
      '/api/items/stream-analytics-job/job-fixture/metrics': () => ({
        ok: true,
        resourceId: 'arm-id',
        jobState: 'Stopped',
        metrics: [
          { name: 'ResourceUtilization', unit: 'Percent', aggregation: 'Average',
            points: [{ timeStamp: '2026-06-07T00:00:00Z', value: 42 }] },
          { name: 'OutputWatermarkDelaySeconds', unit: 'Seconds', aggregation: 'Maximum',
            points: [{ timeStamp: '2026-06-07T00:00:00Z', value: 1.5 }] },
          { name: 'InputEventsSourcesBacklogged', unit: 'Count', aggregation: 'Maximum',
            points: [{ timeStamp: '2026-06-07T00:00:00Z', value: 0 }] },
          { name: 'InputEvents', unit: 'Count', aggregation: 'Total',
            points: [{ timeStamp: '2026-06-07T00:00:00Z', value: 120 }] },
          { name: 'OutputEvents', unit: 'Count', aggregation: 'Total',
            points: [{ timeStamp: '2026-06-07T00:00:00Z', value: 100 }] },
        ],
      }),
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

  it('renders live metric tiles on the Monitoring tab', async () => {
    render(<StreamAnalyticsJobEditor item={makeItem('stream-analytics-job', 'Stream Analytics job')} id="new" />);
    await waitFor(() => {
      expect(screen.getAllByText('job-fixture').length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getByRole('tab', { name: /Monitoring/i }));
    await waitFor(() => {
      expect(screen.getByText('SU % Utilization')).toBeInTheDocument();
      expect(screen.getByText('Watermark Delay')).toBeInTheDocument();
      expect(screen.getByText('Backlogged Events')).toBeInTheDocument();
    });
  });
});
