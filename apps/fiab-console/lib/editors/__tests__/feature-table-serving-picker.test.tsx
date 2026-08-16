/**
 * FeatureTableEditor → serving-endpoint picker (Vitest, jsdom).
 *
 * "Look up + invoke" posts an endpoint NAME to POST .../serve, which hands it
 * straight to `invokeServingEndpoint`. The field used to ask the user to type
 * that name from memory. These tests hold the replacement:
 *
 *   - it lists from the BACKEND-AGNOSTIC route. `invokeServingEndpoint`
 *     dispatches on `resolveServingBackend()` — Azure ML by default, Databricks
 *     Mosaic only on opt-in — so a picker fed by `/api/databricks/serving-endpoints`
 *     would offer names the invoke path cannot call on the default backend, and
 *     Databricks model serving is not GA in Azure Government at all
 *     (`cloud-parity.md`).
 *   - a selected endpoint that DISAPPEARS from a later list is still shown and
 *     still reaches the POST body. That is the same preservation property the
 *     persisted surfaces need, exercised where this surface actually has one:
 *     the value is transient input to an action, not a saved field.
 *   - an empty or gated list never disables the control.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
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

const AML_ENDPOINTS = {
  ok: true,
  backend: 'aml',
  endpoints: [
    { name: 'fraud-scorer', backend: 'aml', state: 'Succeeded' },
    { name: 'churn-scorer', backend: 'aml', state: 'Succeeded' },
  ],
};

/** `endpointsQueue` lets a test change what the list returns between loads. */
function installFetch(opts: { endpoints?: () => unknown } = {}) {
  const calls: Call[] = [];
  vi.spyOn(global, 'fetch').mockImplementation(async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input?.toString?.() ?? input);
    calls.push({ url, init });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) as any;

    if (url.includes('/api/loom/model-serving/endpoints')) {
      return json(opts.endpoints ? opts.endpoints() : AML_ENDPOINTS);
    }
    if (url.includes('/serve')) return json({ ok: true, features: {}, status: 200, latencyMs: 12, result: {} });
    if (url.includes('/online')) return json({ ok: true, published: 5, onlineTable: SPEC.onlineTable });
    if (url.includes('/api/items/feature-table/')) {
      return json({
        ok: true, backend: 'databricks', spec: SPEC, gate: null, onlineGate: null,
        defaults: { catalog: 'main', schema: 'default' },
      });
    }
    return json({ ok: true });
  });
  return calls;
}

async function openServing() {
  renderWithProviders(<FeatureTableEditor item={makeItem('feature-table', 'Feature Table')} id="ft-fixture" />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Online serving' }));
  return screen.findByRole('combobox', { name: 'Serving endpoint' });
}

describe('FeatureTableEditor — the serving endpoint is picked, not typed', () => {
  it('lists from the BACKEND-AGNOSTIC route, not the Databricks-only one', async () => {
    const calls = installFetch();
    const dd = await openServing();
    fireEvent.click(dd);
    await waitFor(() => expect(screen.getByText('fraud-scorer')).toBeInTheDocument());

    expect(calls.some((c) => c.url.includes('/api/loom/model-serving/endpoints'))).toBe(true);
    // The Databricks-only lister would be wrong on the default (AML) backend and
    // unusable in Gov, where Mosaic model serving is not GA.
    expect(calls.some((c) => c.url.includes('/api/databricks/serving-endpoints'))).toBe(false);
  });

  it('the free-text endpoint box is gone', async () => {
    installFetch();
    await openServing();
    expect(screen.queryByPlaceholderText('fraud-scorer')).toBeNull();
  });

  it('a picked endpoint that VANISHES from a later list is still shown and still invoked', async () => {
    // The exact case where a picker that computes its selection from the fetched
    // list blanks a field the user already set — and the action then posts "".
    let listed = true;
    const calls = installFetch({ endpoints: () => (listed ? AML_ENDPOINTS : { ok: true, backend: 'aml', endpoints: [] }) });
    const dd = await openServing();

    fireEvent.click(dd);
    fireEvent.click(await screen.findByText('churn-scorer'));
    await waitFor(() => expect((dd as HTMLInputElement).value).toBe('churn-scorer'));

    // The endpoint is deleted out-of-band; the user refreshes the list.
    listed = false;
    fireEvent.click(screen.getByRole('button', { name: /refresh serving endpoint/i }));
    await waitFor(() => expect(screen.getByText(/not in the endpoints this deployment can list/i)).toBeInTheDocument());
    // Still selected, still disclosed as unresolved — not silently blanked.
    expect((screen.getByRole('combobox', { name: 'Serving endpoint' }) as HTMLInputElement).value).toBe('churn-scorer');

    // …and the invoke still carries it.
    fireEvent.change(screen.getByPlaceholderText('value'), { target: { value: 'c1' } });
    fireEvent.click(screen.getByRole('button', { name: /Look up \+ invoke/ }));
    await waitFor(() => {
      const post = calls.find((c) => c.url.includes('/serve') && c.init?.method === 'POST');
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post!.init!.body)).endpoint).toBe('churn-scorer');
    });
  });

  it('an empty endpoint list leaves the surface usable — no disabled dead end', async () => {
    installFetch({ endpoints: () => ({ ok: true, backend: 'aml', endpoints: [] }) });
    const dd = await openServing();
    await waitFor(() => expect(screen.getByText('No serving endpoints yet')).toBeInTheDocument());
    expect(dd).not.toBeDisabled();
    // Scoped to the picker: the editor has its own unrelated Refresh button.
    expect(within(screen.getByTestId('serving-endpoint-picker')).getByRole('button', { name: 'Refresh' }))
      .toBeInTheDocument();
  });

  it('an honest 503 gate is surfaced verbatim, not flattened into "there are none"', async () => {
    installFetch({
      endpoints: () => ({
        ok: false, code: 'svc-model-serving',
        error: 'Set LOOM_AML_WORKSPACE (+ LOOM_AML_RESOURCE_GROUP) so model-serving endpoints have an Azure Machine Learning workspace.',
        missing: 'LOOM_AML_WORKSPACE (or LOOM_FOUNDRY_NAME)',
      }),
    });
    const dd = await openServing();
    await waitFor(() => expect(screen.getByText(/Set LOOM_AML_WORKSPACE/)).toBeInTheDocument());
    expect(screen.getByText(/Missing: LOOM_AML_WORKSPACE/)).toBeInTheDocument();
    expect(screen.queryByText('No serving endpoints yet')).toBeNull();
    expect(dd).not.toBeDisabled();
  });
});
