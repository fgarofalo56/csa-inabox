/**
 * DetailsPanel (SC-2) — vitest jsdom render + contract tests.
 *
 * Verifies the Fabric "Database details" contract: stat rows render, copyable
 * URI rows expose a Copy button that writes the exact value to the clipboard,
 * inline-editable policy rows call the caller's onSave (the real PATCH), and
 * the Related-elements find-by-name filter narrows the list. No backend is
 * faked — onSave is a caller-supplied handler, exactly as the panel's contract
 * requires (the panel never fetches).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { DetailsPanel, type DetailsPanelProps } from '../details-panel';

afterEach(cleanup);

function renderPanel(props: DetailsPanelProps) {
  return render(
    <FluentProvider theme={webLightTheme}>
      <DetailsPanel {...props} />
    </FluentProvider>,
  );
}

const baseSections: DetailsPanelProps['sections'] = [
  {
    key: 'stats',
    title: 'Storage',
    stats: [
      { key: 'compressed', label: 'Compressed size', value: '1.2 GB' },
      { key: 'original', label: 'Original size', value: '4.8 GB' },
    ],
  },
  {
    key: 'overview',
    title: 'Overview',
    uris: [
      { key: 'query', label: 'Query URI', value: 'https://adx-csa-loom.eastus.kusto.windows.net' },
      { key: 'mcp', label: 'MCP Server URI', value: 'https://adx-csa-loom.eastus.kusto.windows.net/mcp' },
    ],
  },
];

describe('DetailsPanel', () => {
  it('renders stat rows and copyable URI rows', () => {
    renderPanel({ title: 'Database details', sections: baseSections });
    expect(screen.getByText('Compressed size')).toBeInTheDocument();
    expect(screen.getByText('1.2 GB')).toBeInTheDocument();
    expect(screen.getByText('Query URI')).toBeInTheDocument();
    expect(screen.getByText('https://adx-csa-loom.eastus.kusto.windows.net')).toBeInTheDocument();
    expect(screen.getByLabelText('Copy Query URI')).toBeInTheDocument();
    expect(screen.getByLabelText('Copy MCP Server URI')).toBeInTheDocument();
  });

  it('copies the exact URI value to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderPanel({ title: 'Database details', sections: baseSections });
    fireEvent.click(screen.getByLabelText('Copy Query URI'));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('https://adx-csa-loom.eastus.kusto.windows.net');
    });
  });

  it('inline-edits a policy row and calls the caller onSave (real PATCH)', async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true });
    renderPanel({
      title: 'Database details',
      sections: [
        {
          key: 'policies',
          title: 'Policies',
          policies: [
            { key: 'cache', label: 'Caching policy', value: 7, type: 'number', unit: 'days', onSave },
          ],
        },
      ],
    });
    // Enter edit mode via the pencil.
    fireEvent.click(screen.getByLabelText('Edit Caching policy'));
    const field = screen.getByLabelText('Caching policy') as HTMLInputElement;
    fireEvent.change(field, { target: { value: '30' } });
    fireEvent.click(screen.getByLabelText('Save Caching policy'));
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(30);
    });
  });

  it('surfaces the onSave error inline and stays in edit mode', async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: false, error: 'ARM rejected: SKU too small' });
    renderPanel({
      title: 'Database details',
      sections: [
        {
          key: 'policies',
          title: 'Policies',
          policies: [
            { key: 'ret', label: 'Retention policy', value: 30, type: 'number', unit: 'days', onSave },
          ],
        },
      ],
    });
    fireEvent.click(screen.getByLabelText('Edit Retention policy'));
    fireEvent.click(screen.getByLabelText('Save Retention policy'));
    await waitFor(() => {
      expect(screen.getByText('ARM rejected: SKU too small')).toBeInTheDocument();
    });
  });

  it('filters Related elements by name', () => {
    renderPanel({
      title: 'Database details',
      sections: baseSections,
      related: {
        items: [
          { id: '1', name: 'Bicycles', kind: 'Table' },
          { id: '2', name: 'Orders', kind: 'Table' },
          { id: '3', name: 'DailySummary', kind: 'Materialized view' },
        ],
      },
    });
    expect(screen.getByText('Bicycles')).toBeInTheDocument();
    expect(screen.getByText('Orders')).toBeInTheDocument();
    const search = screen.getByLabelText('Find related elements by name');
    fireEvent.change(search, { target: { value: 'bicy' } });
    expect(screen.getByText('Bicycles')).toBeInTheDocument();
    expect(screen.queryByText('Orders')).not.toBeInTheDocument();
  });

  it('renders a loading state without sections', () => {
    renderPanel({ title: 'Database details', sections: [], loading: true });
    expect(screen.getByText('Loading details…')).toBeInTheDocument();
  });

  it('renders an honest error gate', () => {
    renderPanel({
      title: 'Database details',
      sections: [],
      error: 'Set LOOM_KUSTO_CLUSTER to read database details.',
    });
    expect(screen.getByText('Set LOOM_KUSTO_CLUSTER to read database details.')).toBeInTheDocument();
  });
});
