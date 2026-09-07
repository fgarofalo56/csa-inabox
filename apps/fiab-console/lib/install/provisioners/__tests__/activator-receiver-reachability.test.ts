/**
 * #4097 — an installed activator must be able to REACH A HUMAN.
 *
 * The live Commercial estate (verified in ARM 2026-08-26) carried:
 *   - scheduled query rule `High-Roller-Alert-High-Roller-Net-` — enabled
 *   - action group `High-Roller-Alert-ag` — enabled
 *   - receivers on that action group — ZERO, of all ten kinds
 * while the install reported `rulesCreated: 1, rulesPersisted: true`. Both
 * numbers were true. The rule evaluated, fired, routed, and notified nobody.
 *
 * WHAT THIS FILE DOES DIFFERENTLY FROM activator-provisioner.test.ts:
 * that file mocks `createMonitorActivatorRule`, so it can never see which
 * receivers the Azure Monitor derivation actually produces. Here the ONLY thing
 * mocked is the ARM boundary (`monitor-client`). The REAL
 * `lib/azure/activator-monitor.ts` derivation runs, so these assertions are
 * against the receivers that would really be PUT to
 * `Microsoft.Insights/actionGroups`. If that module's private field lists ever
 * drift from the mirror in `_activator-receivers.ts`, these tests go red
 * instead of an alert silently going quiet.
 *
 * The population is not a hand-picked sample: it is EVERY activator item in
 * EVERY registered content bundle, enumerated from the registry. A new bundle
 * that ships an unbindable destination fails here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── the ARM boundary — the ONLY thing mocked ────────────────────────────────
const ACTION_GROUP_RECEIVER_KINDS = [
  'emailReceivers', 'smsReceivers', 'webhookReceivers', 'logicAppReceivers',
  'armRoleReceivers', 'azureFunctionReceivers', 'automationRunbookReceivers',
  'voiceReceivers', 'azureAppPushReceivers', 'eventHubReceivers', 'itsmReceivers',
] as const;
const LOOM_MANAGED_RECEIVER_KINDS = ['emailReceivers', 'smsReceivers', 'webhookReceivers', 'logicAppReceivers'] as const;
/** An empty ARM read — the group does not exist yet. */
function emptyRead(exists = false) {
  const byKind: any = {};
  for (const k of ACTION_GROUP_RECEIVER_KINDS) byKind[k] = [];
  return { exists, byKind, total: 0 };
}
const upsertActionGroup = vi.fn(async (_i: any) => '/subscriptions/s/resourceGroups/rg/providers/microsoft.insights/actionGroups/ag');
const readActionGroupReceivers = vi.fn(async (_n: string) => emptyRead());
const upsertScheduledQueryRule = vi.fn(async (_i: any) => ({}));
const patchScheduledQueryRule = vi.fn(async (_n: string, _e: boolean) => undefined);
vi.mock('@/lib/azure/monitor-client', () => ({
  MonitorNotConfiguredError: class extends Error { missing: string[]; constructor(m: string[]) { super('not configured'); this.missing = m; } },
  MonitorError: class extends Error { status: number; constructor(m: string, s = 500) { super(m); this.status = s; } },
  ACTION_GROUP_RECEIVER_KINDS: [
    'emailReceivers', 'smsReceivers', 'webhookReceivers', 'logicAppReceivers',
    'armRoleReceivers', 'azureFunctionReceivers', 'automationRunbookReceivers',
    'voiceReceivers', 'azureAppPushReceivers', 'eventHubReceivers', 'itsmReceivers',
  ],
  LOOM_MANAGED_RECEIVER_KINDS: ['emailReceivers', 'smsReceivers', 'webhookReceivers', 'logicAppReceivers'],
  upsertActionGroup: (i: any) => upsertActionGroup(i),
  readActionGroupReceivers: (n: string) => readActionGroupReceivers(n),
  upsertScheduledQueryRule: (i: any) => upsertScheduledQueryRule(i),
  patchScheduledQueryRule: (n: string, e: boolean) => patchScheduledQueryRule(n, e),
  deleteScheduledQueryRule: vi.fn(async () => undefined),
  queryLogs: vi.fn(async () => ({ columns: [], rows: [], rowCount: 0 })),
  listAlertHistory: vi.fn(async () => []),
}));
// activator-monitor imports kusto-client (ADX query plane) at module load.
vi.mock('@/lib/azure/kusto-client', () => ({
  executeQuery: vi.fn(async () => ({ columns: [], rows: [], rowCount: 0 })),
  normalizeClusterUri: (v?: string) => v,
  defaultDatabase: () => 'db',
}));
vi.mock('@/lib/azure/activator-client', () => ({
  ActivatorError: class extends Error { status: number; constructor(m: string, s = 500) { super(m); this.status = s; } },
  listActivators: vi.fn(), createActivator: vi.fn(), addRule: vi.fn(), listRules: vi.fn(),
}));

const replace = vi.fn(async (_doc?: any) => ({}));
const read = vi.fn(async () => ({ resource: { id: 'act-1', workspaceId: 'w', state: {} } }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(async () => ({ item: vi.fn(() => ({ read, replace })) })),
}));

import { activatorProvisioner } from '../activator';
import { isUnreachable, receiverTotal, resolveFallbackAlertEmails, unreachableReason } from '../_activator-receivers';
import { listBundleIds, getBundle } from '@/lib/apps/content-bundles';

const LA = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.OperationalInsights/workspaces/law';
const ENV_KEYS = ['LOOM_LOG_ANALYTICS_RESOURCE_ID', 'LOOM_ADX_ALERT_SCOPE', 'LOOM_SUBSCRIPTION_ID'];
let saved: Record<string, string | undefined>;

/** An ordinary interactive install: the signed-in operator. */
function session(claims: Record<string, unknown> = { oid: 'o', upn: 'operator@contoso.com' }) {
  return { claims } as any;
}

function input(content: unknown, displayName = 'High-Roller Alert', sess = session()) {
  return {
    session: sess,
    target: { mode: 'shared', activatorBackend: 'azure-monitor' } as any,
    cosmosItemId: 'act-1',
    workspaceId: 'w',
    displayName,
    content,
    appId: 'app-under-test',
  } as any;
}

/** Every receiver the LAST action-group PUT carried, flattened. */
function lastActionGroupReceivers() {
  const call = upsertActionGroup.mock.calls.at(-1)?.[0] as any;
  if (!call) return null;
  return {
    emails: call.emails || [],
    sms: call.smsReceivers || [],
    webhooks: call.webhookReceivers || [],
    logicApps: call.logicAppReceivers || [],
    total: (call.emails || []).length + (call.smsReceivers || []).length + (call.webhookReceivers || []).length + (call.logicAppReceivers || []).length,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  read.mockResolvedValue({ resource: { id: 'act-1', workspaceId: 'w', state: {} } } as any);
  replace.mockResolvedValue({} as any);
  upsertActionGroup.mockResolvedValue('/subscriptions/s/resourceGroups/rg/providers/microsoft.insights/actionGroups/ag');
  readActionGroupReceivers.mockResolvedValue(emptyRead());
  upsertScheduledQueryRule.mockResolvedValue({} as any);
  patchScheduledQueryRule.mockResolvedValue(undefined as any);
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID = LA;
});
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

/** The verbatim High-Roller Alert content from app-casino-analytics. */
async function casinoHighRollerContent() {
  const bundle = await getBundle('app-casino-analytics');
  const item = bundle?.items.find((i) => i.itemType === 'activator' && i.displayName === 'High-Roller Alert');
  expect(item, 'the High-Roller Alert activator must still exist in app-casino-analytics').toBeTruthy();
  return item!.content;
}

describe('#4097 the High-Roller activator must notify somebody', () => {
  it('the Teams action names a channel and a KV secret NAME — neither is a receiver Azure can use', async () => {
    // Grounding the premise, so this file documents WHY the bind is needed.
    const content: any = await casinoHighRollerContent();
    const cfg = content.rule.action.config;
    expect(content.rule.action.kind).toBe('teams');
    expect(cfg.webhookSecretName).toBeTruthy();
    // No field the Azure Monitor derivation reads carries a destination.
    expect(cfg.webhookUrl ?? cfg.url ?? cfg.triggerUrl ?? cfg.serviceUri).toBeUndefined();
    expect(content.rule.action.recipients ?? content.rule.action.to ?? content.rule.action.email).toBeUndefined();
  });

  it('installing it PUTs an action group with at least one live receiver', async () => {
    const res = await activatorProvisioner(input(await casinoHighRollerContent()));

    expect(res.status).toBe('created');
    // The core regression guard. Against the pre-#4097 provisioner this is 0
    // (or upsertActionGroup is never called at all) and the assertion fails.
    const recv = lastActionGroupReceivers();
    expect(recv, 'an action group must be created for the rule').not.toBeNull();
    expect(recv!.total).toBeGreaterThanOrEqual(1);
    expect(recv!.emails).toContain('operator@contoso.com');

    // …and the scheduled rule is actually WIRED to it — an action group nobody
    // routes to is the same defect one step removed.
    const rulePut = upsertScheduledQueryRule.mock.calls.at(-1)?.[0] as any;
    expect(rulePut.actionGroupIds).toBeTruthy();
    expect(rulePut.actionGroupIds.length).toBeGreaterThanOrEqual(1);
  });

  it('the persisted record carries the receiver counts, so the editor shows the truth', async () => {
    await activatorProvisioner(input(await casinoHighRollerContent()));
    const written = replace.mock.calls[0][0] as any;
    const rule = written.state.rules[0];
    expect(rule.actionGroupId).toBeTruthy();
    const r = rule.actionGroupReceivers;
    expect((r.emails || 0) + (r.sms || 0) + (r.webhooks || 0) + (r.logicApps || 0)).toBeGreaterThanOrEqual(1);
    expect(rule.state).toBe('Active');
  });

  it('binds the SIGNED-IN operator, not a hard-coded or configured address', async () => {
    await activatorProvisioner(input(await casinoHighRollerContent(), 'High-Roller Alert', session({ oid: 'o', email: 'floor-ops@contoso.com', upn: 'other@contoso.com' })));
    const recv = lastActionGroupReceivers()!;
    expect(recv.emails).toEqual(['floor-ops@contoso.com']);
    expect(recv.emails).not.toContain('other@contoso.com');
  });
});

describe('#4097 a destination that can never deliver is not a receiver', () => {
  it('an unsubstituted ${…} webhook URL is REFUSED, not wired as a receiver', async () => {
    // app-federal-data-mesh / app-hybrid-topology ship exactly this: a Sentinel
    // ingestion URL with the workspace name still a build-time placeholder.
    // `/^https?:\/\//` matches it, so it used to become a real ARM webhook
    // receiver pointed at a literal `${sentinelWorkspace}` host — a receiver
    // that COUNTS as one and can never deliver.
    const content = {
      kind: 'activator',
      rule: {
        name: 'Label violation',
        condition: { metric: 'violations', op: '>', threshold: 0 },
        action: { kind: 'webhook', config: { url: 'https://${sentinelWorkspace}.ods.opinsights.azure.us/api/logs' } },
      },
    };
    const res = await activatorProvisioner(input(content, 'Label Violation Alert'));

    expect(res.status).toBe('created');
    const recv = lastActionGroupReceivers()!;
    expect(recv.webhooks.map((w: any) => w.serviceUri).join(' ')).not.toContain('${');
    expect(recv.webhooks).toHaveLength(0);
    // …and it did not silently end up with nobody either: the fallback bound.
    expect(recv.emails).toContain('operator@contoso.com');
    expect(res.steps?.join(' ')).toMatch(/is not a URL Azure Monitor can POST to/);
  });

  it('a reserved documentation domain (RFC 2606) is REFUSED, not wired', async () => {
    // app-data-governance ships `config.recipients: ['data-governance@csa.example.com']`
    // — nested one level deeper than the derivation reads AND at a domain that
    // can never receive mail.
    const content = {
      kind: 'activator',
      rule: {
        name: 'Quality SLA',
        condition: { metric: 'score', op: '<', threshold: 90 },
        action: { kind: 'teams', config: { channel: 'Data Governance', recipients: ['data-governance@csa.example.com'] } },
      },
    };
    const res = await activatorProvisioner(input(content, 'Quality Alert'));

    expect(res.status).toBe('created');
    const recv = lastActionGroupReceivers()!;
    expect(recv.emails).not.toContain('data-governance@csa.example.com');
    expect(recv.emails).toContain('operator@contoso.com');
    expect(res.steps?.join(' ')).toMatch(/not a deliverable address/);
  });

  it('a REAL recipients list nested in config IS lifted and wired (not discarded)', async () => {
    const content = {
      kind: 'activator',
      rule: {
        name: 'Quality SLA',
        condition: { metric: 'score', op: '<', threshold: 90 },
        action: { kind: 'teams', config: { channel: 'Data Governance', recipients: ['stewards@contoso.com'] } },
      },
    };
    await activatorProvisioner(input(content, 'Quality Alert'));
    const recv = lastActionGroupReceivers()!;
    expect(recv.emails).toContain('stewards@contoso.com');
    // The bundle named a real destination, so the fallback must NOT be added.
    expect(recv.emails).not.toContain('operator@contoso.com');
  });

  it('a real webhook URL is wired and the fallback is NOT added on top', async () => {
    const content = {
      kind: 'activator',
      rule: {
        name: 'Ops hook',
        condition: { metric: 'x', op: '>', threshold: 1 },
        action: { kind: 'webhook', config: { url: 'https://contoso.webhook.office.com/webhookb2/abc' } },
      },
    };
    await activatorProvisioner(input(content, 'Ops Hook Alert'));
    const recv = lastActionGroupReceivers()!;
    expect(recv.webhooks.map((w: any) => w.serviceUri)).toEqual(['https://contoso.webhook.office.com/webhookb2/abc']);
    expect(recv.emails).toHaveLength(0);
  });
});

describe('#4097 a rule that can reach nobody is never reported as created', () => {
  /** No env override AND no address on the session — nothing to bind to. */
  const noAddress = () => session({ oid: 'o', name: 'svc' });

  it('refuses `created`, DISABLES the rule, and names the fix', async () => {
    const res = await activatorProvisioner(input(await casinoHighRollerContent(), 'High-Roller Alert', noAddress()));

    expect(res.status).toBe('remediation');
    expect(res.status).not.toBe('created');
    expect(res.secondaryIds?.rulesUnreachable).toBe('1');
    // Quiesced: an enabled alert that notifies nobody is the defect.
    expect(patchScheduledQueryRule).toHaveBeenCalledTimes(1);
    expect(patchScheduledQueryRule.mock.calls[0][1]).toBe(false);
    expect(res.gate?.reason).toMatch(/notify nobody/i);
    expect(res.gate?.remediation).toMatch(/Teams incoming-webhook URL|email address/i);
  });

  it('still persists the rule so the editor can show it and fix it', async () => {
    await activatorProvisioner(input(await casinoHighRollerContent(), 'High-Roller Alert', noAddress()));
    const written = replace.mock.calls[0][0] as any;
    expect(written.state.rules).toHaveLength(1);
    expect(written.state.rules[0].state).toBe('Disabled');
    expect(written.state.rules[0].note).toMatch(/no notification destination is bound/i);
  });

  it('when the disable itself fails it does NOT claim the rule was disabled (R7)', async () => {
    patchScheduledQueryRule.mockRejectedValue(new Error('boom'));
    const res = await activatorProvisioner(input(await casinoHighRollerContent(), 'High-Roller Alert', noAddress()));

    expect(res.status).toBe('remediation');
    const log = res.steps?.join(' ') || '';
    expect(log).toMatch(/disabling it did not complete/i);
    expect(log).toMatch(/may still be enabled/i);
    const written = replace.mock.calls[0][0] as any;
    expect(written.state.rules[0].state).not.toBe('Disabled');
  });
});

/**
 * POPULATION ACCOUNTING — every activator in every registered bundle, not a
 * sample. Before #4097, 9 of these 11 derived ZERO receivers and the other 2
 * derived a receiver pointed at an unexpanded `${…}` host.
 */
describe('#4097 EVERY shipped bundle activator installs with a live receiver', () => {
  it('enumerates at least one activator to test (a zero population proves nothing)', async () => {
    const items = await allBundleActivators();
    expect(items.length).toBeGreaterThanOrEqual(8);
  });

  it('each one PUTs an action group carrying a deliverable receiver', async () => {
    const items = await allBundleActivators();
    const failures: string[] = [];
    for (const { appId, displayName, content } of items) {
      vi.clearAllMocks();
      upsertActionGroup.mockResolvedValue('/subscriptions/s/resourceGroups/rg/providers/microsoft.insights/actionGroups/ag');
      read.mockResolvedValue({ resource: { id: 'act-1', workspaceId: 'w', state: {} } } as any);
      replace.mockResolvedValue({} as any);

      const res = await activatorProvisioner(input(content, displayName));
      const recv = lastActionGroupReceivers();
      const total = recv?.total ?? 0;
      const bogus = (recv?.webhooks || []).filter((w: any) => /\$\{|\{\{/.test(String(w.serviceUri)));
      if (res.status !== 'created' || total < 1 || bogus.length) {
        failures.push(`${appId} / ${displayName}: status=${res.status} receivers=${total} undeliverable=${bogus.length}`);
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });
});

/** Every `activator` item across every registered content bundle. */
async function allBundleActivators(): Promise<Array<{ appId: string; displayName: string; content: unknown }>> {
  const out: Array<{ appId: string; displayName: string; content: unknown }> = [];
  for (const appId of listBundleIds()) {
    const bundle = await getBundle(appId);
    for (const item of bundle?.items || []) {
      if (item.itemType === 'activator') out.push({ appId, displayName: item.displayName, content: item.content });
    }
  }
  return out;
}

/**
 * The reachability primitive itself. The trap it exists to avoid is treating an
 * UNKNOWN as a pass — the same class of error as `2>/dev/null` turning "I could
 * not reach it" into "there is nothing there" (deploy-integrity.md R7).
 */
describe('#4097 receiverTotal separates ZERO from UNKNOWN', () => {
  it('counts every receiver kind the record reports', () => {
    expect(receiverTotal({ actionGroupId: 'ag', actionGroupReceivers: { emails: 1, sms: 2, webhooks: 3, logicApps: 4 } })).toBe(10);
  });

  it('no action group at all is a DEMONSTRATED zero', () => {
    expect(receiverTotal({})).toBe(0);
    expect(isUnreachable({})).toBe(true);
    expect(unreachableReason({})).toMatch(/no receivers of any kind/i);
  });

  it('an attached action group with no reported receivers is UNKNOWN, not zero and not a pass', () => {
    const rec = { actionGroupId: '/subscriptions/s/…/actionGroups/ag' };
    expect(receiverTotal(rec)).toBeNull();
    expect(receiverTotal(rec)).not.toBe(0);
    // Unknown must NOT be reported as reachable.
    expect(isUnreachable(rec)).toBe(true);
    expect(unreachableReason(rec)).toMatch(/could not be confirmed/i);
  });

  it('a reported zero is unreachable even with an action group attached', () => {
    const rec = { actionGroupId: 'ag', actionGroupReceivers: { emails: 0, sms: 0, webhooks: 0, logicApps: 0 } };
    expect(receiverTotal(rec)).toBe(0);
    expect(isUnreachable(rec)).toBe(true);
  });
});

describe('#4097 the fallback address resolves without any configuration', () => {
  it('prefers the `email` claim over `upn` and ignores a non-address upn', () => {
    expect(resolveFallbackAlertEmails(session({ oid: 'o', email: 'me@contoso.com', upn: 'other@contoso.com' }))).toEqual(['me@contoso.com']);
    expect(resolveFallbackAlertEmails(session({ oid: 'o', upn: 'S-1-5-21-not-an-address' }))).toEqual([]);
  });

  it('falls back to `upn` when there is no `email` claim', () => {
    expect(resolveFallbackAlertEmails(session({ oid: 'o', upn: 'operator@contoso.com' }))).toEqual(['operator@contoso.com']);
  });

  it('refuses an undeliverable claim rather than binding a black hole', () => {
    // A tenant whose upn sits on a reserved documentation domain would otherwise
    // produce an email receiver that silently discards every alert.
    expect(resolveFallbackAlertEmails(session({ oid: 'o', upn: 'admin@example.com' }))).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// #4113 — the receivers that were being DELETED, and the ones nobody counted
// ═══════════════════════════════════════════════════════════════════════════

describe('#4113 receiverTotal counts EVERY receiver kind, not the four Loom composes', () => {
  it('a group reachable only by ARM role is NOT reported as reaching nobody', () => {
    // The live `loom-default-alerts` shape: one armRoleReceiver, nothing else.
    // Summing four arrays made it read as zero, which would have licensed
    // "repairing" a group that was already fine — and called it broken.
    const rec = { actionGroupId: 'ag', actionGroupReceivers: { emails: 0, sms: 0, webhooks: 0, logicApps: 0, other: 1 } };
    expect(receiverTotal(rec)).toBe(1);
    expect(isUnreachable(rec)).toBe(false);
  });

  it('still reports a genuinely empty group as unreachable', () => {
    const rec = { actionGroupId: 'ag', actionGroupReceivers: { emails: 0, sms: 0, webhooks: 0, logicApps: 0, other: 0 } };
    expect(receiverTotal(rec)).toBe(0);
    expect(isUnreachable(rec)).toBe(true);
    expect(unreachableReason(rec)).toContain('no receivers of any kind');
  });
});

describe('#4113 bindActionGroup — no rule is left wired to nobody in silence', () => {
  it('SKIP A is gone: an attached existing group is READ, and its receivers recorded', async () => {
    // At head `existingActionGroupId` was attached as-is with no read at all, so
    // `actionGroupReceivers` was undefined and receiverTotal answered UNKNOWN.
    const byKind: any = {};
    for (const k of ACTION_GROUP_RECEIVER_KINDS) byKind[k] = [];
    byKind.armRoleReceivers = [{ name: 'oncall', roleId: 'r' }];
    readActionGroupReceivers.mockResolvedValue({ exists: true, id: 'AG-ID', byKind, total: 1 } as any);
    const { bindActionGroup } = await import('@/lib/azure/activator-monitor');
    const res = await bindActionGroup({
      activatorDisplayName: 'High-Roller Alert', existingActionGroupId: 'AG-ID',
      emails: [], smsReceivers: [], webhookReceivers: [], logicAppReceivers: [], fallbackEmails: [],
    });
    expect(readActionGroupReceivers).toHaveBeenCalledWith('AG-ID');
    expect(res.outcome).toBe('attached');
    expect(receiverTotal({ actionGroupId: 'AG-ID', actionGroupReceivers: res.receivers })).toBe(1);
    // Already reachable => nothing is written. A repair over a healthy group is
    // a mutation nobody asked for.
    expect(upsertActionGroup).not.toHaveBeenCalled();
  });

  it('REPAIRS an attached group that carries ZERO receivers of any kind', async () => {
    readActionGroupReceivers.mockResolvedValue({ ...emptyRead(true), id: 'AG-ID' } as any);
    const { bindActionGroup } = await import('@/lib/azure/activator-monitor');
    const res = await bindActionGroup({
      activatorDisplayName: 'High-Roller Alert', existingActionGroupId: 'AG-ID',
      emails: [], smsReceivers: [], webhookReceivers: [], logicAppReceivers: [],
      fallbackEmails: ['operator@contoso.com'],
    });
    expect(res.outcome).toBe('repaired');
    // Written back to the group's OWN id, so the repair cannot mint a duplicate
    // in the Loom alert RG.
    expect(upsertActionGroup.mock.calls.at(-1)?.[0]).toMatchObject({ name: 'AG-ID', emails: ['operator@contoso.com'] });
    expect(receiverTotal({ actionGroupId: 'AG-ID', actionGroupReceivers: res.receivers })).toBe(1);
  });

  it('SKIP B is gone: no derived destination still binds the platform fallback', async () => {
    const { bindActionGroup } = await import('@/lib/azure/activator-monitor');
    const res = await bindActionGroup({
      activatorDisplayName: 'High-Roller Alert',
      emails: [], smsReceivers: [], webhookReceivers: [], logicAppReceivers: [],
      fallbackEmails: ['operator@contoso.com'],
    });
    expect(res.outcome).toBe('created');
    expect(upsertActionGroup).toHaveBeenCalledTimes(1);
    expect(res.actionGroupId).toBeTruthy();
  });

  it('an UNREADABLE group is reported as unknown — never as attached, never as empty', async () => {
    readActionGroupReceivers.mockRejectedValue(Object.assign(new Error('AuthorizationFailed'), { status: 403 }));
    const { bindActionGroup } = await import('@/lib/azure/activator-monitor');
    const res = await bindActionGroup({
      activatorDisplayName: 'High-Roller Alert', existingActionGroupId: 'AG-ID',
      emails: [], smsReceivers: [], webhookReceivers: [], logicAppReceivers: [], fallbackEmails: ['op@contoso.com'],
    });
    expect(res.outcome).toBe('unreadable');
    expect(res.receivers).toBeUndefined();
    // R7 — an unread group must NOT be written back from a state never observed.
    expect(upsertActionGroup).not.toHaveBeenCalled();
    expect(receiverTotal({ actionGroupId: 'AG-ID', actionGroupReceivers: res.receivers })).toBeNull();
  });

  it('invents nothing when there is neither a destination nor a fallback', async () => {
    const { bindActionGroup } = await import('@/lib/azure/activator-monitor');
    const res = await bindActionGroup({
      activatorDisplayName: 'High-Roller Alert',
      emails: [], smsReceivers: [], webhookReceivers: [], logicAppReceivers: [], fallbackEmails: [],
    });
    expect(res.outcome).toBe('none');
    expect(upsertActionGroup).not.toHaveBeenCalled();
    expect(res.note).toContain('notify nobody');
  });
});

/**
 * #4354 review, finding 5. The CREATE path — no `existingActionGroupId`, so
 * `target` is the name of the group Loom WOULD create. #4113 introduced a read
 * there and let a non-404 failure `throw`, which turned a 403 on the
 * action-group read into a failure of the whole rule creation. Before #4113
 * there was no read at all and the rule was created wired to nobody, silently.
 * Neither extreme is right: refusing to WRITE from a state never observed
 * stays, but the rule is still created and the record says why nothing was
 * bound.
 */
describe('#4354 finding 5 — an unreadable group on the CREATE path is reported, not thrown', () => {
  const unreadable = () => readActionGroupReceivers.mockRejectedValue(
    Object.assign(new Error('AuthorizationFailed'), { status: 403 }),
  );

  it('returns `unreadable` instead of throwing, and writes NOTHING', async () => {
    unreadable();
    const { bindActionGroup } = await import('@/lib/azure/activator-monitor');
    const res = await bindActionGroup({
      activatorDisplayName: 'High-Roller Alert',
      emails: [], smsReceivers: [], webhookReceivers: [], logicAppReceivers: [],
      fallbackEmails: ['operator@contoso.com'],
    });
    expect(res.outcome).toBe('unreadable');
    // The #4113 half that must survive: no PUT from an unobserved state.
    expect(upsertActionGroup).not.toHaveBeenCalled();
    // …and no id is claimed, because none was created or confirmed.
    expect(res.actionGroupId).toBeUndefined();
    expect(res.receivers).toBeUndefined();
  });

  it('the note states only what was established, and names the role (R7)', async () => {
    unreadable();
    const { bindActionGroup } = await import('@/lib/azure/activator-monitor');
    const res = await bindActionGroup({
      activatorDisplayName: 'High-Roller Alert',
      emails: [], smsReceivers: [], webhookReceivers: [], logicAppReceivers: [],
      fallbackEmails: ['operator@contoso.com'],
    });
    const note = res.note || '';
    expect(note).toMatch(/neither\s+created nor confirmed/i);
    expect(note).toContain('AuthorizationFailed');
    expect(note).toContain('Monitoring Contributor');
    // It must not claim the group is EMPTY — the read established no such thing.
    expect(note).not.toMatch(/has no receivers|carried ZERO/i);
  });

  it('a clean 404 is still a 404 — absence binds the fallback rather than reporting unknown', async () => {
    // The counterfactual for the branch above: `readActionGroupReceivers` turns
    // a real ARM 404 into `exists:false` rather than a throw, so absence never
    // reaches the catch and the fallback still binds.
    readActionGroupReceivers.mockResolvedValue(emptyRead(false));
    const { bindActionGroup } = await import('@/lib/azure/activator-monitor');
    const res = await bindActionGroup({
      activatorDisplayName: 'High-Roller Alert',
      emails: [], smsReceivers: [], webhookReceivers: [], logicAppReceivers: [],
      fallbackEmails: ['operator@contoso.com'],
    });
    expect(res.outcome).toBe('created');
    expect(upsertActionGroup).toHaveBeenCalledTimes(1);
  });

  it('the rule is still CREATED, and the reason reaches the record the user sees', async () => {
    // The behaviour regression #4354's reviewer caught: #4113 added this read
    // and let a non-404 `throw`, so a 403 on ONE action-group read failed the
    // whole rule creation. Before #4113 there was no read here and the rule was
    // created wired to nobody, silently. This pins the middle.
    //
    // Reached through `createMonitorActivatorRule` rather than the provisioner
    // on purpose: the provisioner substitutes the fallback address INTO the
    // rule's action first (`norm.usedFallback`), so `derived > 0` and it never
    // takes this branch. The editor/API rule path passes `fallbackEmails`
    // alongside an action that derives nothing, which does.
    unreadable();
    const { createMonitorActivatorRule } = await import('@/lib/azure/activator-monitor');
    const rec = await createMonitorActivatorRule('High-Roller Alert', {
      name: 'High roller net',
      sourceKind: 'log-analytics',
      query: 'AzureDiagnostics | count',
      condition: { metric: 'net', op: '>', threshold: 1 },
      // A Teams action naming a channel + a KV secret NAME — no destination the
      // Azure Monitor derivation can turn into a receiver.
      action: { kind: 'teams', config: { channel: 'Floor Ops', webhookSecretName: 'teams-hook' } },
      fallbackEmails: ['operator@contoso.com'],
    } as any);

    // The scheduled rule was still PUT — the pre-#4113 behaviour, restored.
    expect(upsertScheduledQueryRule).toHaveBeenCalledTimes(1);
    // …with no action group, because none was created or confirmed.
    expect(upsertActionGroup).not.toHaveBeenCalled();
    expect(upsertScheduledQueryRule.mock.calls[0][0].actionGroupIds).toBeUndefined();
    expect(rec.actionGroupId).toBeUndefined();
    // …and the record says so, so the rule reads as unreachable downstream
    // rather than ordinary (`receiverTotal` = 0 ⇒ `isUnreachable`).
    expect(rec.note || '').toContain('No action group was bound');
    expect(receiverTotal(rec as any)).toBe(0);
    expect(isUnreachable(rec as any)).toBe(true);
  });
});

/**
 * The REAL `lib/azure/monitor-client.ts` runs in this block — only its ARM
 * transport (`monitor-arm`) is replaced — because the defect lives in the PUT
 * BODY that function builds, and a mock of the function itself can never see
 * one. Runs LAST in the file: `vi.resetModules()` invalidates the module
 * registry for anything imported after it.
 */
describe('#4113 upsertActionGroup is READ-MODIFY-WRITE (the destructive defect)', () => {
  class ArmError extends Error {
    status: number;
    constructor(m: string, s = 500) { super(m); this.status = s; }
  }

  function armModule(armGet: any, armPut: any) {
    return {
      MonitorError: ArmError,
      MonitorNotConfiguredError: class extends Error { missing: string[] = []; },
      token: vi.fn(async () => 'tok'),
      armGet,
      armPut,
      armPagedList: vi.fn(async () => []),
      armPost: vi.fn(async () => ({ status: 200, json: {} })),
      armPatch: vi.fn(async () => ({})),
      armDelete: vi.fn(async () => undefined),
      cached: (_k: string, _t: number, fn: () => any) => fn(),
      clearMonitorCache: vi.fn(),
    };
  }

  /** `existing === null` ⇒ the group does not exist (a clean ARM 404). */
  async function withArm(existing: any | null) {
    vi.resetModules();
    const armGet = vi.fn(async (_p: string) => {
      if (existing === null) throw new ArmError('ResourceNotFound', 404);
      return existing;
    });
    const armPut = vi.fn(async (_p: string, _b: any) => ({
      id: '/subscriptions/sub-1/resourceGroups/rg/providers/microsoft.insights/actionGroups/ag',
    }));
    vi.doMock('@/lib/azure/monitor-arm', () => armModule(armGet, armPut));
    const mod = await vi.importActual<typeof import('@/lib/azure/monitor-client')>('@/lib/azure/monitor-client');
    return { mod, armGet, armPut };
  }

  let savedSub: string | undefined;
  let savedRg: string | undefined;
  beforeEach(() => {
    savedSub = process.env.LOOM_SUBSCRIPTION_ID; process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
    savedRg = process.env.LOOM_ALERT_RG; process.env.LOOM_ALERT_RG = 'rg';
  });
  afterEach(() => {
    vi.doUnmock('@/lib/azure/monitor-arm');
    if (savedSub === undefined) delete process.env.LOOM_SUBSCRIPTION_ID; else process.env.LOOM_SUBSCRIPTION_ID = savedSub;
    if (savedRg === undefined) delete process.env.LOOM_ALERT_RG; else process.env.LOOM_ALERT_RG = savedRg;
  });

  it('PRESERVES an armRoleReceiver the platform put on the group', async () => {
    // At head the PUT body contained exactly four receiver arrays, so this
    // receiver was DELETED by an "idempotent upsert" every time an activator
    // composed over the group. An action-group PUT replaces `properties`.
    const { mod, armPut } = await withArm({
      id: '/subscriptions/sub-1/resourceGroups/rg/providers/microsoft.insights/actionGroups/ag',
      properties: {
        groupShortName: 'loomdefault',
        armRoleReceivers: [{ name: 'oncall', roleId: '8e3af657', useCommonAlertSchema: true }],
        azureFunctionReceivers: [{ name: 'fn', functionAppResourceId: '/f' }],
        emailReceivers: [],
      },
    });
    await mod.upsertActionGroup({ name: 'ag', shortName: 'ag', emails: ['ops@contoso.com'] });
    const body: any = armPut.mock.calls.at(-1)?.[1];
    expect(body.properties.armRoleReceivers).toEqual([{ name: 'oncall', roleId: '8e3af657', useCommonAlertSchema: true }]);
    expect(body.properties.azureFunctionReceivers).toHaveLength(1);
    expect(body.properties.emailReceivers).toEqual([{ name: 'email0', emailAddress: 'ops@contoso.com', useCommonAlertSchema: true }]);
    // Every kind is present in the body — an ABSENT array is a deletion.
    for (const k of ACTION_GROUP_RECEIVER_KINDS) expect(body.properties[k], k).toBeDefined();
  });

  it('preserves a managed kind the caller did not supply, and clears one supplied EMPTY', async () => {
    const { mod, armPut } = await withArm({
      id: '/x',
      properties: {
        groupShortName: 'sn',
        emailReceivers: [{ name: 'email0', emailAddress: 'keep@contoso.com' }],
        smsReceivers: [{ name: 'sms0', countryCode: '1', phoneNumber: '5550000' }],
      },
    });
    await mod.upsertActionGroup({ name: 'ag', shortName: 'ag', smsReceivers: [] });
    const body: any = armPut.mock.calls.at(-1)?.[1];
    expect(body.properties.emailReceivers).toHaveLength(1);   // not supplied => preserved
    expect(body.properties.smsReceivers).toEqual([]);          // supplied empty => cleared
  });

  it('does not rename an existing group short name', async () => {
    const { mod, armPut } = await withArm({ id: '/x', properties: { groupShortName: 'keepme' } });
    await mod.upsertActionGroup({ name: 'ag', shortName: 'something-else', emails: ['a@b.com'] });
    expect((armPut.mock.calls.at(-1)?.[1] as any).properties.groupShortName).toBe('keepme');
  });

  it('creates cleanly when the group does not exist (a 404 read is not an error)', async () => {
    const { mod, armPut } = await withArm(null);
    const id = await mod.upsertActionGroup({ name: 'ag', shortName: 'ag', emails: ['a@b.com'] });
    expect(id).toBeTruthy();
    const body: any = armPut.mock.calls.at(-1)?.[1];
    expect(body.properties.groupShortName).toBe('ag');
    expect(body.properties.armRoleReceivers).toEqual([]);
  });

  it('writes back to the ARM ID it was handed, not a same-named copy in the alert RG', async () => {
    const AG = '/subscriptions/other-sub/resourceGroups/other-rg/providers/microsoft.insights/actionGroups/AG-ID';
    const { mod, armGet, armPut } = await withArm({ id: AG, properties: { groupShortName: 'sn' } });
    await mod.upsertActionGroup({ name: AG, shortName: 'sn', emails: ['a@b.com'] });
    expect(String(armGet.mock.calls.at(-1)?.[0])).toContain('other-rg');
    expect(String(armPut.mock.calls.at(-1)?.[0])).toContain('/subscriptions/other-sub/resourceGroups/other-rg/');
  });

  it('REFUSES to write when the read failed for any reason other than 404', async () => {
    vi.resetModules();
    const armGet = vi.fn(async () => { throw new ArmError('AuthorizationFailed', 403); });
    const armPut = vi.fn(async () => ({ id: '/x' }));
    vi.doMock('@/lib/azure/monitor-arm', () => armModule(armGet, armPut));
    const mod = await vi.importActual<typeof import('@/lib/azure/monitor-client')>('@/lib/azure/monitor-client');
    // A 403 that degraded into "the group has no receivers" would be written
    // straight back as a DELETION of every receiver on it — R7 with data loss.
    await expect(mod.upsertActionGroup({ name: 'ag', shortName: 'ag', emails: ['a@b.com'] })).rejects.toThrow(/AuthorizationFailed/);
    expect(armPut).not.toHaveBeenCalled();
  });

  it('readActionGroupReceivers reports ALL eleven kinds and a real total', async () => {
    const { mod } = await withArm({
      id: '/x',
      properties: { groupShortName: 'sn', armRoleReceivers: [{ name: 'a' }], voiceReceivers: [{ name: 'v' }] },
    });
    const read = await mod.readActionGroupReceivers('ag');
    expect(read.exists).toBe(true);
    expect(read.total).toBe(2);
    expect(Object.keys(read.byKind).sort()).toEqual([...mod.ACTION_GROUP_RECEIVER_KINDS].sort());
  });
});
