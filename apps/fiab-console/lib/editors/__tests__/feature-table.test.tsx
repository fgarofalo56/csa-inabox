/**
 * FeatureTableEditor — behaviour specs (FINISHLINE C14).
 *
 * `feature-table` had no editor test. These pin the contracts that decide
 * whether a training set is CORRECT rather than merely produced:
 *   - the create gate requires a timestamp key. Databricks makes the TIMESERIES
 *     designation optional and then silently degrades point-in-time joins to
 *     exact-match; Loom makes it mandatory. If that gate ever relaxes, every
 *     downstream training set becomes subtly leaky and nothing visibly breaks.
 *   - the PIT-join request must carry the spine keys/timestamp verbatim
 *   - Preview-SQL must NOT execute (it is the "show me before you run it" path)
 *   - PIT / Serving tabs stay disabled until a spec exists — those routes 404
 *     without one
 *   - both gates (offline + online) render via the shared HonestGate
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { FeatureTableEditor } from '../feature-table-editor';
import { makeItem, renderWithProviders } from './test-helpers';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

interface Call { url: string; init?: RequestInit }

const SPEC = {
  fullName: 'main.default.customer_features',
  primaryKeys: ['customer_id'],
  timestampKey: 'event_ts',
  features: [{ name: 'total_spend_30d', dataType: 'DOUBLE' }],
  offlineBackend: 'databricks',
  onlineTable: 'lakebase.customer_features_online',
};

function installFetch(opts: {
  spec?: typeof SPEC | null;
  backend?: string;
  gate?: Record<string, string>;
  onlineGate?: Record<string, string>;
  pit?: () => Response;
  create?: () => Response;
} = {}) {
  const calls: Call[] = [];
  vi.spyOn(global, 'fetch').mockImplementation(async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input?.toString?.() ?? input);
    calls.push({ url, init });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) as any;

    if (url.includes('/pit-join')) {
      return (opts.pit ? opts.pit() : json({ ok: true, sql: 'SELECT 1', columns: [], rows: [], rowCount: 0, executionMs: 3 })) as any;
    }
    if (url.includes('/online')) return json({ ok: true, published: 5, onlineTable: SPEC.onlineTable });
    if (url.includes('/serve')) return json({ ok: true, features: {}, status: 200, latencyMs: 12, result: {} });
    if (url.includes('/api/items/feature-table/')) {
      if (init?.method === 'POST') {
        return (opts.create ? opts.create() : json({ ok: true, spec: SPEC, message: 'Feature table created.' })) as any;
      }
      return json({
        ok: true,
        backend: opts.backend ?? 'databricks',
        spec: opts.spec === undefined ? null : opts.spec,
        gate: opts.gate ?? null,
        onlineGate: opts.onlineGate ?? null,
        defaults: { catalog: 'main', schema: 'default' },
      });
    }
    return json({ ok: true });
  });
  return calls;
}

function renderEditor(id = 'ft-fixture') {
  return renderWithProviders(<FeatureTableEditor item={makeItem('feature-table', 'Feature Table')} id={id} />);
}

const tab = (name: string) => screen.getByRole('tab', { name });

describe('FeatureTableEditor — the create gate (point-in-time correctness)', () => {
  it('requires a TIMESTAMP KEY before the feature table can be created', async () => {
    // This is the load-bearing gate. Without an event-time column the join
    // degrades from as-of to exact-match and every training set silently leaks
    // future information — with no visible symptom.
    installFetch({ spec: null });
    renderEditor();

    fireEvent.click(await screen.findByRole('tab', { name: 'Define' }));
    await waitFor(() => expect(screen.getByPlaceholderText('customer_features')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('customer_features'), { target: { value: 'ft' } });
    fireEvent.change(screen.getByPlaceholderText('customer_id'), { target: { value: 'cid' } });
    fireEvent.change(screen.getByPlaceholderText('total_spend_30d'), { target: { value: 'spend' } });

    // Everything EXCEPT the timestamp key is set — creation must still be blocked.
    expect(screen.getByRole('button', { name: /Create feature table/ })).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText('event_ts'), { target: { value: 'ts' } });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Create feature table/ })).toBeEnabled(),
    );
  });

  it('requires at least one entity key and one named feature', async () => {
    installFetch({ spec: null });
    renderEditor();

    fireEvent.click(await screen.findByRole('tab', { name: 'Define' }));
    await waitFor(() => expect(screen.getByPlaceholderText('customer_features')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('customer_features'), { target: { value: 'ft' } });
    fireEvent.change(screen.getByPlaceholderText('event_ts'), { target: { value: 'ts' } });
    // No entity key yet.
    expect(screen.getByRole('button', { name: /Create feature table/ })).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText('customer_id'), { target: { value: 'cid' } });
    // Still no NAMED feature.
    expect(screen.getByRole('button', { name: /Create feature table/ })).toBeDisabled();
  });

  it('POSTs the composed three-part name and the parsed key list', async () => {
    const calls = installFetch({ spec: null });
    renderEditor();

    fireEvent.click(await screen.findByRole('tab', { name: 'Define' }));
    await waitFor(() => expect(screen.getByPlaceholderText('customer_features')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('customer_features'), { target: { value: 'orders_ft' } });
    fireEvent.change(screen.getByPlaceholderText('customer_id'), { target: { value: 'cid, region' } });
    fireEvent.change(screen.getByPlaceholderText('event_ts'), { target: { value: 'ts' } });
    fireEvent.change(screen.getByPlaceholderText('total_spend_30d'), { target: { value: 'spend' } });

    await waitFor(() => expect(screen.getByRole('button', { name: /Create feature table/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /Create feature table/ }));

    await waitFor(() => {
      const post = calls.find((c) => c.init?.method === 'POST' && !c.url.includes('/pit-join'));
      expect(post).toBeTruthy();
      const body = JSON.parse(String(post!.init!.body));
      // Defaults from the route fill catalog/schema; the table is what was typed.
      expect(body.fullName).toBe('main.default.orders_ft');
      // Comma-separated keys are parsed and trimmed, not passed as one string.
      expect(body.primaryKeys).toEqual(['cid', 'region']);
      expect(body.timestampKey).toBe('ts');
      expect(body.features).toEqual([{ name: 'spend', dataType: 'DOUBLE' }]);
    });
  });
});

describe('FeatureTableEditor — tab gating', () => {
  it('disables the PIT and Serving tabs until a feature table exists', async () => {
    // Those routes have nothing to operate on without a spec.
    installFetch({ spec: null });
    renderEditor();

    await waitFor(() => expect(tab('Overview')).toBeInTheDocument());
    expect(tab('Point-in-time join')).toBeDisabled();
    expect(tab('Online serving')).toBeDisabled();
    expect(screen.getByText(/No feature table defined yet/)).toBeInTheDocument();
  });

  it('enables them once a spec is loaded, and shows the spec summary', async () => {
    installFetch({ spec: SPEC });
    renderEditor();

    await waitFor(() => expect(tab('Point-in-time join')).toBeEnabled());
    expect(tab('Online serving')).toBeEnabled();
    expect(screen.getByText('main.default.customer_features')).toBeInTheDocument();
    expect(screen.getByText('1 key(s)')).toBeInTheDocument();
    expect(screen.getByText('ts: event_ts')).toBeInTheDocument();
  });
});

describe('FeatureTableEditor — point-in-time join', () => {
  it('Preview SQL requests preview:true and renders SQL WITHOUT running the join', async () => {
    // "Show me the query before you run it" — if preview ever executed, a user
    // inspecting a join would trigger a real warehouse query.
    const calls = installFetch({
      spec: SPEC,
      pit: () =>
        new Response(JSON.stringify({ ok: true, sql: 'SELECT * FROM main.default.customer_features AS OF spine.ts' }),
          { status: 200, headers: { 'content-type': 'application/json' } }) as any,
    });
    renderEditor();

    fireEvent.click(await screen.findByRole('tab', { name: 'Point-in-time join' }));
    await waitFor(() => expect(screen.getByPlaceholderText('main.default.training_labels')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('main.default.training_labels'), { target: { value: 'main.default.labels' } });

    fireEvent.click(screen.getByRole('button', { name: 'Preview SQL' }));

    await waitFor(() => expect(screen.getByText(/AS OF spine\.ts/)).toBeInTheDocument());
    const post = calls.find((c) => c.url.includes('/pit-join'));
    expect(post).toBeTruthy();
    expect(JSON.parse(String(post!.init!.body)).preview).toBe(true);
    // No result grid on a preview.
    expect(screen.queryByLabelText('PIT join result')).not.toBeInTheDocument();
  });

  it('Run join sends preview:false with the spine keys, timestamp and carry columns', async () => {
    const calls = installFetch({
      spec: SPEC,
      pit: () =>
        new Response(JSON.stringify({
          ok: true, sql: 'SELECT 1', columns: ['customer_id', 'total_spend_30d', 'label'],
          rows: [['c1', 42.0, 1]], rowCount: 1, executionMs: 128,
        }), { status: 200, headers: { 'content-type': 'application/json' } }) as any,
    });
    renderEditor();

    fireEvent.click(await screen.findByRole('tab', { name: 'Point-in-time join' }));
    await waitFor(() => expect(screen.getByPlaceholderText('main.default.training_labels')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('main.default.training_labels'), { target: { value: 'main.default.labels' } });
    fireEvent.change(screen.getByPlaceholderText('label_ts'), { target: { value: 'label_ts' } });
    fireEvent.change(screen.getByPlaceholderText('label'), { target: { value: 'label, weight' } });

    fireEvent.click(screen.getByRole('button', { name: /Run join/ }));

    await waitFor(() => expect(screen.getByText('1 rows · 128 ms')).toBeInTheDocument());
    const post = calls.filter((c) => c.url.includes('/pit-join')).pop();
    expect(post).toBeTruthy();
    const body = JSON.parse(String(post!.init!.body));
    expect(body.preview).toBe(false);
    expect(body.spine.fullName).toBe('main.default.labels');
    expect(body.spine.timestampKey).toBe('label_ts');
    // Spine keys are pre-seeded from the spec's primary keys.
    expect(body.spine.entityKeys).toEqual(['customer_id']);
    expect(body.spine.carryColumns).toEqual(['label', 'weight']);
    // Results render.
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('surfaces a PIT-join error rather than rendering an empty grid', async () => {
    installFetch({
      spec: SPEC,
      pit: () =>
        new Response(JSON.stringify({ ok: false, error: 'spine table not found' }),
          { status: 200, headers: { 'content-type': 'application/json' } }) as any,
    });
    renderEditor();

    fireEvent.click(await screen.findByRole('tab', { name: 'Point-in-time join' }));
    await waitFor(() => expect(screen.getByPlaceholderText('main.default.training_labels')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('main.default.training_labels'), { target: { value: 'x.y.z' } });
    fireEvent.change(screen.getByPlaceholderText('label_ts'), { target: { value: 'ts' } });
    fireEvent.click(screen.getByRole('button', { name: /Run join/ }));

    await waitFor(() => expect(screen.getByText('spine table not found')).toBeInTheDocument());
  });
});

describe('FeatureTableEditor — honest gates (G2)', () => {
  it('renders the offline gate and disables the Define inputs behind it', async () => {
    installFetch({
      spec: null,
      gate: { gateId: 'svc-feature-store', backend: 'databricks', missing: 'LOOM_DATABRICKS_HOST', fixEnvVar: 'LOOM_DATABRICKS_HOST', hint: 'wire a Databricks workspace' },
    });
    renderEditor();

    fireEvent.click(await screen.findByRole('tab', { name: 'Define' }));
    // Inputs are disabled while gated — no dead button that POSTs into a void.
    await waitFor(() => expect(screen.getByPlaceholderText('customer_features')).toBeDisabled());
    expect(screen.getByRole('button', { name: /Create feature table/ })).toBeDisabled();
  });

  it('shows the sovereign PostgreSQL backend badge on the Gov path', async () => {
    // The Gov path takes different code through every control; the badge is the
    // only on-screen signal of which one is live.
    installFetch({ spec: null, backend: 'postgres' });
    renderEditor();

    await waitFor(() => expect(screen.getByText('OSS Unity Catalog + PostgreSQL')).toBeInTheDocument());
    expect(screen.getByText('sovereign / Gov path')).toBeInTheDocument();
  });
});
