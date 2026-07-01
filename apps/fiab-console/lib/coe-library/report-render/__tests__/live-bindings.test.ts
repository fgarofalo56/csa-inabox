/**
 * Unit tests for the CoE report-render LIVE data bindings.
 *
 * Covers (per .claude/rules/no-vaporware.md — exercises real mapping logic, not
 * a façade):
 *   - resolveReportParams: env-first defaulting + override behavior
 *   - resolveLiveReport: per-entity live / empty / error TAGGING + the
 *     {columns, rows} shape each resolver maps its real client output into.
 *     There is NO sample-data render path: unbound / empty / errored entities
 *     render a REAL EMPTY table (schema, zero rows) — never bundled SAMPLE rows.
 *
 * The Azure clients are mocked so the tests assert the binding's mapping +
 * tagging contract deterministically (no live Azure calls).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SampleData } from '../tmdl-sample';

// --- mock the Azure backends the bindings call -----------------------------
vi.mock('@azure/identity', () => {
  class Cred {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(..._args: unknown[]) {}
    async getToken() { return { token: 'test-token', expiresOnTimestamp: Date.now() + 3_600_000 }; }
  }
  return { ChainedTokenCredential: Cred, DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred };
});
vi.mock('@/lib/azure/aca-managed-identity', () => ({
  AcaManagedIdentityCredential: class { async getToken() { return { token: 'test-token' }; } },
}));
vi.mock('@/lib/azure/cost-client', () => ({
  getLoomCostSummary: vi.fn(),
  loomSubscriptions: vi.fn(() => ['sub-env']),
}));
vi.mock('@/lib/azure/monitor-client', () => ({
  queryLogs: vi.fn(),
  logAnalyticsWorkspaceId: vi.fn(() => 'ws-123'),
}));
vi.mock('@/lib/azure/defender-client', () => ({
  getDefenderSummary: vi.fn(),
}));
vi.mock('@/lib/azure/fetch-with-timeout', () => ({
  fetchWithTimeout: vi.fn(),
}));

import { resolveReportParams, resolveLiveReport } from '../live-bindings';
import { getLoomCostSummary, loomSubscriptions } from '@/lib/azure/cost-client';
import { queryLogs } from '@/lib/azure/monitor-client';
import { getDefenderSummary } from '@/lib/azure/defender-client';
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';

const sampleTable = (columns: string[]) => ({ columns, rows: [{ __sample: true }] });
/** An Azure Resource Graph HTTP response with the given `data` rows. */
const argResponse = (data: any[]) => ({ ok: true, status: 200, text: async () => JSON.stringify({ data }) });
/** The query string an ARG call was invoked with (to differentiate concurrent resolvers). */
const argQuery = (init: any): string => { try { return String(JSON.parse(init.body).query || ''); } catch { return ''; } };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LOOM_SUBSCRIPTION_ID = 'sub-env';
  (loomSubscriptions as any).mockReturnValue(['sub-env']);
});

describe('resolveReportParams', () => {
  it('defaults from the deployment env (zero manual entry)', () => {
    (loomSubscriptions as any).mockReturnValue(['sub-env', 'sub-2']);
    const p = resolveReportParams();
    expect(p.subscriptionId).toBe('sub-env');
    expect(p.subscriptionIds).toEqual(['sub-env', 'sub-2']);
    expect(p.billingScope).toBe('/subscriptions/sub-env');
    expect(p.logAnalyticsWorkspaceId).toBe('ws-123');
  });

  it('honors an explicit subscription override (scopes live queries to it)', () => {
    const p = resolveReportParams({ subscriptionId: 'sub-x' });
    expect(p.subscriptionId).toBe('sub-x');
    expect(p.subscriptionIds).toEqual(['sub-x']);
    expect(p.billingScope).toBe('/subscriptions/sub-x');
  });

  it('honors an explicit billingScope override', () => {
    const p = resolveReportParams({ billingScope: '/providers/Microsoft.Billing/billingAccounts/123' });
    expect(p.billingScope).toBe('/providers/Microsoft.Billing/billingAccounts/123');
  });
});

describe('resolveLiveReport — Cost Management (cloud-cost-finops)', () => {
  const sample: SampleData = {
    Cost: sampleTable(['UsageDate', 'SubscriptionName', 'ResourceGroup', 'ServiceName', 'CostCenterTag', 'PreTaxCost']),
    Budget: sampleTable(['SubscriptionName', 'MonthlyBudget']),
  };

  it('tags Cost + Budget LIVE and maps the client output into the sample shape', async () => {
    (getLoomCostSummary as any).mockResolvedValue({
      currency: 'USD',
      subscriptions: ['sub-env'],
      subscriptionErrors: [],
      byService: [{ key: 'Storage', cost: 10.5 }, { key: 'Compute', cost: 20 }],
      budgets: [{ subscription: 'sub-env', amount: 1000, currentSpend: 250, percentUsed: 25, timeGrain: 'Monthly', scope: 'Cost', name: 'b1' }],
    });

    const { live, dataSources } = await resolveLiveReport('cloud-cost-finops', sample);

    expect(dataSources.Cost.source).toBe('live');
    expect(live.Cost.columns).toEqual(['UsageDate', 'SubscriptionName', 'ResourceGroup', 'ServiceName', 'CostCenterTag', 'PreTaxCost']);
    expect(live.Cost.rows).toHaveLength(2);
    expect(live.Cost.rows[0]).toMatchObject({ ServiceName: 'Storage', PreTaxCost: 10.5, SubscriptionName: 'sub-env' });

    expect(dataSources.Budget.source).toBe('live');
    expect(live.Budget.rows[0]).toMatchObject({ SubscriptionName: 'sub-env', MonthlyBudget: 1000 });
  });

  it('tags Budget EMPTY (not error) when no Consumption budgets exist — real empty, never fabricated', async () => {
    (getLoomCostSummary as any).mockResolvedValue({
      currency: 'USD', subscriptions: ['sub-env'], subscriptionErrors: [],
      byService: [{ key: 'Storage', cost: 5 }], budgets: [],
    });
    const { live, dataSources } = await resolveLiveReport('cloud-cost-finops', sample);
    expect(dataSources.Budget.source).toBe('empty');
    expect(dataSources.Budget.note).toMatch(/no azure consumption budgets/i);
    // Renders a REAL EMPTY table (schema, zero rows) — never the bundled sample.
    expect(live.Budget.columns).toEqual(['SubscriptionName', 'MonthlyBudget']);
    expect(live.Budget.rows).toHaveLength(0);
  });

  it('tags Cost ERROR (and renders empty) when Cost Management is not configured', async () => {
    const e: any = new Error('Monitor not configured. Missing env: LOOM_SUBSCRIPTION_ID');
    e.name = 'MonitorNotConfiguredError';
    (getLoomCostSummary as any).mockRejectedValue(e);

    const { live, dataSources } = await resolveLiveReport('cloud-cost-finops', sample);
    expect(dataSources.Cost.source).toBe('error');
    expect(dataSources.Cost.note).toMatch(/not configured/i);
    expect(live.Cost.rows).toHaveLength(0);
  });
});

describe('resolveLiveReport — Azure Resource Graph (resource-inventory-sprawl)', () => {
  const sample: SampleData = {
    Resources: sampleTable(['ResourceType', 'Location', 'SubscriptionName', 'Environment', 'HasOwnerTag', 'ResourceCount']),
    Orphans: sampleTable(['OrphanType', 'Count', 'EstMonthlyWaste']),
  };

  it('maps ARG rows into the Resources shape (live) and resolves Orphans live from its own ARG query', async () => {
    (fetchWithTimeout as any).mockImplementation((_url: string, init: any) => {
      const q = argQuery(init);
      if (q.includes('OrphanType')) {
        return Promise.resolve(argResponse([{ OrphanType: 'Unattached managed disk', Count: 4 }]));
      }
      return Promise.resolve(argResponse([
        { ResourceType: 'microsoft.storage/storageaccounts', Location: 'eastus', SubscriptionName: 'sub-env', Environment: 'prod', HasOwnerTag: 'Yes', ResourceCount: 7 },
        { ResourceType: 'microsoft.compute/virtualmachines', Location: 'westus', SubscriptionName: 'sub-env', Environment: '', HasOwnerTag: 'No', ResourceCount: 3 },
      ]));
    });

    const { live, dataSources } = await resolveLiveReport('resource-inventory-sprawl', sample);

    expect(dataSources.Resources.source).toBe('live');
    expect(live.Resources.columns).toEqual(['ResourceType', 'Location', 'SubscriptionName', 'Environment', 'HasOwnerTag', 'ResourceCount']);
    expect(live.Resources.rows).toHaveLength(2);
    expect(live.Resources.rows[0]).toMatchObject({ ResourceType: 'microsoft.storage/storageaccounts', Location: 'eastus', ResourceCount: 7 });

    // Orphans now has a real ARG backend → live, monthly-waste left null (honest unknown), never fabricated.
    expect(dataSources.Orphans.source).toBe('live');
    expect(live.Orphans.rows[0]).toMatchObject({ OrphanType: 'Unattached managed disk', Count: 4, EstMonthlyWaste: null });
  });

  it('tags Resources ERROR (and renders empty) on an ARG 403', async () => {
    (fetchWithTimeout as any).mockResolvedValue({
      ok: false, status: 403, text: async () => JSON.stringify({ error: { message: 'Forbidden' } }),
    });
    const { live, dataSources } = await resolveLiveReport('resource-inventory-sprawl', sample);
    expect(dataSources.Resources.source).toBe('error');
    expect(dataSources.Resources.note).toMatch(/access denied|reader/i);
    expect(live.Resources.rows).toHaveLength(0);
  });
});

describe('resolveLiveReport — Log Analytics + Defender + Azure Policy', () => {
  it('maps monthly active users into Adoption Signals (live); unbound Maturity Assessment renders empty', async () => {
    (queryLogs as any).mockResolvedValue({
      columns: ['Month', 'MonthlyActiveUsers'],
      rows: [['2026-05-01T00:00:00Z', 12], ['2026-06-01T00:00:00Z', 18]],
      rowCount: 2,
    });
    const sample: SampleData = {
      'Adoption Signals': sampleTable(['Service', 'Month', 'MonthlyActiveUsers', 'WorkloadsOnboarded']),
      'Maturity Assessment': sampleTable(['Pillar', 'Capability', 'CurrentLevel', 'TargetLevel', 'Owner', 'AssessedDate']),
    };
    const { live, dataSources } = await resolveLiveReport('coe-adoption-maturity', sample);
    expect(dataSources['Adoption Signals'].source).toBe('live');
    expect(live['Adoption Signals'].rows[1]).toMatchObject({ Month: '2026-06-01T00:00:00Z', MonthlyActiveUsers: 18 });
    // Maturity Assessment has no live backend → real EMPTY table, never sample.
    expect(dataSources['Maturity Assessment'].source).toBe('empty');
    expect(live['Maturity Assessment'].rows).toHaveLength(0);
  });

  it('maps Defender secure score (live) and Azure Policy compliance (live) for security-compliance-posture', async () => {
    (getDefenderSummary as any).mockResolvedValue({
      secureScore: { current: 42, max: 60, percentage: 70 },
      subscriptionId: 'sub-env',
      recommendations: [], unhealthyCount: 0, highSeverityCount: 0, alerts: [], portalUrl: '',
    });
    (fetchWithTimeout as any).mockImplementation((_url: string, init: any) => {
      const q = argQuery(init);
      if (q.includes('policyresources')) {
        return Promise.resolve(argResponse([
          { PolicyInitiative: 'Azure Security Benchmark', ComplianceState: 'NonCompliant', ResourceCount: 12 },
        ]));
      }
      return Promise.resolve(argResponse([]));
    });
    const sample: SampleData = {
      'Secure Score': sampleTable(['SubscriptionName', 'CurrentScore', 'MaxScore', 'Percentage']),
      'Policy Compliance': sampleTable(['PolicyInitiative', 'ComplianceState', 'ResourceCount']),
    };
    const { live, dataSources } = await resolveLiveReport('security-compliance-posture', sample);
    expect(dataSources['Secure Score'].source).toBe('live');
    expect(live['Secure Score'].rows[0]).toMatchObject({ CurrentScore: 42, MaxScore: 60, Percentage: 70 });
    expect(dataSources['Policy Compliance'].source).toBe('live');
    expect(live['Policy Compliance'].rows[0]).toMatchObject({ PolicyInitiative: 'Azure Security Benchmark', ComplianceState: 'NonCompliant', ResourceCount: 12 });
  });
});
