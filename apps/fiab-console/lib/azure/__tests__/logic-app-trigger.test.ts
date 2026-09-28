/**
 * #4748 — a Logic App's HTTP-request trigger is RESOLVED from the workflow
 * definition, never assumed to be called `manual`.
 *
 * WHAT MAKES THESE FAIL (assertion-design.md):
 *   The load-bearing fixture names its request trigger
 *   `When_a_HTTP_request_is_received` — NOT `manual`. The fetch stub answers a
 *   listCallbackUrl POST for THAT name only and 404s every other trigger name,
 *   exactly as ARM did on the live walk (run 36437492634: "The workflow
 *   'WeathForeCast' trigger 'manual' could not be found."). Code that
 *   interpolates a hard-coded `manual` therefore POSTs `/triggers/manual/…`,
 *   gets the 404, and throws — RED. A fixture whose trigger IS `manual` could
 *   not tell the two apart and is deliberately absent from the red-proof case.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

const WF = '/subscriptions/sub-1/resourceGroups/rg-airportsecurity-dev/providers/Microsoft.Logic/workflows/WeathForeCast';

/** A Consumption workflow ARM GET body with the given `definition.triggers`. */
function workflowBody(triggers: Record<string, { type: string; kind?: string }>) {
  return { id: WF, name: 'WeathForeCast', properties: { state: 'Enabled', definition: { triggers, actions: {} } } };
}

/**
 * ARM stub: GET workflow → `triggers`; POST listCallbackUrl → a SAS URL for a
 * trigger that exists in `triggers`, and ARM's own 404 shape for any other name.
 */
function stubArm(triggers: Record<string, { type: string; kind?: string }>) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = String(init?.method || 'GET');
    calls.push({ url: u, method });
    const m = /\/triggers\/([^/]+)\/listCallbackUrl/.exec(u);
    if (m) {
      const name = decodeURIComponent(m[1]);
      if (!Object.prototype.hasOwnProperty.call(triggers, name)) {
        return new Response(JSON.stringify({ error: { code: 'WorkflowTriggerNotFound', message: `The workflow 'WeathForeCast' trigger '${name}' could not be found.` } }), { status: 404, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ value: `https://prod-07.westus.logic.azure.com/workflows/abc/triggers/${name}/paths/invoke?sig=SIG` }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (method === 'GET' && u.includes('/Microsoft.Logic/workflows/WeathForeCast?')) {
      return new Response(JSON.stringify(workflowBody(triggers)), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: { code: 'NotFound', message: `unexpected ${method} ${u}` } }), { status: 404, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}

describe('getLogicAppCallbackUrl — trigger resolution (#4748)', () => {
  it('resolves a request trigger that is NOT named `manual` (RED against a hard-coded `manual`)', async () => {
    const calls = stubArm({ When_a_HTTP_request_is_received: { type: 'Request', kind: 'Http' } });
    const { getLogicAppCallbackUrl } = await import('../monitor-client');
    const url = await getLogicAppCallbackUrl(WF);
    // Breaks if the POST targets any trigger other than the one the definition declares.
    expect(url).toContain('/triggers/When_a_HTTP_request_is_received/');
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toContain('/triggers/When_a_HTTP_request_is_received/listCallbackUrl?api-version=2016-06-01');
    // Breaks if a `manual` POST is still attempted first (e.g. try-manual-then-fall-back).
    expect(calls.some((c) => c.url.includes('/triggers/manual/'))).toBe(false);
  });

  it('a workflow with NO request trigger fails naming the workflow, the triggers found, and what is required — and never POSTs', async () => {
    const calls = stubArm({ Recurrence: { type: 'Recurrence' } });
    const { getLogicAppCallbackUrl } = await import('../monitor-client');
    const err = await getLogicAppCallbackUrl(WF).catch((e) => e);
    // Breaks if the message still names a trigger the user never chose, or drops any of the three facts.
    expect(err?.status).toBe(422);
    expect(err?.message).toContain("Logic App 'WeathForeCast'");
    expect(err?.message).toContain("'Recurrence' (Recurrence)");
    expect(err?.message).toMatch(/When a HTTP request is received/);
    expect(err?.message).not.toContain("'manual'");
    // Breaks if the resolver falls back to POSTing some default name anyway.
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('an explicit trigger name is honoured when it is a request trigger', async () => {
    const calls = stubArm({ alpha: { type: 'Request' }, zulu: { type: 'Request' } });
    const { getLogicAppCallbackUrl } = await import('../monitor-client');
    // `zulu` is deliberately NOT the one the deterministic default would pick (`alpha`).
    await getLogicAppCallbackUrl(WF, 'zulu');
    expect(calls.find((c) => c.method === 'POST')?.url).toContain('/triggers/zulu/listCallbackUrl');
  });

  it('an explicit trigger name that is not a request trigger is refused with the real candidates', async () => {
    stubArm({ Recurrence: { type: 'Recurrence' }, hook: { type: 'Request' } });
    const { getLogicAppCallbackUrl } = await import('../monitor-client');
    const err = await getLogicAppCallbackUrl(WF, 'Recurrence').catch((e) => e);
    expect(err?.status).toBe(422);
    expect(err?.message).toContain("no HTTP-request trigger named 'Recurrence'");
    expect(err?.message).toContain("'hook'");
  });
});

describe('chooseRequestTrigger — deterministic choice among several (#4748)', () => {
  it('prefers the designer default `manual` when it is one of several request triggers', async () => {
    const { chooseRequestTrigger } = await import('../logic-app-trigger');
    // `a_first` sorts before `manual`, so an ordinal-first rule would pick it — breaks if the `manual` preference is dropped.
    const r = chooseRequestTrigger('wf', [
      { name: 'a_first', type: 'Request', callbackCapable: true },
      { name: 'manual', type: 'Request', callbackCapable: true },
    ]);
    expect(r).toEqual({ triggerName: 'manual', chosenBy: 'designer-default' });
  });

  it('otherwise picks the ordinal-first name, independent of declaration order', async () => {
    const { chooseRequestTrigger } = await import('../logic-app-trigger');
    // Declared zulu-first: a "first declared" rule would return `zulu` — breaks if the sort is removed.
    const r = chooseRequestTrigger('wf', [
      { name: 'zulu', type: 'Request', callbackCapable: true },
      { name: 'Recurrence', type: 'Recurrence', callbackCapable: false },
      { name: 'bravo', type: 'Request', callbackCapable: true },
    ]);
    expect(r).toEqual({ triggerName: 'bravo', chosenBy: 'first-by-name' });
  });

  it('a lone request trigger among others is `only`, and the non-request trigger is never chosen', async () => {
    const { chooseRequestTrigger } = await import('../logic-app-trigger');
    // `Alpha` sorts first but is a Recurrence — breaks if callbackCapable is ignored.
    const r = chooseRequestTrigger('wf', [
      { name: 'Alpha', type: 'Recurrence', callbackCapable: false },
      { name: 'renamed_http', type: 'Request', callbackCapable: true },
    ]);
    expect(r).toEqual({ triggerName: 'renamed_http', chosenBy: 'only' });
  });

  it('triggersOfDefinition marks only `Request` (any case) as callback-capable', async () => {
    const { triggersOfDefinition } = await import('../logic-app-trigger');
    const ts = triggersOfDefinition({ triggers: { a: { type: 'request', kind: 'Http' }, b: { type: 'ApiConnectionWebhook' }, c: { type: 'Recurrence' } } });
    expect(ts.filter((t) => t.callbackCapable).map((t) => t.name)).toEqual(['a']);
    expect(triggersOfDefinition(undefined)).toEqual([]);
  });

  it('a Request trigger restricted to a non-POST method is NOT callback-capable (C4)', async () => {
    const { triggersOfDefinition } = await import('../logic-app-trigger');
    // Azure Monitor invokes with POST; a GET-only Request trigger would bind then reject.
    const ts = triggersOfDefinition({ triggers: {
      getOnly: { type: 'Request', inputs: { method: 'GET' } },
      postOnly: { type: 'Request', inputs: { method: 'post' } },
      anyMethod: { type: 'Request', inputs: {} },
    } });
    expect(ts.filter((t) => t.callbackCapable).map((t) => t.name)).toEqual(['postOnly', 'anyMethod']);
  });
});
