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
const upsertActionGroup = vi.fn(async (_i: any) => '/subscriptions/s/resourceGroups/rg/providers/microsoft.insights/actionGroups/ag');
const upsertScheduledQueryRule = vi.fn(async (_i: any) => ({}));
const patchScheduledQueryRule = vi.fn(async (_n: string, _e: boolean) => undefined);
vi.mock('@/lib/azure/monitor-client', () => ({
  MonitorNotConfiguredError: class extends Error { missing: string[]; constructor(m: string[]) { super('not configured'); this.missing = m; } },
  MonitorError: class extends Error { status: number; constructor(m: string, s = 500) { super(m); this.status = s; } },
  upsertActionGroup: (i: any) => upsertActionGroup(i),
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
