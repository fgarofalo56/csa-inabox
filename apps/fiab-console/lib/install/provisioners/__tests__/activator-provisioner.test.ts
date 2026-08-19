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
 *
 * The second describe covers #3551: the returned status must reflect whether the
 * authored records reached the Cosmos item's state.rules — the ONLY place the
 * editor's GET reads a deployed activator's rules — and not merely whether Azure
 * Monitor accepted the rules.
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

/**
 * #3551 — the status must reflect whether the record reached state.rules, not
 * only whether Azure Monitor accepted the rules.
 *
 * Before the fix, the state.rules write was best-effort: a failure was appended
 * to steps[] and `status: created > 0 ? 'created' : 'remediation'` was computed
 * SOLELY from Azure Monitor's acceptance. So a lost write produced real
 * scheduledQueryRules, a green 'created', and an editor showing NOTHING. Every
 * test below FAILS against that code (it returned 'created' in all three).
 */
describe('#3551 activatorProvisioner — state.rules persistence gates the status', () => {
  const LA = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.OperationalInsights/workspaces/law';

  it('Azure Monitor created the rules but EVERY Cosmos write fails → NOT a green created', async () => {
    process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID = LA;
    replace.mockRejectedValue(new Error('Request timed out'));

    const res = await activatorProvisioner(input());

    // The core regression guard: install must not report success.
    expect(res.status).not.toBe('created');
    expect(res.status).not.toBe('exists');
    // The write was genuinely retried, not attempted once.
    expect(replace).toHaveBeenCalledTimes(3);
    // The receipt still names the REAL alert rules that exist in Azure, and
    // records that they are not persisted (deploy-integrity.md R7 — say only
    // what was established).
    expect(res.secondaryIds?.rulesCreated).toBe('1');
    expect(res.secondaryIds?.rulesPersisted).toBe('false');
    const detail = `${res.error || ''} ${res.gate?.reason || ''} ${res.gate?.remediation || ''}`;
    expect(detail).toContain('Request timed out');
    expect(res.steps?.some((s) => /could not be written to the activator item's state\.rules/i.test(s))).toBe(true);
  });

  it('a permission-shaped write failure classifies as a retryable remediation gate', async () => {
    process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID = LA;
    replace.mockRejectedValue(new Error('Forbidden (403): request is not authorized'));

    const res = await activatorProvisioner(input());

    expect(res.status).toBe('remediation');
    expect(res.gate?.reason).toMatch(/could not record them on the activator item/i);
    // The remediation is an action, and it states the retry is safe to run.
    expect(res.gate?.remediation).toMatch(/idempotent/i);
  });

  it('the item read never resolving a document → remediation, not created', async () => {
    process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID = LA;
    read.mockResolvedValue({ resource: undefined } as any);

    const res = await activatorProvisioner(input());

    expect(res.status).toBe('remediation');
    expect(replace).not.toHaveBeenCalled();
    expect(res.gate?.reason).toMatch(/returned no document/i);
  });

  it('a TRANSIENT write failure is recovered by the retry → created', async () => {
    process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID = LA;
    replace
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockResolvedValue({} as any);

    const res = await activatorProvisioner(input());

    expect(res.status).toBe('created');
    expect(replace).toHaveBeenCalledTimes(2);
    expect(res.secondaryIds?.rulesPersisted).toBe('true');
    expect(res.steps?.some((s) => /on attempt 2\/3/.test(s))).toBe(true);
  });

  it('the persisted document carries the authored records on state.rules', async () => {
    process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID = LA;

    const res = await activatorProvisioner(input());

    expect(res.status).toBe('created');
    const written = replace.mock.calls[0][0] as any;
    expect(written.state.rules).toHaveLength(1);
    expect(written.state.rules[0].azureRuleName).toBe('DL-Shim-Activator-rule');
  });

  it('a Cosmos 403 whose TEXT carries no infra token still classifies as a remediation, not a bug', async () => {
    process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID = LA;
    // A real Cosmos rejection: the status is on the error object, and the message
    // is the service's prose — it need not contain 'forbidden'/'403' at all.
    // Carrying only `e.message` forward strips the status, so
    // isInfraOrPermissionError (types.ts) can never see it and the install is
    // reported as `failed` — which types.ts reserves for genuine code bugs.
    const err: any = new Error('Request is blocked by the account policy.');
    err.status = 403;
    replace.mockRejectedValue(err);

    const res = await activatorProvisioner(input());

    expect(res.status).toBe('remediation');
    expect(res.status).not.toBe('failed');
    expect(res.gate?.remediation).toContain('Request is blocked by the account policy.');
  });

  it('a Cosmos 429 whose TEXT carries no infra token still classifies as a remediation', async () => {
    process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID = LA;
    // @azure/cosmos ErrorResponse carries the HTTP status on `code` (number) —
    // it has NO `status`/`statusCode` field (ErrorResponse.d.ts) — so a throttle
    // reaches the classifier as prose alone unless `code` is read too.
    const err: any = new Error('Request rate is large.');
    err.code = 429;
    replace.mockRejectedValue(err);

    const res = await activatorProvisioner(input());

    expect(res.status).toBe('remediation');
  });

  it('re-running the install REPLACES its own rule instead of duplicating it', async () => {
    process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID = LA;
    // The item already carries this install's rule plus one the user added.
    read.mockResolvedValue({
      resource: {
        id: 'act-1', workspaceId: 'w',
        state: { rules: [{ id: 'r1', name: 'stale' }, { id: 'user-rule', name: 'added by hand' }] },
      },
    } as any);

    const res = await activatorProvisioner(input());

    expect(res.status).toBe('created');
    const written = replace.mock.calls[0][0] as any;
    expect(written.state.rules).toHaveLength(2);
    // The user's own rule survives; the install's rule is updated in place.
    expect(written.state.rules.map((r: any) => r.id).sort()).toEqual(['r1', 'user-rule']);
    expect(written.state.rules.find((r: any) => r.id === 'r1').name).toBe('DL-Shim refresh SLA breach');
  });
});
