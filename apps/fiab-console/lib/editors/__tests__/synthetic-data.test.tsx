/**
 * SyntheticDataEditor — behaviour specs (FINISHLINE C14).
 *
 * `synthetic-data` had no editor test. The highest-stakes property of this
 * surface is the PII guarantee: columns a data contract classified as PII must
 * be mapped to SYNTHETIC generation strategies so no real personal data is ever
 * emitted. A regression there is a privacy incident that the UI would not show.
 *
 * These pin:
 *   - PII contract columns are seeded as synthetic AND badged as such
 *   - the generate gate (5 required inputs) — a partial target must not fire a
 *     write against Unity Catalog
 *   - the preview request caps rows at 10 regardless of the configured count
 *   - the seed reaches the backend (reproducibility is a documented promise)
 *   - a FAILED generation is still recorded in history, not lost
 *   - the Databricks gate states that preview still works
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { SyntheticDataEditor } from '../synthetic-data-editor';
import { makeItem, renderWithProviders } from './test-helpers';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

interface Call { url: string; init?: RequestInit }

function installFetch(opts: {
  state?: Record<string, unknown>;
  contracts?: { id: string; name: string; columns: { name: string; type?: string; classification?: string }[] }[];
  warehouses?: { id: string; name: string; state?: string }[];
  dbxGate?: string;
  preview?: () => Response;
  generate?: () => Response;
} = {}) {
  const calls: Call[] = [];
  vi.spyOn(global, 'fetch').mockImplementation(async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input?.toString?.() ?? input);
    calls.push({ url, init });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) as any;

    if (url.includes('/sources')) return json({ ok: true, contracts: opts.contracts ?? [] });
    if (url.includes('/catalog')) {
      if (opts.dbxGate) return json({ ok: true, gate: { missing: opts.dbxGate } });
      if (url.includes('level=schemas')) return json({ ok: true, schemas: ['default'] });
      if (url.includes('level=volumes')) return json({ ok: true, volumes: ['staging'] });
      if (url.includes('level=catalogs')) return json({ ok: true, catalogs: ['main'] });
      return json({ ok: true, warehouses: opts.warehouses ?? [{ id: 'wh1', name: 'Serverless', state: 'RUNNING' }] });
    }
    if (url.includes('/preview')) {
      return (opts.preview ? opts.preview() : json({ ok: true, columns: [], rows: [] })) as any;
    }
    if (url.includes('/generate')) {
      return (opts.generate ? opts.generate() : json({ ok: true, run: aRun() })) as any;
    }
    if (url.includes('/api/items/synthetic-data/')) return json({ ok: true, state: opts.state ?? {} });
    return json({ ok: true });
  });
  return calls;
}

const aRun = (over: Record<string, unknown> = {}) => ({
  id: 'g1', startedAt: new Date().toISOString(), target: 'main.default.synthetic_orders',
  requestedRows: 100, rowsWritten: 100, status: 'succeeded', ...over,
});

function renderEditor(id = 'sd-fixture') {
  return renderWithProviders(<SyntheticDataEditor item={makeItem('synthetic-data', 'Synthetic Data')} id={id} />);
}

const previewBtn = () => screen.getByRole('button', { name: /Preview sample|Previewing/ });
const generateBtn = () => screen.getByRole('button', { name: /Generate table|Generating/ });

/** A fully-configured item: specs + every write-target field set. */
const readyState = {
  specs: [{ name: 'amount', type: 'double', strategy: 'normal', options: { mean: 10, stddev: 2 } }],
  rowCount: 100, seed: 42,
  warehouseId: 'wh1', catalog: 'main', schema: 'default', volume: 'staging', table: 'synthetic_orders',
};

describe('SyntheticDataEditor — the PII guarantee', () => {
  it('seeds a PII-classified contract column as a SYNTHETIC strategy and badges it', async () => {
    installFetch({
      contracts: [{
        id: 'c1', name: 'Customers',
        columns: [
          { name: 'email', type: 'string', classification: 'PII' },
          { name: 'amount', type: 'double' },
        ],
      }],
    });
    renderEditor();

    await waitFor(() => expect(screen.getByText('Source schema')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('radio', { name: 'From a data contract' }));

    // Pick the contract from the dropdown.
    const combo = await screen.findByRole('combobox', { name: /Data contract/i });
    fireEvent.click(combo);
    fireEvent.click(await screen.findByText(/Customers/));

    // The PII column arrives with the PII->synthetic badge. If inferStrategy
    // ever stopped honouring `classification`, real emails could be emitted and
    // NOTHING else on the surface would show it.
    await waitFor(() => expect(screen.getByText('PII→synthetic')).toBeInTheDocument());
    // Both columns are seeded, not just the safe one.
    expect(screen.getByDisplayValue('email')).toBeInTheDocument();
    expect(screen.getByDisplayValue('amount')).toBeInTheDocument();
  });

  it('states the no-real-data guarantee on the surface', async () => {
    installFetch();
    renderEditor();
    await waitFor(() =>
      expect(screen.getByText(/no source row is copied/i)).toBeInTheDocument(),
    );
  });
});

describe('SyntheticDataEditor — the generate gate', () => {
  it('disables Generate until specs AND every write-target field are set', async () => {
    // A partial target must never fire a real Unity Catalog write.
    installFetch({ state: { specs: [{ name: 'a', type: 'string', strategy: 'categorical', options: { values: ['x'] } }] } });
    renderEditor();

    await waitFor(() => expect(screen.getByText('Write target')).toBeInTheDocument());
    expect(generateBtn()).toBeDisabled();
    expect(screen.getByText(/Add columns and pick a warehouse, catalog, schema, volume and table/)).toBeInTheDocument();
  });

  it('enables Generate once specs + warehouse + catalog + schema + volume + table are all present', async () => {
    installFetch({ state: readyState });
    renderEditor();
    await waitFor(() => expect(generateBtn()).toBeEnabled());
  });

  it('keeps Preview available with NO write target (preview needs no backend)', async () => {
    installFetch({ state: { specs: readyState.specs } });
    renderEditor();

    await waitFor(() => expect(previewBtn()).toBeEnabled());
    expect(generateBtn()).toBeDisabled();
  });

  it('disables Preview when there are no column specs at all', async () => {
    installFetch({ state: { specs: [] } });
    renderEditor();
    await waitFor(() => expect(previewBtn()).toBeDisabled());
  });
});

describe('SyntheticDataEditor — request shapes', () => {
  it('caps the PREVIEW row count at 10 regardless of the configured count', async () => {
    // Previewing 200,000 rows would hang the surface; the clamp is the contract.
    const calls = installFetch({ state: { ...readyState, rowCount: 200000 } });
    renderEditor();

    await waitFor(() => expect(previewBtn()).toBeEnabled());
    fireEvent.click(previewBtn());

    await waitFor(() => {
      const post = calls.find((c) => c.init?.method === 'POST' && c.url.includes('/preview'));
      expect(post).toBeTruthy();
      const body = JSON.parse(String(post!.init!.body));
      expect(body.rowCount).toBe(10);
      expect(body.seed).toBe(42);
    });
  });

  it('sends the full row count, seed and resolved target on GENERATE', async () => {
    const calls = installFetch({ state: readyState });
    renderEditor();

    await waitFor(() => expect(generateBtn()).toBeEnabled());
    fireEvent.click(generateBtn());

    await waitFor(() => {
      const post = calls.find((c) => c.init?.method === 'POST' && c.url.includes('/generate'));
      expect(post).toBeTruthy();
      const body = JSON.parse(String(post!.init!.body));
      expect(body.rowCount).toBe(100);
      // The seed is the reproducibility promise ("same seed reproduces the same
      // rows") — dropping it silently breaks that guarantee.
      expect(body.seed).toBe(42);
      expect(body.catalog).toBe('main');
      expect(body.schema).toBe('default');
      expect(body.volume).toBe('staging');
      expect(body.table).toBe('synthetic_orders');
      expect(body.warehouseId).toBe('wh1');
    });
  });

  it('renders the previewed rows, showing nulls distinctly', async () => {
    installFetch({
      state: readyState,
      preview: () =>
        new Response(JSON.stringify({
          ok: true, columns: ['amount', 'note'], rows: [{ amount: 11.2, note: null }],
        }), { status: 200, headers: { 'content-type': 'application/json' } }) as any,
    });
    renderEditor();

    await waitFor(() => expect(previewBtn()).toBeEnabled());
    fireEvent.click(previewBtn());

    await waitFor(() => expect(screen.getByText('11.2')).toBeInTheDocument());
    // A null must be visibly distinct from an empty string, or a null-rate
    // setting looks like it did nothing.
    expect(screen.getByText('∅')).toBeInTheDocument();
  });
});

describe('SyntheticDataEditor — failure handling', () => {
  it('records a FAILED generation in history instead of losing it', async () => {
    // A failed write is exactly the run a user needs to see afterwards.
    installFetch({
      state: readyState,
      generate: () =>
        new Response(JSON.stringify({
          ok: false, error: 'volume not found', hint: 'create the UC volume first',
          run: aRun({ status: 'failed', rowsWritten: null }),
        }), { status: 200, headers: { 'content-type': 'application/json' } }) as any,
    });
    renderEditor();

    await waitFor(() => expect(generateBtn()).toBeEnabled());
    fireEvent.click(generateBtn());

    await waitFor(() =>
      expect(screen.getByText(/volume not found — create the UC volume first/)).toBeInTheDocument(),
    );
    // The failed run reaches the Runs tab.
    fireEvent.click(screen.getByRole('tab', { name: /Runs/ }));
    await waitFor(() => expect(screen.getByText('failed')).toBeInTheDocument());
  });

  it('states that Preview still works when Databricks is not configured', async () => {
    // An honest gate that would otherwise imply the whole surface is dead.
    installFetch({ dbxGate: 'LOOM_DATABRICKS_HOST' });
    renderEditor();

    await waitFor(() => expect(screen.getByText('Databricks not configured')).toBeInTheDocument());
    expect(screen.getByText('LOOM_DATABRICKS_HOST')).toBeInTheDocument();
    expect(screen.getByText(/Preview still works with no backend/)).toBeInTheDocument();
  });
});
