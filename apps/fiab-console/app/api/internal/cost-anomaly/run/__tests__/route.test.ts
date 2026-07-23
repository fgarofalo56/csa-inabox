/**
 * BFF route tests for /api/internal/cost-anomaly/run (C3).
 *
 * Verifies the machine-to-machine contract the scheduled cost-anomaly monitor
 * ACA Job depends on:
 *   - fail-closed internal-token auth (401 without/with a wrong token);
 *   - LOOM_COST_ANOMALY_ENABLED=false → a no-op summary (opt-out);
 *   - an empty rules store seeds the default estate rule, evaluates the REAL
 *     detector on the cost daily series, and on a firing anomaly writes a
 *     loom-notifications row AND dispatches ONE shared-action-group alert;
 *   - an honest Cost-Management config gate (MonitorNotConfiguredError) is
 *     recorded, not thrown (exit-0 class).
 * The Cosmos / cost-client / alert seams are mocked; the REAL data path is the
 * C3 live receipt (minted probe on the deployment), per G1.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  MonitorNotConfiguredErrorMock,
  rulesContainerMock,
  notificationsContainerMock,
  costSummaryMock,
  dispatchAlertMock,
  ruleItems,
  createdNotifications,
} = vi.hoisted(() => {
  class MonitorNotConfiguredErrorMock extends Error {
    constructor() { super('monitor not configured'); this.name = 'MonitorNotConfiguredError'; }
  }
  const ruleItems: any[] = [];
  const createdNotifications: any[] = [];
  return {
    MonitorNotConfiguredErrorMock,
    ruleItems,
    createdNotifications,
    costSummaryMock: vi.fn(),
    dispatchAlertMock: vi.fn(),
    rulesContainerMock: {
      items: {
        query: () => ({ fetchAll: async () => ({ resources: [...ruleItems] }) }),
        upsert: async (doc: any) => { ruleItems.push(doc); return { resource: doc }; },
      },
      item: () => ({ replace: async () => ({}) }),
    },
    notificationsContainerMock: {
      items: { create: async (doc: any) => { createdNotifications.push(doc); return { resource: doc }; } },
    },
  };
});

vi.mock('@/lib/azure/cosmos-client', () => ({
  costAnomalyRulesContainer: async () => rulesContainerMock,
  notificationsContainer: async () => notificationsContainerMock,
}));
vi.mock('@/lib/azure/cost-client', () => ({
  getLoomCostSummaryCached: costSummaryMock,
  MonitorNotConfiguredError: MonitorNotConfiguredErrorMock,
}));
vi.mock('@/lib/azure/alert-dispatch', () => ({ dispatchAlert: dispatchAlertMock }));

import { POST } from '../route';

const TOKEN = 'test-internal-token';

function post(body?: unknown, token?: string): NextRequest {
  return new NextRequest('http://localhost/api/internal/cost-anomaly/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-loom-internal-token': token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Flat baseline with a clear spike on the last day → guaranteed anomaly. */
function spikeSeries() {
  const daily = Array.from({ length: 14 }, (_, i) => ({ date: `2026-07-${String(i + 1).padStart(2, '0')}`, cost: 100 }));
  daily.push({ date: '2026-07-15', cost: 1200 });
  return { value: { daily } };
}

beforeEach(() => {
  process.env.LOOM_INTERNAL_TOKEN = TOKEN;
  process.env.LOOM_TENANT_ADMIN_OID = '11111111-1111-1111-1111-111111111111';
  delete process.env.LOOM_COST_ANOMALY_ENABLED;
  ruleItems.length = 0;
  createdNotifications.length = 0;
  costSummaryMock.mockReset().mockResolvedValue(spikeSeries());
  dispatchAlertMock.mockReset().mockResolvedValue({ ok: true, severity: 'P2' });
});

afterEach(() => {
  delete process.env.LOOM_INTERNAL_TOKEN;
  delete process.env.LOOM_TENANT_ADMIN_OID;
  delete process.env.LOOM_COST_ANOMALY_ENABLED;
});

describe('auth (fail closed)', () => {
  it('401 without a token', async () => {
    expect((await POST(post({}))).status).toBe(401);
  });
  it('401 with a wrong token', async () => {
    expect((await POST(post({}, 'wrong'))).status).toBe(401);
  });
});

describe('opt-out', () => {
  it('returns a no-op summary when LOOM_COST_ANOMALY_ENABLED=false', async () => {
    process.env.LOOM_COST_ANOMALY_ENABLED = 'false';
    const res = await POST(post({}, TOKEN));
    const j: any = await res.json();
    expect(res.status).toBe(200);
    expect(j.enabled).toBe(false);
    expect(j.evaluated).toBe(0);
    expect(dispatchAlertMock).not.toHaveBeenCalled();
  });
});

describe('scheduled run', () => {
  it('seeds the default rule, detects the spike, notifies + dispatches ONE alert', async () => {
    const res = await POST(post({ trigger: 'scheduled' }, TOKEN));
    const j: any = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.evaluated).toBe(1);
    expect(j.fired).toBeGreaterThanOrEqual(1);
    // In-product notification written to the fallback tenant-admin oid.
    expect(createdNotifications).toHaveLength(1);
    expect(createdNotifications[0].userId).toBe('11111111-1111-1111-1111-111111111111');
    expect(createdNotifications[0].source).toBe('cost-anomaly-monitor');
    expect(createdNotifications[0].link).toBe('/admin/finops');
    // Exactly one shared-action-group alert with a scoped dedup key.
    expect(dispatchAlertMock).toHaveBeenCalledTimes(1);
    const alert = dispatchAlertMock.mock.calls[0][0];
    expect(alert.source).toBe('cost-anomaly-monitor');
    expect(alert.dedupKey).toContain('cost-anomaly:all:');
  });

  it('does NOT re-fire an already-alerted day (dedup via lastFiredAt)', async () => {
    ruleItems.push({
      id: 'estate-default', scope: 'all', docType: 'cost-anomaly-rule', schemaVersion: 1,
      enabled: true, method: '3sigma', threshold: 2, minAbsDelta: 0, timeframe: 'Last30Days',
      alertSeverity: 'P3', recipients: [], createdAt: 'x', updatedAt: 'x',
      lastFiredAt: '2026-07-15', // the spike day is already the watermark
    });
    const res = await POST(post({}, TOKEN));
    const j: any = await res.json();
    expect(j.fired).toBe(0);
    expect(dispatchAlertMock).not.toHaveBeenCalled();
  });

  it('records an honest Cost-Management config gate without throwing', async () => {
    costSummaryMock.mockRejectedValue(new MonitorNotConfiguredErrorMock());
    const res = await POST(post({}, TOKEN));
    const j: any = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.configGate).toContain('Cost Management');
    expect(dispatchAlertMock).not.toHaveBeenCalled();
  });
});
