/**
 * PUT /api/items/activator/[id]/rules — a partial edit must not silently replace
 * a real KQL query with the condition-builder's DEFAULTS.
 *
 * This is the follow-on hazard of the #3551 reconcile: a record recovered from
 * ARM carries the rule's REAL query but no structured `condition` (ARM does not
 * return one, and the item's bundle may not carry a matching rule). The editor's
 * Edit dialog then opens with an empty condition builder and PUTs
 * `condition: { operator, value }` with NO `property`, plus `ruleKind: 'event'`.
 *
 * Before this guard, ANY truthy `condition`/`ruleKind` on the body made the route
 * pass `query: undefined` to createMonitorActivatorRule, whose buildRuleQuery
 * then composed its defaults — `property='value'`, `operator='=='`, `value=0` —
 * and UPSERTED that over a working alert rule. Changing only the severity of a
 * recovered rule silently destroyed its query.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const TENANT = 'oid-1';
const REAL_QUERY = 'AppEvents\n| where drift_score > 0.2';

const state = { itemDoc: null as any, workspaceDoc: null as any };

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

vi.mock('@/lib/auth/session', () => ({
  getSession: () => ({ claims: { oid: TENANT } }),
  tenantScopeId: (s: any) => s?.claims?.tid || s?.claims?.oid,
}));

vi.mock('@/lib/auth/workspace-guard', () => ({ authorizeItemWorkspace: vi.fn(async () => null) }));

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: state.itemDoc ? [state.itemDoc] : [] }) }) },
    item: () => ({ read: async () => ({ resource: state.itemDoc }), replace: async (d: any) => ({ resource: d }) }),
  }),
  workspacesContainer: async () => ({ item: () => ({ read: async () => ({ resource: state.workspaceDoc }) }) }),
}));

const createMonitorActivatorRule = vi.fn(async (_display: string, input: any) => ({
  id: 'Model-Drift-Alert-customer_churn_m',
  name: input.name,
  query: input.query ?? 'REBUILT-FROM-CONDITION',
  azureRuleName: 'Model-Drift-Alert-customer_churn_m',
  severity: input.severity ?? 3,
  evaluationFrequency: input.evaluationFrequency ?? 'PT5M',
  windowSize: input.windowSize ?? 'PT5M',
  state: 'Active', backend: 'azure-monitor', sourceKind: 'log-analytics', createdAt: 'now',
}));

vi.mock('@/lib/azure/activator-monitor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/azure/activator-monitor')>()),
  createMonitorActivatorRule: (...a: any[]) => (createMonitorActivatorRule as any)(...a),
  deleteMonitorActivatorRule: vi.fn(async () => undefined),
  disableMonitorRule: vi.fn(async () => undefined),
}));

import { PUT } from '../route';

const PARAMS = { params: Promise.resolve({ id: 'act-1' }) };
const putReq = (body: any) =>
  new NextRequest('http://localhost/api/items/activator/act-1/rules?workspaceId=ws-1&ruleId=Model-Drift-Alert-customer_churn_m', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

/** The shape a #3551 reconcile produces: real query, no structured condition. */
const RECOVERED_RULE = {
  id: 'Model-Drift-Alert-customer_churn_m',
  name: 'customer_churn_model_drift_alert',
  azureRuleName: 'Model-Drift-Alert-customer_churn_m',
  query: REAL_QUERY,
  severity: 2,
  evaluationFrequency: 'PT15M',
  windowSize: 'PT1H',
  state: 'Active' as const,
  backend: 'azure-monitor' as const,
  sourceKind: 'log-analytics' as const,
  createdAt: 't',
};

beforeEach(() => {
  vi.clearAllMocks();
  state.itemDoc = {
    id: 'act-1', workspaceId: 'ws-1', itemType: 'activator', displayName: 'Model Drift Alert',
    state: { rules: [RECOVERED_RULE] }, createdBy: 'u', createdAt: 't', updatedAt: 't',
  };
  state.workspaceDoc = { id: 'ws-1', tenantId: TENANT };
  delete process.env.LOOM_ACTIVATOR_BACKEND;
});

describe('PUT activator rule — an empty condition builder never overwrites a real query', () => {
  it('the editor\'s empty-condition edit (severity change only) keeps the rule\'s query', async () => {
    // Exactly what activator-editor.tsx composes when condProperty is blank.
    const r = await PUT(putReq({
      name: 'customer_churn_model_drift_alert',
      condition: { operator: 'gt', value: null },
      action: { kind: 'Email', config: { to: 'ds@contoso.com' } },
      ruleKind: 'event',
      severity: 1,
      evaluationFrequency: 'PT15M',
      windowSize: 'PT1H',
    }), PARAMS);

    expect(r.status).toBe(200);
    const passed = createMonitorActivatorRule.mock.calls[0][1] as any;
    expect(passed.query).toBe(REAL_QUERY);
    expect(passed.severity).toBe(1);
  });

  it('a REAL condition edit still rebuilds the query', async () => {
    await PUT(putReq({
      name: 'customer_churn_model_drift_alert',
      condition: { property: 'drift_score', operator: 'gt', value: 0.5 },
      ruleKind: 'event',
    }), PARAMS);

    const passed = createMonitorActivatorRule.mock.calls[0][1] as any;
    expect(passed.query).toBeUndefined();
    expect(passed.condition).toEqual({ property: 'drift_score', operator: 'gt', value: 0.5 });
  });

  it('a verbatim KQL edit still wins', async () => {
    await PUT(putReq({
      name: 'customer_churn_model_drift_alert',
      condition: { operator: 'gt', value: null },
      query: 'AppEvents | take 5',
    }), PARAMS);

    const passed = createMonitorActivatorRule.mock.calls[0][1] as any;
    expect(passed.query).toBe('AppEvents | take 5');
  });

  it('a typed trigger-model edit still rebuilds the query', async () => {
    await PUT(putReq({
      name: 'customer_churn_model_drift_alert',
      condition: { operator: 'gt', value: null },
      ruleKind: 'property',
      propertyConditionType: 'increases-by',
      changePercent: 10,
    }), PARAMS);

    const passed = createMonitorActivatorRule.mock.calls[0][1] as any;
    expect(passed.query).toBeUndefined();
    expect(passed.ruleKind).toBe('property');
  });
});
