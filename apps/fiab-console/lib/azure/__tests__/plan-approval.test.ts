/**
 * audit-T13 — plan approval handoff + semantic-model writeback contract tests.
 *
 *   buildPlanDataTableDax        DATATABLE() literal for _PlanTasks
 *   buildPlanTasksTableTmsl      createOrReplace for the _PlanTasks calc table
 *   buildPlanMetricsTableTmsl    createOrReplace for the _PlanMetrics measures
 *   buildPlanStatusMeasuresTmsl  both scripts in dependency order
 *   approvalConfigGate           honest env gate (which var is missing)
 *   getApprovalTriggerUrl        ARM listCallbackUrl call + 404/error mapping
 *
 * Stubs @azure/identity + global.fetch — no live tenant. Real code path, not a
 * mock of it (per no-vaporware.md).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'TOK', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

import {
  buildPlanDataTableDax,
  buildPlanTasksTableTmsl,
  buildPlanMetricsTableTmsl,
  buildPlanStatusMeasuresTmsl,
  type PlanMetricTask,
} from '../aas-client';
import {
  approvalConfigGate,
  getApprovalTriggerUrl,
  ApprovalArmError,
} from '../plan-approval-client';

const TASKS: PlanMetricTask[] = [
  { title: 'Define semantic model', owner: 'ana@x.com', due: '2026-01-01', status: 'done' },
  { title: 'Wire approval', owner: 'bo@x.com', due: '2026-12-31', status: 'doing' },
  { title: 'Ship "v1"', owner: '', due: '', status: 'todo' },
];

const realFetch = global.fetch;
function mockFetch(handler: (url: string, init?: RequestInit) => any) {
  global.fetch = vi.fn(async (url: any, init?: any) => {
    const out = await handler(String(url), init);
    if (out instanceof Response) return out;
    const status = out?._status || 200;
    const text = typeof out === 'string' ? out : (out === undefined ? '' : JSON.stringify(out));
    return new Response(text, { status });
  }) as any;
}
afterEach(() => { global.fetch = realFetch; vi.unstubAllEnvs(); });

describe('buildPlanDataTableDax', () => {
  it('emits a DATATABLE with 4 typed columns and one row per task', () => {
    const dax = buildPlanDataTableDax(TASKS);
    expect(dax.startsWith('DATATABLE(')).toBe(true);
    expect(dax).toContain('"Title", STRING');
    expect(dax).toContain('"Status", STRING');
    expect(dax).toContain('{ "Define semantic model", "ana@x.com", "2026-01-01", "done" }');
    // empty owner/due remain valid empty string literals
    expect(dax).toContain('{ "Ship ""v1""", "", "", "todo" }');
  });

  it('produces a valid zero-row DATATABLE for an empty task list', () => {
    const dax = buildPlanDataTableDax([]);
    expect(dax.startsWith('DATATABLE(')).toBe(true);
    expect(dax).toContain('"Title", STRING');
  });
});

describe('buildPlanTasksTableTmsl', () => {
  it('emits a createOrReplace for _PlanTasks with a calculated partition', () => {
    const tmsl = JSON.parse(buildPlanTasksTableTmsl('AdventureWorks', TASKS));
    expect(tmsl.createOrReplace.object).toEqual({ database: 'AdventureWorks', table: '_PlanTasks' });
    const t = tmsl.createOrReplace.table;
    expect(t.name).toBe('_PlanTasks');
    expect(t.columns.map((c: any) => c.name)).toEqual(['Title', 'Owner', 'Due', 'Status']);
    expect(t.partitions[0].source.type).toBe('calculated');
    expect(t.partitions[0].source.expression).toContain('DATATABLE(');
  });
});

describe('buildPlanMetricsTableTmsl', () => {
  it('emits PlanDone%, PlanOverdue, ApprovalStatus measures + carries the approval status row', () => {
    const tmsl = JSON.parse(buildPlanMetricsTableTmsl('AdventureWorks', 'approved'));
    const t = tmsl.createOrReplace.table;
    expect(t.name).toBe('_PlanMetrics');
    expect(t.isHidden).toBe(true);
    const names = t.measures.map((m: any) => m.name);
    expect(names).toContain('PlanDone%');
    expect(names).toContain('PlanOverdue');
    expect(names).toContain('ApprovalStatus');
    const done = t.measures.find((m: any) => m.name === 'PlanDone%');
    expect(done.expression).toContain("'_PlanTasks'[Status] = \"done\"");
    expect(done.expression).toContain('DIVIDE');
    // the approval status is the single-row partition value
    expect(t.partitions[0].source.expression).toContain('"approved"');
  });
});

describe('buildPlanStatusMeasuresTmsl', () => {
  it('returns both scripts in dependency order (tasks before metrics)', () => {
    const { tasksTmsl, metricsTmsl } = buildPlanStatusMeasuresTmsl('DB', TASKS, 'pending');
    expect(JSON.parse(tasksTmsl).createOrReplace.object.table).toBe('_PlanTasks');
    expect(JSON.parse(metricsTmsl).createOrReplace.object.table).toBe('_PlanMetrics');
  });
});

describe('approvalConfigGate', () => {
  beforeEach(() => { vi.unstubAllEnvs(); });
  it('flags LOOM_APPROVAL_LOGIC_APP_NAME first when unset', () => {
    vi.stubEnv('LOOM_APPROVAL_LOGIC_APP_NAME', '');
    vi.stubEnv('LOOM_SUBSCRIPTION_ID', '');
    const gate = approvalConfigGate();
    expect(gate?.missing).toBe('LOOM_APPROVAL_LOGIC_APP_NAME');
    expect(gate?.remediation).toContain('approval-logicapp.bicep');
  });
  it('flags LOOM_SUBSCRIPTION_ID when the name is set but the sub is not', () => {
    vi.stubEnv('LOOM_APPROVAL_LOGIC_APP_NAME', 'logic-loom-approval-eastus');
    vi.stubEnv('LOOM_SUBSCRIPTION_ID', '');
    expect(approvalConfigGate()?.missing).toBe('LOOM_SUBSCRIPTION_ID');
  });
  it('returns null when both are set', () => {
    vi.stubEnv('LOOM_APPROVAL_LOGIC_APP_NAME', 'logic-loom-approval-eastus');
    vi.stubEnv('LOOM_SUBSCRIPTION_ID', 'sub-1');
    expect(approvalConfigGate()).toBeNull();
  });
});

describe('getApprovalTriggerUrl', () => {
  it('POSTs ARM listCallbackUrl and returns the trigger URL', async () => {
    let url = ''; let method = '';
    mockFetch((u, init) => { url = u; method = (init?.method as string) || 'GET'; return { value: 'https://prod.logic.azure.com/trigger?sig=abc' }; });
    const out = await getApprovalTriggerUrl('rg-dlz', 'logic-loom-approval-eastus', 'sub-1');
    expect(out).toBe('https://prod.logic.azure.com/trigger?sig=abc');
    expect(method).toBe('POST');
    expect(url).toContain('/subscriptions/sub-1/resourceGroups/rg-dlz');
    expect(url).toContain('/providers/Microsoft.Logic/workflows/logic-loom-approval-eastus/triggers/manual/listCallbackUrl');
    expect(url).toContain('api-version=2019-05-01');
  });

  it('throws a notFound ApprovalArmError on 404', async () => {
    mockFetch(() => ({ _status: 404 }));
    await expect(getApprovalTriggerUrl('rg', 'wf', 'sub')).rejects.toMatchObject({ status: 404, notFound: true });
  });

  it('throws ApprovalArmError on a non-OK ARM response', async () => {
    mockFetch(() => ({ _status: 500 }));
    await expect(getApprovalTriggerUrl('rg', 'wf', 'sub')).rejects.toBeInstanceOf(ApprovalArmError);
  });
});
