/**
 * Install-time provisioner tests for the Azure-native Activator backend.
 *
 * The provisioner authors each bundle rule via createMonitorActivatorRule (the
 * shared runtime helper) against whichever Azure Monitor alert SCOPE the
 * deployment actually has — Log Analytics (LOOM_LOG_ANALYTICS_RESOURCE_ID,
 * preferred) or the ADX cluster (LOOM_ADX_ALERT_SCOPE). A bundle rule that
 * references a phantom custom metric no longer sinks the install: the query is
 * column_ifexists + skipQueryValidation, so it CREATEs. Here the shared helper +
 * Cosmos are mocked; the tests pin:
 *   - LA scope set → rule authored with sourceKind 'log-analytics', created
 *   - only ADX scope set → rule authored with sourceKind 'adx', created
 *   - neither scope → honest gate naming BOTH env vars (not "no rules created")
 *   - no rules in bundle → created (no rules to author) — unchanged
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/azure/activator-client', () => ({
  ActivatorError: class extends Error { status: number; constructor(m: string, s = 500) { super(m); this.status = s; } },
  listActivators: vi.fn(),
  createActivator: vi.fn(),
  addRule: vi.fn(),
  listRules: vi.fn(),
}));
vi.mock('@/lib/azure/monitor-client', () => ({
  MonitorNotConfiguredError: class extends Error { missing: string[]; constructor(m: string[]) { super('not configured'); this.missing = m; } },
  MonitorError: class extends Error { status: number; constructor(m: string, s = 500) { super(m); this.status = s; } },
}));
vi.mock('@/lib/azure/activator-monitor', () => ({
  createMonitorActivatorRule: vi.fn(),
}));

const replace = vi.fn(async () => ({}));
const read = vi.fn(async () => ({ resource: { id: 'act-1', workspaceId: 'w', state: {} } }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(async () => ({ item: vi.fn(() => ({ read, replace })) })),
}));

import { activatorProvisioner } from '../activator';
import { createMonitorActivatorRule } from '@/lib/azure/activator-monitor';

// The Direct-Lake-shim bundle rule: a phantom custom metric, Teams action.
function input(overrides: any = {}) {
  return {
    session: { claims: { oid: 'o' } } as any,
    target: { mode: 'shared', activatorBackend: 'azure-monitor' },
    cosmosItemId: 'act-1',
    workspaceId: 'w',
    displayName: 'DL-Shim Activator',
    content: {
      kind: 'activator',
      rule: {
        name: 'DL-Shim refresh SLA breach',
        condition: { metric: 'shim_refresh_latency_seconds', op: 'greaterThan', threshold: 30 },
        window: '5m',
        action: { kind: 'teams', config: { teamsWebhookSecretRef: 'LOOM_DL_SHIM_TEAMS_WEBHOOK' } },
      },
    },
    appId: 'app-direct-lake',
    ...overrides,
  };
}

const ENV_KEYS = ['LOOM_LOG_ANALYTICS_RESOURCE_ID', 'LOOM_ADX_ALERT_SCOPE'];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  vi.clearAllMocks();
  read.mockResolvedValue({ resource: { id: 'act-1', workspaceId: 'w', state: {} } });
  replace.mockResolvedValue({});
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  (createMonitorActivatorRule as any).mockImplementation(async (_name: string, i: any) => ({
    id: 'r1', name: i.name, azureRuleName: 'DL-Shim-Activator-rule', query: 'AppEvents | take 0',
    condition: i.condition, action: i.action, severity: 3, evaluationFrequency: 'PT5M', windowSize: 'PT5M',
    state: 'Active', backend: 'azure-monitor', sourceKind: i.sourceKind || 'log-analytics', createdAt: 'now',
  }));
});
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('activatorProvisioner (Azure Monitor default)', () => {
  it('LA scope configured → authors the rule with sourceKind log-analytics, created', async () => {
    process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.OperationalInsights/workspaces/law';
    const res = await activatorProvisioner(input());
    expect(res.status).toBe('created');
    expect(createMonitorActivatorRule).toHaveBeenCalledTimes(1);
    const passed = (createMonitorActivatorRule as any).mock.calls[0][1];
    expect(passed.sourceKind).toBe('log-analytics');
    // Phantom metric normalized to the canonical {property,operator,value} shape.
    expect(passed.condition).toEqual({ property: 'shim_refresh_latency_seconds', operator: 'greaterThan', value: 30 });
    // Persisted to state.rules so the editor/pane are self-sufficient.
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('only ADX scope configured → authors the rule with sourceKind adx, created (no LA needed)', async () => {
    process.env.LOOM_ADX_ALERT_SCOPE = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Kusto/clusters/adx';
    const res = await activatorProvisioner(input());
    expect(res.status).toBe('created');
    const passed = (createMonitorActivatorRule as any).mock.calls[0][1];
    expect(passed.sourceKind).toBe('adx');
  });

  it('neither alert scope configured → honest gate naming BOTH env vars', async () => {
    const res = await activatorProvisioner(input());
    expect(res.status).toBe('remediation');
    expect(createMonitorActivatorRule).not.toHaveBeenCalled();
    expect(res.gate?.remediation).toContain('LOOM_LOG_ANALYTICS_RESOURCE_ID');
    expect(res.gate?.remediation).toContain('LOOM_ADX_ALERT_SCOPE');
    expect(res.gate?.remediation).toContain('No Microsoft Fabric');
  });

  it('no rules in bundle → created (no rules to author), no scope required', async () => {
    const res = await activatorProvisioner(input({ content: { kind: 'activator' } }));
    expect(res.status).toBe('created');
    expect(createMonitorActivatorRule).not.toHaveBeenCalled();
    expect(res.steps?.some((s) => /no alert rules to author/i.test(s))).toBe(true);
  });
});
