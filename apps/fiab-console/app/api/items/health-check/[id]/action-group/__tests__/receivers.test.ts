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
 *   • Every privileged ARM call carries the CALLER's token (`USER-ARM-7z`), not
 *     the platform token (`UAMI-tk`); the auth header is captured and asserted.
 *     With no caller token the route must gate and mint nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'UAMI-tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

const getSessionMock = vi.fn(() => ({ claims: { oid: 'oid-1' } } as any));
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

// The caller's ARM token. When it is null the route must gate (S2); when present
// every privileged ARM call must carry THIS bearer, not the UAMI one.
const getUserArmTokenMock = vi.fn(async (_oid: string) => 'USER-ARM-7z' as string | null);
vi.mock('@/lib/azure/user-token-store', () => ({
  getUserArmToken: (oid: string) => getUserArmTokenMock(oid),
  saveUserToken: vi.fn(async () => true),
}));
// No MSAL account ⇒ the silent refresh cannot mint a token, so a null cache is a
// real "no caller token" (deterministic — not dependent on MSAL env config).
vi.mock('@/lib/auth/msal', () => ({
  getMsalClient: () => ({ getTokenCache: () => ({ getAllAccounts: async () => [] }), acquireTokenSilent: vi.fn() }),
}));

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

const authHeaders: string[] = [];
function stubArm(opts: { functionGetStatus?: number } = {}) {
  authHeaders.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url); const m = String(init?.method || 'GET');
    const auth = (init?.headers as any)?.authorization || '';
    if (/\/listkeys|\/listCallbackUrl/.test(u)) authHeaders.push(String(auth));
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (m === 'GET' && u.includes('/sites/alerts-fn/functions/OnAlert?')) {
      if (opts.functionGetStatus && opts.functionGetStatus >= 400) return json({ error: { code: 'AuthorizationFailed', message: 'not authorized' } }, opts.functionGetStatus);
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
  getUserArmTokenMock.mockClear().mockResolvedValue('USER-ARM-7z');
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
    // S2: the privileged listkeys ran under the CALLER's ARM token, not the UAMI.
    // Passing `undefined` (UAMI fallback) would make this Bearer UAMI-tk → RED.
    expect(authHeaders).toEqual(['Bearer USER-ARM-7z']);
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

describe('health-check action-group — resolves under the caller\'s permissions', () => {
  it('gates with 401 and mints NOTHING when the caller has no Azure token', async () => {
    getUserArmTokenMock.mockResolvedValue(null);
    const res = await PUT(put({ name: 'hc-ag', functions: [{ functionAppResourceId: SITE, functionName: 'OnAlert' }] }), CTX);
    expect(res.status).toBe(401);
    // No ARM secret call, no action group, no persisted change.
    expect(authHeaders).toEqual([]);
    expect(upsertMock).not.toHaveBeenCalled();
    expect(updateOwnedItemMock).not.toHaveBeenCalled();
  });

  it('when the caller cannot READ the resource, refuses BEFORE any listkeys and returns 403', async () => {
    stubArm({ functionGetStatus: 403 });
    const res = await PUT(put({ name: 'hc-ag', functions: [{ functionAppResourceId: SITE, functionName: 'OnAlert' }] }), CTX);
    expect(res.status).toBe(403);
    // Authorization is the function GET; a listkeys must never be attempted after it fails.
    expect(authHeaders).toEqual([]);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('the Logic App callback is resolved under the caller token too', async () => {
    await PUT(put({ name: 'hc-ag', logicApps: [{ resourceId: WF }] }), CTX);
    expect(authHeaders).toEqual(['Bearer USER-ARM-7z']);
  });

  it('redacts a secret query value from an ARM error returned to the browser (S4)', async () => {
    // ARM 422s the function GET with a message that echoes a `code=` secret.
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url); const m = String(init?.method || 'GET');
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (m === 'GET' && u.includes('/sites/alerts-fn/functions/OnAlert?')) {
        return json({ error: { code: 'BadRequest', message: 'bad callback https://x.azurewebsites.net/api/a?code=SECRET-echo-1' } }, 422);
      }
      return json({ error: { code: 'NotFound', message: 'x' } }, 404);
    }));
    const res = await PUT(put({ name: 'hc-ag', functions: [{ functionAppResourceId: SITE, functionName: 'OnAlert' }] }), CTX);
    const body = await res.json();
    // Breaks if the raw ARM message (with the secret) is forwarded verbatim.
    expect(JSON.stringify(body)).not.toContain('SECRET-echo-1');
    expect(JSON.stringify(body)).toContain('code=REDACTED');
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

/**
 * #4748 at the SAVE call site: the persisted `triggerName` must reach
 * `listCallbackUrl`, and a workflow the product cannot notify must be refused
 * before anything is written.
 *
 * WHAT MAKES THESE FAIL:
 *   • `Multi` has TWO request triggers, `manual` and `secondary`. The row asks
 *     for `secondary`. A route that stops passing `la.triggerName` into
 *     `resolveLogicAppCallback` falls back to the designer default `manual`,
 *     which EXISTS here — so the mutant saves successfully to the WRONG trigger
 *     and only the POSTed-path / SAS / `chosenBy` pins can see it. That is why
 *     the fixture contains `manual`: without it the mutant would 422 instead.
 *   • `Nightly` has only a Recurrence: the save must be a 422 that names the
 *     workflow and its triggers, mint no SAS, write no action group and persist
 *     nothing. Mapping that 4xx to a 502, or saving the other receivers anyway,
 *     fails.
 *   • ARM 500 on the workflow read must not be reported as a permission gate.
 */
describe('health-check action-group — Logic App trigger at the save call site (#4748)', () => {
  const MULTI = '/subscriptions/sub-1/resourceGroups/rg-la/providers/Microsoft.Logic/workflows/Multi';
  const NIGHTLY = '/subscriptions/sub-1/resourceGroups/rg-la/providers/Microsoft.Logic/workflows/Nightly';
  const posts: string[] = [];
  function stubWorkflows(opts: { workflowStatus?: number } = {}) {
    posts.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url); const m = String(init?.method || 'GET');
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (m === 'POST') posts.push(u);
      if (m === 'GET' && opts.workflowStatus) return json({ error: { code: 'X', message: 'workflow read failed' } }, opts.workflowStatus);
      if (m === 'GET' && u.includes('/workflows/Multi?')) {
        return json({ name: 'Multi', properties: { definition: { triggers: { manual: { type: 'Request', kind: 'Http' }, secondary: { type: 'Request', kind: 'Http' } } } } });
      }
      if (m === 'GET' && u.includes('/workflows/Nightly?')) {
        return json({ name: 'Nightly', properties: { definition: { triggers: { Recurrence: { type: 'Recurrence' } } } } });
      }
      const cb = /\/triggers\/([^/]+)\/listCallbackUrl/.exec(u);
      if (m === 'POST' && cb) return json({ value: `https://prod-1.westus.logic.azure.com/wf/triggers/${cb[1]}/paths/invoke?sig=SIG-${cb[1]}` });
      return json({ error: { code: 'NotFound', message: `unexpected ${m} ${u}` } }, 404);
    }));
  }

  it('SEVERAL request triggers: the persisted pick is the trigger whose callback is minted, and it stays persisted', async () => {
    stubWorkflows();
    const res = await PUT(put({ name: 'hc-ag', logicApps: [{ resourceId: MULTI, triggerName: 'secondary' }] }), CTX);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(posts).toEqual([expect.stringContaining('/workflows/Multi/triggers/secondary/listCallbackUrl')]);
    expect(upsertMock.mock.calls[0][0].logicAppReceivers.map((r: any) => r.callbackUrl)).toEqual([
      'https://prod-1.westus.logic.azure.com/wf/triggers/secondary/paths/invoke?sig=SIG-secondary',
    ]);
    expect(body.bindings.logicApps).toEqual([{ resourceId: MULTI, workflowName: 'Multi', triggerName: 'secondary', chosenBy: 'explicit' }]);
    expect(updateOwnedItemMock.mock.calls[0][3].state.actionGroup.logicApps).toEqual([
      { resourceId: MULTI, triggerName: 'secondary', useCommonAlertSchema: true },
    ]);
  });

  it('SEVERAL with no pick: the designer default is used, and the choice is reported rather than silent', async () => {
    stubWorkflows();
    const body = await (await PUT(put({ name: 'hc-ag', logicApps: [{ resourceId: MULTI }] }), CTX)).json();
    expect(posts).toEqual([expect.stringContaining('/triggers/manual/listCallbackUrl')]);
    expect(body.bindings.logicApps[0]).toMatchObject({ triggerName: 'manual', chosenBy: 'designer-default' });
    // Nothing was picked, so nothing is pinned: a renamed trigger re-resolves next save.
    expect(updateOwnedItemMock.mock.calls[0][3].state.actionGroup.logicApps[0].triggerName).toBeUndefined();
  });

  it('NONE: a workflow with no HTTP-request trigger is refused 422 naming what it has, and nothing is written', async () => {
    stubWorkflows();
    const res = await PUT(put({ name: 'hc-ag', emails: ['ops@contoso.com'], logicApps: [{ resourceId: NIGHTLY }] }), CTX);
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.error).toContain("Logic App 'Nightly' cannot be notified by Azure Monitor: it has no HTTP-request trigger");
    expect(body.error).toContain("Triggers found: 'Recurrence' (Recurrence)");
    expect(posts).toEqual([]);
    expect(upsertMock).not.toHaveBeenCalled();
    expect(updateOwnedItemMock).not.toHaveBeenCalled();
  });

  it('ARM 500 on the workflow read: a 502 with no permission gate, and nothing is written', async () => {
    stubWorkflows({ workflowStatus: 500 });
    const res = await PUT(put({ name: 'hc-ag', logicApps: [{ resourceId: MULTI }] }), CTX);
    const body = await res.json();
    expect(res.status).toBe(502);
    expect(body.gate).toBeUndefined();
    expect(body.error).toContain('workflow read failed');
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('ARM 403 on the workflow read: a 403 naming Logic App Contributor on that workflow', async () => {
    stubWorkflows({ workflowStatus: 403 });
    const res = await PUT(put({ name: 'hc-ag', logicApps: [{ resourceId: MULTI }] }), CTX);
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.gate.remediation).toContain('"Logic App Contributor" on \'Multi\'');
    expect(upsertMock).not.toHaveBeenCalled();
  });
});
