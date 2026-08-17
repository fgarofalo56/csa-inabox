/**
 * #3551 — GET /api/items/activator/[id]/rules self-heals from live Azure Monitor.
 *
 * Live repro: an app-installed activator ("Model Drift Alert", "Data Quality SLA
 * Activator") showed a COMPLETELY EMPTY Reflex list while real
 * Microsoft.Insights/scheduledQueryRules existed in Azure and the install had
 * reported success. The provisioner's state.rules write had been best-effort, so
 * the record was lost; this GET read state.rules, found nothing, fell back to a
 * static bundle projection, and returned `rules: []`.
 *
 * The provisioner fix stops NEW installs losing the record. It does nothing for
 * the items already in that state — those alert rules exist and fire, and every
 * per-rule action keys off state.rules, so without a reconcile they are dead
 * forever. Per .claude/rules/auto-bind-by-default.md §3 a stale binding is
 * repaired automatically, so GET now rebuilds the records from ARM and writes
 * them back.
 *
 * Cosmos + auth + the ARM listing are mocked; safeRuleName (the join key between
 * a Loom item and its ARM rules) is the REAL implementation — mocking it would
 * test a model of the code instead of the code.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const TENANT = 'oid-1';

const state = {
  itemDoc: null as any,
  workspaceDoc: null as any,
  liveRules: [] as any[],
  listThrows: null as any,
  replaceThrows: null as any,
};

const replaced: any[] = [];

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

vi.mock('@/lib/auth/session', () => ({
  getSession: () => ({ claims: { oid: TENANT } }),
  tenantScopeId: (s: any) => s?.claims?.tid || s?.claims?.oid,
}));

vi.mock('@/lib/auth/workspace-guard', () => ({
  authorizeItemWorkspace: vi.fn(async () => null),
}));

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: {
      query: () => ({ fetchAll: async () => ({ resources: state.itemDoc ? [state.itemDoc] : [] }) }),
    },
    item: () => ({
      read: async () => ({ resource: state.itemDoc }),
      replace: async (doc: any) => {
        if (state.replaceThrows) throw state.replaceThrows;
        replaced.push(doc);
        return { resource: doc };
      },
    }),
  }),
  workspacesContainer: async () => ({
    item: () => ({ read: async () => ({ resource: state.workspaceDoc }) }),
  }),
}));

// Stub ONLY the ARM listing; every other monitor-client export (and the real
// error classes activator-monitor / monitor-gate depend on) stays real.
vi.mock('@/lib/azure/monitor-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/azure/monitor-client')>()),
  listScheduledQueryRules: vi.fn(async () => {
    if (state.listThrows) throw state.listThrows;
    return state.liveRules;
  }),
}));

import { GET } from '../route';

const PARAMS = { params: Promise.resolve({ id: 'act-1' }) };
const req = () => new NextRequest('http://localhost/api/items/activator/act-1/rules?workspaceId=ws-1');

/** An activator whose install DID create alert rules but lost the record. */
function makeItem(over: Partial<any> = {}) {
  return {
    id: 'act-1',
    workspaceId: 'ws-1',
    itemType: 'activator',
    displayName: 'Model Drift Alert',
    state: {},
    createdBy: 'u', createdAt: 't', updatedAt: 't',
    ...over,
  };
}

/** A real ARM scheduledQueryRule as listScheduledQueryRules projects it. The
 *  name is what createMonitorActivatorRule authors: safeRuleName(displayName,
 *  <rule-suffix>) — 'Model Drift Alert' sanitizes to 'Model-Drift-Alert'. */
function makeLiveRule(over: Partial<any> = {}) {
  return {
    id: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Insights/scheduledQueryRules/Model-Drift-Alert-customer_churn',
    name: 'Model-Drift-Alert-customer_churn',
    enabled: true,
    severity: 2,
    description: "Loom Activator rule 'customer_churn_model_drift_alert'",
    scopes: ['/subscriptions/s/resourceGroups/rg/providers/Microsoft.OperationalInsights/workspaces/law'],
    query: 'AppEvents | where drift > 0.2',
    evaluationFrequency: 'PT15M',
    windowSize: 'PT1H',
    actionGroupIds: ['/subscriptions/s/resourceGroups/rg/providers/microsoft.insights/actionGroups/Model-Drift-Alert-ag'],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  replaced.length = 0;
  state.itemDoc = makeItem();
  state.workspaceDoc = { id: 'ws-1', tenantId: TENANT };
  state.liveRules = [makeLiveRule()];
  state.listThrows = null;
  state.replaceThrows = null;
  delete process.env.LOOM_ACTIVATOR_BACKEND;
});

describe('#3551 GET activator rules — reconciles a lost record from live Azure Monitor', () => {
  it('empty state.rules + a real matching alert rule → returns it instead of []', async () => {
    const r = await GET(req(), PARAMS);
    expect(r.status).toBe(200);
    const j = await r.json();

    expect(j.ok).toBe(true);
    expect(j.rules).toHaveLength(1);
    expect(j.source).toBe('azure-monitor-reconciled');
    // The recovered record carries the REAL backing rule, so every per-rule
    // action (Start/Stop/Edit/Delete) can resolve it — a bundle projection cannot.
    expect(j.rules[0].azureRuleName).toBe('Model-Drift-Alert-customer_churn');
    expect(j.rules[0].name).toBe('customer_churn_model_drift_alert');
    expect(j.rules[0].query).toBe('AppEvents | where drift > 0.2');
    expect(j.rules[0].severity).toBe(2);
    expect(j.rules[0].evaluationFrequency).toBe('PT15M');
    expect(j.rules[0].state).toBe('Active');
    expect(j.rules[0].sourceKind).toBe('log-analytics');
  });

  it('writes the recovered records back so the next open is a plain read', async () => {
    const r = await GET(req(), PARAMS);
    const j = await r.json();

    expect(j.healed).toBe(true);
    expect(replaced).toHaveLength(1);
    expect(replaced[0].state.rules).toHaveLength(1);
    expect(replaced[0].state.rules[0].azureRuleName).toBe('Model-Drift-Alert-customer_churn');
  });

  it('a disabled ARM rule reconciles as Disabled, and an ADX-scoped rule as adx', async () => {
    state.liveRules = [makeLiveRule({
      enabled: false,
      scopes: ['/subscriptions/s/resourceGroups/rg/providers/Microsoft.Kusto/clusters/adx1'],
    })];

    const j = await (await GET(req(), PARAMS)).json();

    expect(j.rules[0].state).toBe('Disabled');
    expect(j.rules[0].sourceKind).toBe('adx');
  });

  it('fills condition/action from the bundle when the rule names match', async () => {
    state.itemDoc = makeItem({
      state: {
        content: {
          kind: 'activator',
          rule: {
            name: 'customer_churn_model_drift_alert',
            condition: { metric: 'drift_score', op: 'greaterThan', threshold: 0.2 },
            action: { kind: 'email', config: { to: 'ds@contoso.com' } },
          },
        },
      },
    });

    const j = await (await GET(req(), PARAMS)).json();

    expect(j.source).toBe('azure-monitor-reconciled');
    // Recovered from ARM, enriched from the item's OWN bundle content — the
    // record is actionable AND complete, with nothing invented.
    expect(j.rules[0].azureRuleName).toBe('Model-Drift-Alert-customer_churn');
    expect(j.rules[0].condition).toEqual({ property: 'drift_score', operator: 'greaterThan', value: 0.2 });
    expect(j.rules[0].action.kind).toBe('email');
  });

  it('a failed heal-write still returns the rules, and says so honestly', async () => {
    state.replaceThrows = new Error('Cosmos 503');

    const j = await (await GET(req(), PARAMS)).json();

    expect(j.rules).toHaveLength(1);
    expect(j.healed).toBe(false);
  });

  it('does NOT claim another activator\'s rules', async () => {
    state.liveRules = [makeLiveRule({ name: 'Some-Other-Activator-rule', id: '/x/Some-Other-Activator-rule' })];

    const j = await (await GET(req(), PARAMS)).json();

    expect(j.source).not.toBe('azure-monitor-reconciled');
    expect(j.rules).toHaveLength(0);
    expect(replaced).toHaveLength(0);
  });

  it('state.rules already populated → plain read, no ARM call', async () => {
    const { listScheduledQueryRules } = await import('@/lib/azure/monitor-client');
    state.itemDoc = makeItem({ state: { rules: [{ id: 'r1', name: 'existing', azureRuleName: 'a' }] } });

    const j = await (await GET(req(), PARAMS)).json();

    expect(j.rules).toHaveLength(1);
    expect(j.rules[0].name).toBe('existing');
    expect(j.source).toBeUndefined();
    expect(listScheduledQueryRules).not.toHaveBeenCalled();
  });

  it('Azure Monitor unreachable → falls through to the bundle projection, never 500s', async () => {
    state.listThrows = new Error('Azure Monitor not configured');
    state.itemDoc = makeItem({
      state: {
        content: {
          kind: 'activator',
          rule: { name: 'customer_churn_model_drift_alert', condition: { metric: 'd', op: 'gt', threshold: 1 }, action: { kind: 'email' } },
        },
      },
    });

    const r = await GET(req(), PARAMS);
    const j = await r.json();

    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.source).toBe('bundle');
    expect(j.rules).toHaveLength(1);
  });

  it('a genuinely empty NEW activator still returns an empty list, not an error', async () => {
    state.liveRules = [];

    const r = await GET(req(), PARAMS);
    const j = await r.json();

    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.rules).toEqual([]);
    expect(replaced).toHaveLength(0);
  });
});
