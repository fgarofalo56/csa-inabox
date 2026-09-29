/**
 * /governance/data-quality — UX-baseline lift (Vitest, jsdom).
 *
 * Asserts the SC-6 TeachingBanner renders and, when the rule store is empty,
 * the Rules tab shows the SC-4 GuidedEmptyState launcher (not a bare table
 * empty string). Network is caught by installFetchMock.
 *
 * #4776 — a CLASSIFIED warehouse failure renders the registry HonestGate with
 * its cause, remediation, entitlement and a Fix-it, on the Run tab and on BOTH
 * halves of the Monitors tab. Before this, the Monitors GET put the classified
 * body into `constraints` under ok:true and the panel mapped the non-array to
 * `[]` — "No Delta CHECK constraints" over a failed call.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { installFetchMock } from '@/lib/editors/__tests__/test-helpers';
import DataQualityPage from '../page';

function mount() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <DataQualityPage />
    </FluentProvider>,
  );
}

/** The `warehouseErrorBody` shape for a permission refusal (what the routes return). */
const PERMISSION_BODY = {
  ok: false,
  code: 'warehouse_permission',
  gateId: 'svc-databricks-sql',
  kind: 'permission',
  error: 'Databricks refused the Console identity\'s list call (HTTP 403 PERMISSION_DENIED): denied',
  remediation: 'A workspace admin grants the databricks-sql-access entitlement to the Console managed identity.',
  entitlement: 'databricks-sql-access',
};

async function openMonitorsAndLoad() {
  await waitFor(() => expect(screen.getByRole('tab', { name: 'Monitors' })).toBeInTheDocument());
  fireEvent.click(screen.getByRole('tab', { name: 'Monitors' }));
  fireEvent.change(await screen.findByPlaceholderText('customers'), { target: { value: 't1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Load' }));
}

describe('Data quality — teaching banner + guided empty state', () => {
  beforeEach(() => { window.localStorage.clear(); vi.restoreAllMocks(); });
  afterEach(() => { cleanup(); });

  it('renders the teaching banner and a guided empty state when no rules exist', async () => {
    installFetchMock({ '/api/dq/rules': () => ({ ok: true, rules: [] }) });
    mount();
    await waitFor(() => expect(screen.getByText('Author, run, then enforce')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('No data-quality rules yet')).toBeInTheDocument());
    // The launcher card runs a real path (opens the New-rule dialog); its body
    // copy is unique to the guided empty state.
    expect(screen.getByText(/Define a not-null, unique, range, regex/)).toBeInTheDocument();
  });
});

describe('Data quality — a classified warehouse failure is the HonestGate (#4776)', () => {
  beforeEach(() => { window.localStorage.clear(); vi.restoreAllMocks(); });
  afterEach(() => { cleanup(); });

  it('Monitors: a classified constraints half renders the gate, NOT "No Delta CHECK constraints"', async () => {
    installFetchMock({
      '/api/dq/rules': () => ({ ok: true, rules: [] }),
      '/api/dq/monitors': () => ({ ok: true, fullName: 't1', constraints: PERMISSION_BODY, monitor: null, refreshes: [] }),
    });
    mount();
    await openMonitorsAndLoad();
    // Breaks if the page maps a non-array `constraints` to [] again: the gate
    // title is absent and the empty-state caption renders instead.
    expect(await screen.findByText(/Delta constraints: .* — permission refused/)).toBeInTheDocument();
    expect(screen.getByText(/refused the Console identity's list call/)).toBeInTheDocument();
    expect(screen.getByText('databricks-sql-access')).toBeInTheDocument();
    expect(screen.queryByText('No Delta CHECK constraints on this table yet.')).toBeNull();
    // G2: the gate carries the Fix-it, and for a PERMISSION cause it opens as
    // the role grant naming the route's remediation (the browser's registry
    // copy cannot see the server overlay — the classified prop supplies it).
    fireEvent.click(screen.getByRole('button', { name: /fix it/i }));
    const grants = await screen.findAllByText(/grants the databricks-sql-access entitlement/);
    // Three sites carry the route's remediation: the bar's list item, the
    // dialog's remediation caption, and the dialog's role-grant note. Breaks
    // (2) if the Fix-it keeps the static env-picker (no grant note), and (1) if
    // the dialog is handed the static registry def instead of the classified one.
    expect(grants).toHaveLength(3);
  });

  it('Monitors: a non-classified constraints error is shown as an error, not as "no constraints"', async () => {
    installFetchMock({
      '/api/dq/rules': () => ({ ok: true, rules: [] }),
      '/api/dq/monitors': () => ({ ok: true, fullName: 't1', constraints: { error: 'TABLE_OR_VIEW_NOT_FOUND t1' }, monitor: null, refreshes: [] }),
    });
    mount();
    await openMonitorsAndLoad();
    expect(await screen.findByText('TABLE_OR_VIEW_NOT_FOUND t1')).toBeInTheDocument();
    expect(screen.queryByText('No Delta CHECK constraints on this table yet.')).toBeNull();
  });

  it('Monitors: an ARRAY of zero constraints still reads as the empty state (control)', async () => {
    installFetchMock({
      '/api/dq/rules': () => ({ ok: true, rules: [] }),
      '/api/dq/monitors': () => ({ ok: true, fullName: 't1', constraints: [], monitor: null, refreshes: [] }),
    });
    mount();
    await openMonitorsAndLoad();
    expect(await screen.findByText('No Delta CHECK constraints on this table yet.')).toBeInTheDocument();
    expect(screen.queryByText(/permission refused/)).toBeNull();
  });

  it('Monitors: a classified failure on the whole GET (top level) renders the gate', async () => {
    installFetchMock({
      '/api/dq/rules': () => ({ ok: true, rules: [] }),
      '/api/dq/monitors': () => ({ ...PERMISSION_BODY, kind: 'unknown', code: 'warehouse_unknown', entitlement: undefined,
        error: 'The list call failed and the response does not identify a permission, network, or quota cause (HTTP 500)', remediation: 'The cause is not established.' }),
    });
    mount();
    await openMonitorsAndLoad();
    // Breaks if load() drops its surfaceGateFrom check: the body falls to the
    // plain error bar — no gate title, no Fix-it.
    expect(await screen.findByText(/Data quality monitors: .* — failed, cause not established/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /fix it/i })).toBeInTheDocument();
  });

  it('Monitors: a classified failure on DROP renders the gate (not a silent no-op)', async () => {
    let posted = 0;
    installFetchMock({
      '/api/dq/rules': () => ({ ok: true, rules: [] }),
      '/api/dq/monitors': (_u, init) => {
        if (init?.method === 'POST') { posted++; return PERMISSION_BODY; }
        return { ok: true, fullName: 't1', constraints: [{ name: 'c1', expression: 'x > 0' }], monitor: null, refreshes: [] };
      },
    });
    mount();
    await openMonitorsAndLoad();
    fireEvent.click(await screen.findByRole('button', { name: 'Drop' }));
    // Breaks if action() only reads `j.error` into a plain error bar: no gate title.
    expect(await screen.findByText(/Data quality monitors: .* — permission refused/)).toBeInTheDocument();
    expect(posted).toBe(1);
  });

  it('Run: a classified failure renders the gate with its cause', async () => {
    installFetchMock({
      '/api/dq/rules': () => ({ ok: true, rules: [] }),
      '/api/dq/run': () => ({ ...PERMISSION_BODY, kind: 'network', code: 'warehouse_network', entitlement: undefined,
        error: 'The Console\'s list call on the Databricks workspace x was refused at the network layer (HTTP 403)', remediation: 'Check the private endpoint.' }),
    });
    mount();
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Run' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: 'Run' }));
    fireEvent.click(await screen.findByRole('button', { name: /Run rules/ }));
    // Breaks on the old `503 && not_configured` check: a network body fell to setError(j.error).
    expect(await screen.findByText(/Data quality run: .* — refused or unreachable at the network layer/)).toBeInTheDocument();
    expect(screen.getByText('Check the private endpoint.')).toBeInTheDocument();
  });
});
