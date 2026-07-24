/**
 * /governance/data-contracts — N6 registry render test (Vitest, jsdom).
 *
 * Asserts the surface tells the enforcement story from REAL payload data:
 * the KPI roll-up, the per-contract row with its ODCS version, its enforcement
 * mode (default `warn-quarantine` vs the opt-in `hard-reject`), its ingestion
 * binding, and its last decision — plus the guided empty state when the
 * registry is empty and the honest "turned off" state when the FLAG0 kill
 * switch is flipped.
 *
 * Network is caught by installFetchMock; next/navigation is stubbed by
 * vitest.setup.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { installFetchMock } from '@/lib/editors/__tests__/test-helpers';
import DataContractsPage from '../data-contracts/page';

const ROW = {
  itemId: 'contract-1',
  displayName: 'Orders contract',
  workspaceId: 'ws-1',
  odcsId: 'contract-1',
  apiVersion: 'v3.1.0',
  version: '2.1.0',
  status: 'active',
  objectName: 'dbo.Orders',
  properties: 5,
  slaCount: 4,
  enforcementEnabled: true,
  enforcementMode: 'warn-quarantine',
  bindings: [{ id: 'b1', kind: 'mirrored-database', targetItemId: 'mir-1', targetItemName: 'Sales mirror', dataset: 'dbo.Orders', enabled: true }],
  trend: { runs: 3, clean: 1, quarantined: 1, rejected: 1, rowsEvaluated: 300, rowsRejected: 30, passRate: 0.9 },
  lastRun: {
    at: '2026-07-23T10:00:00.000Z', source: 'mirrored-database', dataset: 'dbo.Orders',
    decision: 'landed-with-quarantine', evaluated: 100, rejected: 10, deadLetterPath: 'mirrors/ws1/mir1/_rejected/dbo.Orders/rejected-x.jsonl',
  },
  updatedAt: '2026-07-23T10:00:00.000Z',
};

const STRICT_ROW = {
  ...ROW,
  itemId: 'contract-2',
  displayName: 'Payments contract',
  enforcementMode: 'hard-reject',
  bindings: [],
  trend: { runs: 0, clean: 0, quarantined: 0, rejected: 0, rowsEvaluated: 0, rowsRejected: 0, passRate: null },
  lastRun: null,
  updatedAt: '2026-07-22T10:00:00.000Z',
};

const SUMMARY = {
  total: 2, active: 2, enforcing: 2, hardReject: 1, bound: 1, unbound: 1,
  rowsEvaluated: 300, rowsRejected: 30, quarantinedRuns: 1, rejectedRuns: 1,
};

function mount() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <DataContractsPage />
    </FluentProvider>,
  );
}

describe('Governance → Data contracts registry', () => {
  beforeEach(() => { window.localStorage.clear(); vi.restoreAllMocks(); });
  afterEach(() => { cleanup(); });

  it('renders each registered contract with its ODCS version, enforcement mode, binding, and last decision', async () => {
    installFetchMock({
      '/api/governance/data-contracts': () => ({
        ok: true, disabled: false, contracts: [ROW, STRICT_ROW], summary: SUMMARY, defaultMode: 'warn-quarantine',
      }),
    });
    mount();

    await waitFor(() => expect(screen.getByText('Orders contract')).toBeInTheDocument());
    expect(screen.getByText('Payments contract')).toBeInTheDocument();

    // ODCS identity + status come from the stored document, not the UI.
    expect(screen.getAllByText('v3.1.0').length).toBeGreaterThan(0);
    expect(screen.getAllByText('v2.1.0').length).toBeGreaterThan(0);
    expect(screen.getAllByText('active').length).toBeGreaterThan(0);

    // Enforcement posture — the safe default and the opt-in strict mode.
    expect(screen.getAllByText('warn-quarantine').length).toBeGreaterThan(0);
    expect(screen.getAllByText('hard-reject').length).toBeGreaterThan(0);

    // Binding + the honest "nothing is enforced yet" state for the unbound one.
    expect(screen.getAllByText(/mirrored-database/).length).toBeGreaterThan(0);
    expect(screen.getByText(/not bound — nothing is enforced yet/)).toBeInTheDocument();

    // Last decision + pass rate come from the real run trend.
    expect(screen.getByText('Quarantined')).toBeInTheDocument();
    expect(screen.getByText(/90% · 30 rejected/)).toBeInTheDocument();
    expect(screen.getByText('Never enforced')).toBeInTheDocument();
  });

  it('rolls the enforcement posture up into the KPI row', async () => {
    installFetchMock({
      '/api/governance/data-contracts': () => ({ ok: true, disabled: false, contracts: [ROW, STRICT_ROW], summary: SUMMARY, defaultMode: 'warn-quarantine' }),
    });
    mount();
    await waitFor(() => expect(screen.getByText('Registered contracts')).toBeInTheDocument());
    expect(screen.getByText(/Enforcing \(1 hard-reject\)/)).toBeInTheDocument();
    expect(screen.getByText(/Bound to an ingestion path \(1 unbound\)/)).toBeInTheDocument();
    expect(screen.getByText(/Rows quarantined of 300 evaluated/)).toBeInTheDocument();
  });

  it('shows the guided empty state (never fabricated rows) when nothing is registered', async () => {
    installFetchMock({
      '/api/governance/data-contracts': () => ({ ok: true, disabled: false, contracts: [], summary: { ...SUMMARY, total: 0 }, defaultMode: 'warn-quarantine' }),
    });
    mount();
    await waitFor(() => expect(screen.getByText('No data contracts registered yet')).toBeInTheDocument());
    expect(screen.getByText('Create a data contract')).toBeInTheDocument();
    expect(screen.getByText('Bind an ingestion path')).toBeInTheDocument();
  });

  it('renders the honest FLAG0 kill-switch state instead of erroring', async () => {
    installFetchMock({
      '/api/governance/data-contracts': () => ({ ok: true, disabled: true, contracts: [], summary: null }),
    });
    mount();
    await waitFor(() => expect(screen.getByText('Registry turned off')).toBeInTheDocument());
    expect(screen.getByText(/n6-data-contracts/)).toBeInTheDocument();
  });

  it('surfaces a load failure as a designed error state, not a silent blank page', async () => {
    installFetchMock({
      '/api/governance/data-contracts': () => ({ ok: false, error: 'could not read the data-contract registry' }),
    });
    mount();
    await waitFor(() => expect(screen.getByText('Could not load the registry')).toBeInTheDocument());
  });
});
