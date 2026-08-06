/**
 * DataContractEditor — behaviour specs (FINISHLINE C14).
 *
 * `data-contract` had no editor test. The subtlest and most valuable behaviour
 * on this surface is the DERIVE MERGE (editor :104-132): re-deriving the schema
 * from the bound ADX table must be a DIFF, not a wipe —
 *   - columns the steward already annotated keep their description /
 *     classification / primaryKey / nullable
 *   - columns the source dropped are removed
 *   - new source columns are appended
 * A regression that turned this into a plain overwrite would silently destroy
 * every PII classification on the contract — and the UI would look like it
 * worked, because the column list would still be full. That is exactly the
 * class of defect a unit test catches and a click-walk does not.
 *
 * Also pinned: the ADX browse cascade, the honest ADX gate, and the derive
 * failure path.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { DataContractEditor } from '../data-contract-editor';
import { makeItem, renderWithProviders } from './test-helpers';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

interface Call { url: string; init?: RequestInit }

function installFetch(opts: {
  state?: Record<string, unknown>;
  databases?: string[];
  tables?: string[];
  adxGate?: string;
  introspect?: () => Response;
} = {}) {
  const calls: Call[] = [];
  vi.spyOn(global, 'fetch').mockImplementation(async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input?.toString?.() ?? input);
    calls.push({ url, init });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) as any;

    if (url.includes('/introspect')) {
      return (opts.introspect
        ? opts.introspect()
        : json({ ok: true, database: 'loomdb', table: 'orders', columns: [] })) as any;
    }
    if (url.includes('browse=databases')) {
      return json({
        ok: true,
        databases: opts.databases ?? ['loomdb'],
        gate: opts.adxGate ? { adx: { missing: opts.adxGate } } : undefined,
      });
    }
    if (url.includes('browse=tables')) return json({ ok: true, tables: opts.tables ?? ['orders'] });
    if (url.includes('/quality')) return json({ ok: true, results: [] });
    if (url.includes('/odcs')) return json({ ok: true });
    if (url.includes('/api/items/data-contract/')) return json({ ok: true, state: opts.state ?? {} });
    return json({ ok: true });
  });
  return calls;
}

const col = (name: string, over: Record<string, unknown> = {}) =>
  ({ name, type: 'string', ...over });

function renderEditor(id = 'dc-fixture') {
  return renderWithProviders(<DataContractEditor item={makeItem('data-contract', 'Data Contract')} id={id} />);
}

const deriveBtn = () => screen.getByRole('button', { name: /Derive schema from this table|Deriving/ });

describe('DataContractEditor — ADX binding cascade', () => {
  it('populates the database dropdown from a real browse call', async () => {
    installFetch({ databases: ['loomdb', 'salesdb'] });
    renderEditor();

    await waitFor(() => expect(screen.getByText('Validate against a table')).toBeInTheDocument());
    const combo = screen.getByRole('combobox', { name: /ADX database/i });
    fireEvent.click(combo);
    await waitFor(() => expect(screen.getByText('salesdb')).toBeInTheDocument());
  });

  it('loads tables for the persisted database on first render', async () => {
    installFetch({ state: { databaseName: 'loomdb' }, tables: ['orders', 'customers'] });
    renderEditor();

    await waitFor(() => {
      const combo = screen.getByRole('combobox', { name: /^Table$/i });
      expect(combo).toBeEnabled();
    });
  });

  it('surfaces the honest ADX gate with the exact env var and the bicep module', async () => {
    installFetch({ adxGate: 'LOOM_ADX_CLUSTER_URI' });
    renderEditor();

    await waitFor(() => expect(screen.getByText('ADX not configured')).toBeInTheDocument());
    expect(screen.getByText('LOOM_ADX_CLUSTER_URI')).toBeInTheDocument();
    // Naming the module that would deploy it is what makes the gate actionable.
    expect(screen.getByText(/adx-cluster\.bicep/)).toBeInTheDocument();
  });

  it('disables Derive until a table is bound', async () => {
    installFetch();
    renderEditor();
    await waitFor(() => expect(deriveBtn()).toBeDisabled());
  });
});

describe('DataContractEditor — derive-from-table is a DIFF, not a wipe', () => {
  const annotated = {
    contract: {
      schema: [
        col('order_id', { description: 'Business key', classification: 'internal', primaryKey: true, nullable: false }),
        col('email', { description: 'Customer email', classification: 'PII', nullable: true }),
        col('legacy_flag', { description: 'to be removed', classification: 'internal' }),
      ],
      slos: [], expectations: [],
    },
    databaseName: 'loomdb',
    databaseTable: 'orders',
  };

  it('PRESERVES steward annotations on columns that still exist in the source', async () => {
    // The regression this catches: a plain overwrite would drop every
    // classification, silently declassifying PII while the column list still
    // looks complete.
    const calls = installFetch({
      state: annotated,
      introspect: () =>
        new Response(JSON.stringify({
          ok: true, database: 'loomdb', table: 'orders',
          columns: [col('order_id', { type: 'long' }), col('email', { type: 'string' })],
        }), { status: 200, headers: { 'content-type': 'application/json' } }) as any,
    });
    renderEditor();

    await waitFor(() => expect(deriveBtn()).toBeEnabled());
    fireEvent.click(deriveBtn());

    await waitFor(() =>
      expect(screen.getByText('Schema derived from the bound table')).toBeInTheDocument(),
    );

    // Save and inspect what would be persisted — the merged contract.
    fireEvent.click(screen.getByRole('button', { name: /Save contract/ }));
    await waitFor(() => {
      const patch = calls.find((c) => c.init?.method === 'PATCH');
      expect(patch, 'Save must PATCH the merged contract').toBeTruthy();
      const schema = JSON.parse(String(patch!.init!.body)).state.contract.schema;
      const byName = Object.fromEntries(schema.map((c: any) => [c.name, c]));

      // Annotations survived the re-derive...
      expect(byName.email.classification).toBe('PII');
      expect(byName.email.description).toBe('Customer email');
      expect(byName.order_id.primaryKey).toBe(true);
      expect(byName.order_id.description).toBe('Business key');
      // ...while the SOURCE's type won (the source is authoritative for type).
      expect(byName.order_id.type).toBe('long');
    });
  });

  it('REMOVES a column the source no longer has', async () => {
    const calls = installFetch({
      state: annotated,
      introspect: () =>
        new Response(JSON.stringify({
          ok: true, database: 'loomdb', table: 'orders',
          columns: [col('order_id'), col('email')],
        }), { status: 200, headers: { 'content-type': 'application/json' } }) as any,
    });
    renderEditor();

    await waitFor(() => expect(deriveBtn()).toBeEnabled());
    fireEvent.click(deriveBtn());
    await waitFor(() => expect(screen.getByText('Schema derived from the bound table')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Save contract/ }));
    await waitFor(() => {
      const patch = calls.find((c) => c.init?.method === 'PATCH');
      expect(patch).toBeTruthy();
      const names = JSON.parse(String(patch!.init!.body)).state.contract.schema.map((c: any) => c.name);
      expect(names).not.toContain('legacy_flag');
      expect(names).toEqual(['order_id', 'email']);
    });
  });

  it('APPENDS a new source column with no stale annotation attached', async () => {
    const calls = installFetch({
      state: annotated,
      introspect: () =>
        new Response(JSON.stringify({
          ok: true, database: 'loomdb', table: 'orders',
          columns: [col('order_id'), col('email'), col('region')],
        }), { status: 200, headers: { 'content-type': 'application/json' } }) as any,
    });
    renderEditor();

    await waitFor(() => expect(deriveBtn()).toBeEnabled());
    fireEvent.click(deriveBtn());
    await waitFor(() => expect(screen.getByText('Schema derived from the bound table')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Save contract/ }));
    await waitFor(() => {
      const patch = calls.find((c) => c.init?.method === 'PATCH');
      expect(patch).toBeTruthy();
      const schema = JSON.parse(String(patch!.init!.body)).state.contract.schema;
      const region = schema.find((c: any) => c.name === 'region');
      expect(region, 'a new source column must be appended').toBeTruthy();
      // It must NOT inherit another column's classification.
      expect(region.classification).toBeUndefined();
    });
  });

  it('reports the derived column count and the source table in the success message', async () => {
    installFetch({
      state: annotated,
      introspect: () =>
        new Response(JSON.stringify({
          ok: true, database: 'loomdb', table: 'orders',
          columns: [col('a'), col('b'), col('c')],
        }), { status: 200, headers: { 'content-type': 'application/json' } }) as any,
    });
    renderEditor();

    await waitFor(() => expect(deriveBtn()).toBeEnabled());
    fireEvent.click(deriveBtn());

    await waitFor(() =>
      expect(screen.getByText(/Derived 3 columns from loomdb\.orders/)).toBeInTheDocument(),
    );
    // And tells the user the change is not yet persisted.
    expect(screen.getByText(/Save the contract to persist them/)).toBeInTheDocument();
  });

  it('surfaces a derive failure honestly and leaves the existing schema intact', async () => {
    const calls = installFetch({
      state: annotated,
      introspect: () =>
        new Response(JSON.stringify({ ok: false, error: 'Table orders not found in loomdb' }),
          { status: 200, headers: { 'content-type': 'application/json' } }) as any,
    });
    renderEditor();

    await waitFor(() => expect(deriveBtn()).toBeEnabled());
    fireEvent.click(deriveBtn());

    await waitFor(() => expect(screen.getByText('Could not derive the schema')).toBeInTheDocument());
    expect(screen.getByText('Table orders not found in loomdb')).toBeInTheDocument();

    // Critically: a failed derive must NOT have wiped the contract.
    fireEvent.click(screen.getByRole('button', { name: /Save contract/ }));
    await waitFor(() => {
      const patch = calls.find((c) => c.init?.method === 'PATCH');
      if (patch) {
        const names = JSON.parse(String(patch!.init!.body)).state.contract.schema.map((c: any) => c.name);
        expect(names).toContain('email');
        expect(names).toContain('legacy_flag');
      } else {
        // Save is disabled while clean — equally acceptable, and proves nothing
        // was mutated by the failed derive.
        expect(screen.getByRole('button', { name: /Save contract/ })).toBeDisabled();
      }
    });
  });
});

describe('DataContractEditor — contract stat badges', () => {
  it('counts columns, SLOs and expectations off the REAL contract shape', async () => {
    // The shape matters: contractStats() counts `schema` (array), the truthy
    // values of `slo` (an OBJECT of quantified targets), and `quality` (array).
    // Encoding it here means a model rename cannot slip past with the badges
    // silently reading 0.
    installFetch({
      state: {
        contract: {
          schema: [col('a'), col('b')],
          slo: { freshnessMinutes: 60, availabilityPct: null, completenessPct: 99 },
          quality: [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }],
        },
      },
    });
    renderEditor();

    await waitFor(() => expect(screen.getByText('2 columns')).toBeInTheDocument());
    // Only the two truthy SLO targets count; the null one does not.
    expect(screen.getByText('2 SLOs')).toBeInTheDocument();
    expect(screen.getByText('3 expectations')).toBeInTheDocument();
  });

  it('singularises the badges for a one-of-each contract', async () => {
    installFetch({
      state: { contract: { schema: [col('a')], slo: { freshnessMinutes: 60 }, quality: [{ id: 'e1' }] } },
    });
    renderEditor();

    await waitFor(() => expect(screen.getByText('1 column')).toBeInTheDocument());
    expect(screen.getByText('1 SLO')).toBeInTheDocument();
    expect(screen.getByText('1 expectation')).toBeInTheDocument();
  });
});
