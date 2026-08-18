/**
 * PR #3693 review, B1 — the #3551 self-heal is a WRITE inside a READ-SCOPED GET.
 *
 * THE DEFECT THIS PINS. `GET /api/items/activator/[id]/rules` authorizes with
 * `allowReadRoles: true`, which admits every workspace role including a
 * read-only Viewer. It then called `reconcileFromAzureMonitor`, which does two
 * `replaceWithMerge` writes to the Cosmos item — the second rewrites
 * `state.rules` and bumps `updatedAt`. That is exactly what
 * `lib/auth/workspace-guard.ts` forbids in the contract on `allowReadRoles`:
 *
 *   "Mutating handlers must NOT pass it — they stay write-scoped
 *    (Owner/Admin/Member) so a read-only Viewer can never mutate through a route
 *    that only 'made the read work'."
 *
 * The fix keeps the heal in GET and re-authorizes the WRITE on the write ladder,
 * so a read-only caller still gets the real live rules — just un-persisted.
 *
 * WHAT IS DELIBERATELY *NOT* MOCKED. `authorizeItemWorkspace`,
 * `authorizeWorkspace` and `isTenantAdmin` all RUN FOR REAL; only the data layer
 * under them (Cosmos, the ARM listing) and the access RESOLVER are stubbed.
 * Mocking the guard — as the sibling `rules-reconcile.test.ts` does, because its
 * subject is the join key rather than the ladder — would leave a suite that
 * passes with the whole read/write split deleted.
 *
 * HONEST SCOPE OF THE FIXTURE. `loadContentBackedItem` (the item load these
 * handlers run first) point-reads the workspace on `(workspaceId, callerOid)`
 * and requires `workspace.tenantId === callerOid`, and a workspace doc lives in
 * its CREATOR's partition — so on today's code only the workspace owner (always
 * `canWrite`) gets an item back at all, and the Viewer write is not reachable
 * end-to-end. The Cosmos stub here is partition-key-agnostic (identical to the
 * sibling suite's), which holds the item load fixed and varies ONLY the caller's
 * workspace ROLE. That is the variable under test: the day `loadContentBackedItem`
 * becomes ACL-aware — the #2947 class of fix this repo is actively applying — the
 * unfixed route mutates on a Viewer's GET with no other line changing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { AccessRole } from '@/lib/auth/workspace-access';

const TENANT = 'oid-1';

const state = {
  itemDoc: null as any,
  workspaceDoc: null as any,
  liveRules: [] as any[],
};
/** Every document handed to Cosmos `replace()` — i.e. every WRITE. */
const replaced: any[] = [];

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

vi.mock('@/lib/auth/session', () => ({
  getSession: () => ({ claims: { oid: TENANT, tid: 'tid-1' } }),
  tenantScopeId: (s: any) => s?.claims?.tid || s?.claims?.oid,
}));

// The ONE authorization input that is stubbed: who the caller is on the
// workspace. The guard that consumes it is the real one.
const resolveWorkspaceAccessByOid = vi.fn();
vi.mock('@/lib/auth/workspace-access', () => ({
  resolveWorkspaceAccessByOid: (...a: any[]) => resolveWorkspaceAccessByOid(...a),
}));

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: {
      query: () => ({ fetchAll: async () => ({ resources: state.itemDoc ? [state.itemDoc] : [] }) }),
    },
    item: () => ({
      read: async () => ({ resource: state.itemDoc }),
      replace: async (doc: any) => { replaced.push(doc); state.itemDoc = doc; return { resource: doc }; },
    }),
  }),
  workspacesContainer: async () => ({
    item: () => ({ read: async () => ({ resource: state.workspaceDoc }) }),
  }),
}));

vi.mock('@/lib/azure/monitor-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/azure/monitor-client')>()),
  listScheduledQueryRules: vi.fn(async () => state.liveRules),
  listScheduledQueryRulesPaged: vi.fn(async () => ({ rules: state.liveRules, truncatedBy: null, pagesFetched: 1 })),
  deleteScheduledQueryRule: vi.fn(async () => undefined),
  upsertScheduledQueryRule: vi.fn(async (input: any) =>
    `/subscriptions/s/resourceGroups/rg/providers/Microsoft.Insights/scheduledQueryRules/${input.name}`),
  patchScheduledQueryRule: vi.fn(async () => undefined),
}));

import { GET, POST, PATCH, DELETE } from '../route';
import { expectedAzureRuleName } from '@/lib/azure/activator-monitor';

const PARAMS = { params: Promise.resolve({ id: 'act-1' }) };
const url = (extra = '') => `http://localhost/api/items/activator/act-1/rules?workspaceId=ws-1${extra}`;
const req = () => new NextRequest(url());
const postReq = (body: any) => new NextRequest(url(), {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

const RULE_NAME = 'customer_churn_model_drift_alert';
const MY_ARM_NAME = expectedAzureRuleName('Model Drift Alert', RULE_NAME);

const access = (role: AccessRole, canWrite: boolean) =>
  ({ workspace: { id: 'ws-1' }, role, via: role === 'Owner' ? 'owner' : 'acl', canWrite });
const OWNER = access('Owner', true);
const VIEWER = access('Viewer', false);

function makeItem(over: Partial<any> = {}) {
  return {
    id: 'act-1',
    workspaceId: 'ws-1',
    itemType: 'activator',
    displayName: 'Model Drift Alert',
    _etag: 'etag-1',
    state: { provisioning: { status: 'created', secondaryIds: { backend: 'azure-monitor', rulesCreated: '1' } } },
    createdBy: 'u', createdAt: 't', updatedAt: 't',
    ...over,
  };
}

function makeLiveRule(over: Partial<any> = {}) {
  return {
    id: `/subscriptions/s/resourceGroups/rg/providers/Microsoft.Insights/scheduledQueryRules/${MY_ARM_NAME}`,
    name: MY_ARM_NAME,
    enabled: true,
    severity: 2,
    description: `Loom Activator rule '${RULE_NAME}'`,
    scopes: ['/subscriptions/s/resourceGroups/rg/providers/Microsoft.OperationalInsights/workspaces/law'],
    query: 'AppEvents | where drift > 0.2',
    evaluationFrequency: 'PT15M',
    windowSize: 'PT1H',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  replaced.length = 0;
  state.itemDoc = makeItem();
  state.workspaceDoc = { id: 'ws-1', tenantId: TENANT };
  state.liveRules = [makeLiveRule()];
  resolveWorkspaceAccessByOid.mockResolvedValue(OWNER);
  delete process.env.LOOM_ACTIVATOR_BACKEND;
  // isTenantAdmin runs for real — make sure the fixture caller is not one, or
  // every role below would be admitted by the bypass and prove nothing. The
  // names are the ones lib/auth/feature-gate.ts actually reads.
  delete process.env.LOOM_TENANT_ADMIN_OID;
  delete process.env.LOOM_TENANT_ADMIN_GROUP_ID;
});

// ---------------------------------------------------------------------------
describe('B1 — a read-only role cannot mutate the item through GET', () => {
  it('a Viewer GET performs NO Cosmos write', async () => {
    // MUTATION B1-a: drop the `canPersist` argument from
    //   `reconcileFromAzureMonitor(item, bundleRule, canPersist)` and restore the
    //   unconditional `replaceWithMerge` write-back (i.e. revert the fix).
    // → observed: RED here and in the two specs below — `replaced` carries a
    //   document whose `state.rules` is the recovered record and whose
    //   `updatedAt` has moved, from a GET issued by a Viewer.
    resolveWorkspaceAccessByOid.mockResolvedValue(VIEWER);

    const r = await GET(req(), PARAMS);

    expect(r.status).toBe(200);
    expect(replaced).toHaveLength(0);
    expect(state.itemDoc.state.rules).toBeUndefined();
    expect(state.itemDoc.updatedAt).toBe('t');
  });

  it('the un-healed response is still CORRECT and useful — the real live rules, and an honest note', async () => {
    // A gate that also breaks the legitimate read is not a fix: the Viewer must
    // not be handed `[]` (the pre-#3551 dead editor) or a 403.
    resolveWorkspaceAccessByOid.mockResolvedValue(VIEWER);

    const j = await (await GET(req(), PARAMS)).json();

    expect(j.ok).toBe(true);
    expect(j.source).toBe('azure-monitor-reconciled');
    expect(j.rules).toHaveLength(1);
    expect(j.rules[0].azureRuleName).toBe(MY_ARM_NAME);
    expect(j.rules[0].query).toBe('AppEvents | where drift > 0.2');
    // …and it says plainly that nothing was recorded, and why (R7).
    expect(j.healed).toBe(false);
    expect(j.note).toMatch(/not.*recorded|read-only/i);
  });

  it('a Viewer GET that matches NOTHING does not write the reconcile-cooldown marker either', async () => {
    // MUTATION B1-b: gate only the heal write and leave the no-match
    //   `rulesReconcile` write ungated.
    // → observed: RED here only. That write is quieter (it does not bump
    //   updatedAt) but it is still a `replace()` of another tenant-visible
    //   document driven by a read-only caller, and it changes what the NEXT
    //   reconcile does.
    resolveWorkspaceAccessByOid.mockResolvedValue(VIEWER);
    state.liveRules = [];

    const r = await GET(req(), PARAMS);

    expect(r.status).toBe(200);
    expect(replaced).toHaveLength(0);
    expect(state.itemDoc.state.rulesReconcile).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('B1 — the write ladder is the REAL one, and write-capable callers still self-heal', () => {
  const WRITE_ROLES: AccessRole[] = ['Owner', 'Admin', 'Member'];
  const READ_ROLES: AccessRole[] = ['Contributor', 'Viewer'];

  for (const role of WRITE_ROLES) {
    it(`${role} still heals the item (the #3551 behaviour is intact)`, async () => {
      resolveWorkspaceAccessByOid.mockResolvedValue(access(role, true));

      const j = await (await GET(req(), PARAMS)).json();

      expect(j.healed).toBe(true);
      const written = replaced.filter((d) => (d.state?.rules || []).length > 0);
      expect(written).toHaveLength(1);
      expect(written[0].state.rules[0].azureRuleName).toBe(MY_ARM_NAME);
    });
  }

  for (const role of READ_ROLES) {
    it(`${role} reads the rules but writes nothing`, async () => {
      resolveWorkspaceAccessByOid.mockResolvedValue(access(role, false));

      const j = await (await GET(req(), PARAMS)).json();

      expect(j.rules).toHaveLength(1);
      expect(j.healed).toBe(false);
      expect(replaced).toHaveLength(0);
    });
  }

  it('the write probe is a SECOND, write-scoped authorization — not the read one reused', async () => {
    // The read call passes `allowReadRoles: true`; the write probe must not.
    // Asserted through the real guard: the ONLY thing that differs between the
    // two calls below is `canWrite` on the resolved access, and it must decide
    // the write. A probe that reused the read scope would heal in both.
    resolveWorkspaceAccessByOid.mockResolvedValue(access('Viewer', false));
    await GET(req(), PARAMS);
    expect(replaced).toHaveLength(0);

    state.itemDoc = makeItem();
    resolveWorkspaceAccessByOid.mockResolvedValue(access('Viewer', true));
    await GET(req(), PARAMS);
    expect(replaced.some((d) => (d.state?.rules || []).length > 0)).toBe(true);
  });

  it('a tenant admin is admitted by the real isTenantAdmin bypass, with no ACL role at all', async () => {
    // The admin-open path must keep working: the probe is the canonical ladder,
    // so an admin who is not an ACL member of the workspace still heals.
    process.env.LOOM_TENANT_ADMIN_OID = TENANT;
    resolveWorkspaceAccessByOid.mockResolvedValue(null);

    const j = await (await GET(req(), PARAMS)).json();

    expect(j.healed).toBe(true);
    expect(replaced.some((d) => (d.state?.rules || []).length > 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('B1 — the explicitly mutating verbs stay refused for a read-only role', () => {
  // These pass today. They are here so the read/write split cannot be "fixed"
  // later by handing the mutating handlers `allowReadRoles: true` — the shape
  // the guard's docstring names, and the one that made this GET a mutation.
  it('POST (create rule) 404s a Viewer and reaches no ARM upsert', async () => {
    const { upsertScheduledQueryRule } = await import('@/lib/azure/monitor-client');
    resolveWorkspaceAccessByOid.mockResolvedValue(VIEWER);

    const r = await POST(postReq({ name: RULE_NAME }), PARAMS);

    expect(r.status).toBe(404);
    expect(upsertScheduledQueryRule).not.toHaveBeenCalled();
    expect(replaced).toHaveLength(0);
  });

  it('DELETE (remove rule) 404s a Viewer and reaches no ARM delete', async () => {
    const { deleteScheduledQueryRule } = await import('@/lib/azure/monitor-client');
    resolveWorkspaceAccessByOid.mockResolvedValue(VIEWER);
    state.itemDoc = makeItem({
      state: { rules: [{ id: MY_ARM_NAME, name: RULE_NAME, azureRuleName: MY_ARM_NAME, backend: 'azure-monitor' }] },
    });

    const r = await DELETE(new NextRequest(url(`&ruleId=${MY_ARM_NAME}`)), PARAMS);

    expect(r.status).toBe(404);
    expect(deleteScheduledQueryRule).not.toHaveBeenCalled();
    expect(replaced).toHaveLength(0);
  });

  it('PATCH (enable/disable) 404s a Viewer and reaches no ARM patch', async () => {
    const { patchScheduledQueryRule } = await import('@/lib/azure/monitor-client');
    resolveWorkspaceAccessByOid.mockResolvedValue(VIEWER);
    state.itemDoc = makeItem({
      state: { rules: [{ id: MY_ARM_NAME, name: RULE_NAME, azureRuleName: MY_ARM_NAME, backend: 'azure-monitor' }] },
    });

    const r = await PATCH(new NextRequest(url(`&ruleId=${MY_ARM_NAME}&enabled=false`)), PARAMS);

    expect(r.status).toBe(404);
    expect(patchScheduledQueryRule).not.toHaveBeenCalled();
    expect(replaced).toHaveLength(0);
  });
});
