/**
 * GetDataGallery — vitest render + interaction (report "Get data" popup).
 *
 * Locks the fixes for the broken Get-data popup:
 *   1. The "Use a Loom item" source (the ONLY entry to existing Loom sources)
 *      renders in the gallery AND stays reachable while the connector search
 *      box has text — it was gated behind `!q`, so any search stranded the user
 *      with "no option to select existing Loom sources".
 *   2. Every dismiss path is wired: the header Close (X) and the footer Cancel
 *      both call onDismiss so the popup can always be closed.
 *
 * Renders the REAL component under a FluentProvider with a URL-keyed fetch mock
 * (no network) per the editor test harness.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { render } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { installFetchMock } from '../../__tests__/test-helpers';
import { GetDataGallery } from '../get-data-gallery';

function renderGallery(props: Partial<React.ComponentProps<typeof GetDataGallery>> = {}) {
  const onChosen = vi.fn();
  const onDismiss = vi.fn();
  const utils = render(
    <FluentProvider theme={webLightTheme}>
      <GetDataGallery open onChosen={onChosen} onDismiss={onDismiss} {...props} />
    </FluentProvider>,
  );
  return { ...utils, onChosen, onDismiss };
}

describe('GetDataGallery (report Get data popup)', () => {
  beforeEach(() => {
    // The gallery loads connections on open; return an empty list so the
    // catalog + Loom hero render without any recents.
    installFetchMock({
      '/api/connections': () => ({ ok: true, connections: [] }),
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('always offers the "Use a Loom item" source — even while searching connectors', async () => {
    renderGallery();

    // Loom source is present on open.
    expect(await screen.findByLabelText(/Use a Loom item as the data source/i)).toBeTruthy();

    // Type a query that matches NO connector — the Loom source must remain
    // reachable (regression: it was hidden the moment `q` was non-empty).
    const search = screen.getByLabelText(/Search connectors/i);
    fireEvent.change(search, { target: { value: 'zzz-no-such-connector' } });

    await waitFor(() => {
      // Connector catalog collapses to its empty state…
      expect(screen.getByText(/No connectors match/i)).toBeTruthy();
    });
    // …but the Loom-item source is STILL offered.
    expect(screen.getByLabelText(/Use a Loom item as the data source/i)).toBeTruthy();
  });

  it('dismisses via the header Close (X)', async () => {
    const { onDismiss } = renderGallery();
    const closeBtn = await screen.findByLabelText(/Close Get data/i);
    fireEvent.click(closeBtn);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('dismisses via the footer Cancel', async () => {
    const { onDismiss } = renderGallery();
    await screen.findByLabelText(/Use a Loom item as the data source/i);
    // The DialogActions Cancel button (footer) dismisses the popup.
    const cancels = screen.getAllByRole('button', { name: /^Cancel$/i });
    fireEvent.click(cancels[cancels.length - 1]);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

/**
 * Upload path — the gallery is shared by the report, semantic-model and
 * paginated-report editors, and an upload is stored with (and authorized
 * against) whichever item the gallery is open in.
 */
describe('GetDataGallery upload (host item)', () => {
  let calls: Array<{ url: string; init?: RequestInit }>;
  let uploadReply: Record<string, unknown>;

  beforeEach(() => {
    uploadReply = {
      ok: true, filename: 'a.csv', container: 'landing', path: 'report-uploads/x/a.csv',
      abfssPath: 'abfss://landing@acct.dfs.core.windows.net/report-uploads/x/a.csv',
      sparkFormat: { format: 'csv' },
    };
    ({ calls } = installFetchMock({
      '/api/connections': () => ({ ok: true, connections: [] }),
      '/api/lakehouse/upload': () => uploadReply,
    }));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  async function openUploadTab() {
    fireEvent.click(await screen.findByLabelText(/Get data from Azure Data Lake Storage Gen2/i));
    fireEvent.click(await screen.findByRole('tab', { name: /Upload a file/i }));
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    fireEvent.change(input, { target: { files: [new File(['a,b\n1,2\n'], 'a.csv', { type: 'text/csv' })] } });
  }
  const uploadCalls = () => calls.filter((c) => c.url.includes('/api/lakehouse/upload'));
  const formOf = (i = 0) => uploadCalls()[i].init!.body as FormData;

  it.each([
    ['semantic-model', 'sm-1'],
    ['paginated-report', 'pr-1'],
  ] as const)('a %s host uploads under its own id and type', async (hostItemType, id) => {
    renderGallery({ reportId: id, hostItemType });
    await openUploadTab();
    // Positive arm: the upload lands and is shown.
    expect(await screen.findByText('a.csv')).toBeTruthy();
    expect(uploadCalls()).toHaveLength(1);
    // Breaks if the gallery drops reportItemType (the route would then look the id up as a report).
    expect(formOf().get('reportItemType')).toBe(hostItemType);
    expect(formOf().get('reportId')).toBe(id);
    expect(formOf().get('path')).toBe(`report-uploads/${id}/a.csv`);
    expect(screen.queryByText(/Save the report first/i)).toBeNull();
    // The live preview runs the report connector-preview route, so it is offered to report hosts only.
    expect(screen.queryByRole('button', { name: /Preview data/i })).toBeNull();
  });

  it('a report host (the default) sends reportItemType=report and offers the live preview', async () => {
    renderGallery({ reportId: 'rep-1' });
    await openUploadTab();
    expect(await screen.findByText('a.csv')).toBeTruthy();
    expect(formOf().get('reportItemType')).toBe('report');
    // Positive arm for the preview gate above: breaks if the preview is hidden for every host.
    expect(screen.getByRole('button', { name: /Preview data/i })).toBeTruthy();
  });

  it('an unsaved semantic model is asked to save the semantic model, and nothing is sent', async () => {
    renderGallery({ reportId: 'new', hostItemType: 'semantic-model' });
    await openUploadTab();
    expect(await screen.findByText(/Save the semantic model first/i)).toBeTruthy();
    expect(screen.queryByText(/Save the report first/i)).toBeNull();
    expect(uploadCalls()).toEqual([]);
  });

  it('a refusal shows the error and its remediation', async () => {
    uploadReply = { ok: false, error: 'Your role on this semantic model is read-only.', code: 'read_only', remediation: 'Ask a workspace Admin or Member for edit access.' };
    renderGallery({ reportId: 'sm-1', hostItemType: 'semantic-model' });
    await openUploadTab();
    // Breaks if the remediation is dropped from the message.
    expect(await screen.findByText(/read-only\. Ask a workspace Admin or Member for edit access\./i)).toBeTruthy();
  });
});
