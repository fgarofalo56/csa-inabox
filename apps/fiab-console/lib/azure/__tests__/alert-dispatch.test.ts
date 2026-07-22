/**
 * O1 — unified alert-dispatch unit tests. Exercise the REAL routing + payload
 * logic (severity receivers, ARM-id parsing, createNotifications body, direct
 * webhook leg, dedup-issue convention) against an injected mock fetch/token —
 * no live ARM.
 */
import { describe, it, expect } from 'vitest';
import {
  dispatchAlert,
  parseActionGroupId,
  receiversForSeverity,
  webhookPayload,
  dedupIssueTitle,
  upsertDedupIssue,
  type AlertInput,
} from '../alert-dispatch';

const AG_ID =
  '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-csa-loom-admin-centralus/providers/microsoft.insights/actionGroups/loom-default-alerts';

const GROUP_PROPS = {
  emailReceivers: [{ name: 'admin-email', emailAddress: 'ops@example.com', useCommonAlertSchema: true }],
  armRoleReceivers: [{ name: 'subscription-owners', roleId: '8e3af657-a8ff-443c-a75c-2fe8c4bcb635' }],
  webhookReceivers: [] as Array<{ name?: string; serviceUri?: string }>,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Recording mock fetch: GET action group → props; POST createNotifications → 202. */
function mockArm(calls: Array<{ url: string; init?: RequestInit }>, groupProps: unknown = GROUP_PROPS) {
  return async (url: any, init?: any): Promise<Response> => {
    calls.push({ url: String(url), init });
    const u = String(url);
    if (u.includes('/createNotifications')) return jsonResponse(202, {});
    if (u.includes('/actionGroups/')) return jsonResponse(200, { properties: groupProps });
    // direct webhook target
    return jsonResponse(200, { ok: true });
  };
}

const BASE_INPUT: AlertInput = {
  source: 'synthetic-monitor',
  severity: 'P1',
  title: 'J1 login probe failing',
  body: 'AADSTS7000215 class — real sign-in path down.',
  dedupKey: 'synthetic-monitor:J1',
};

describe('parseActionGroupId', () => {
  it('parses a well-formed ARM id (case-insensitive provider)', () => {
    expect(parseActionGroupId(AG_ID)).toEqual({
      sub: '00000000-0000-0000-0000-000000000000',
      rg: 'rg-csa-loom-admin-centralus',
      name: 'loom-default-alerts',
    });
  });
  it('rejects malformed ids', () => {
    expect(parseActionGroupId('loom-default-alerts')).toBeNull();
    expect(parseActionGroupId('')).toBeNull();
    expect(parseActionGroupId(undefined)).toBeNull();
  });
});

describe('receiversForSeverity (P1 page vs P3 email routing)', () => {
  it('P3 keeps email + ARM-role receivers and DROPS webhook/Logic App receivers', () => {
    const r = receiversForSeverity(
      { ...GROUP_PROPS, webhookReceivers: [{ name: 'w', serviceUri: 'https://h/x' }], logicAppReceivers: [{ name: 'l' }] },
      'P3',
      'https://oncall.example/hook',
    );
    expect(r.emailReceivers).toHaveLength(1);
    expect(r.armRoleReceivers).toHaveLength(1);
    expect(r.webhookReceivers).toEqual([]);
    expect(r.logicAppReceivers).toEqual([]);
  });

  it('P1 mirrors all receivers and appends the direct on-call webhook', () => {
    const r = receiversForSeverity(GROUP_PROPS, 'P1', 'https://oncall.example/hook');
    expect(r.webhookReceivers).toEqual([
      expect.objectContaining({ name: 'oncall-webhook', serviceUri: 'https://oncall.example/hook' }),
    ]);
    expect(r.emailReceivers).toHaveLength(1);
  });

  it('does not duplicate a webhook already registered on the group', () => {
    const r = receiversForSeverity(
      { ...GROUP_PROPS, webhookReceivers: [{ name: 'oncall', serviceUri: 'https://oncall.example/hook' }] },
      'P2',
      'https://oncall.example/hook',
    );
    expect(r.webhookReceivers).toHaveLength(1);
  });

  it('P2 without a direct webhook mirrors the group as-is', () => {
    const r = receiversForSeverity(GROUP_PROPS, 'P2', undefined);
    expect(r.webhookReceivers).toEqual([]);
    expect(r.emailReceivers).toHaveLength(1);
    expect(r.armRoleReceivers).toHaveLength(1);
  });
});

describe('dispatchAlert', () => {
  it('honestly skips both legs when nothing is configured (never throws)', async () => {
    const res = await dispatchAlert(BASE_INPUT, { env: {}, getToken: async () => 'tok', fetchImpl: mockArm([]) });
    expect(res.ok).toBe(false);
    expect(res.actionGroup.status).toBe('skipped');
    expect(res.webhook.status).toBe('skipped');
  });

  it('fires the ONE shared action group via createNotifications (P1)', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const res = await dispatchAlert(BASE_INPUT, {
      env: { LOOM_ALERT_ACTION_GROUP_ID: AG_ID },
      getToken: async () => 'tok',
      fetchImpl: mockArm(calls),
    });
    expect(res.ok).toBe(true);
    expect(res.actionGroup).toEqual({ status: 'sent', httpStatus: 202 });
    expect(res.receivers).toEqual({ emails: 1, armRoles: 1, webhooks: 0, logicApps: 0 });
    // GET group then POST createNotifications, both against the parsed ARM path.
    expect(calls[0].url).toContain('/actionGroups/loom-default-alerts?api-version=');
    expect(calls[1].url).toContain('/createNotifications?api-version=');
    const body = JSON.parse(String(calls[1].init?.body));
    expect(body.alertType).toBe('logalertv2');
    expect(body.emailReceivers).toHaveLength(1);
  });

  it('P1 with LOOM_ALERT_WEBHOOK_URL delivers BOTH legs (webhook payload carries the alert text)', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const res = await dispatchAlert(BASE_INPUT, {
      env: { LOOM_ALERT_ACTION_GROUP_ID: AG_ID, LOOM_ALERT_WEBHOOK_URL: 'https://oncall.example/hook' },
      getToken: async () => 'tok',
      fetchImpl: mockArm(calls),
    });
    expect(res.ok).toBe(true);
    expect(res.webhook.status).toBe('sent');
    expect(res.receivers?.webhooks).toBe(1); // appended into createNotifications too
    const direct = calls.find((c) => c.url === 'https://oncall.example/hook');
    const payload = JSON.parse(String(direct?.init?.body));
    expect(payload).toMatchObject({
      schema: 'loom-alert/v1',
      source: 'synthetic-monitor',
      severity: 'P1',
      title: 'J1 login probe failing',
      dedupKey: 'synthetic-monitor:J1',
    });
  });

  it('P3 severity-routes AWAY from the webhook (email band only)', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const res = await dispatchAlert(
      { ...BASE_INPUT, severity: 'P3' },
      {
        env: { LOOM_ALERT_ACTION_GROUP_ID: AG_ID, LOOM_ALERT_WEBHOOK_URL: 'https://oncall.example/hook' },
        getToken: async () => 'tok',
        fetchImpl: mockArm(calls),
      },
    );
    expect(res.actionGroup.status).toBe('sent');
    expect(res.webhook.status).toBe('skipped');
    expect(res.receivers?.webhooks).toBe(0);
    expect(calls.some((c) => c.url === 'https://oncall.example/hook')).toBe(false);
  });

  it('reports a malformed action-group id as a per-leg error, not a throw', async () => {
    const res = await dispatchAlert(BASE_INPUT, {
      env: { LOOM_ALERT_ACTION_GROUP_ID: 'not-an-arm-id' },
      getToken: async () => 'tok',
      fetchImpl: mockArm([]),
    });
    expect(res.ok).toBe(false);
    expect(res.actionGroup.status).toBe('error');
  });

  it('captures ARM failures per-leg and still tries the webhook leg', async () => {
    const res = await dispatchAlert(BASE_INPUT, {
      env: { LOOM_ALERT_ACTION_GROUP_ID: AG_ID, LOOM_ALERT_WEBHOOK_URL: 'https://oncall.example/hook' },
      getToken: async () => 'tok',
      fetchImpl: async (url: any) =>
        String(url).includes('actionGroups') ? new Response('forbidden', { status: 403 }) : jsonResponse(200, {}),
    });
    expect(res.actionGroup.status).toBe('error');
    expect(res.actionGroup.detail).toContain('403');
    expect(res.webhook.status).toBe('sent');
    expect(res.ok).toBe(true);
  });
});

describe('dedup conventions', () => {
  it('dedupIssueTitle prefers the dedupKey and stamps the severity', () => {
    expect(dedupIssueTitle(BASE_INPUT)).toBe('[P1] synthetic-monitor:J1');
    expect(dedupIssueTitle({ source: 's1', severity: 'P2', title: 'expiring' })).toBe('[P2] s1: expiring');
  });

  it('upsertDedupIssue comments on an exact-title open issue instead of duplicating', async () => {
    const calls: string[] = [];
    const out = await upsertDedupIssue(
      { token: 't', owner: 'o', repo: 'r', title: '[P1] synthetic-monitor:J1', body: 'b' },
      {
        fetchImpl: async (url: any, init?: any) => {
          calls.push(`${init?.method || 'GET'} ${url}`);
          if (String(url).includes('/search/issues')) {
            return jsonResponse(200, { items: [{ number: 42, title: '[P1] synthetic-monitor:J1' }] });
          }
          return jsonResponse(201, { number: 42 });
        },
      },
    );
    expect(out).toEqual({ action: 'commented', number: 42 });
    expect(calls.some((c) => c.includes('/issues/42/comments'))).toBe(true);
  });

  it('upsertDedupIssue creates when no open issue matches, and reports errors without throwing', async () => {
    const created = await upsertDedupIssue(
      { token: 't', owner: 'o', repo: 'r', title: '[P2] x', body: 'b', labels: ['csa-loom'] },
      {
        fetchImpl: async (url: any) =>
          String(url).includes('/search/issues') ? jsonResponse(200, { items: [] }) : jsonResponse(201, { number: 7 }),
      },
    );
    expect(created).toEqual({ action: 'created', number: 7 });

    const errored = await upsertDedupIssue(
      { token: 't', owner: 'o', repo: 'r', title: 'x', body: 'b' },
      { fetchImpl: async () => new Response('nope', { status: 500 }) },
    );
    expect(errored.action).toBe('error');
  });

  it('webhookPayload is the loom-alert/v1 shape', () => {
    const p = webhookPayload(BASE_INPUT);
    expect(p.schema).toBe('loom-alert/v1');
    expect(typeof p.firedAt).toBe('string');
  });
});
