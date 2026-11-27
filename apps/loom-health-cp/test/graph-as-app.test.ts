// Graph membership is called AS the AS app (loom-health-cp-as), authenticated by the managed identity's
// federated client assertion, NOT with the managed identity's own Graph token. Live defect 2026-11-27: the
// Graph application permissions + admin consent sit on the AS app, the MI holds none, so every callback
// failed `role membership could not be established` with `consent:1`.
// Each assertion names the value that breaks it (.claude/rules/assertion-design.md).

import { describe, expect, it } from 'vitest';
import { createAppTokenProvider, GraphConsentRequiredError, GraphTokenError } from '../src/auth/federation.js';
import { membershipFailure } from '../src/auth/server.js';
import { graphMembershipAsApp } from '../src/auth/wire.js';
import { TOKEN_EXCHANGE_SCOPE_BY_CLOUD } from '../src/auth/clouds.js';

const AUTH = 'login.test';
const TID = 'dddddddd-0000-0000-0000-000000000001';
const AS_APP = 'cccccccc-0000-0000-0000-00000000000a';
const OID = '11111111-1111-1111-1111-111111111111';
const GID = '00000000-0000-0000-0000-000000000001';
const TOKEN_URL = `https://${AUTH}/${TID}/oauth2/v2.0/token`;

/** The MI getter: returns a value that names the scope it was asked for, so a wrong scope or a direct MI use is visible. */
const miGetToken = (asked: string[]) => async (scope: string) => {
  asked.push(scope);
  return `mi-token-for:${scope}`;
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

interface Call { url: string; body: string; auth: string | undefined }
function fakeNet(token: () => Response, graph: (c: Call) => Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (u: string, init: RequestInit) => {
    const c = { url: String(u), body: String(init.body), auth: (init.headers as Record<string, string>).authorization };
    calls.push(c);
    return c.url === TOKEN_URL ? token() : graph(c);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl, tokenCalls: () => calls.filter((c) => c.url === TOKEN_URL), graphCalls: () => calls.filter((c) => c.url !== TOKEN_URL) };
}

describe('the AS-app client-credentials token request', () => {
  it('carries exactly grant_type, client_id = AS app, scope = Graph .default, and the MI federated assertion (commercial)', async () => {
    const asked: string[] = [];
    const net = fakeNet(() => json({ access_token: 'as-app-token', expires_in: 3599 }), () => json({ value: [GID] }));
    const g = graphMembershipAsApp({ cloud: 'commercial', authorityHost: AUTH, entraTenantId: TID, asClientId: AS_APP, getToken: miGetToken(asked), fetchImpl: net.fetchImpl });
    expect(await g.memberOf(OID, [GID])).toEqual([GID]);
    const [t] = net.tokenCalls();
    const form = Object.fromEntries(new URLSearchParams(t!.body));
    // Breaks if client_id is the MI (or anything but the AS app), if the assertion is missing, or if the
    // assertion was minted for the Graph scope instead of the token-exchange audience.
    expect(form).toEqual({
      grant_type: 'client_credentials',
      client_id: AS_APP,
      scope: 'https://graph.microsoft.com/.default',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: `mi-token-for:${TOKEN_EXCHANGE_SCOPE_BY_CLOUD.commercial}`,
    });
    // The MI is asked ONLY for the token-exchange audience; breaks if Graph is called with the MI's own Graph token.
    expect(asked).toEqual(['api://AzureADTokenExchange/.default']);
    // Happy path: checkMemberGroups is called with the AS-app token. Breaks on `Bearer mi-token-for:https://graph...`.
    expect(net.graphCalls().map((c) => [c.url, c.auth])).toEqual([
      [`https://graph.microsoft.com/v1.0/directoryObjects/${OID}/checkMemberGroups`, 'Bearer as-app-token'],
    ]);
  });

  it('Gov (gcc-high) asks for graph.microsoft.us/.default with the USGov exchange audience, and calls graph.microsoft.us', async () => {
    const asked: string[] = [];
    const net = fakeNet(() => json({ access_token: 'as-app-token', expires_in: 3599 }), () => json({ value: [] }));
    const g = graphMembershipAsApp({ cloud: 'gcc-high', authorityHost: AUTH, entraTenantId: TID, asClientId: AS_APP, getToken: miGetToken(asked), fetchImpl: net.fetchImpl });
    await g.memberOf(OID, [GID]);
    expect(new URLSearchParams(net.tokenCalls()[0]!.body).get('scope')).toBe('https://graph.microsoft.us/.default'); // breaks on graph.microsoft.com in Gov
    expect(asked).toEqual(['api://AzureADTokenExchangeUSGov/.default']);
    expect(net.graphCalls()[0]!.url.startsWith('https://graph.microsoft.us/')).toBe(true);
  });
});

describe('the AS-app token cache', () => {
  it('reuses the token until expires_in minus the skew, then fetches again', async () => {
    let t = 1_000_000;
    let n = 0;
    const net = fakeNet(() => json({ access_token: `tok-${++n}`, expires_in: 3600 }), () => json({}));
    const get = createAppTokenProvider({ authorityHost: AUTH, entraTenantId: TID, clientId: AS_APP, getClientAssertion: async () => 'a', fetchImpl: net.fetchImpl, now: () => t });
    expect(await get('s')).toBe('tok-1');
    t += 3600_000 - 5 * 60_000 - 1; // 1 ms before the refresh point
    expect(await get('s')).toBe('tok-1'); // breaks if every call refetches (no cache)
    expect(net.tokenCalls()).toHaveLength(1);
    t += 1; // at the refresh point
    expect(await get('s')).toBe('tok-2'); // breaks if the cache never expires
    expect(net.tokenCalls()).toHaveLength(2);
  });

  it('concurrent first calls share one fetch (single-flight)', async () => {
    const net = fakeNet(() => json({ access_token: 'tok', expires_in: 3600 }), () => json({}));
    const get = createAppTokenProvider({ authorityHost: AUTH, entraTenantId: TID, clientId: AS_APP, getClientAssertion: async () => 'a', fetchImpl: net.fetchImpl });
    expect(await Promise.all([get('s'), get('s'), get('s')])).toEqual(['tok', 'tok', 'tok']);
    expect(net.tokenCalls()).toHaveLength(1); // breaks if each concurrent caller mints its own token
  });

  it('a failed fetch is NOT cached: the next call retries and succeeds (#5416)', async () => {
    let fail = true;
    const net = fakeNet(() => (fail ? json({ error: 'temporarily_unavailable' }, 503) : json({ access_token: 'tok', expires_in: 3600 })), () => json({}));
    const get = createAppTokenProvider({ authorityHost: AUTH, entraTenantId: TID, clientId: AS_APP, getClientAssertion: async () => 'a', fetchImpl: net.fetchImpl });
    await expect(get('s')).rejects.toBeInstanceOf(GraphTokenError);
    fail = false;
    expect(await get('s')).toBe('tok'); // breaks if the rejected promise is cached (every later call re-throws)
    expect(net.tokenCalls()).toHaveLength(2);
  });

  it('is keyed per scope: two scopes are two fetches, and each scope keeps its own token', async () => {
    const net = fakeNet(() => json({ access_token: `tok-${net.tokenCalls().length}`, expires_in: 3600 }), () => json({}));
    const get = createAppTokenProvider({ authorityHost: AUTH, entraTenantId: TID, clientId: AS_APP, getClientAssertion: async () => 'a', fetchImpl: net.fetchImpl });
    expect(await get('scope-a')).toBe('tok-1');
    expect(await get('scope-b')).toBe('tok-2'); // breaks if the cache ignores the scope (scope-b would get tok-1)
    expect(await get('scope-a')).toBe('tok-1'); // breaks if scope-b's token overwrote scope-a's
    expect(net.tokenCalls().map((c) => new URLSearchParams(c.body).get('scope'))).toEqual(['scope-a', 'scope-b']);
  });

  it('a response with no expires_in is not cached: the next call fetches again', async () => {
    const net = fakeNet(() => json({ access_token: 'tok' }), () => json({}));
    const get = createAppTokenProvider({ authorityHost: AUTH, entraTenantId: TID, clientId: AS_APP, getClientAssertion: async () => 'a', fetchImpl: net.fetchImpl });
    await get('s');
    await get('s');
    expect(net.tokenCalls()).toHaveLength(2); // breaks if a token of unknown lifetime is cached (e.g. for ever)
  });

  it('clamps an absurd expires_in (1e12) to one day', async () => {
    let t = 0;
    const net = fakeNet(() => json({ access_token: 'tok', expires_in: 1e12 }), () => json({}));
    const get = createAppTokenProvider({ authorityHost: AUTH, entraTenantId: TID, clientId: AS_APP, getClientAssertion: async () => 'a', fetchImpl: net.fetchImpl, now: () => t });
    await get('s');
    t = 86_400_000 - 5 * 60_000 - 1;
    await get('s');
    expect(net.tokenCalls()).toHaveLength(1); // paired control: still cached just inside the clamped lifetime
    t += 1;
    await get('s');
    expect(net.tokenCalls()).toHaveLength(2); // breaks without the clamp: the token would be cached for ~31,700 years
  });

  it('a Graph 403 evicts the cached app token, so the next call mints a fresh one (just-granted consent applies)', async () => {
    let graphStatus = 403;
    let n = 0;
    const net = fakeNet(() => json({ access_token: `tok-${++n}`, expires_in: 3600 }), () => (graphStatus === 200 ? json({ value: [] }) : json({}, graphStatus)));
    const g = graphMembershipAsApp({ cloud: 'commercial', authorityHost: AUTH, entraTenantId: TID, asClientId: AS_APP, getToken: async () => 'a', fetchImpl: net.fetchImpl });
    await expect(g.memberOf(OID, [GID])).rejects.toBeInstanceOf(GraphConsentRequiredError);
    graphStatus = 200;
    await g.memberOf(OID, [GID]);
    // Breaks without the eviction: the second Graph call would reuse `tok-1` (cached ~55 min) and stay refused.
    expect(net.graphCalls().map((c) => c.auth)).toEqual(['Bearer tok-1', 'Bearer tok-2']);
    expect(net.tokenCalls()).toHaveLength(2);
  });

  it('a Graph 200 keeps the cached token (eviction is only on 401/403)', async () => {
    const net = fakeNet(() => json({ access_token: 'tok', expires_in: 3600 }), () => json({ value: [] }));
    const g = graphMembershipAsApp({ cloud: 'commercial', authorityHost: AUTH, entraTenantId: TID, asClientId: AS_APP, getToken: async () => 'a', fetchImpl: net.fetchImpl });
    await g.memberOf(OID, [GID]);
    await g.memberOf(OID, [GID]);
    expect(net.tokenCalls()).toHaveLength(1); // breaks if every Graph response evicts the token
  });
});

describe('failure classes are distinct and sanitised', () => {
  const ENTRA_400 = { error: 'invalid_client', error_description: 'AADSTS700016: app not found. Trace ID: trace-abc-999', error_codes: [700016], trace_id: 'trace-abc-999' };

  it('a token endpoint 400 invalid_client/700016 logs the token_acquisition class with that code and no body', async () => {
    const net = fakeNet(() => json(ENTRA_400, 400), () => json({ value: [] }));
    const g = graphMembershipAsApp({ cloud: 'commercial', authorityHost: AUTH, entraTenantId: TID, asClientId: AS_APP, getToken: async () => 'assertion-value-xyz', fetchImpl: net.fetchImpl });
    const e = await g.memberOf(OID, [GID]).then(() => undefined, (x: unknown) => x);
    expect(e).toBeInstanceOf(GraphTokenError);
    expect(net.graphCalls()).toEqual([]); // Graph is never asked without a token
    const f = membershipFailure(e);
    // Breaks if a token failure reads as consent (the misleading live `consent:1`), or loses the AADSTS number.
    expect(f).toEqual({ error: 'GraphTokenError', cause: 'token_acquisition', consent: 0, reason: 'token_endpoint_400', entraError: 'invalid_client', entraErrorCode: 700016 });
    const all = JSON.stringify(f) + String((e as Error).message);
    expect(all).not.toContain('trace-abc-999'); // breaks if the body is carried
    expect(all).not.toContain('assertion-value-xyz'); // breaks if the assertion is carried
  });

  it('a Graph 403 (token acquired) logs the graph_refused consent class', async () => {
    const net = fakeNet(() => json({ access_token: 'as-app-token', expires_in: 3599 }), () => json({ error: { code: 'Authorization_RequestDenied' } }, 403));
    const g = graphMembershipAsApp({ cloud: 'commercial', authorityHost: AUTH, entraTenantId: TID, asClientId: AS_APP, getToken: async () => 'a', fetchImpl: net.fetchImpl });
    const e = await g.memberOf(OID, [GID]).then(() => undefined, (x: unknown) => x);
    expect(e).toBeInstanceOf(GraphConsentRequiredError);
    expect(membershipFailure(e)).toEqual({ error: 'GraphConsentRequiredError', cause: 'graph_refused', consent: 1 }); // breaks if it reads as a token failure
  });

  it('an MI assertion failure is its own reason, and the underlying message is not carried', async () => {
    const net = fakeNet(() => json({ access_token: 'x', expires_in: 3599 }), () => json({ value: [] }));
    const g = graphMembershipAsApp({ cloud: 'commercial', authorityHost: AUTH, entraTenantId: TID, asClientId: AS_APP, getToken: async () => { throw new Error('IMDS said secret-ish-detail'); }, fetchImpl: net.fetchImpl });
    const e = await g.memberOf(OID, [GID]).then(() => undefined, (x: unknown) => x);
    const f = membershipFailure(e);
    expect(f).toMatchObject({ cause: 'token_acquisition', reason: 'client_assertion_failed' }); // breaks if it is classified as consent/other
    expect(JSON.stringify(f)).not.toContain('secret-ish-detail');
    expect(net.tokenCalls()).toEqual([]); // nothing is sent to Entra without an assertion
  });
});
