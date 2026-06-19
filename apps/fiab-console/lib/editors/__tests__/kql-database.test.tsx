/**
 * KqlDatabaseEditor — vitest render + interaction.
 *
 * Mounts the KQL Database editor with mocked /api/items/kql-database/[id]
 * and /query responses and confirms:
 *   - DB details + table list fetch fires on mount
 *   - Run button executes a POST to /query and surfaces the result row
 *   - pre-save id === 'new' gate suppresses the fetch
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { KqlDatabaseEditor } from '../phase3-editors';
import { makeItem, installFetchMock, renderWithProviders } from './test-helpers';

describe('KqlDatabaseEditor', () => {
  let calls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    const m = installFetchMock({
      '/api/items/kql-database/kqldb-fixture/schema-graph': () => ({
        ok: true,
        database: 'loomdb-default',
        nodes: [
          { id: 'table:Events', kind: 'table', name: 'Events', columns: [{ name: 'ts', type: 'datetime' }] },
          { id: 'mv:EventsDaily', kind: 'materialized-view', name: 'EventsDaily', sourceTable: 'Events' },
          { id: 'function:fn_recent', kind: 'function', name: 'fn_recent', parameters: '(days:int)' },
        ],
        edges: [
          { from: 'mv:EventsDaily', to: 'table:Events', type: 'mv-source' },
          { from: 'function:fn_recent', to: 'table:Events', type: 'function-ref' },
        ],
        counts: { tables: 1, materializedViews: 1, functions: 1, shortcuts: 0, edges: 2 },
      }),
      '/api/items/kql-database/kqldb-fixture/query': () => ({
        ok: true,
        database: 'loomdb-default',
        mode: 'query',
        columns: ['smoke', 'server_time'],
        rows: [['ok', '2026-05-27T00:00:00Z']],
        rowCount: 1,
        executionMs: 23,
      }),
      '/api/items/kql-database/kqldb-fixture': () => ({
        ok: true,
        cluster: 'https://adx-csa-loom-shared.eastus2.kusto.usgovcloudapi.net',
        database: 'loomdb-default',
        details: { OriginalSize: 1_048_576, HotCachePeriod: 'P7D', SoftDeletePeriod: 'P30D' },
        tables: [{ name: 'Events' }, { name: 'Alerts' }],
        tableCount: 2,
      }),
      // AdxDatabaseTree (left navigator) — real /api/adx/* routes.
      '/api/adx/tables': () => ({ ok: true, database: 'loomdb-default', tables: [{ name: 'Events', totalRowCount: 12 }, { name: 'Alerts', totalRowCount: 3 }] }),
      '/api/adx/functions': () => ({ ok: true, database: 'loomdb-default', functions: [] }),
      '/api/adx/materialized-views': () => ({ ok: true, database: 'loomdb-default', materializedViews: [] }),
      '/api/adx/ingestion-mappings': () => ({ ok: true, database: 'loomdb-default', mappings: [] }),
      '/api/adx/overview': () => ({ ok: true, database: 'loomdb-default', schema: null, continuousExports: [] }),
    });
    calls = m.calls;
  });

  // globals:false in vitest.config means @testing-library's auto-afterEach
  // cleanup never registers, so each render() would otherwise pile up in the
  // same jsdom document.body — making getByRole(/^Run/) find duplicate Run
  // buttons across tests. Unmount explicitly between tests.
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('fetches DB details + table list on mount', async () => {
    renderWithProviders(<KqlDatabaseEditor item={makeItem('kql-database', 'KQL Database')} id="kqldb-fixture" />);
    await waitFor(() => {
      expect(calls.some((c) => c.url.endsWith('/api/items/kql-database/kqldb-fixture'))).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByText('Events')).toBeInTheDocument();
      expect(screen.getByText('Alerts')).toBeInTheDocument();
    });
  });

  it('Run button posts to /query and renders the result', async () => {
    renderWithProviders(<KqlDatabaseEditor item={makeItem('kql-database', 'KQL Database')} id="kqldb-fixture" />);
    await waitFor(() => expect(screen.getByText('Events')).toBeInTheDocument());
    const runBtn = screen.getByRole('button', { name: /^Run/i });
    fireEvent.click(runBtn);
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/query') && c.init?.method === 'POST')).toBe(true);
    });
  });

  it('skips the DB fetch when id is "new" (pre-save gate)', () => {
    renderWithProviders(<KqlDatabaseEditor item={makeItem('kql-database', 'KQL Database')} id="new" />);
    expect(calls.filter((c) => c.url.endsWith('/api/items/kql-database/new')).length).toBe(0);
  });

  it('Ingestion mapping wizard opens from the ribbon, builds the grid, and POSTs to /api/adx/ingestion-mappings', async () => {
    renderWithProviders(<KqlDatabaseEditor item={makeItem('kql-database', 'KQL Database')} id="kqldb-fixture" />);
    await waitFor(() => expect(screen.getByText('Events')).toBeInTheDocument());

    // Ribbon action (surfaced as a <button> by the chrome stub) opens the wizard.
    fireEvent.click(screen.getByRole('button', { name: 'Ingestion mapping' }));
    expect(await screen.findByText('New ingestion mapping')).toBeInTheDocument();

    // Step 1 — name + format; the target table defaults to the first DB table.
    // The wizard is a Fluent Dialog rendered through a portal; under jsdom the
    // tabster mutation observer can corrupt the ARIA role tree after repeated
    // mounts, so the step buttons are matched by their button text rather than
    // by getByRole('button', { name }).
    fireEvent.change(screen.getByPlaceholderText('EventMapping'), { target: { value: 'EventMapping' } });
    fireEvent.click(screen.getByText('Next', { selector: 'button' }));

    // Step 2 — a column-map grid row exists; fill the target column then create.
    const col = await screen.findByLabelText('Target column for row 1');
    fireEvent.change(col, { target: { value: 'ts' } });

    fireEvent.click(screen.getByText('Create mapping', { selector: 'button' }));
    await waitFor(() => {
      const post = calls.find((c) => c.url.includes('/api/adx/ingestion-mappings') && c.init?.method === 'POST');
      expect(post).toBeTruthy();
      const sent = JSON.parse(String(post!.init!.body));
      expect(sent.name).toBe('EventMapping');
      expect(sent.kind).toBe('csv');
      expect(JSON.parse(sent.mapping)[0].Column).toBe('ts');
    });
  });

  it('Get data wizard ingests with format + ingestionMappingReference', async () => {
    renderWithProviders(<KqlDatabaseEditor item={makeItem('kql-database', 'KQL Database')} id="kqldb-fixture" />);
    await waitFor(() => expect(screen.getByText('Events')).toBeInTheDocument());

    // The Get data ribbon action + the dialog's controls live inside a Fluent
    // Dialog portal; under jsdom the tabster mutation observer can corrupt the
    // ARIA role tree, so match buttons by text. The "Format" Select has no
    // associated <label>/aria-label (it is preceded by a Caption1 caption), so
    // resolve it from that caption's container rather than by getByLabelText.
    fireEvent.click(screen.getByText('Get data', { selector: 'button' }));
    expect(await screen.findByText(/Get data — ingest a file/)).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('events'), { target: { value: 'Events' } });
    const formatSelect = screen
      .getByText('Format', { selector: 'span' })
      .parentElement!.querySelector('select') as HTMLSelectElement;
    fireEvent.change(formatSelect, { target: { value: 'json' } });
    fireEvent.change(screen.getByPlaceholderText('EventMapping'), { target: { value: 'EventMapping' } });
    const fileContent = '{"ts":"2026-01-01T00:00:00Z"}';
    const file = new File([fileContent], 'sample.json', { type: 'application/json' });
    // jsdom's File does not implement Blob.text() (it exists in real browsers),
    // and the editor reads the file with `await file.text()` before building the
    // inline .ingest command. Polyfill it on this instance so the submit path runs.
    if (typeof (file as any).text !== 'function') {
      Object.defineProperty(file, 'text', { value: async () => fileContent });
    }
    fireEvent.change(screen.getByLabelText('File to ingest'), { target: { files: [file] } });

    fireEvent.click(screen.getByText(/^Create$/, { selector: 'button' }));
    await waitFor(() => {
      const post = calls.find((c) =>
        c.url.includes('/api/items/kql-database/kqldb-fixture/query') &&
        c.init?.method === 'POST' &&
        String(c.init?.body).includes('ingestionMappingReference'));
      expect(post).toBeTruthy();
      const kql = JSON.parse(String(post!.init!.body)).kql as string;
      expect(kql).toContain("format='json'");
      expect(kql).toContain("ingestionMappingReference='EventMapping'");
    });
  });

  it('Diagram tab fetches schema-graph and renders entity nodes', async () => {
    renderWithProviders(<KqlDatabaseEditor item={makeItem('kql-database', 'KQL Database')} id="kqldb-fixture" />);
    await waitFor(() => expect(screen.getByText('Events')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: /diagram/i }));
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/schema-graph'))).toBe(true);
    });
    // The canvas renders the real entity names returned by the schema-graph route.
    await waitFor(() => {
      expect(screen.getByText('EventsDaily')).toBeInTheDocument();
      expect(screen.getByText('fn_recent')).toBeInTheDocument();
    });
  });
});
