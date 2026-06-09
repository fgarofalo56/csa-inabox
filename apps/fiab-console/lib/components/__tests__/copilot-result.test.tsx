/**
 * CopilotResult — vitest jsdom render tests, one per kind.
 *
 * Drives the typed renderer the way the Copilot surfaces do: feed a TypedResult
 * and assert the right surface renders (DataGrid rows for table, an SVG chart
 * for chart, a Monaco/textarea for code, rendered markdown for summary, a
 * change table for proposed_change, an error MessageBar for error, a
 * collapsible <details> for unknown). All data is in-hand (per no-vaporware) —
 * no backend faked. Monaco is stubbed to a <textarea> by vitest.setup.ts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { CopilotResult } from '../copilot-result';
import type { TypedResult } from '../copilot-result-tagger';

function renderResult(result: TypedResult) {
  return render(
    <FluentProvider theme={webLightTheme}>
      <CopilotResult result={result} />
    </FluentProvider>,
  );
}

afterEach(cleanup);

describe('CopilotResult dispatch', () => {
  it('renders a DataGrid of real rows for a table result (NL2SQL)', () => {
    renderResult({
      kind: 'table',
      source: 'synapse_serverless',
      columns: ['customer', 'revenue'],
      rows: [['Contoso', 1200], ['Fabrikam', 950]],
      rowCount: 2,
      executionMs: 33,
    });
    // grid + the real row values are present (not raw JSON)
    expect(screen.getAllByRole('row').length).toBeGreaterThan(0);
    const cells = screen.getAllByRole('gridcell');
    const text = cells.map((c) => c.textContent).join(' ');
    expect(text).toContain('Contoso');
    expect(text).toContain('Fabrikam');
    expect(text).toContain('1,200');
  });

  it('renders an SVG chart for a chart result', () => {
    const { container } = renderResult({
      kind: 'chart',
      chartType: 'barchart',
      columns: ['region', 'sales'],
      rows: [['East', 5], ['West', 9]],
      title: 'Sales by region',
    });
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('renders read-only Monaco for a code result with copy + insert actions', () => {
    renderResult({ kind: 'code', language: 'sql', code: 'SELECT TOP 10 * FROM gold.fact_sales', filename: 'top10.sql' });
    const editor = screen.getByLabelText('sql code') as HTMLTextAreaElement;
    expect(editor).toBeInTheDocument();
    expect(editor.value).toContain('SELECT TOP 10');
    expect(screen.getByLabelText('Insert into editor')).toBeInTheDocument();
    expect(screen.getByLabelText('Copy')).toBeInTheDocument();
  });

  it('renders markdown (heading + bold) for a summary result', () => {
    renderResult({ kind: 'summary', title: 'Self-audit', markdown: '## Score 88/100\nThe **Cosmos** check passed.' });
    expect(screen.getByText('Score 88/100')).toBeInTheDocument();
    expect(screen.getByText('Cosmos')).toBeInTheDocument(); // <strong> from **Cosmos**
  });

  it('renders a change table for a proposed_change result', () => {
    renderResult({
      kind: 'proposed_change',
      targetType: 'lakehouse',
      targetId: 'item-1',
      displayName: 'Gold lakehouse',
      changes: [{ field: 'created', after: 'lakehouse' }, { field: 'workspaceId', before: undefined, after: 'ws-9' }],
    });
    expect(screen.getByText('created')).toBeInTheDocument();
    expect(screen.getByText('workspaceId')).toBeInTheDocument();
    // working "Open" link to the real item editor route
    const open = screen.getByText('Open').closest('a');
    expect(open?.getAttribute('href')).toBe('/items/lakehouse/item-1');
  });

  it('renders an error MessageBar for an error result', () => {
    renderResult({ kind: 'error', message: 'dedicated pool is paused', code: 'POOL_PAUSED' });
    expect(screen.getByText('dedicated pool is paused')).toBeInTheDocument();
    expect(screen.getByText('POOL_PAUSED')).toBeInTheDocument();
  });

  it('renders a collapsible details for an unknown result (no bare JSON dump)', () => {
    const { container } = renderResult({ kind: 'unknown', raw: { opaque: true, n: 7 } });
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(within(details as HTMLElement).getByText('Result detail')).toBeInTheDocument();
  });
});
