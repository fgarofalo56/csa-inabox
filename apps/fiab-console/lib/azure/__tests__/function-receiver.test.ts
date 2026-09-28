/**
 * #4740 — Azure Function receivers resolve their key-bearing URL from ARM at
 * save, and nothing secret is typed, stored, or returned.
 *
 * WHAT MAKES THESE FAIL (assertion-design.md):
 *   • `resolveFunctionTriggerUrl` must append the key ARM returned — the
 *     fixture key `FNKEY-7f3a` appears nowhere else, so a URL without it (or
 *     with the host key when a function key exists) fails the exact-string
 *     assertion.
 *   • an `admin`-level function must never reach `listkeys` — a resolver that
 *     fetched keys first and checked later fails the POST-count assertion.
 *   • the id guards are exercised with ids the PRE-#4748 loose regex
 *     (`/\/providers\/Microsoft\.Logic\/workflows\//i`, a substring test)
 *     ACCEPTED: a `?x=` smuggle and a `..` segment. Reverting to a contains
 *     test turns those rows green-for-the-wrong-reason → RED here.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

const SITE = '/subscriptions/sub-1/resourceGroups/rg-fn/providers/Microsoft.Web/sites/alerts-fn';

function envelope(name: string, opts: { http?: boolean; authLevel?: string; disabled?: boolean; url?: string } = {}) {
  const bindings = opts.http === false
    ? [{ type: 'timerTrigger', name: 't', schedule: '0 */5 * * * *' }]
    : [{ type: 'httpTrigger', name: 'req', direction: 'in', ...(opts.authLevel ? { authLevel: opts.authLevel } : {}) }, { type: 'http', direction: 'out', name: 'res' }];
  return {
    id: `${SITE}/functions/${name}`,
    name: `alerts-fn/${name}`,
    properties: {
      config: { bindings },
      invoke_url_template: opts.url ?? `https://alerts-fn.azurewebsites.net/api/${name.toLowerCase()}`,
      isDisabled: !!opts.disabled,
    },
  };
}

function stubArm(routes: (url: string, method: string) => { status?: number; body: unknown } | undefined) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url); const method = String(init?.method || 'GET');
    calls.push({ url: u, method });
    const r = routes(u, method) ?? { status: 404, body: { error: { code: 'NotFound', message: `unexpected ${method} ${u}` } } };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}

describe('resolveFunctionTriggerUrl (#4740)', () => {
  it('appends the FUNCTION key ARM returns to the invoke URL', async () => {
    const calls = stubArm((u, m) => {
      if (m === 'GET' && u.includes('/functions/OnAlert?')) return { body: envelope('OnAlert') };
      if (m === 'POST' && u.includes('/functions/OnAlert/listkeys')) return { body: { properties: { default: 'FNKEY-7f3a' } } };
      if (m === 'POST' && u.includes('/host/default/listkeys')) return { body: { functionKeys: { default: 'HOSTKEY-should-not-be-used' } } };
      return undefined;
    });
    const { resolveFunctionTriggerUrl } = await import('../function-receiver');
    const url = await resolveFunctionTriggerUrl(SITE, 'OnAlert');
    expect(url).toBe('https://alerts-fn.azurewebsites.net/api/onalert?code=FNKEY-7f3a');
    // Breaks if the host-key fallback runs even though a function key exists.
    expect(calls.some((c) => c.url.includes('/host/default/listkeys'))).toBe(false);
  });

  it('falls back to the host function key when the function has none', async () => {
    stubArm((u, m) => {
      if (m === 'GET' && u.includes('/functions/OnAlert?')) return { body: envelope('OnAlert', { authLevel: 'Function' }) };
      if (m === 'POST' && u.includes('/functions/OnAlert/listkeys')) return { body: { properties: {} } };
      if (m === 'POST' && u.includes('/host/default/listkeys')) return { body: { masterKey: 'MASTER-never', functionKeys: { default: 'HOSTKEY-91c2' } } };
      return undefined;
    });
    const { resolveFunctionTriggerUrl } = await import('../function-receiver');
    const url = await resolveFunctionTriggerUrl(SITE, 'OnAlert');
    // Breaks if the master key is used, or if the empty function-key dict is taken as a key.
    expect(url).toBe('https://alerts-fn.azurewebsites.net/api/onalert?code=HOSTKEY-91c2');
  });

  it('an anonymous function needs no key — no listkeys call', async () => {
    const calls = stubArm((u, m) => (m === 'GET' && u.includes('/functions/Open?') ? { body: envelope('Open', { authLevel: 'anonymous' }) } : undefined));
    const { resolveFunctionTriggerUrl } = await import('../function-receiver');
    expect(await resolveFunctionTriggerUrl(SITE, 'Open')).toBe('https://alerts-fn.azurewebsites.net/api/open');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('refuses an admin-level function BEFORE reading any key (never the master key)', async () => {
    const calls = stubArm((u, m) => (m === 'GET' && u.includes('/functions/Admin?') ? { body: envelope('Admin', { authLevel: 'admin' }) } : undefined));
    const { resolveFunctionTriggerUrl } = await import('../function-receiver');
    const err = await resolveFunctionTriggerUrl(SITE, 'Admin').catch((e) => e);
    expect(err?.status).toBe(422);
    expect(err?.message).toContain("Function 'Admin' in Function App 'alerts-fn'");
    expect(err?.message).toContain('master key');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('refuses a timer-triggered function with the reason', async () => {
    stubArm((u, m) => (m === 'GET' && u.includes('/functions/Nightly?') ? { body: envelope('Nightly', { http: false }) } : undefined));
    const { resolveFunctionTriggerUrl } = await import('../function-receiver');
    await expect(resolveFunctionTriggerUrl(SITE, 'Nightly')).rejects.toThrow(/not HTTP-triggered/);
  });

  it('refuses a routed function whose URL has template parameters', async () => {
    stubArm((u, m) => (m === 'GET' && u.includes('/functions/ById?') ? { body: envelope('ById', { url: 'https://alerts-fn.azurewebsites.net/api/items/{id}' }) } : undefined));
    const { resolveFunctionTriggerUrl } = await import('../function-receiver');
    await expect(resolveFunctionTriggerUrl(SITE, 'ById')).rejects.toThrow(/route has parameters/);
  });
});

describe('listFunctionTriggers (#4740)', () => {
  it('marks each function usable or not, and returns no URL', async () => {
    stubArm((u, m) => (m === 'GET' && /\/functions\?api-version=/.test(u)
      ? { body: { value: [envelope('OnAlert'), envelope('Nightly', { http: false }), envelope('Off', { disabled: true })] } }
      : undefined));
    const { listFunctionTriggers } = await import('../function-receiver');
    const fns = await listFunctionTriggers(SITE);
    expect(fns.map((f) => [f.name, f.usable, f.reason ?? null])).toEqual([
      ['OnAlert', true, null],
      ['Nightly', false, 'not HTTP-triggered'],
      ['Off', false, 'disabled'],
    ]);
    // Breaks if invoke_url_template leaks through to the picker.
    expect(JSON.stringify(fns)).not.toContain('azurewebsites.net');
    expect(fns[0].authLevel).toBe('function');
  });
});

describe('ARM id guards — the id becomes a path the UAMI token is sent to', () => {
  it('assertFunctionAppId accepts a real site id and rejects traversal / smuggling', async () => {
    const { assertFunctionAppId } = await import('../function-receiver');
    expect(assertFunctionAppId(`${SITE}/`)).toBe('alerts-fn');
    for (const bad of [
      `${SITE}/../../../providers/Microsoft.KeyVault/vaults/kv`,
      `/subscriptions/sub-1/resourceGroups/../providers/Microsoft.Web/sites/x`,
      `${SITE}?x=1`,
      '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.Logic/workflows/wf',
    ]) {
      expect(() => assertFunctionAppId(bad), bad).toThrow(/Function App/);
    }
  });

  it('assertLogicAppId rejects ids the old substring test accepted', async () => {
    const { assertLogicAppId } = await import('../logic-app-trigger');
    const OLD_LOOSE = /\/providers\/Microsoft\.Logic\/workflows\//i;
    const smuggled = [
      '/subscriptions/s/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/v/secrets/s?x=/providers/Microsoft.Logic/workflows/a',
      '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Logic/workflows/..',
    ];
    for (const id of smuggled) {
      // The fixture must be one the pre-fix guard let through, or this row proves nothing.
      expect(OLD_LOOSE.test(id), `fixture must satisfy the old guard: ${id}`).toBe(true);
      expect(() => assertLogicAppId(id), id).toThrow(/Logic App/);
    }
    expect(assertLogicAppId('/subscriptions/s/resourcegroups/rg/providers/microsoft.logic/workflows/WeathForeCast')).toBe('WeathForeCast');
  });
});
