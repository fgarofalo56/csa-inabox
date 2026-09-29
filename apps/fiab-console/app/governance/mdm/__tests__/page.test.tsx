/**
 * MDM page (UX-603) — render test for the UX-baseline lift.
 *
 * Asserts the SC-6 TeachingBanner renders above the tab strip, and the SC-4
 * GuidedEmptyState shows on the Models tab when the backend returns no models.
 *
 * #4776 — the Match and Golden-records tabs render a CLASSIFIED warehouse
 * failure (403 permission / 503 network / 502 unknown) as the registry
 * HonestGate with its cause and remediation. Before this they checked only
 * `503 && code === 'not_configured'`, so every classified body fell to
 * `setError(j.error)` and the remediation, entitlement and Fix-it were dropped.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

const routes = vi.hoisted(() => ({ handler: (_url: string, _init?: RequestInit): unknown => ({ ok: true, models: [] }) }));

vi.mock('@/lib/client-fetch', () => ({
  clientFetch: vi.fn(async (url: string, init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => routes.handler(url, init),
  })),
}));

import GovernanceMdmPage from '../page';

function wrap(ui: React.ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}

const MODEL = { id: 'm1', name: 'Customers', entity: 'customer', sourceTable: 'customers', recordIdColumn: 'id', matchAttributes: [], survivorship: [] };

beforeEach(() => {
  window.localStorage.clear();
  routes.handler = () => ({ ok: true, models: [] });
});
afterEach(cleanup);

describe('MDM page UX-baseline', () => {
  it('renders the MDM teaching banner and guided empty state', async () => {
    wrap(<GovernanceMdmPage />);
    expect(
      await screen.findByText(/How master data management builds a golden record/),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText('Define your first golden-record model')).toBeInTheDocument(),
    );
  });
});

describe('MDM page — a classified warehouse failure is the HonestGate (#4776)', () => {
  it('Match: a 403-permission body renders the gate with cause, remediation and entitlement', async () => {
    routes.handler = (url) => {
      if (url.startsWith('/api/mdm/models')) return { ok: true, models: [MODEL] };
      if (url === '/api/mdm/match') {
        return {
          ok: false, code: 'warehouse_permission', gateId: 'svc-databricks-sql', kind: 'permission',
          error: 'Databricks refused the Console identity\'s list call (HTTP 403): denied',
          remediation: 'A workspace admin grants the databricks-sql-access entitlement to the Console managed identity.',
          entitlement: 'databricks-sql-access',
        };
      }
      return { ok: true, pairs: [] };
    };
    wrap(<GovernanceMdmPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Match' }));
    fireEvent.click(await screen.findByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: 'Customers' }));
    fireEvent.click(screen.getByRole('button', { name: /Run match/ }));
    // Breaks on the old `503 && not_configured` check: the body falls to
    // setError(j.error) — no gate title, no remediation, no entitlement.
    expect(await screen.findByText(/MDM: .* — permission refused/)).toBeInTheDocument();
    expect(screen.getByText(/grants the databricks-sql-access entitlement/)).toBeInTheDocument();
    expect(screen.getByText('databricks-sql-access')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /fix it/i })).toBeInTheDocument();
  });

  it('Golden records: a legacy not_configured body still renders the gate for the missing var', async () => {
    routes.handler = (url) => {
      if (url.startsWith('/api/mdm/models')) return { ok: true, models: [MODEL] };
      if (url.startsWith('/api/mdm/golden-records')) {
        return { ok: false, code: 'not_configured', missing: 'LOOM_DATABRICKS_HOSTNAME', error: 'MDM engine not configured — set LOOM_DATABRICKS_HOSTNAME.' };
      }
      return { ok: true };
    };
    wrap(<GovernanceMdmPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Golden records' }));
    fireEvent.click(await screen.findByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: 'Customers' }));
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    // The registry gate that requires LOOM_DATABRICKS_HOSTNAME (svc-databricks),
    // with its Fix-it — not a bare "Set X" bar.
    expect(await screen.findByText(/MDM needs Azure Databricks/)).toBeInTheDocument();
    expect(screen.getByText('LOOM_DATABRICKS_HOSTNAME')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /fix it/i })).toBeInTheDocument();
  });
});
