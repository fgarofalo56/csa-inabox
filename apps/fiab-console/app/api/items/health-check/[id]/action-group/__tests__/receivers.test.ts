/**
 * PUT/GET /api/items/health-check/[id]/action-group — the receiver bindings
 * #4740 (Azure Function) and #4748 (Logic App) at the ROUTE seam, with the
 * real `function-receiver` / `logic-app-trigger` resolvers running against a
 * stubbed ARM. Only the action-group upsert and the item store are mocked, so
 * what reaches Azure Monitor and what reaches the item are both observable.
 *
 * WHAT MAKES THESE FAIL (assertion-design.md):
 *   • The fixture function key `FNKEY-7f3a` is a unique token. It MUST appear
 *     in the webhook handed to `upsertActionGroup` (positive: the receiver
 *     works) and MUST NOT appear in the persisted item state or either
 *     response body (the key is never stored or echoed). Persisting the
 *     resolved URL, or returning `current` un-redacted, fails the negative;
 *     dropping the receiver fails the positive.
 *   • The legacy row's key `LEGACYKEY-55` behaves the same way: delivered to
 *     Azure (it must keep working until re-bound), absent from GET/PUT bodies.
 *   • The Logic App fixture's request trigger is `When_a_HTTP_request_is_received`
 *     and ARM 404s `manual` — a route that still defaults to `manual` fails.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

const getSessionMock = vi.fn(() => ({ claims: { oid: 'oid-1' } } as any));
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

let storedItem: any = null;
const updateOwnedItemMock = vi.fn(async (_id: string, _t: string, _o: string, patch: any) => {
  storedItem = { ...storedItem, ...patch };
  return storedItem;
});
vi.mock('@/app/api/items/_lib/item-crud', () => ({
  loadOwnedItem: vi.fn(async () => storedItem),
  updateOwnedItem: (...a: any[]) => updateOwnedItemMock(...(a as [string, string, string, any])),
}));

const upsertMock = vi.fn(async (_input: any) => '/subscriptions/sub-1/resourceGroups/rg-alerts/providers/microsoft.insights/actionGroups/hc-ag');
vi.mock('@/lib/azure/monitor-client', async () => {
  const arm = await vi.importActual<any>('@/lib/azure/monitor-arm');
  return {
    MonitorError: arm.MonitorError,
    MonitorNotConfiguredError: arm.MonitorNotConfiguredError,
    upsertActionGroup: (input: any) => upsertMock(input),
    listActionGroups: vi.fn(async () => []),
    sendActionGroupTestNotification: vi.fn(),
  };
});

import { GET, PUT } from '../route';

const SITE = '/subscriptions/sub-1/resourceGroups/rg-fn/providers/Microsoft.Web/sites/alerts-fn';
const WF = '/subscriptions/sub-1/resourceGroups/rg-airportsecurity-dev/providers/Microsoft.Logic/workflows/WeathForeCast';
const LEGACY_URL = 'https://old-fn.azurewebsites.net/api/alert?code=LEGACYKEY-55';
const CTX = { params: Promise.resolve({ id: 'hc-1' }) };

function stubArm() {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url); const m = String(init?.method || 'GET');
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (m === 'GET' && u.includes('/sites/alerts-fn/functions/OnAlert?')) {
      return json({ name: 'alerts-fn/OnAlert', properties: { config: { bindings: [{ type: 'httpTrigger', authLevel: 'function' }] }, invoke_url_template: 'https://alerts-fn.azurewebsites.net/api/onalert', isDisabled: false } });
    }
    if (m === 'POST' && u.includes('/sites/alerts-fn/functions/OnAlert/listkeys')) return json({ properties: { default: 'FNKEY-7f3a' } });
    if (m === 'GET' && u.includes('/workflows/WeathForeCast?')) {
      return json({ name: 'WeathForeCast', properties: { definition: { triggers: { When_a_HTTP_request_is_received: { type: 'Request', kind: 'Http' } } } } });
    }
    if (m === 'POST' && u.includes('/triggers/When_a_HTTP_request_is_received/listCallbackUrl')) return json({ value: 'https://prod-07.westus.logic.azure.com/workflows/abc/triggers/x/paths/invoke?sig=LASIG-3' });
    return json({ error: { code: 'NotFound', message: `unexpected ${m} ${u}` } }, 404);
  }));
}

function put(body: unknown) {
  return new NextRequest('http://localhost/api/items/health-check/hc-1/action-group', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}
const get = () => new NextRequest('http://localhost/api/items/health-check/hc-1/action-group');

beforeEach(() => {
  process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
  storedItem = { id: 'hc-1', state: {} };
  updateOwnedItemMock.mockClear();
  upsertMock.mockClear();
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-1' } } as any);
  stubArm();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('health-check action-group — Azure Function receiver (#4740)', () => {
  it('resolves the key server-side, delivers it to Azure Monitor, and never stores or returns it', async () => {
    const res = await PUT(put({ name: 'hc-ag', functions: [{ functionAppResourceId: SITE, functionName: 'OnAlert' }] }), CTX);
    const text = await res.clone().text();
    expect(res.status).toBe(200);
    // Positive: the receiver Azure Monitor gets carries the resolved key.
    const hooks = upsertMock.mock.calls[0][0].webhookReceivers.map((w: any) => w.serviceUri);
    expect(hooks).toEqual(['https://alerts-fn.azurewebsites.net/api/onalert?code=FNKEY-7f3a']);
    // Negative, paired: the key is in neither the stored item nor the response.
    const persisted = JSON.stringify(updateOwnedItemMock.mock.calls[0][3]);
    expect(persisted).not.toContain('FNKEY-7f3a');
    expect(text).not.toContain('FNKEY-7f3a');
    expect(updateOwnedItemMock.mock.calls[0][3].state.actionGroup.functions).toEqual([
      { functionAppResourceId: SITE, functionName: 'OnAlert', useCommonAlertSchema: true },
    ]);
  });

  it('refuses a NEW hand-typed trigger URL (the key-in-a-field shape) with 400 and upserts nothing', async () => {
    const res = await PUT(put({ name: 'hc-ag', functions: [{ functionUrl: 'https://x.azurewebsites.net/api/a?code=TYPEDKEY' }] }), CTX);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no longer accepted: it carries the function key/);
    expect(upsertMock).not.toHaveBeenCalled();
    expect(updateOwnedItemMock).not.toHaveBeenCalled();
  });

  it('a pre-#4740 legacy row is returned REDACTED, keeps delivering on save, and is kept as stored', async () => {
    storedItem = { id: 'hc-1', state: { actionGroup: { name: 'hc-ag', shortName: 'hc', emails: [], sms: [], webhooks: [], logicApps: [], functions: [{ functionUrl: LEGACY_URL, useCommonAlertSchema: true }] } } };
    const g = await GET(get(), CTX);
    const gBody = await g.json();
    expect(JSON.stringify(gBody)).not.toContain('LEGACYKEY-55');
    expect(gBody.current.functions).toEqual([{ useCommonAlertSchema: true, legacyEndpoint: 'https://old-fn.azurewebsites.net/api/alert' }]);

    // The browser sends back exactly what it was given.
    const res = await PUT(put({ name: 'hc-ag', functions: gBody.current.functions }), CTX);
    const body = await res.json();
    expect(res.status).toBe(200);
    // Still delivering — a silent drop would stop alerts reaching the function.
    expect(upsertMock.mock.calls[0][0].webhookReceivers.map((w: any) => w.serviceUri)).toEqual([LEGACY_URL]);
    expect(body.bindings.legacyFunctions).toBe(1);
    expect(JSON.stringify(body)).not.toContain('LEGACYKEY-55');
    expect(updateOwnedItemMock.mock.calls[0][3].state.actionGroup.functions).toEqual([{ functionUrl: LEGACY_URL, useCommonAlertSchema: true }]);
  });

  it('a legacyEndpoint that matches nothing stored is refused (400), not silently dropped', async () => {
    // Stored row has a DIFFERENT path — breaks if matching is by host only or by position.
    storedItem = { id: 'hc-1', state: { actionGroup: { name: 'hc-ag', shortName: 'hc', emails: [], sms: [], webhooks: [], logicApps: [], functions: [{ functionUrl: 'https://old-fn.azurewebsites.net/api/other?code=K' }] } } };
    const res = await PUT(put({ name: 'hc-ag', functions: [{ legacyEndpoint: 'https://old-fn.azurewebsites.net/api/alert' }] }), CTX);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no longer stored on this item/);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('re-binding a legacy row to a Function App drops the stored hand-typed URL', async () => {
    storedItem = { id: 'hc-1', state: { actionGroup: { name: 'hc-ag', shortName: 'hc', emails: [], sms: [], webhooks: [], logicApps: [], functions: [{ functionUrl: LEGACY_URL }] } } };
    const res = await PUT(put({ name: 'hc-ag', functions: [{ functionAppResourceId: SITE, functionName: 'OnAlert' }] }), CTX);
    expect(res.status).toBe(200);
    expect(JSON.stringify(updateOwnedItemMock.mock.calls[0][3])).not.toContain('LEGACYKEY-55');
    expect(upsertMock.mock.calls[0][0].webhookReceivers.map((w: any) => w.serviceUri)).toEqual(['https://alerts-fn.azurewebsites.net/api/onalert?code=FNKEY-7f3a']);
  });
});

describe('health-check action-group — Logic App receiver (#4748)', () => {
  it('binds a workflow whose request trigger is NOT named `manual`, and reports the trigger it chose', async () => {
    const res = await PUT(put({ name: 'hc-ag', logicApps: [{ resourceId: WF }] }), CTX);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(upsertMock.mock.calls[0][0].logicAppReceivers).toEqual([
      { resourceId: WF, callbackUrl: 'https://prod-07.westus.logic.azure.com/workflows/abc/triggers/x/paths/invoke?sig=LASIG-3', useCommonAlertSchema: true },
    ]);
    expect(body.bindings.logicApps).toEqual([{ resourceId: WF, workflowName: 'WeathForeCast', triggerName: 'When_a_HTTP_request_is_received', chosenBy: 'only' }]);
    // The SAS callback is a secret too — handed to Azure, not stored or echoed.
    expect(JSON.stringify(body)).not.toContain('LASIG-3');
    expect(JSON.stringify(updateOwnedItemMock.mock.calls[0][3])).not.toContain('LASIG-3');
  });
});
