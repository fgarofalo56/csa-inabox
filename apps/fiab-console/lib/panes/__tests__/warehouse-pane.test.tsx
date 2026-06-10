import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { WarehousePane } from '../warehouse';

// MonacoTextarea pulls in the Monaco AMD loader which can't run under jsdom;
// stub it with a plain textarea that preserves the ariaLabel + onChange.
vi.mock('@/lib/components/editor/monaco-textarea', () => ({
  MonacoTextarea: ({ value, onChange, ariaLabel }: any) => (
    <textarea aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

// The copilot pane bridge dispatches a window CustomEvent — no-op in tests.
vi.mock('@/lib/components/copilot-pane', () => ({ setCopilotContext: vi.fn() }));

function renderPane() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <WarehousePane />
    </FluentProvider>,
  );
}

describe('WarehousePane', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('renders the T-SQL editor surface and run controls', () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    renderPane();
    expect(screen.getByLabelText('Warehouse T-SQL editor')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /run query/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /explain plan/i })).toBeInTheDocument();
  });

  it('renders rows from a successful query against the real backend shape', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, columns: ['region', 'total'], rows: [['East', 42]], rowCount: 1, engine: 'synapse-dedicated' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    renderPane();
    fireEvent.click(screen.getByRole('button', { name: /run query/i }));
    // rowCount === 1 renders the singular "1 row" badge (not "1 rows").
    await waitFor(() => expect(screen.getByText(/^1 row$/)).toBeInTheDocument());
    // Engine is shown verbatim in a Badge ("synapse-dedicated"), not "engine: …".
    expect(screen.getByText('synapse-dedicated')).toBeInTheDocument();
    expect(screen.getByText('East')).toBeInTheDocument();
  });

  it('surfaces a failed query as an error MessageBar (honest gate / SQL error)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ ok: false, error: 'Warehouse compute is Paused. Resume it before running queries.' }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      ),
    );
    renderPane();
    fireEvent.click(screen.getByRole('button', { name: /run query/i }));
    await waitFor(() => expect(screen.getByText('Query failed')).toBeInTheDocument());
    expect(screen.getByText(/Warehouse compute is Paused/)).toBeInTheDocument();
  });

  it('fetches an execution plan from /api/warehouse/explain', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, planXml: '<ShowPlanXML>cost=12</ShowPlanXML>', engine: 'synapse-dedicated' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    renderPane();
    fireEvent.click(screen.getByRole('button', { name: /explain plan/i }));
    await waitFor(() => expect(screen.getByText(/ShowPlanXML/)).toBeInTheDocument());
    expect(fetchSpy).toHaveBeenCalledWith('/api/warehouse/explain', expect.objectContaining({ method: 'POST' }));
  });
});
