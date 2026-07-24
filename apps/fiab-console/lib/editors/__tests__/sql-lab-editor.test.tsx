/**
 * N2b — SQL Lab (DuckDB) editor.
 *
 * Pins the behaviours the surface is judged on:
 *   • it renders FULLY and names the engine in both states — the DuckDB serving
 *     tier when wired, Synapse Serverless (with the Fix-it gate, never a
 *     blocked surface) when not;
 *   • Run executes through the audited BFF and the status bar prints MEASURED
 *     numbers (rows, engine ms, round-trip ms, engine name);
 *   • the FLAG0 kill switch reverts the surface to a guided notice.
 *
 * The editor chrome (ribbon / page shell / side panels) is substituted so the
 * spec exercises THIS surface rather than re-testing the shared chrome.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { renderWithProviders, installFetchMock, makeItem } from './test-helpers';

vi.mock('../item-editor-chrome', () => ({
  ItemEditorChrome: ({ main }: { main: React.ReactNode }) => <div data-testid="chrome">{main}</div>,
}));
vi.mock('@/lib/components/editor/monaco-textarea', () => ({
  MonacoTextarea: ({ value, onChange, ariaLabel }: any) => (
    <textarea aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

let flagValue = true;
vi.mock('@/lib/components/ui/use-runtime-flag', () => ({ useRuntimeFlag: () => flagValue }));

import { SqlLabEditor } from '../sql-lab-editor';

const ITEM = makeItem('sql-lab', 'SQL Lab (DuckDB)');

const CONFIGURED_CAPS = {
  ok: true,
  configured: true,
  engine: 'duckdb',
  capabilities: { version: '1.1.3', extensions: ['httpfs', 'azure', 'delta', 'iceberg'], lakeAccount: 'stloom' },
  flight: { configured: true, exposure: 'published', note: 'ok' },
};

const FALLBACK_CAPS = {
  ok: true,
  configured: false,
  engine: 'synapse-serverless',
  gate: {
    id: 'svc-loom-duckdb',
    title: 'SQL Lab serving tier (embedded DuckDB Container App)',
    remediation: 'Set LOOM_DUCKDB_URL to the internal-ingress FQDN of the loom-duckdb Container App.',
    fixItHref: '/admin/gates?gate=svc-loom-duckdb',
    missing: ['LOOM_DUCKDB_URL'],
  },
  fallback: { engine: 'synapse-serverless', note: 'SQL Lab runs every statement on Synapse Serverless.' },
  flight: { configured: false, exposure: 'not-deployed', note: 'not deployed' },
};

const DUCKDB_RESULT = {
  ok: true,
  engine: 'duckdb',
  columns: [{ name: 'product', type: 'VARCHAR' }, { name: 'revenue', type: 'BIGINT' }],
  rows: [['widget', 175], ['gadget', 250]],
  rowCount: 2,
  elapsedMs: 12,
  totalMs: 48,
  truncated: false,
  note: 'Executed on the loom-duckdb serving tier (embedded DuckDB reading your lake in place).',
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); flagValue = true; });

describe('SqlLabEditor — DuckDB tier wired', () => {
  it('badges the real engine version and the extensions it actually loaded', async () => {
    installFetchMock({ '/api/duckdb/capabilities': () => CONFIGURED_CAPS });
    renderWithProviders(<SqlLabEditor item={ITEM} id="lab-1" />);

    await waitFor(() => expect(screen.getByText('DuckDB 1.1.3')).toBeInTheDocument());
    expect(screen.getByText('httpfs · azure · delta · iceberg')).toBeInTheDocument();
  });

  it('runs through the audited BFF and prints the MEASURED status bar', async () => {
    const { calls } = installFetchMock({
      '/api/duckdb/capabilities': () => CONFIGURED_CAPS,
      '/api/duckdb/query': () => DUCKDB_RESULT,
    });
    renderWithProviders(<SqlLabEditor item={ITEM} id="lab-1" />);

    await waitFor(() => expect(screen.getByText('DuckDB 1.1.3')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() =>
      expect(screen.getByText('2 rows · 12 ms engine · 48 ms round-trip · duckdb')).toBeInTheDocument());
    // getAllByText: the engine note renders in both the status bar and the
    // results header, so uniqueness is the wrong assertion — presence is.
    expect(screen.getAllByText(/reading your lake in place/).length).toBeGreaterThan(0);

    const run = calls.find((c) => c.url.includes('/api/duckdb/query'));
    expect(run).toBeTruthy();
    expect(JSON.parse(String(run!.init!.body))).toMatchObject({ itemId: 'lab-1', maxRows: 5000 });
  });

  it('surfaces a refused statement inline instead of an empty grid', async () => {
    installFetchMock({
      '/api/duckdb/capabilities': () => CONFIGURED_CAPS,
      '/api/duckdb/query': () => ({ ok: false, error: 'DROP is a write/DDL statement. The tier is read-only.' }),
    });
    renderWithProviders(<SqlLabEditor item={ITEM} id="lab-1" />);

    await waitFor(() => expect(screen.getByText('DuckDB 1.1.3')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(screen.getByText('Query failed')).toBeInTheDocument());
    expect(screen.getByText(/write\/DDL statement/)).toBeInTheDocument();
  });
});

describe('SqlLabEditor — tier not deployed (honest fallback)', () => {
  it('renders the full surface, names Synapse Serverless, and offers the Fix-it gate', async () => {
    installFetchMock({ '/api/duckdb/capabilities': () => FALLBACK_CAPS });
    renderWithProviders(<SqlLabEditor item={ITEM} id="lab-1" />);

    await waitFor(() => expect(screen.getByText('Synapse Serverless')).toBeInTheDocument());
    // The query surface is present, not gated away.
    expect(screen.getByRole('button', { name: 'Run' })).toBeInTheDocument();
    expect(screen.getByLabelText('SQL Lab query editor')).toBeInTheDocument();
    // And all three tiers remain reachable.
    expect(screen.getByRole('tab', { name: /Local analysis/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Connect/ })).toBeInTheDocument();
  });

  it('explains in the Local analysis tab why there is no Arrow to slice yet', async () => {
    installFetchMock({ '/api/duckdb/capabilities': () => FALLBACK_CAPS });
    renderWithProviders(<SqlLabEditor item={ITEM} id="lab-1" />);

    await waitFor(() => expect(screen.getByText('Synapse Serverless')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: /Local analysis/ }));

    await waitFor(() =>
      expect(screen.getByText(/no Arrow payload to analyze in the browser yet/)).toBeInTheDocument());
    // Honest, not red, and the server path is unaffected.
    expect(screen.getByText(/Your query still runs/)).toBeInTheDocument();
  });
});

describe('SqlLabEditor — FLAG0 kill switch', () => {
  it('reverts to a guided notice that says the backend is untouched', async () => {
    flagValue = false;
    installFetchMock({ '/api/duckdb/capabilities': () => CONFIGURED_CAPS });
    renderWithProviders(<SqlLabEditor item={ITEM} id="lab-1" />);

    await waitFor(() =>
      expect(screen.getByText('SQL Lab is turned off for this deployment')).toBeInTheDocument());
    expect(screen.getByText(/Runtime flags/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run' })).toBeNull();
  });
});
