/**
 * GET /api/monitor/logic-app-triggers — the pre-save trigger report the
 * health-check Logic App picker renders (#4748), at the ROUTE seam: the real
 * `logic-app-trigger` resolver runs against a stubbed ARM `fetch`.
 *
 * WHAT MAKES THESE FAIL (assertion-design.md):
 *   • ONE trigger: the fixture's only Request trigger is
 *     `When_a_HTTP_request_is_received` and there is NO `manual` — a route that
 *     assumed `manual` reports the wrong name and fails the `triggerName` pin.
 *   • SEVERAL: the fixture carries `manual` AND `secondary` as Request triggers
 *     plus a Recurrence. Without `triggerName` the route must report
 *     `manual`/`designer-default`; with `triggerName=secondary` it must report
 *     `secondary`/`explicit`. A route that drops the query parameter reports
 *     `manual` for both and fails the second pin — the fixture contains
 *     `manual` precisely so that mutation yields a WRONG ANSWER, not a 404.
 *   • NONE: a Recurrence-only workflow must come back `ok: true` with a
 *     `problem` naming the triggers found — the editor renders that as the
 *     "cannot be notified" gate. Rethrowing the 422 instead turns `ok` false
 *     and the status non-200.
 *   • ARM ERROR: a 403 on the workflow GET must be a 403 whose remediation
 *     names "Logic App Contributor"; a 500 must NOT be reported as a
 *     permission problem.
 *   • NO SECRET READ: every case records the ARM calls made; this route must
 *     make exactly one GET and never POST `listCallbackUrl` (the SAS is minted
 *     only at save). The fixture answers `listCallbackUrl` with a real-looking
 *     SAS, so a route that minted one would also leak `LASIG-route-1`.
 *   • CALLER TOKEN: the GET carries `Bearer USER-ARM-q1`, never the UAMI token.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'UAMI-tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});
vi.mock('@/lib/auth/session', () => ({ getSession: () => ({ claims: { oid: 'oid-1' } }) }));
const getUserArmTokenMock = vi.fn(async (_oid: string) => 'USER-ARM-q1' as string | null);
vi.mock('@/lib/azure/user-token-store', () => ({
  getUserArmToken: (oid: string) => getUserArmTokenMock(oid),
  saveUserToken: vi.fn(async () => true),
}));
// No MSAL account ⇒ a null cached token is a real "no caller token".
vi.mock('@/lib/auth/msal', () => ({
  getMsalClient: () => ({ getTokenCache: () => ({ getAllAccounts: async () => [] }), acquireTokenSilent: vi.fn() }),
}));

import { GET } from '../route';

const WF_BASE = '/subscriptions/sub-1/resourceGroups/rg-la/providers/Microsoft.Logic/workflows';
const DEFINITIONS: Record<string, unknown> = {
  Renamed: { triggers: { When_a_HTTP_request_is_received: { type: 'Request', kind: 'Http' } } },
  Multi: {
    triggers: {
      secondary: { type: 'Request', kind: 'Http' },
      manual: { type: 'Request', kind: 'Http' },
      Recurrence: { type: 'Recurrence', recurrence: { frequency: 'Hour', interval: 1 } },
    },
  },
  Nightly: { triggers: { Recurrence: { type: 'Recurrence', recurrence: { frequency: 'Day', interval: 1 } } } },
};

const calls: { method: string; url: string; auth: string }[] = [];
function stubArm(opts: { workflowStatus?: number } = {}) {
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url); const m = String(init?.method || 'GET');
    calls.push({ method: m, url: u, auth: String((init?.headers as any)?.authorization || '') });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (/\/listCallbackUrl/.test(u)) return json({ value: 'https://prod-1.westus.logic.azure.com/x?sig=LASIG-route-1' });
    const hit = /\/workflows\/([^/?]+)\?/.exec(u);
    if (m === 'GET' && hit) {
      if (opts.workflowStatus && opts.workflowStatus >= 400) {
        return json({ error: { code: opts.workflowStatus === 403 ? 'AuthorizationFailed' : 'InternalServerError', message: 'arm said no' } }, opts.workflowStatus);
      }
      const def = DEFINITIONS[hit[1]];
      if (def) return json({ name: hit[1], properties: { definition: def } });
    }
    return json({ error: { code: 'NotFound', message: `unexpected ${m} ${u}` } }, 404);
  }));
}

function get(workflow: string, triggerName?: string) {
  const q = `workflowResourceId=${encodeURIComponent(`${WF_BASE}/${workflow}`)}${triggerName ? `&triggerName=${encodeURIComponent(triggerName)}` : ''}`;
  return GET(new NextRequest(`http://localhost/api/monitor/logic-app-triggers?${q}`), { params: Promise.resolve({}) } as any);
}

/** The route is read-only: one workflow GET, under the caller's token, no secret minted. */
function expectReadOnlyUnderCaller(bodyText: string) {
  expect(calls.map((c) => c.method)).toEqual(['GET']);
  expect(calls[0].url).toContain('/providers/Microsoft.Logic/workflows/');
  expect(calls[0].auth).toBe('Bearer USER-ARM-q1');
  expect(bodyText).not.toContain('LASIG-route-1');
}

beforeEach(() => {
  getUserArmTokenMock.mockReset().mockResolvedValue('USER-ARM-q1');
  stubArm();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('GET /api/monitor/logic-app-triggers (#4748)', () => {
  it('ONE request trigger, not named `manual`: reports it as the only choice', async () => {
    const res = await get('Renamed');
    const text = await res.clone().text();
    const body = JSON.parse(text);
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, workflowName: 'Renamed', triggerName: 'When_a_HTTP_request_is_received', chosenBy: 'only' });
    expect(body.problem).toBeUndefined();
    expectReadOnlyUnderCaller(text);
  });

  it('SEVERAL request triggers: reports every one (request or not), defaults to the designer name, and honours an explicit pick', async () => {
    const dflt = await get('Multi');
    const dBody = await dflt.json();
    expect(dBody).toMatchObject({ ok: true, triggerName: 'manual', chosenBy: 'designer-default' });
    // The editor builds its dropdown from `callbackCapable` rows — the Recurrence must be reported as NOT capable.
    expect(dBody.triggers.map((t: any) => [t.name, t.callbackCapable])).toEqual([
      ['secondary', true], ['manual', true], ['Recurrence', false],
    ]);
    expectReadOnlyUnderCaller(JSON.stringify(dBody));

    calls.length = 0;
    const picked = await get('Multi', 'secondary');
    const pText = await picked.clone().text();
    expect(JSON.parse(pText)).toMatchObject({ ok: true, triggerName: 'secondary', chosenBy: 'explicit' });
    expectReadOnlyUnderCaller(pText);
  });

  it('NONE: a Recurrence-only workflow is ok:true with a problem naming the triggers found, and no trigger is chosen', async () => {
    const res = await get('Nightly');
    const text = await res.clone().text();
    const body = JSON.parse(text);
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.triggerName).toBeUndefined();
    expect(body.problem).toContain("Logic App 'Nightly' cannot be notified by Azure Monitor: it has no HTTP-request trigger");
    expect(body.problem).toContain("Triggers found: 'Recurrence' (Recurrence)");
    expectReadOnlyUnderCaller(text);
  });

  it('an explicit pick the workflow no longer has comes back as a problem that lists the real candidates', async () => {
    const body = await (await get('Multi', 'gone')).json();
    expect(body.ok).toBe(true);
    expect(body.problem).toContain("no HTTP-request trigger named 'gone'");
    expect(body.problem).toContain("'secondary', 'manual'");
  });

  it('ARM 403 on the workflow: a 403 gate naming the role, and nothing else attempted', async () => {
    stubArm({ workflowStatus: 403 });
    const res = await get('Renamed');
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.ok).toBe(false);
    expect(body.gate.remediation).toContain('"Logic App Contributor"');
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('ARM 500 on the workflow: a 500 that is NOT dressed up as a permission problem', async () => {
    stubArm({ workflowStatus: 500 });
    const res = await get('Renamed');
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.gate).toBeUndefined();
    expect(body.error).toContain('arm said no');
  });

  it('no caller ARM token: 401 gate, and ARM is never called', async () => {
    getUserArmTokenMock.mockResolvedValue(null);
    const res = await get('Renamed');
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it('a non-workflow resource id is refused 400 before any ARM call', async () => {
    const res = await GET(new NextRequest(`http://localhost/api/monitor/logic-app-triggers?workflowResourceId=${encodeURIComponent('/subscriptions/s/resourceGroups/r/providers/Microsoft.Web/sites/fn')}`), { params: Promise.resolve({}) } as any);
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });
});
