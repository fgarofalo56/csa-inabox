/**
 * DataProductDetailEditor (F3) — Vitest contract test.
 *
 * Mounts the owner details page with a mocked GET /api/data-products/[id]
 * response and asserts the real behaviors that matter per the task's VERIFY:
 *   - product name + status badge render from the (mocked) Cosmos doc
 *   - the DQ honest-gate shows the reason the ROUTE established when dqScore is
 *     null (no fabricated number, and no reason the code did not establish)
 *   - the show-empty toggle hides null custom attributes and restores them
 *
 * The gate fixture is the one the route can actually return. It previously
 * asserted `/No data-quality rules configured/i` against a string that had been
 * DELETED from the codebase — the spec passed only because it fabricated the
 * response it then asserted on, i.e. a fixture modelling code that no longer
 * exists. The strings below come from `lib/dataproducts/certification-dq.ts`.
 *
 * Network is caught by installFetchMock; ItemEditorChrome + next/navigation
 * are stubbed by vitest.setup.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within, cleanup } from '@testing-library/react';
import { DataProductDetailEditor } from '../data-product-detail';
import { DQ_GATE, DQ_ADX_GATE_ID } from '@/lib/dataproducts/certification-dq';
import { makeItem, installFetchMock } from './test-helpers';

const PRODUCT = {
  id: 'p1',
  tenantId: 'tid',
  governanceDomainId: 'gd1',
  governanceDomainName: 'Finance',
  name: 'Test product',
  description: 'A real description from Cosmos.',
  status: 'Draft',
  endorsed: true,
  updateFrequency: 'Daily',
  owners: [{ id: 'u1', displayName: 'Alice', upn: 'alice@contoso.com' }],
  customAttributes: [
    { groupName: 'Quality', name: 'SLA', value: '99%' },
    { groupName: 'Quality', name: 'Retention', value: null },
  ],
  termsOfUse: [],
  documentation: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function mountWith(extra: Record<string, unknown> = {}) {
  installFetchMock({
    // Observability tab GET — honest ADX gate (no fake health/lineage). The
    // missing env var is the REAL one the BFF reports (adxConfigGate() →
    // LOOM_KUSTO_CLUSTER_URI). This key MUST be longer than the detail key
    // ('/api/data-products/') so installFetchMock's longest-substring-wins
    // routing picks it for the /observability request.
    '/api/data-products/p1/observability': () => ({
      ok: true,
      lineage: null,
      healthCharts: null,
      dqScore: null,
      gate: { adx: { missing: 'LOOM_KUSTO_CLUSTER_URI' } },
    }),
    '/api/data-products/': () => ({
      ok: true,
      isOwner: true,
      product: PRODUCT,
      dqScore: null,
      // The reason a product with no measurement actually reports.
      dqGate: DQ_GATE.notMeasured,
      dqGateId: null,
      dqMissing: [],
      dqMeasuredAt: null,
      dqStale: false,
      subscriberCount: 0,
      ...extra,
    }),
  });
  render(<DataProductDetailEditor item={makeItem('data-product', 'Data product')} id="p1" />);
}

describe('DataProductDetailEditor', () => {
  // globals:false means @testing-library/react does NOT auto-register cleanup.
  // Without explicit cleanup, renders accumulate across tests → "found multiple elements".
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('renders the product name and status badge from the GET response', async () => {
    mountWith();
    await waitFor(() => expect(screen.getByText('Test product')).toBeInTheDocument());
    // Status badge reflects Cosmos status field (Draft). It appears in both the
    // header and the governance grid, so use getAllByText.
    expect(screen.getAllByText('Draft').length).toBeGreaterThan(0);
    expect(screen.getByText('Endorsed')).toBeInTheDocument();
  });

  it('shows the DQ honest-gate (no fabricated score) when dqScore is null', async () => {
    mountWith();
    await waitFor(() =>
      expect(screen.getAllByText(/has not been measured for this data product yet/i).length).toBeGreaterThan(0),
    );
    // The health-action card must not contradict the bar above it by claiming a
    // cause it did not establish ("No rules are defined for this tenant").
    expect(screen.queryByText(/No rules are defined for this tenant/i)).not.toBeInTheDocument();
  });

  it('an INFRA reason renders the registry gate with a Fix it, not a dead-end sentence', async () => {
    mountWith({
      dqGate: `${DQ_GATE.adx} (missing LOOM_KUSTO_CLUSTER_URI)`,
      dqGateId: DQ_ADX_GATE_ID,
      dqMissing: ['LOOM_KUSTO_CLUSTER_URI'],
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /fix it/i })).toBeInTheDocument(),
    );
  });

  it('a real score is described as rules that PASSED, never as rules that are enabled', async () => {
    mountWith({ dqScore: 50, dqGate: null, dqMeasuredAt: '2026-08-10T12:00:00.000Z' });
    await waitFor(() =>
      expect(screen.getByText(/rules that passed when last measured/i)).toBeInTheDocument(),
    );
    // 50 now means half the rules FAILED — the old card called that "some rules
    // are disabled", which is a different fact entirely.
    expect(screen.getByText(/rules are FAILING their thresholds/i)).toBeInTheDocument();
    expect(screen.queryByText(/some rules are disabled/i)).not.toBeInTheDocument();
  });

  it('show-empty toggle hides null custom attributes and restores them', async () => {
    mountWith();
    await waitFor(() => expect(screen.getByText('Quality · SLA')).toBeInTheDocument());
    // The null-valued attribute is hidden by default.
    expect(screen.queryByText('Quality · Retention')).not.toBeInTheDocument();
    // Toggle "Show attributes without a value".
    const sw = screen.getByRole('switch', { name: /show attributes without a value/i });
    fireEvent.click(sw);
    await waitFor(() => expect(screen.getByText('Quality · Retention')).toBeInTheDocument());
    // Toggling back hides it again.
    fireEvent.click(sw);
    await waitFor(() => expect(screen.queryByText('Quality · Retention')).not.toBeInTheDocument());
  });

  it('renders the Data Observability honest-gate tab', async () => {
    mountWith();
    await waitFor(() => expect(screen.getByText('Test product')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: /data observability/i }));
    // The ADX honest-gate MessageBar names the exact env var to set. The real
    // env var (per lib/azure/data-quality-client.ts adxConfigGate) is
    // LOOM_KUSTO_CLUSTER_URI — not the stale LOOM_KUSTO_ENDPOINT.
    await waitFor(() =>
      expect(screen.getByText(/LOOM_KUSTO_CLUSTER_URI/)).toBeInTheDocument(),
    );
  });

  it('exposes a working Edit ribbon action (not a dead button)', async () => {
    mountWith();
    const ribbon = await screen.findByTestId('ribbon');
    await waitFor(() => {
      const edit = within(ribbon).getByRole('button', { name: 'Edit' });
      expect(edit).not.toBeDisabled();
    });
  });
});
