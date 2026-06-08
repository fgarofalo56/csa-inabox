/**
 * DataProductDetailEditor (F3) — Vitest contract test.
 *
 * Mounts the owner details page with a mocked GET /api/data-products/[id]
 * response and asserts the real behaviors that matter per the task's VERIFY:
 *   - product name + status badge render from the (mocked) Cosmos doc
 *   - the DQ honest-gate shows when dqScore is null (no fabricated number)
 *   - the show-empty toggle hides null custom attributes and restores them
 *
 * Network is caught by installFetchMock; ItemEditorChrome + next/navigation
 * are stubbed by vitest.setup.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { DataProductDetailEditor } from '../data-product-detail';
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
    '/api/data-products/': () => ({
      ok: true,
      isOwner: true,
      product: PRODUCT,
      dqScore: null,
      dqGate: 'No data-quality rules configured for this tenant. Define rules in Admin › Data Quality Rules to compute a real score.',
      subscriberCount: 0,
      ...extra,
    }),
  });
  render(<DataProductDetailEditor item={makeItem('data-product', 'Data product')} id="p1" />);
}

describe('DataProductDetailEditor', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

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
      expect(screen.getByText(/No data-quality rules configured/i)).toBeInTheDocument(),
    );
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
    await waitFor(() =>
      expect(screen.getByText(/LOOM_KUSTO_ENDPOINT/)).toBeInTheDocument(),
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
