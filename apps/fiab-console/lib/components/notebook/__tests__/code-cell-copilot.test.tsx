/**
 * CodeCell in-cell Copilot — vitest jsdom render + behavior tests.
 *
 * Mirrors the Fabric in-cell Copilot UX (a per-cell Copilot button that opens a
 * prompt popover with slash commands; the result is inserted as a new cell
 * below). The backend (`POST /api/notebook/[id]/assist`) is the SAME real AOAI
 * route the cross-item Copilot uses — here `fetch` is stubbed so we exercise the
 * client wiring (request shape + result-cell construction) without faking AOAI
 * behavior, per no-vaporware.md.
 *
 * Assertions:
 *  (1) Copilot button is HIDDEN when notebookId/onInsertBelow are absent
 *      (legacy scratchpad pane — zero regression).
 *  (2) Copilot button is shown when notebookId + onInsertBelow are passed.
 *  (3) /explain calls /assist with mode:'explain' and inserts a MARKDOWN cell
 *      prefixed with "## Copilot explanation".
 *  (4) A 503 no_aoai response surfaces the honest MessageBar hint (no throw,
 *      no cell inserted).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { CodeCell } from '../code-cell';
import type { NotebookCell } from '@/lib/types/notebook-cell';

function baseCell(): NotebookCell {
  return {
    id: 'cell-1',
    type: 'code',
    lang: 'pyspark',
    source: "df = spark.read.table('bronze.orders')\ndf.show(5)",
  };
}

function renderCell(extra?: Partial<React.ComponentProps<typeof CodeCell>>) {
  const onInsertBelow = vi.fn();
  const utils = render(
    <FluentProvider theme={webLightTheme}>
      <CodeCell cell={baseCell()} onChange={vi.fn()} {...extra} />
    </FluentProvider>,
  );
  return { onInsertBelow, ...utils };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('CodeCell in-cell Copilot', () => {
  it('hides the Copilot button when notebookId/onInsertBelow are absent', () => {
    renderCell();
    expect(screen.queryByLabelText('In-cell Copilot')).toBeNull();
  });

  it('shows the Copilot button when notebookId + onInsertBelow are passed', () => {
    const onInsertBelow = vi.fn();
    render(
      <FluentProvider theme={webLightTheme}>
        <CodeCell cell={baseCell()} onChange={vi.fn()} notebookId="nb-1" onInsertBelow={onInsertBelow} />
      </FluentProvider>,
    );
    expect(screen.getByLabelText('In-cell Copilot')).toBeInTheDocument();
  });

  it('/explain posts mode:explain and inserts a markdown explanation cell below', async () => {
    const onInsertBelow = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        mode: 'explain',
        result: 'This cell reads the bronze.orders Delta table and shows the first five rows.',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FluentProvider theme={webLightTheme}>
        <CodeCell cell={baseCell()} onChange={vi.fn()} notebookId="nb-1" onInsertBelow={onInsertBelow} />
      </FluentProvider>,
    );

    fireEvent.click(screen.getByLabelText('In-cell Copilot'));
    const input = await screen.findByLabelText('Copilot prompt');
    fireEvent.change(input, { target: { value: '/explain' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/notebook/nb-1/assist');
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.mode).toBe('explain');
    expect(sent.lang).toBe('pyspark');
    expect(sent.source).toContain('bronze.orders');

    await waitFor(() => expect(onInsertBelow).toHaveBeenCalledTimes(1));
    const inserted = onInsertBelow.mock.calls[0][0] as NotebookCell;
    expect(inserted.type).toBe('markdown');
    expect(inserted.source).toContain('## Copilot explanation');
    expect(inserted.source).toContain('bronze.orders Delta table');
  });

  it('surfaces the honest AOAI hint on a 503 no_aoai response (no throw, no insert)', async () => {
    const onInsertBelow = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({
        ok: false,
        code: 'no_aoai',
        error: 'AOAI not configured',
        hint: 'set LOOM_AOAI_ENDPOINT and LOOM_AOAI_DEPLOYMENT.',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FluentProvider theme={webLightTheme}>
        <CodeCell cell={baseCell()} onChange={vi.fn()} notebookId="nb-1" onInsertBelow={onInsertBelow} />
      </FluentProvider>,
    );

    fireEvent.click(screen.getByLabelText('In-cell Copilot'));
    const input = await screen.findByLabelText('Copilot prompt');
    fireEvent.change(input, { target: { value: '/explain' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/AOAI not configured/i)).toBeInTheDocument();
    expect(onInsertBelow).not.toHaveBeenCalled();
  });
});
