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
 * The reconcile CLAIMS ARM rules and then lets DELETE/PATCH act on them, so its
 * join key has to be authoritative — a claim that is merely PLAUSIBLE would let
 * one activator delete/pause another activator's live alert rule. The second and
 * third describes below pin that: the join key (tag, else description marker +
 * the exact deterministic name), and the write-back's concurrency + truncation +
 * tombstone behaviour.
 *
 * Cosmos + auth + the ARM listing are mocked; safeRuleName / expectedAzureRuleName
 * (the join key between a Loom item and its ARM rules) are the REAL
 * implementations — mocking them would test a model of the code instead of the
 * code.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const TENANT = 'oid-1';

const state = {
  /** What the query-by-id load returns (the doc the GET starts from). */
  itemDoc: null as any,
  /** What a point read returns — the CURRENT doc, which may have moved on. */
  itemDocLatest: undefined as any,
  workspaceDoc: null as any,
  liveRules: [] as any[],
  /** Non-null → listScheduledQueryRulesPaged reports an INCOMPLETE list. */
  truncatedBy: null as null | 'pages' | 'time',
  listThrows: null as any,
  replaceThrows: null as any,
  /** Queue of errors thrown by successive replace() calls (etag conflicts). */
  replaceThrowsOnce: [] as any[],
};

const replaced: any[] = [];
const replaceOptions: any[] = [];

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
      // The point read is the CURRENT document — the write-back re-reads through
      // it, so a rule POSTed while ARM was being listed shows up here.
      read: async () => ({ resource: state.itemDocLatest ?? state.itemDoc }),
      replace: async (doc: any, opts?: any) => {
        if (state.replaceThrowsOnce.length) throw state.replaceThrowsOnce.shift();
        if (state.replaceThrows) throw state.replaceThrows;
        replaced.push(doc);
        replaceOptions.push(opts);
        // Persist, so a GET after a DELETE sees what the DELETE wrote.
        state.itemDoc = doc;
        state.itemDocLatest = { ...doc, _etag: `etag-${replaced.length + 1}` };
        return { resource: doc };
      },
    }),
  }),
  workspacesContainer: async () => ({
    item: () => ({ read: async () => ({ resource: state.workspaceDoc }) }),
  }),
}));

// Stub ONLY the ARM listing + the ARM delete; every other monitor-client export
// (and the real error classes activator-monitor / monitor-gate depend on) stays
// real.
vi.mock('@/lib/azure/monitor-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/azure/monitor-client')>()),
  listScheduledQueryRules: vi.fn(async () => {
    if (state.listThrows) throw state.listThrows;
    return state.liveRules;
  }),
  listScheduledQueryRulesPaged: vi.fn(async () => {
    if (state.listThrows) throw state.listThrows;
    return { rules: state.liveRules, truncatedBy: state.truncatedBy, pagesFetched: 1 };
  }),
  deleteScheduledQueryRule: vi.fn(async () => undefined),
  upsertScheduledQueryRule: vi.fn(async (input: any) =>
    `/subscriptions/s/resourceGroups/rg/providers/Microsoft.Insights/scheduledQueryRules/${input.name}`),
}));

import { GET, POST, DELETE } from '../route';
import { safeRuleName, expectedAzureRuleName } from '@/lib/azure/activator-monitor';

const PARAMS = { params: Promise.resolve({ id: 'act-1' }) };
const req = () => new NextRequest('http://localhost/api/items/activator/act-1/rules?workspaceId=ws-1');
const delReq = (ruleId: string) =>
  new NextRequest(`http://localhost/api/items/activator/act-1/rules?workspaceId=ws-1&ruleId=${encodeURIComponent(ruleId)}`);
const postReq = (body: any) =>
  new NextRequest('http://localhost/api/items/activator/act-1/rules?workspaceId=ws-1', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

/** The bundle rule the app-ml-pipeline "Model Drift Alert" activator installs. */
const BUNDLE_RULE_NAME = 'customer_churn_model_drift_alert';
/** What createMonitorActivatorRule ACTUALLY names that rule on ARM. Derived from
 *  the real helper — a hand-typed name can (and did) model a name the code
 *  cannot author, which makes every join-key assertion vacuous. */
const MY_ARM_NAME = expectedAzureRuleName('Model Drift Alert', BUNDLE_RULE_NAME);

/**
 * An activator whose install DID create alert rules but lost the record.
 *
 * `state.provisioning.secondaryIds.rulesCreated` is what /api/apps/[id]/install
 * stamps from the provisioner's ProvisionResult — it is the EVIDENCE that this
 * item's install authored real ARM rules, and it is what licenses the reconcile
 * to spend a deployment-wide ARM list on this GET.
 */
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

/** A real ARM scheduledQueryRule as listScheduledQueryRules projects it. */
function makeLiveRule(over: Partial<any> = {}) {
  return {
    id: `/subscriptions/s/resourceGroups/rg/providers/Microsoft.Insights/scheduledQueryRules/${MY_ARM_NAME}`,
    name: MY_ARM_NAME,
    enabled: true,
    severity: 2,
    description: `Loom Activator rule '${BUNDLE_RULE_NAME}'`,
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
  replaceOptions.length = 0;
  state.itemDoc = makeItem();
  state.itemDocLatest = undefined;
  state.workspaceDoc = { id: 'ws-1', tenantId: TENANT };
  state.liveRules = [makeLiveRule()];
  state.truncatedBy = null;
  state.listThrows = null;
  state.replaceThrows = null;
  state.replaceThrowsOnce = [];
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
    expect(j.rules[0].azureRuleName).toBe(MY_ARM_NAME);
    expect(j.rules[0].name).toBe(BUNDLE_RULE_NAME);
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
    const withRules = replaced.filter((d) => (d.state?.rules || []).length > 0);
    expect(withRules).toHaveLength(1);
    expect(withRules[0].state.rules[0].azureRuleName).toBe(MY_ARM_NAME);
  });

  it('a disabled ARM rule reconciles as Disabled, and an ADX-scoped rule as adx', async () => {
    state.liveRules = [makeLiveRule({
      enabled: false,
      description: `Loom Activator rule '${BUNDLE_RULE_NAME}' (Eventhouse / ADX)`,
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
            name: BUNDLE_RULE_NAME,
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
    expect(j.rules[0].azureRuleName).toBe(MY_ARM_NAME);
    expect(j.rules[0].condition).toEqual({ property: 'drift_score', operator: 'greaterThan', value: 0.2 });
    expect(j.rules[0].action.kind).toBe('email');
  });

  it('a failed heal-write still returns the rules, and says so honestly', async () => {
    state.replaceThrows = new Error('Cosmos 503');

    const j = await (await GET(req(), PARAMS)).json();

    expect(j.rules).toHaveLength(1);
    expect(j.healed).toBe(false);
  });

  it('state.rules already populated → plain read, no ARM call', async () => {
    const { listScheduledQueryRules, listScheduledQueryRulesPaged } = await import('@/lib/azure/monitor-client');
    state.itemDoc = makeItem({ state: { rules: [{ id: 'r1', name: 'existing', azureRuleName: 'a' }] } });

    const j = await (await GET(req(), PARAMS)).json();

    expect(j.rules).toHaveLength(1);
    expect(j.rules[0].name).toBe('existing');
    expect(j.source).toBeUndefined();
    expect(listScheduledQueryRulesPaged).not.toHaveBeenCalled();
    expect(listScheduledQueryRules).not.toHaveBeenCalled();
  });

  it('Azure Monitor unreachable → falls through to the bundle projection, never 500s', async () => {
    state.listThrows = new Error('Azure Monitor not configured');
    state.itemDoc = makeItem({
      state: {
        content: {
          kind: 'activator',
          rule: { name: BUNDLE_RULE_NAME, condition: { metric: 'd', op: 'gt', threshold: 1 }, action: { kind: 'email' } },
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
    // Nothing was claimed, so nothing was recorded as a rule.
    expect(replaced.some((d) => (d.state?.rules || []).length > 0)).toBe(false);
  });
});

/**
 * The join key. The reconcile does not merely DISPLAY what it claims — the
 * records it writes into state.rules are what DELETE (deleteMonitorActivatorRule)
 * and PATCH (enable/disable) then act on. So a claim that is only PLAUSIBLE is a
 * cross-item write: `LOOM_ALERT_RG` is deployment-wide and the display name is
 * user-controlled, so a bare name-prefix test lets one activator delete or pause
 * a DIFFERENT activator's live Azure alert rule.
 */
describe('#3551 reconcile join key — a rule is claimed only on authoritative evidence', () => {
  it('does NOT claim a sibling activator\'s rule whose ARM name starts with this one\'s prefix', async () => {
    // Two REAL activators. 'Model Drift Alert' + rule 'churn' would be named
    // Model-Drift-Alert-churn; 'Model Drift Alert Prod' + rule 'churn' is named
    // Model-Drift-Alert-Prod-churn. The names DIFFER at write time — so there is
    // no write-time collision to "inherit" — yet the second startsWith the
    // first's prefix, and the prefix test claimed it.
    const siblingName = safeRuleName('Model Drift Alert Prod', 'churn');
    expect(siblingName).toBe('Model-Drift-Alert-Prod-churn');
    expect(siblingName.startsWith(safeRuleName('Model Drift Alert', ''))).toBe(true);
    expect(expectedAzureRuleName('Model Drift Alert', 'churn')).toBe('Model-Drift-Alert-churn');

    state.liveRules = [makeLiveRule({
      id: `/subscriptions/s/resourceGroups/rg/providers/Microsoft.Insights/scheduledQueryRules/${siblingName}`,
      name: siblingName,
      description: "Loom Activator rule 'churn'",
    })];

    const j = await (await GET(req(), PARAMS)).json();

    expect(j.source).not.toBe('azure-monitor-reconciled');
    expect(j.rules).toHaveLength(0);
    // Nothing foreign reached state.rules, so DELETE/PATCH cannot reach it either.
    expect(replaced.some((d) => (d.state?.rules || []).length > 0)).toBe(false);
  });

  it('does NOT claim a rule that carries no Loom description marker, even at the exact name', async () => {
    // An operator-authored (or third-party) rule that happens to be named like
    // ours. Nothing establishes it is Loom's, so it is not claimed.
    state.liveRules = [makeLiveRule({ description: 'Nightly SLO breach check (authored by the platform team)' })];

    const j = await (await GET(req(), PARAMS)).json();

    expect(j.source).not.toBe('azure-monitor-reconciled');
    expect(j.rules).toHaveLength(0);
  });

  it('does NOT claim a rule TAGGED with a different Loom item id, even at the exact name', async () => {
    state.liveRules = [makeLiveRule({ tags: { 'loom-item-id': 'act-OTHER', 'loom-item-type': 'activator' } })];

    const j = await (await GET(req(), PARAMS)).json();

    expect(j.source).not.toBe('azure-monitor-reconciled');
    expect(j.rules).toHaveLength(0);
    expect(replaced.some((d) => (d.state?.rules || []).length > 0)).toBe(false);
  });

  it('DOES claim a rule tagged with THIS item id even after the activator was renamed', async () => {
    // The tag is authoritative: a display-name change breaks the derived name but
    // not the identity, so the binding self-heals instead of going dead (#3551).
    state.itemDoc = makeItem({ displayName: 'Model Drift Alert (renamed)' });
    state.liveRules = [makeLiveRule({ tags: { 'loom-item-id': 'act-1', 'loom-item-type': 'activator' } })];

    const j = await (await GET(req(), PARAMS)).json();

    expect(j.source).toBe('azure-monitor-reconciled');
    expect(j.rules).toHaveLength(1);
    expect(j.rules[0].azureRuleName).toBe(MY_ARM_NAME);
  });
});

/**
 * The write-back. It replaces a document that was read BEFORE a multi-hundred-ms
 * ARM call, so an unconditional full overwrite re-creates the very symptom #3551
 * exists to fix — a rule the user added during the window is dropped from
 * state.rules while its real Azure rule keeps firing. And because a non-empty
 * state.rules never re-reconciles, anything wrong that lands here is permanent.
 */
describe('#3551 reconcile write-back — conditional, merged, and never persists a partial list', () => {
  it('a rule POSTed while ARM was being listed is NOT dropped by the heal write', async () => {
    const userRule = { id: 'user-1', name: 'added during the ARM call', azureRuleName: 'Model-Drift-Alert-user', backend: 'azure-monitor' };
    // The GET started from a document with no rules; by write time the document
    // has the user's rule.
    state.itemDocLatest = makeItem({ _etag: 'etag-2', state: { ...makeItem().state, rules: [userRule] } });

    const j = await (await GET(req(), PARAMS)).json();

    const written = replaced.find((d) => (d.state?.rules || []).length > 0);
    expect(written).toBeDefined();
    const ids = written.state.rules.map((r: any) => r.id).sort();
    expect(ids).toContain('user-1');
    expect(ids).toContain(MY_ARM_NAME);
    // …and the response reports what was actually persisted.
    expect(j.rules.map((r: any) => r.id).sort()).toEqual(ids);
  });

  it('the heal write is conditional on the etag of the document it merged against', async () => {
    state.itemDocLatest = makeItem({ _etag: 'etag-live' });

    await GET(req(), PARAMS);

    const idx = replaced.findIndex((d) => (d.state?.rules || []).length > 0);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(replaceOptions[idx]?.accessCondition).toEqual({ type: 'IfMatch', condition: 'etag-live' });
  });

  it('an etag conflict re-reads and retries instead of clobbering', async () => {
    const conflict: any = new Error('PreconditionFailed'); conflict.code = 412;
    state.replaceThrowsOnce = [conflict];
    const userRule = { id: 'user-2', name: 'raced in', azureRuleName: 'Model-Drift-Alert-user2', backend: 'azure-monitor' };
    state.itemDocLatest = makeItem({ _etag: 'etag-2', state: { ...makeItem().state, rules: [userRule] } });

    const j = await (await GET(req(), PARAMS)).json();

    expect(j.healed).toBe(true);
    const written = replaced.find((d) => (d.state?.rules || []).length > 0);
    expect(written.state.rules.map((r: any) => r.id).sort()).toEqual(['user-2', MY_ARM_NAME].sort());
  });

  it('a TRUNCATED ARM listing is never written back — a partial reconcile would stick forever', async () => {
    state.truncatedBy = 'pages';

    const j = await (await GET(req(), PARAMS)).json();

    // The rules it DID find are real and still shown…
    expect(j.rules).toHaveLength(1);
    expect(j.source).toBe('azure-monitor-reconciled');
    // …but nothing is persisted, so the next open reconciles again instead of
    // freezing a partial list into state.rules.
    expect(j.healed).toBe(false);
    expect(j.partial).toBe(true);
    expect(replaced.some((d) => (d.state?.rules || []).length > 0)).toBe(false);
  });

  it('a rule DELETED through this route is not resurrected by a lagging ARM list', async () => {
    // Give the item the record, delete it, then reopen while ARM still lists it.
    state.itemDoc = makeItem({ state: { ...makeItem().state, rules: [{ id: MY_ARM_NAME, name: BUNDLE_RULE_NAME, azureRuleName: MY_ARM_NAME, backend: 'azure-monitor' }] } });

    const del = await DELETE(delReq(MY_ARM_NAME), PARAMS);
    expect(del.status).toBe(200);
    expect((await del.json()).ok).toBe(true);

    // ARM's list is eventually consistent and still returns the deleted rule.
    const j = await (await GET(req(), PARAMS)).json();

    expect(j.rules).toEqual([]);
    expect(j.source).not.toBe('azure-monitor-reconciled');
  });

  it('re-creating the same rule lifts its tombstone, so it is claimable again', async () => {
    state.itemDoc = makeItem({ state: { ...makeItem().state, rules: [{ id: MY_ARM_NAME, name: BUNDLE_RULE_NAME, azureRuleName: MY_ARM_NAME, backend: 'azure-monitor' }] } });

    await DELETE(delReq(MY_ARM_NAME), PARAMS);
    expect(state.itemDoc.state.rulesDeleted).toContain(MY_ARM_NAME);

    const post = await POST(postReq({ name: BUNDLE_RULE_NAME }), PARAMS);
    expect(post.status).toBe(200);
    const created = await post.json();
    expect(created.ok).toBe(true);
    expect(created.rule.azureRuleName).toBe(MY_ARM_NAME);
    // The deletion no longer shadows the re-created rule.
    expect(state.itemDoc.state.rulesDeleted || []).not.toContain(MY_ARM_NAME);
  });
});

/**
 * The ARM list is a DEPLOYMENT-WIDE listing of LOOM_ALERT_RG. Spending one on
 * every GET of every zero-rule activator — including the first open of a
 * freshly created one, which cannot possibly have install-authored rules — is a
 * cost with no chance of a payoff, and it never stops because a no-match writes
 * nothing that would clear the gate.
 */
describe('#3551 reconcile is gated — no deployment-wide ARM list without a reason to run one', () => {
  it('a freshly created activator (no bundle content, no install record) never lists ARM', async () => {
    const { listScheduledQueryRules, listScheduledQueryRulesPaged } = await import('@/lib/azure/monitor-client');
    state.itemDoc = makeItem({ state: {} });

    const r = await GET(req(), PARAMS);
    const j = await r.json();

    expect(r.status).toBe(200);
    expect(j.rules).toEqual([]);
    expect(listScheduledQueryRulesPaged).not.toHaveBeenCalled();
    expect(listScheduledQueryRules).not.toHaveBeenCalled();
    expect(replaced).toHaveLength(0);
  });

  it('an install that authored ZERO rules never lists ARM', async () => {
    const { listScheduledQueryRules, listScheduledQueryRulesPaged } = await import('@/lib/azure/monitor-client');
    state.itemDoc = makeItem({
      state: { provisioning: { status: 'created', secondaryIds: { backend: 'azure-monitor', rulesCreated: '0' } } },
    });

    await GET(req(), PARAMS);

    expect(listScheduledQueryRulesPaged).not.toHaveBeenCalled();
    expect(listScheduledQueryRules).not.toHaveBeenCalled();
  });

  it('a no-match reconcile is remembered, so the next open does not re-list ARM', async () => {
    const { listScheduledQueryRules, listScheduledQueryRulesPaged } = await import('@/lib/azure/monitor-client');
    state.liveRules = [];

    await GET(req(), PARAMS);
    const listedOnce =
      (listScheduledQueryRulesPaged as any).mock.calls.length + (listScheduledQueryRules as any).mock.calls.length;
    expect(listedOnce).toBe(1);

    // The no-match is recorded on the item (no rules written), so the second GET
    // is a plain read.
    await GET(req(), PARAMS);
    const listedTwice =
      (listScheduledQueryRulesPaged as any).mock.calls.length + (listScheduledQueryRules as any).mock.calls.length;
    expect(listedTwice).toBe(1);
  });
});
