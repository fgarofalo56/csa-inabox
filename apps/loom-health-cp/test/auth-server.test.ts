// End-to-end contract tests for the Authorization Server over real HTTP, with
// fakes only at the seams (Entra, Graph, JWKS fetch, stores, signer). Rows are
// named after the negative-scope matrix in docs/fiab/health/security.md A9.
// Every deny is paired with a permit control that differs by ONE variable.

import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, createLocalJWKSet, decodeJwt, decodeProtectedHeader, exportJWK, generateKeyPair, jwtVerify, type JWK } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuthenticator } from '../src/middleware/auth.js';
import { createAuthServer } from '../src/auth/server.js';
import { ASSERTION_TYPE } from '../src/auth/backend-auth.js';
import { GraphConsentRequiredError, createEntraFederation, type Federation, type GraphMembership } from '../src/auth/federation.js';
import { LocalRsaSigner, LocalSigner, type IdTokenSigner } from '../src/auth/signer.js';
import { createFhirUserResolver } from '../src/auth/fhir-user.js';
import type { AuthStores, FhirUserDoc, FhirUserStore } from '../src/auth/types.js';
import { PatientSearchUnavailableError, type PatientQuery, type PatientSearch, type PatientSummary } from '../src/auth/patient-search.js';
import type { TenantDoc } from '../src/registry/types.js';
import { graphMembershipAsApp } from '../src/auth/wire.js';
import { AUDIENCE, AUTHORITY, MemoryCollection, TENANT, adminToken, readerToken, testKeyResolver } from './helpers.js';

const ISSUER = 'https://cp.test/auth';
const fhir = (t: string) => `https://${t}.health.test/fhir`;
const USER = 'aaaaaaaa-1111-1111-1111-000000000001';
const OTHER_USER = 'aaaaaaaa-1111-1111-1111-000000000002';
const G_SMART = 'bbbbbbbb-0000-0000-0000-000000000001';
const G_READER = 'bbbbbbbb-0000-0000-0000-000000000002';
const G_ADMIN = 'bbbbbbbb-0000-0000-0000-000000000003';
const G_EXPORT = 'bbbbbbbb-0000-0000-0000-000000000004';

/** The fhirUser store seam: MemoryCollection plus the delete and tenant-scoped list the Cosmos store adds. */
class MemoryFhirUsers extends MemoryCollection<FhirUserDoc> implements FhirUserStore {
  async delete(id: string): Promise<boolean> {
    if (this.failWith) throw this.failWith;
    return this.docs.delete(id);
  }
  async listForTenant(tenant: string, limit: number): Promise<FhirUserDoc[]> {
    return (await this.list(10_000)).filter((d) => d.kind === 'fhiruser' && d.tenant === tenant).slice(0, limit);
  }
}

class FakeFed implements Federation {
  identity = { oid: USER, tid: TENANT };
  fail = false;
  authorizeUrl(p: { state: string }): string {
    return `https://entra.test/authorize?state=${p.state}`;
  }
  async exchange(): Promise<{ oid: string; tid: string }> {
    if (this.fail) throw new Error('boom');
    return this.identity;
  }
}
class FakeGraph implements GraphMembership {
  members = new Map<string, Set<string>>();
  consent = false;
  failWith: Error | undefined;
  async memberOf(oid: string, groupIds: string[]): Promise<string[]> {
    if (this.failWith) throw this.failWith;
    if (this.consent) throw new GraphConsentRequiredError('x');
    const m = this.members.get(oid) ?? new Set();
    return groupIds.filter((g) => m.has(g));
  }
}

const pkce = () => {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

interface Ctx {
  url: string;
  fed: FakeFed;
  graph: FakeGraph;
  stores: AuthStores & { replay: MemoryCollection<never>; grants: MemoryCollection<never>; fhirUsers: MemoryFhirUsers };
  tenants: MemoryCollection<TenantDoc>;
  jwksFetched: string[];
  jwksByUrl: Map<string, JWK[]>;
  signer: LocalSigner;
  idTokenSigner: IdTokenSigner;
  call(method: string, path: string, o?: { token?: string; json?: unknown; form?: Record<string, string>; cookie?: string }): Promise<{ status: number; json: any; headers: Headers }>;
  /** Like call, for HTML responses (the patient picker): the body as text. */
  page(method: string, path: string, o?: { form?: Record<string, string>; cookie?: string }): Promise<{ status: number; text: string; headers: Headers }>;
  admin(method: string, path: string, json?: unknown): Promise<{ status: number; json: any }>;
  registerApp(id: string, o?: { scopes?: string[]; tenant?: string }): Promise<void>;
  bind(groups: Record<string, string>, v1?: boolean, tenant?: string): Promise<void>;
  authorizeAndLogin(o: { client?: string; scope: string; launch?: string; tenant?: string; challenge?: string; method?: string }): Promise<{ redirect: URL }>;
  exchange(o: { client?: string; redirect: URL; verifier: string; tenant?: string }): Promise<{ status: number; json: any }>;
  close(): Promise<void>;
}

const open: Ctx[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function boot(over: {
  signer?: LocalSigner;
  idTokenSigner?: IdTokenSigner;
  federation?: Federation;
  log?: (event: string, f: Record<string, string | number>) => void;
  patientSearch?: PatientSearch;
  fetchFhir?: typeof fetch;
  graph?: GraphMembership;
} = {}): Promise<Ctx> {
  const tenants = new MemoryCollection<TenantDoc>();
  const base = { stampId: 'stamp-a', quotas: { maxRequestsPerMinute: 1, maxStorageGiB: 1 }, createdAt: 't', updatedAt: 't', updatedBy: 'x' };
  await tenants.create({ id: 'visn-01', displayName: 'V1', status: 'active', ...base });
  await tenants.create({ id: 'visn-02', displayName: 'V2', status: 'suspended', ...base });
  const stores = {
    bindings: new MemoryCollection(),
    clients: new MemoryCollection(),
    fhirUsers: new MemoryFhirUsers(),
    replay: new MemoryCollection(),
    grants: new MemoryCollection(),
  } as unknown as Ctx['stores'];
  const fed = new FakeFed();
  const graph = new FakeGraph();
  const signer = over.signer ?? new LocalSigner();
  const idTokenSigner = over.idTokenSigner ?? new LocalRsaSigner();
  const jwksFetched: string[] = [];
  const jwksByUrl = new Map<string, JWK[]>();
  const authSrv = createAuthServer({
    issuer: ISSUER,
    cloud: 'gcc-high',
    entraTenantId: TENANT,
    stores,
    tenants,
    signer,
    idTokenSigner,
    federation: over.federation ?? fed,
    graph: over.graph ?? graph,
    fhirBaseFor: fhir,
    // The production resolver over the fake store, exactly as wire.ts builds it (#5454 A4).
    resolveFhirUser: createFhirUserResolver(stores.fhirUsers, fhir),
    authenticate: createAuthenticator({ authorityHost: AUTHORITY, entraTenantId: TENANT, audiences: [AUDIENCE], allowedCallerAppIds: [], keyResolver: testKeyResolver }),
    fetchJwks: async (u) => {
      jwksFetched.push(u);
      const keys = jwksByUrl.get(u);
      if (!keys) throw new Error('404');
      return { keys, maxAgeS: 0 };
    },
    graphConsentUrl: 'https://login.microsoftonline.us/consent',
    log: over.log ?? (() => undefined),
    ...(over.patientSearch ? { patientSearch: over.patientSearch } : {}),
    ...(over.fetchFhir ? { fetchFhir: over.fetchFhir } : {}),
  });
  const server: Server = createServer((req, res) => void authSrv.handle(req, res).then((h) => { if (!h) { res.writeHead(404); res.end(); } }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const call: Ctx['call'] = async (method, path, o = {}) => {
    const headers: Record<string, string> = {};
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    if (o.cookie) headers.cookie = o.cookie;
    let body: string | undefined;
    if (o.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(o.json);
    } else if (o.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(o.form).toString();
    }
    const res = await fetch(url + path, { method, headers, body, redirect: 'manual' });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined, headers: res.headers };
  };
  const page: Ctx['page'] = async (method, path, o = {}) => {
    const headers: Record<string, string> = {};
    if (o.cookie) headers.cookie = o.cookie;
    let body: string | undefined;
    if (o.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(o.form).toString();
    }
    const res = await fetch(url + path, { method, headers, body, redirect: 'manual' });
    return { status: res.status, text: await res.text(), headers: res.headers };
  };
  const admin: Ctx['admin'] = async (method, path, json) => call(method, path, { token: await adminToken(), ...(json !== undefined ? { json } : {}) });

  const ctx: Ctx = {
    url, fed, graph, stores, tenants, jwksFetched, jwksByUrl, signer, idTokenSigner, call, page, admin,
    async registerApp(id, o = {}) {
      const r = await admin('POST', '/api/health/auth/clients', {
        clientId: id, tenant: o.tenant ?? 'visn-01', clientType: 'app', displayName: id,
        allowedScopes: o.scopes ?? ['user/*.cruds', 'patient/*.cruds', 'system/*.cruds'],
        redirectUris: ['https://app.test/cb'],
      });
      expect(r.status).toBe(201);
    },
    async bind(groups, v1 = false, tenant = 'visn-01') {
      const r = await admin('PUT', `/api/health/auth/tenants/${tenant}/bindings`, {
        bindings: Object.entries(groups).map(([groupId, roleId]) => ({ groupId, roleId })), v1Scopes: v1,
      });
      expect(r.status).toBe(200);
    },
    async authorizeAndLogin(o) {
      const tenant = o.tenant ?? 'visn-01';
      const q = new URLSearchParams({
        response_type: 'code', client_id: o.client ?? 'app-1', redirect_uri: 'https://app.test/cb', scope: o.scope, state: 'client-state',
        aud: fhir(tenant), code_challenge: o.challenge ?? 'x'.repeat(43), code_challenge_method: o.method ?? 'S256',
        ...(o.launch ? { launch: o.launch } : {}),
      });
      const a = await call('GET', `/auth/${tenant}/authorize?${q}`);
      expect(a.status).toBe(302);
      const loc = new URL(a.headers.get('location')!);
      if (loc.host !== 'entra.test') return { redirect: loc }; // refused before Entra (error redirect)
      const cookie = (a.headers.get('set-cookie') ?? '').split(';')[0] ?? ''; // the browser returns the binding cookie
      const cb = await call('GET', `/auth/callback?code=entra-code&state=${loc.searchParams.get('state')}`, { cookie });
      expect(cb.status).toBe(302);
      return { redirect: new URL(cb.headers.get('location')!) };
    },
    async exchange(o) {
      return call('POST', `/auth/${o.tenant ?? 'visn-01'}/token`, {
        form: { grant_type: 'authorization_code', client_id: o.client ?? 'app-1', code: o.redirect.searchParams.get('code') ?? '', redirect_uri: 'https://app.test/cb', code_verifier: o.verifier },
      });
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
  open.push(ctx);
  return ctx;
}

/** Full code flow with a real PKCE pair; returns the token response. */
async function flow(c: Ctx, scope: string, o: { launch?: string } = {}) {
  const { verifier, challenge } = pkce();
  const { redirect } = await c.authorizeAndLogin({ scope, challenge, ...(o.launch ? { launch: o.launch } : {}) });
  if (!redirect.searchParams.get('code')) return { redirect, token: undefined };
  return { redirect, verifier, token: await c.exchange({ redirect, verifier }) };
}
const claims = async (c: Ctx, jwt: string) => {
  const jwks = await (await fetch(`${c.url}/auth/jwks.json`)).json();
  return (await jwtVerify(jwt, createLocalJWKSet(jwks), { issuer: ISSUER })).payload as Record<string, any>;
};

describe('discovery and jwks', () => {
  it('smart-configuration advertises S256 only and v1 only when the tenant flag is on', async () => {
    const c = await boot();
    await c.bind({ [G_SMART]: 'fhir-smart-user' }, false);
    const off = (await c.call('GET', '/auth/visn-01/.well-known/smart-configuration')).json;
    expect(off.code_challenge_methods_supported).toEqual(['S256']); // breaks if "plain" is ever listed
    expect(off.capabilities).toContain('permission-v2');
    expect(off.capabilities).not.toContain('permission-v1');
    expect(off.token_endpoint).toBe(`${ISSUER}/visn-01/token`);
    await c.bind({ [G_SMART]: 'fhir-smart-user' }, true);
    expect((await c.call('GET', '/auth/visn-01/.well-known/smart-configuration')).json.capabilities).toContain('permission-v1');
  });
  it('a suspended tenant has no discovery document and a path outside the prefix is not handled', async () => {
    const c = await boot();
    expect((await c.call('GET', '/auth/visn-02/.well-known/smart-configuration')).status).toBe(400); // T4 at discovery
    expect((await c.call('GET', '/auth/visn-01/.well-known/smart-configuration')).status).toBe(200); // paired permit
    expect((await c.call('GET', '/api/health/stamps')).status).toBe(404); // falls through to the host app
  });
  it('root openid-configuration returns issuer + jwks_uri with no tenant lookup', async () => {
    const c = await boot();
    const r = await c.call('GET', '/auth/.well-known/openid-configuration');
    expect(r.status).toBe(200);
    // breaks if issuer or jwks_uri drift from what tokens carry / the jwks route serves
    expect(r.json.issuer).toBe(ISSUER);
    expect(r.json.jwks_uri).toBe(`${ISSUER}/jwks.json`);
    // paired: the advertised jwks_uri resolves to a key; a suspended tenant does not affect the root doc
    expect((await c.call('GET', '/auth/jwks.json')).json.keys).toHaveLength(2); // ES384 access-token key + RS256 id_token key (A7)
    expect((await c.call('GET', '/auth/visn-02/.well-known/smart-configuration')).status).toBe(400);
    expect((await c.call('POST', '/auth/.well-known/openid-configuration')).status).not.toBe(200);
  });
  it('jwks.json carries the public key only', async () => {
    const c = await boot();
    const j = (await c.call('GET', '/auth/jwks.json')).json;
    expect(j.keys).toHaveLength(2); // A7: EC + RSA; the full key-shape test is in the A7 block below
    expect(j.keys[0].d).toBeUndefined(); // breaks if the private scalar is published
    expect(j.keys[0].alg).toBe('ES384');
  });
});

describe('authorization-code flow', () => {
  it('N9 + claims contract: smart-user asking cruds is issued user/Patient.rs, signed lhds-at/1 token', async () => {
    const c = await boot();
    await c.registerApp('app-1');
    await c.bind({ [G_SMART]: 'fhir-smart-user' });
    c.graph.members.set(USER, new Set([G_SMART]));
    const { token } = await flow(c, 'openid user/Patient.cruds offline_access');
    expect(token!.status).toBe(200);
    expect(token!.json.scope).toBe('user/Patient.rs openid offline_access'); // breaks if the request is echoed unmodified
    expect(token!.json.refresh_token).toBeTruthy();
    expect(token!.json.id_token).toBeTruthy();
    const p = await claims(c, token!.json.access_token);
    expect(p).toMatchObject({
      iss: ISSUER, aud: fhir('visn-01'), tenant: 'visn-01', sub: USER, sub_type: 'user', idp_tid: TENANT,
      client_id: 'app-1', lhds_ver: 'lhds-at/1', lhds_roles: ['fhir-smart-user'], lhds_map_ver: 'lhds-scope-map/1', pou: ['TREAT'],
    });
    expect(p.scope).toBe('user/Patient.rs openid offline_access');
    expect(p.patient).toBeUndefined(); // no patient context was established
    expect(p.act === undefined && p.cnf === undefined).toBe(true);
  });

  it('N10: a tenant-admin-only user receives no data scope; adding a reader binding yields one', async () => {
    const c = await boot();
    await c.registerApp('app-1');
    c.graph.members.set(USER, new Set([G_ADMIN]));
    await c.bind({ [G_ADMIN]: 'health-tenant-admin', [G_READER]: 'fhir-data-reader' });
    const denied = await flow(c, 'user/Patient.rs');
    expect(denied.redirect.searchParams.get('error')).toBe('invalid_scope'); // breaks if admin inherits data access (D12)
    c.graph.members.set(USER, new Set([G_ADMIN, G_READER]));
    expect((await flow(c, 'user/Patient.rs')).token!.json.scope).toBe('user/Patient.rs');
  });

  it('N11: system/ asked for in the code flow is absent from the grant', async () => {
    const c = await boot();
    await c.registerApp('app-1');
    await c.bind({ [G_READER]: 'fhir-data-reader', [G_EXPORT]: 'fhir-data-exporter' });
    c.graph.members.set(USER, new Set([G_READER, G_EXPORT]));
    const t = (await flow(c, 'system/*.rs user/*.rs')).token!;
    expect(t.json.scope).toBe('user/*.rs'); // breaks if the compartment is not tied to the grant type
  });

  it('N23: PKCE is enforced (plain refused at authorize; missing or wrong verifier refused at token)', async () => {
    const c = await boot();
    await c.registerApp('app-1');
    await c.bind({ [G_READER]: 'fhir-data-reader' });
    c.graph.members.set(USER, new Set([G_READER]));
    const plain = await c.authorizeAndLogin({ scope: 'user/*.rs', method: 'plain', challenge: 'y'.repeat(43) });
    expect(plain.redirect.searchParams.get('error')).toBe('invalid_request');
    expect(plain.redirect.searchParams.get('state')).toBe('client-state');
    const { verifier, challenge } = pkce();
    const { redirect } = await c.authorizeAndLogin({ scope: 'user/*.rs', challenge });
    const wrong = await c.exchange({ redirect, verifier: pkce().verifier });
    expect(wrong.status).toBe(400);
    expect(wrong.json.error).toBe('invalid_grant');
    const { redirect: r2 } = await c.authorizeAndLogin({ scope: 'user/*.rs', challenge });
    expect((await c.exchange({ redirect: r2, verifier: '' })).json.error).toBe('invalid_grant'); // breaks if no verifier is accepted
    const { redirect: r3 } = await c.authorizeAndLogin({ scope: 'user/*.rs', challenge });
    expect((await c.exchange({ redirect: r3, verifier })).status).toBe(200); // paired S256 permit
  });

  it('an authorization code is single-use', async () => {
    const c = await boot();
    await c.registerApp('app-1');
    await c.bind({ [G_READER]: 'fhir-data-reader' });
    c.graph.members.set(USER, new Set([G_READER]));
    const { redirect, verifier, token } = await flow(c, 'user/*.rs');
    expect(token!.status).toBe(200);
    expect((await c.exchange({ redirect, verifier: verifier! })).json.error).toBe('invalid_grant'); // breaks if used codes are accepted
  });

  it('T4: an identity from another Entra tenant, or a suspended tenant, gets no code; the paired control does', async () => {
    const c = await boot();
    await c.registerApp('app-1');
    await c.bind({ [G_READER]: 'fhir-data-reader' });
    c.graph.members.set(USER, new Set([G_READER]));
    c.fed.identity = { oid: USER, tid: '99999999-9999-9999-9999-999999999999' };
    expect((await flow(c, 'user/*.rs')).redirect.searchParams.get('error')).toBe('access_denied'); // breaks if tid is unchecked
    c.fed.identity = { oid: USER, tid: TENANT };
    expect((await flow(c, 'user/*.rs')).token!.status).toBe(200);
    c.fed.fail = true;
    expect((await flow(c, 'user/*.rs')).redirect.searchParams.get('error')).toBe('access_denied'); // Entra failure fails closed
  });

  describe('Entra callback over the REAL federation (first headed SMART sign-in, 2026-11-27)', () => {
    // The production createEntraFederation.exchange at the seam, with only Entra's token endpoint faked.
    async function realFed(respond: (idToken: string, body: string) => Response, claims: Record<string, unknown>): Promise<Federation> {
      const { publicKey, privateKey } = await generateKeyPair('RS256');
      const ENTRA_CLIENT = 'cccccccc-0000-0000-0000-00000000000a';
      const idToken = await new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'k' })
        .setIssuer(`https://entra.test/${TENANT}/v2.0`)
        .setAudience(ENTRA_CLIENT)
        .setExpirationTime('5m')
        .sign(privateKey);
      return createEntraFederation({
        authorityHost: 'entra.test', entraTenantId: TENANT, clientId: ENTRA_CLIENT, getClientAssertion: async () => 'assertion-value', keyResolver: async () => publicKey,
        fetchImpl: (async (_u: string, init: RequestInit) => respond(idToken, String(init.body))) as unknown as typeof fetch,
      });
    }
    async function signIn(respond: (idToken: string, body: string) => Response, claims: (nonce: string) => Record<string, unknown>) {
      const logs: Array<{ event: string; f: Record<string, string | number> }> = [];
      // authorizeUrl on host entra.test so authorizeAndLogin follows it as it does FakeFed. The id_token is minted at
      // exchange time so it carries the nonce the AS sent to Entra, as Entra echoes it.
      const lazy: Federation = {
        authorizeUrl: (p) => `https://entra.test/${TENANT}/oauth2/v2.0/authorize?state=${p.state}`,
        exchange: async (p) => (await realFed(respond, claims(p.nonce))).exchange(p),
      };
      const c = await boot({ federation: lazy, log: (event, f) => logs.push({ event, f }) });
      await c.registerApp('app-1');
      await c.bind({ [G_READER]: 'fhir-data-reader' });
      c.graph.members.set(USER, new Set([G_READER]));
      const { redirect } = await c.authorizeAndLogin({ scope: 'user/*.rs' });
      return { redirect, logs, fed: logs.filter((l) => l.event === 'auth.federation_failed') };
    }
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

    it('an openid-only id_token (no oid) logs id_token_invalid naming oid, and the client sees only the generic access_denied', async () => {
      // Reproduces the live failure: tid + nonce, NO oid. Breaks on the old silent catch (no auth.federation_failed),
      // or if the reason loses the claim name, or if the detail leaks into the RP redirect.
      const r = await signIn((t) => json({ id_token: t }), (nonce) => ({ tid: TENANT, nonce }));
      expect(r.redirect.searchParams.get('error')).toBe('access_denied');
      expect(r.redirect.searchParams.get('error_description')).toBe('sign-in could not be completed');
      expect(r.redirect.toString()).not.toContain('oid'); // breaks if the reason class reaches the RP
      expect(r.fed.map((l) => l.f)).toEqual([{ reason: 'id_token_invalid:ERR_JWT_CLAIM_VALIDATION_FAILED:oid' }]);
    });
    it('a token-endpoint 400 invalid_grant logs the class and AADSTS number, never the body or the authorization code', async () => {
      const body = { error: 'invalid_grant', error_description: 'AADSTS70008: expired. Trace ID: trace-xyz-123', error_codes: [70008], trace_id: 'trace-xyz-123' };
      const r = await signIn(() => json(body, 400), (nonce) => ({ oid: USER, tid: TENANT, nonce }));
      expect(r.redirect.searchParams.get('error')).toBe('access_denied');
      expect(r.fed.map((l) => l.f)).toEqual([{ reason: 'token_endpoint_400', entraError: 'invalid_grant', entraErrorCode: 70008 }]); // breaks on a status-only or silent log
      const all = JSON.stringify(r.logs);
      expect(all).not.toContain('trace-xyz-123'); // breaks if the body (description / trace) is logged
      expect(all).not.toContain('entra-code'); // the authorization code authorizeAndLogin sends; breaks if it is logged
      expect(all).not.toContain('assertion-value'); // breaks if the client assertion is logged
    });
    it('happy path unchanged: an id_token WITH oid issues a code and logs no federation failure', async () => {
      // The paired control: differs from the first test by the oid claim alone.
      let tokenBody = '';
      const r = await signIn((t, b) => ((tokenBody = b), json({ id_token: t })), (nonce) => ({ oid: USER, tid: TENANT, nonce }));
      expect(r.redirect.searchParams.get('error')).toBeNull();
      expect(r.redirect.searchParams.get('code')).toMatch(/.+/); // breaks if the real federation rejects a valid id_token
      expect(r.fed).toEqual([]);
      expect(new URLSearchParams(tokenBody).get('scope')).toBe('openid profile');
    });
  });

  it('aud must be the tenant FHIR base; unknown redirect_uri is never redirected to', async () => {
    const c = await boot();
    await c.registerApp('app-1');
    const base = { response_type: 'code', client_id: 'app-1', redirect_uri: 'https://app.test/cb', scope: 'user/*.rs', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' };
    const badAud = await c.call('GET', `/auth/visn-01/authorize?${new URLSearchParams({ ...base, aud: 'https://other.test/fhir' })}`);
    expect(new URL(badAud.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');
    const badRu = await c.call('GET', `/auth/visn-01/authorize?${new URLSearchParams({ ...base, aud: fhir('visn-01'), redirect_uri: 'https://evil.test/cb' })}`);
    expect(badRu.status).toBe(400); // JSON error, no Location header
    expect(badRu.headers.get('location')).toBeNull();
  });

  it('v1 scope syntax: rewritten to v2 in the claim, echoed in the client syntax, only when the flag is on', async () => {
    const c = await boot();
    await c.registerApp('app-1');
    await c.bind({ [G_READER]: 'fhir-data-reader' }, true);
    c.graph.members.set(USER, new Set([G_READER]));
    const t = (await flow(c, 'user/Patient.read')).token!;
    expect(t.json.scope).toBe('user/Patient.read');
    expect((await claims(c, t.json.access_token)).scope).toBe('user/Patient.rs'); // claim is v2 only
    await c.bind({ [G_READER]: 'fhir-data-reader' }, false);
    expect((await flow(c, 'user/Patient.read')).redirect.searchParams.get('error')).toBe('invalid_scope');
  });
});

describe('EHR launch (N19)', () => {
  async function mint(c: Ctx, over: Record<string, unknown> = {}) {
    const r = await c.admin('POST', '/api/health/auth/launch', { tenant: 'visn-01', oid: USER, clientId: 'app-1', patient: 'pat-1', ...over });
    expect(r.status).toBe(201);
    // The launcher's `iss`: the tenant FHIR base, the same value the token audience is. Breaks if the CP omits it
    // or answers another tenant's base.
    expect(r.json.data.iss).toBe(fhir(String(over.tenant ?? 'visn-01')));
    return r.json.data.launch as string;
  }
  async function setup() {
    const c = await boot();
    await c.registerApp('app-1');
    await c.registerApp('app-2');
    await c.bind({ [G_READER]: 'fhir-data-reader' });
    c.graph.members.set(USER, new Set([G_READER]));
    c.graph.members.set(OTHER_USER, new Set([G_READER]));
    return c;
  }
  it('first use by the bound user and client yields a patient context; reuse is refused', async () => {
    const c = await setup();
    const h = await mint(c);
    const ok = (await flow(c, 'launch patient/*.rs user/*.rs', { launch: h })).token!;
    expect(ok.json.patient).toBe('pat-1');
    expect(ok.json.need_patient_banner).toBe(false);
    expect(ok.json.scope).toContain('patient/*.rs');
    const again = await flow(c, 'launch patient/*.rs', { launch: h });
    expect(again.redirect.searchParams.get('error')).toBe('access_denied'); // breaks if the handle is reusable
  });
  it('a different oid, or a different client_id, is refused', async () => {
    const c = await setup();
    c.fed.identity = { oid: OTHER_USER, tid: TENANT };
    expect((await flow(c, 'launch patient/*.rs', { launch: await mint(c) })).redirect.searchParams.get('error')).toBe('access_denied');
    c.fed.identity = { oid: USER, tid: TENANT };
    const h = await mint(c, { clientId: 'app-2' }); // bound to app-2, presented by app-1
    expect((await flow(c, 'launch patient/*.rs', { launch: h })).redirect.searchParams.get('error')).toBe('access_denied');
    expect((await flow(c, 'launch patient/*.rs', { launch: await mint(c) })).token!.status).toBe(200); // paired permit
  });
  it('a standalone patient/ request without a patient context loses every patient/ scope', async () => {
    const c = await setup();
    const t = (await flow(c, 'patient/*.rs user/*.rs')).token!;
    expect(t.json.scope).toBe('user/*.rs');
    expect(t.json.patient).toBeUndefined();
  });
  it('an EHR launch WITHOUT a patient is accepted and the token carries no patient (#5454 A6)', async () => {
    const c = await setup();
    // Breaks (400, so mint's expect(201) fails) if LaunchSchema makes `patient` required again.
    const h = await mint(c, { patient: undefined });
    const stored = [...c.stores.grants.docs.values()].find((d: any) => d.kind === 'launch') as any;
    expect('patient' in stored).toBe(false); // breaks if the doc is written with patient: undefined/null
    const t = (await flow(c, 'launch patient/*.rs user/*.rs', { launch: h })).token!;
    expect(t.status).toBe(200);
    expect(t.json.patient).toBeUndefined(); // breaks if a patient leaks in from anywhere
    expect(t.json.need_patient_banner).toBeUndefined(); // banner only when a patient exists
    expect(t.json.scope).toBe('user/*.rs launch'); // no patient => every patient/ scope dropped; user/ kept
    const claimsOf = await claims(c, t.json.access_token);
    expect(claimsOf.patient).toBeUndefined();
    // Paired control: the same flow with a patient is unchanged.
    const withP = (await flow(c, 'launch patient/*.rs user/*.rs', { launch: await mint(c) })).token!;
    expect(withP.json.patient).toBe('pat-1');
    expect(withP.json.need_patient_banner).toBe(false);
    expect(withP.json.scope).toContain('patient/*.rs');
    // An invalid patient id is still refused when one IS supplied.
    expect((await c.admin('POST', '/api/health/auth/launch', { tenant: 'visn-01', oid: USER, clientId: 'app-1', patient: 'a/b' })).status).toBe(400);
  });
});

describe('admin patient search for the console EHR launcher (#5454 A6)', () => {
  class Search implements PatientSearch {
    calls: string[] = [];
    fail = false;
    rows: PatientSummary[] = [{ id: 'pat-1', name: 'Ada Smith', birthDate: '1970-01-02' }];
    async search(tenant: string, oid: string, roles: readonly string[], q: PatientQuery): Promise<PatientSummary[]> {
      this.calls.push(`${tenant} ${oid} ${[...roles].join(',')} ${q.name} ${q.birthdate ?? '-'}`);
      if (this.fail) throw new PatientSearchUnavailableError('fhir edge unreachable');
      return this.rows.filter((r) => r.name.toLowerCase().includes(q.name.toLowerCase()));
    }
    async read(): Promise<PatientSummary | undefined> {
      return undefined;
    }
  }
  async function setup() {
    const search = new Search();
    const c = await boot({ patientSearch: search });
    await c.bind({ [G_READER]: 'fhir-data-reader' });
    c.graph.members.set(USER, new Set([G_READER]));
    return { c, search };
  }
  const path = (t = 'visn-01') => `/api/health/auth/tenants/${t}/patient-search`;

  it('searches as the named user with that user\'s roles and returns the rows', async () => {
    const { c, search } = await setup();
    const r = await c.admin('POST', path(), { oid: USER, q: 'ada', birthdate: '1970' });
    expect(r.status).toBe(200);
    expect(r.json.data).toEqual({ patients: [{ id: 'pat-1', name: 'Ada Smith', birthDate: '1970-01-02' }] });
    // Breaks if the route searches with another oid, drops the user's roles, or loses the birthdate.
    expect(search.calls).toEqual([`visn-01 ${USER} fhir-data-reader ada 1970`]);
  });
  it('an unavailable search is a 200 with {unavailable, reason} and no rows', async () => {
    const { c, search } = await setup();
    search.fail = true;
    const r = await c.admin('POST', path(), { oid: USER, q: 'ada' });
    expect(r.status).toBe(200); // breaks if the error escapes as a 500
    expect(r.json.data).toEqual({ unavailable: true, reason: 'fhir edge unreachable' });
  });
  it('a user with no role carrying user/Patient.rs is notPermitted and the FHIR search never runs', async () => {
    const { c, search } = await setup();
    c.graph.members.set(USER, new Set()); // no bound group => no role
    const r = await c.admin('POST', path(), { oid: USER, q: 'ada' });
    expect(r.json.data).toEqual({ notPermitted: true, patients: [] });
    expect(search.calls).toEqual([]); // breaks if the search runs with an empty authority
  });
  it('needs write auth, a GUID oid, a 1-100 char query, an FHIR date and an active tenant', async () => {
    const { c } = await setup();
    expect((await c.call('POST', path(), { token: await readerToken(), json: { oid: USER, q: 'ada' } })).status).toBe(403);
    expect((await c.admin('POST', path(), { oid: 'not-a-guid', q: 'ada' })).status).toBe(400);
    expect((await c.admin('POST', path(), { oid: USER, q: '   ' })).status).toBe(400);
    expect((await c.admin('POST', path(), { oid: USER, q: 'x'.repeat(101) })).status).toBe(400);
    expect((await c.admin('POST', path(), { oid: USER, q: 'ada', birthdate: '02/01/1970' })).status).toBe(400);
    expect((await c.admin('POST', path('visn-02'), { oid: USER, q: 'ada' })).status).toBe(404); // suspended tenant
    expect((await c.admin('POST', path('visn-99'), { oid: USER, q: 'ada' })).status).toBe(404);
    expect((await c.admin('POST', path(), { oid: USER, q: 'ada' })).status).toBe(200); // paired permit
  });
  it('the DEFAULT FHIR search mints a 60 s user token whose idp_tid is the CP Entra tenant', async () => {
    // An injected patientSearch bypasses token minting, so this uses createFhirPatientSearch over a fake fetch.
    const seen: Array<{ url: string; auth: string }> = [];
    const fetchFhir = (async (u: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(u), auth: String((init?.headers as Record<string, string>)?.authorization ?? '') });
      return new Response(JSON.stringify({ resourceType: 'Bundle', entry: [{ resource: { resourceType: 'Patient', id: 'pat-1', name: [{ text: 'Ada Smith' }] } }] }), { status: 200, headers: { 'content-type': 'application/fhir+json' } });
    }) as typeof fetch;
    const c = await boot({ fetchFhir });
    await c.bind({ [G_READER]: 'fhir-data-reader' });
    c.graph.members.set(USER, new Set([G_READER]));
    const r = await c.admin('POST', path(), { oid: USER, q: 'ada' });
    expect(r.json.data).toEqual({ patients: [{ id: 'pat-1', name: 'Ada Smith' }] });
    expect(seen.map((x) => x.url)).toEqual([`${fhir('visn-01')}/Patient?name=ada&_count=20`]);
    const tok = await claims(c, seen[0]!.auth.replace(/^Bearer /, ''));
    // Breaks if searchAs is handed anything but deps.entraTenantId (e.g. undefined: the claim would be absent).
    expect(tok.idp_tid).toBe(TENANT);
    expect([tok.sub, tok.sub_type, tok.scope, tok.client_id, tok.aud, tok.exp - tok.iat]).toEqual([USER, 'user', 'user/Patient.rs', 'lhds-patient-picker', fhir('visn-01'), 60]);
  });
});

describe('authorize state is bound to the browser session (#5134)', () => {
  it('a callback without the starting browser cookie is refused and does not consume the request', async () => {
    const c = await boot();
    await c.registerApp('app-1');
    await c.bind({ [G_SMART]: 'fhir-smart-user' });
    c.graph.members.set(USER, new Set([G_SMART]));
    const start = async () => {
      const q = new URLSearchParams({ response_type: 'code', client_id: 'app-1', redirect_uri: 'https://app.test/cb', scope: 'user/Patient.rs', state: 's', aud: fhir('visn-01'), code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' });
      const a = await c.call('GET', `/auth/visn-01/authorize?${q}`);
      return { state: new URL(a.headers.get('location')!).searchParams.get('state')!, setCookie: a.headers.get('set-cookie') ?? '' };
    };
    const v = await start();
    const other = await start();
    expect(v.setCookie).toContain('HttpOnly'); // breaks if the binding cookie is readable by page script
    expect(v.setCookie).toContain('SameSite=Lax');
    const cb = (cookie?: string) => c.call('GET', `/auth/callback?code=entra-code&state=${v.state}`, cookie ? { cookie } : {});
    expect((await cb()).status).toBe(400); // attacker-delivered link: no cookie
    expect((await cb(other.setCookie.split(';')[0])).status).toBe(400); // another request's cookie
    // Breaks (400 here) if a forged callback burns the pending request; also proves the genuine browser still passes.
    expect((await cb(v.setCookie.split(';')[0])).status).toBe(302);
  });
});

describe('refresh (N20)', () => {
  it('scopes shrink after a group removal and are refused when nothing remains; membership intact keeps them', async () => {
    const c = await boot();
    await c.registerApp('app-1');
    await c.bind({ [G_READER]: 'fhir-data-reader', [G_SMART]: 'fhir-smart-user' });
    c.graph.members.set(USER, new Set([G_READER]));
    const first = (await flow(c, 'user/Patient.rs offline_access')).token!;
    const refresh = (rt: string) => c.call('POST', '/auth/visn-01/token', { form: { grant_type: 'refresh_token', client_id: 'app-1', refresh_token: rt } });
    const kept = await refresh(first.json.refresh_token);
    expect(kept.status).toBe(200);
    expect(kept.json.scope).toBe('user/Patient.rs offline_access'); // paired: intact membership => same scopes
    expect(kept.json.refresh_token).not.toBe(first.json.refresh_token); // rotated
    c.graph.members.set(USER, new Set()); // removed from every bound group
    const gone = await refresh(kept.json.refresh_token);
    expect(gone.status).toBe(400); // breaks if refresh replays the stored grant without re-running the mapping (mutation arm iii)
    expect(gone.json.error).toBe('invalid_grant');
  });
  it('a Graph outage during refresh issues no token and does not burn the refresh token (#5134)', async () => {
    const c = await boot();
    await c.registerApp('app-1');
    await c.bind({ [G_READER]: 'fhir-data-reader' });
    c.graph.members.set(USER, new Set([G_READER]));
    const first = (await flow(c, 'user/Patient.rs offline_access')).token!;
    const form = { grant_type: 'refresh_token', client_id: 'app-1', refresh_token: first.json.refresh_token };
    c.graph.failWith = new Error('graph returned 503');
    const down = await c.call('POST', '/auth/visn-01/token', { form });
    expect(down.status).toBe(500);
    expect(down.json.access_token).toBeUndefined(); // breaks if a token is minted without the membership check
    c.graph.failWith = undefined;
    const retry = await c.call('POST', '/auth/visn-01/token', { form });
    // Breaks (400 invalid_grant) if the refresh token is marked used before the Graph re-check.
    expect(retry.status).toBe(200);
    expect(retry.json.access_token).toBeTruthy();
  });
  it('replaying a rotated refresh token revokes the whole chain, but an honest rotation chain keeps working (#5134)', async () => {
    const c = await boot();
    await c.registerApp('app-1');
    await c.bind({ [G_READER]: 'fhir-data-reader' });
    c.graph.members.set(USER, new Set([G_READER]));
    const refresh = (rt: string) => c.call('POST', '/auth/visn-01/token', { form: { grant_type: 'refresh_token', client_id: 'app-1', refresh_token: rt } });
    // control: two honest rotations, no replay
    const a1 = (await flow(c, 'user/Patient.rs offline_access')).token!;
    const a2 = await refresh(a1.json.refresh_token);
    const a3 = await refresh(a2.json.refresh_token);
    expect(a3.status).toBe(200);
    // attack: rt1 is stolen and replayed after the user already rotated to rt2
    const b1 = (await flow(c, 'user/Patient.rs offline_access')).token!;
    const b2 = await refresh(b1.json.refresh_token);
    expect(b2.status).toBe(200);
    expect((await refresh(b1.json.refresh_token)).json.error).toBe('invalid_grant'); // the replay itself
    const afterReplay = await refresh(b2.json.refresh_token);
    // Breaks (200) if a replay does not revoke the family: the current, unused rt2 must now be dead too.
    expect(afterReplay.status).toBe(400);
    expect(afterReplay.json.access_token).toBeUndefined();
    // the other chain is untouched by that revocation
    expect((await refresh(a3.json.refresh_token)).status).toBe(200);
  });
  it('a used refresh token cannot be replayed, and a refresh can never add scopes', async () => {
    const c = await boot();
    await c.registerApp('app-1');
    await c.bind({ [G_READER]: 'fhir-data-reader' });
    c.graph.members.set(USER, new Set([G_READER]));
    const first = (await flow(c, 'user/Patient.rs offline_access')).token!;
    const form = (scope?: string) => ({ grant_type: 'refresh_token', client_id: 'app-1', refresh_token: first.json.refresh_token, ...(scope ? { scope } : {}) });
    const widened = await c.call('POST', '/auth/visn-01/token', { form: form('user/*.cruds') });
    expect(widened.status).toBe(400); // asked for more than the original grant => nothing in common => refused
    const replay = await c.call('POST', '/auth/visn-01/token', { form: form() });
    expect(replay.json.error).toBe('invalid_grant'); // the first (refused) attempt already consumed it
  });
});

describe('Backend Services (N12, N18)', () => {
  async function backend(c: Ctx, id: string, o: { kind?: 'url' | 'value'; keys?: JWK[]; roles?: string[]; scopes?: string[] } = {}) {
    const { publicKey, privateKey } = await generateKeyPair('ES384');
    const pub = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES384' } as JWK;
    const keys = o.keys ?? [pub];
    const jwksUrl = `https://${id}.client.test/jwks.json`;
    c.jwksByUrl.set(jwksUrl, keys);
    const r = await c.admin('POST', '/api/health/auth/clients', {
      clientId: id, tenant: 'visn-01', clientType: 'backend', displayName: id,
      allowedScopes: o.scopes ?? ['system/*.rs'], roleIds: o.roles ?? ['fhir-data-exporter'],
      ...(o.kind === 'value' ? { jwks: { keys } } : { jwksUrl }),
    });
    expect(r.status).toBe(201);
    const tokenUrl = `${ISSUER}/visn-01/token`;
    const assertion = async (x: { alg?: string; signWith?: any; kid?: string; aud?: string; expIn?: number; jku?: string; jti?: string; typ?: string } = {}) =>
      new SignJWT({})
        .setProtectedHeader({ alg: x.alg ?? 'ES384', typ: x.typ ?? 'JWT', kid: x.kid ?? 'k1', ...(x.jku ? { jku: x.jku } : {}) })
        .setIssuer(id).setSubject(id).setAudience(x.aud ?? tokenUrl)
        .setJti(x.jti ?? randomBytes(8).toString('hex'))
        .setExpirationTime(Math.floor(Date.now() / 1000) + (x.expIn ?? 120))
        .sign(x.signWith ?? privateKey);
    const token = (a: string, scope = 'system/*.rs') =>
      c.call('POST', '/auth/visn-01/token', { form: { grant_type: 'client_credentials', scope, client_assertion_type: ASSERTION_TYPE, client_assertion: a } });
    return { assertion, token, privateKey, jwksUrl };
  }

  it('a well-formed assertion is issued a system token with no refresh token', async () => {
    const c = await boot();
    const b = await backend(c, 'svc-a');
    const r = await b.token(await b.assertion());
    expect(r.status).toBe(200);
    expect(r.json.scope).toBe('system/*.rs');
    expect(r.json.refresh_token).toBeUndefined(); // breaks if a refresh token is issued to a backend client
    const p = await claims(c, r.json.access_token);
    expect(p).toMatchObject({ sub_type: 'system', sub: 'svc-a', client_id: 'svc-a', tenant: 'visn-01', lhds_roles: ['fhir-data-exporter'] });
    expect(p.idp_tid).toBeUndefined();
    expect(p.exp - p.iat).toBeLessThanOrEqual(300);
  });

  it('N12: patient/ asked for by client credentials is invalid_scope; system/ is granted', async () => {
    const c = await boot();
    const b = await backend(c, 'svc-a');
    const bad = await b.token(await b.assertion(), 'patient/*.rs');
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('invalid_scope');
    expect((await b.token(await b.assertion(), 'system/*.rs')).status).toBe(200);
  });

  it('N18a: jku different from the registered URL is refused and never fetched', async () => {
    const c = await boot();
    const b = await backend(c, 'svc-a');
    const r = await b.token(await b.assertion({ jku: 'https://evil.test/jwks.json' }));
    expect([r.status, r.json.error]).toEqual([401, 'invalid_client']); // breaks if the jku comparison is removed (mutation arm ii)
    expect(c.jwksFetched).not.toContain('https://evil.test/jwks.json');
    expect((await b.token(await b.assertion({ jku: b.jwksUrl }))).status).toBe(200); // paired: jku equal to registered
  });

  it('N18b: a replayed jti is refused (second presentation of the same assertion)', async () => {
    const c = await boot();
    const b = await backend(c, 'svc-a');
    const a = await b.assertion({ jti: 'fixed-jti' });
    expect((await b.token(a)).status).toBe(200);
    expect((await b.token(a)).json.error).toBe('invalid_client'); // breaks if the jti store is not consulted
  });

  it('N18c: exp more than 300 s ahead is refused; exactly within it is accepted', async () => {
    const c = await boot();
    const b = await backend(c, 'svc-a');
    expect((await b.token(await b.assertion({ expIn: 330 }))).json.error).toBe('invalid_client'); // 300 + slack for test latency
    expect((await b.token(await b.assertion({ expIn: 290 }))).status).toBe(200);
  });

  it('N18d: alg RS256 (and none-like or unlisted algs) is refused even with a valid signature', async () => {
    const c = await boot();
    const rsa = await generateKeyPair('RS256');
    const rsaPub = { ...(await exportJWK(rsa.publicKey)), kid: 'k1', alg: 'RS256' } as JWK;
    const b = await backend(c, 'svc-a', { keys: [rsaPub] });
    expect((await b.token(await b.assertion({ alg: 'RS256', signWith: rsa.privateKey }))).json.error).toBe('invalid_client');
    // control: the same shape with RS384 and a matching RSA key is accepted
    const rsa384 = await generateKeyPair('RS384');
    const b2 = await backend(c, 'svc-b', { keys: [{ ...(await exportJWK(rsa384.publicKey)), kid: 'k1' } as JWK] });
    expect((await b2.token(await b2.assertion({ alg: 'RS384', signWith: rsa384.privateKey }))).status).toBe(200);
  });

  it('N18e: aud different from the token URL is refused', async () => {
    const c = await boot();
    const b = await backend(c, 'svc-a');
    expect((await b.token(await b.assertion({ aud: `${ISSUER}/visn-02/token` }))).json.error).toBe('invalid_client');
    expect((await b.token(await b.assertion())).status).toBe(200);
  });

  it('N18f: two keys sharing the kid are refused; a signature by an unregistered key is refused', async () => {
    const c = await boot();
    const k1 = await generateKeyPair('ES384');
    const k2 = await generateKeyPair('ES384');
    const dup = [
      { ...(await exportJWK(k1.publicKey)), kid: 'k1' } as JWK,
      { ...(await exportJWK(k2.publicKey)), kid: 'k1' } as JWK,
    ];
    const b = await backend(c, 'svc-a', { keys: dup, kind: 'value' });
    expect((await b.token(await b.assertion({ signWith: k1.privateKey }))).json.error).toBe('invalid_client'); // ambiguity refused though k1 signed
    const ok = await backend(c, 'svc-b'); // paired: one key per kid
    expect((await ok.token(await ok.assertion())).status).toBe(200);
    const stranger = await generateKeyPair('ES384');
    expect((await ok.token(await ok.assertion({ signWith: stranger.privateKey }))).json.error).toBe('invalid_client');
  });

  it('a disabled client and an unknown client are indistinguishable from a bad signature', async () => {
    const c = await boot();
    const b = await backend(c, 'svc-a');
    expect((await c.admin('PATCH', '/api/health/auth/clients/svc-a', { status: 'disabled' })).status).toBe(200);
    const r = await b.token(await b.assertion());
    expect([r.status, r.json.error]).toEqual([401, 'invalid_client']);
    const unknown = await c.call('POST', '/auth/visn-01/token', { form: { grant_type: 'client_credentials', client_assertion_type: ASSERTION_TYPE, client_assertion: 'not-a-jwt', scope: 'system/*.rs' } });
    expect([unknown.status, unknown.json.error]).toEqual([401, 'invalid_client']);
  });
});

describe('client registry, bindings and gate (admin API)', () => {
  it('requires a control-plane bearer token and write permission', async () => {
    const c = await boot();
    const body = { clientId: 'svc-x', tenant: 'visn-01', clientType: 'app', displayName: 'x', allowedScopes: ['user/*.rs'], redirectUris: ['https://app.test/cb'] };
    expect((await c.call('POST', '/api/health/auth/clients', { json: body })).status).toBe(401);
    expect((await c.call('POST', '/api/health/auth/clients', { token: await readerToken(), json: body })).status).toBe(403); // reader cannot register
    expect((await c.call('POST', '/api/health/auth/clients', { token: await adminToken(), json: body })).status).toBe(201);
  });
  it('rejects private JWK members, unknown roles, BTG, unparseable scopes, missing key source', async () => {
    const c = await boot();
    const ok = { clientId: 'svc-x', tenant: 'visn-01', clientType: 'backend', displayName: 'x', allowedScopes: ['system/*.rs'], roleIds: ['fhir-data-exporter'], jwksUrl: 'https://x.test/jwks' };
    const status = async (over: Record<string, unknown>) => (await c.admin('POST', '/api/health/auth/clients', { ...ok, ...over })).status;
    expect(await status({ jwksUrl: undefined, jwks: { keys: [{ kty: 'EC', kid: 'k', d: 'secret' }] } })).toBe(400);
    expect(await status({ roleIds: ['made-up'] })).toBe(400);
    expect(await status({ pou: 'BTG' })).toBe(400);
    expect(await status({ allowedScopes: ['system/*.sr'] })).toBe(400);
    expect(await status({ jwksUrl: 'http://x.test/jwks' })).toBe(400);
    expect(await status({ jwksUrl: undefined })).toBe(400);
    expect(await status({ tenant: 'no-such-tenant' })).toBe(404);
    expect(await status({})).toBe(201); // paired permit
    expect(await status({})).toBe(409);
  });
  it('refuses an RSA key under 2048 bits and a private/loopback jwksUrl, and accepts the paired public ones (#5134)', async () => {
    const c = await boot();
    const ok = { clientId: 'svc-r', tenant: 'visn-01', clientType: 'backend', displayName: 'x', allowedScopes: ['system/*.rs'], roleIds: ['fhir-data-exporter'] };
    const post = async (over: Record<string, unknown>) => (await c.admin('POST', '/api/health/auth/clients', { ...ok, ...over })).status;
    // node:crypto, because jose refuses to generate keys under 2048 bits
    const rsa = async (bits: number, kid: string) => ({ ...generateKeyPairSync('rsa', { modulusLength: bits }).publicKey.export({ format: 'jwk' }), kid });
    // breaks (201) if the minimum-size check is removed
    expect(await post({ jwks: { keys: [await rsa(1024, 'k1')] } })).toBe(400);
    expect(await post({ jwks: { keys: [await rsa(2048, 'k2')] } })).toBe(201); // paired: 2048 is accepted
    for (const [i, h] of ['127.0.0.1', 'localhost', '10.0.0.5', '169.254.169.254', '[::1]', '[::ffff:7f00:1]', 'intranet'].entries()) {
      // each breaks (201) if that range/name is dropped from isPrivateHost
      expect(await post({ clientId: `svc-p${i}`, jwksUrl: `https://${h}/jwks.json` }), h).toBe(400);
    }
    expect(await post({ clientId: 'svc-pub', jwksUrl: 'https://keys.client.test/jwks.json' })).toBe(201); // paired
  });
  it('lists clients without binding documents or secrets', async () => {
    const c = await boot();
    await c.registerApp('app-1');
    await c.bind({ [G_READER]: 'fhir-data-reader' });
    const l = (await c.admin('GET', '/api/health/auth/clients')).json.data.clients;
    expect(l.map((x: { clientId: string }) => x.clientId)).toEqual(['app-1']); // breaks if the shared container leaks binding docs
    expect(JSON.stringify(l)).not.toContain('_etag');
  });
  it('bindings reject unknown role ids and non-GUID groups', async () => {
    const c = await boot();
    expect((await c.admin('PUT', '/api/health/auth/tenants/visn-01/bindings', { bindings: [{ groupId: G_READER, roleId: 'nope' }], v1Scopes: false })).status).toBe(400);
    expect((await c.admin('PUT', '/api/health/auth/tenants/visn-01/bindings', { bindings: [{ groupId: 'not-a-guid', roleId: 'fhir-data-reader' }], v1Scopes: false })).status).toBe(400);
    expect((await c.admin('PUT', '/api/health/auth/tenants/visn-01/bindings', { bindings: [{ groupId: G_READER, roleId: 'fhir-data-reader' }], v1Scopes: false })).status).toBe(200);
  });
  it('readiness reports the Graph consent gate with a Fix-it, and ok once consented', async () => {
    const c = await boot();
    c.graph.consent = true;
    const gate = (await c.admin('GET', '/api/health/auth/readiness')).json.data;
    expect(gate.status).toBe('needs-consent'); // breaks if a consent failure reads as ok/empty membership
    expect(gate.fixIt).toMatchObject({ action: 'admin-consent', url: 'https://login.microsoftonline.us/consent' });
    c.graph.consent = false;
    expect((await c.admin('GET', '/api/health/auth/readiness')).json.data.status).toBe('ok');
  });
  it('a Graph consent failure during sign-in fails closed (no code, no roles assumed)', async () => {
    const c = await boot();
    await c.registerApp('app-1');
    await c.bind({ [G_READER]: 'fhir-data-reader' });
    c.graph.consent = true;
    expect((await flow(c, 'user/*.rs')).redirect.searchParams.get('error')).toBe('server_error');
  });
});

describe('Graph membership AS the AS app, through the callback (live consent:1, 2026-11-27)', () => {
  // The production graphMembershipAsApp at the seam; only Entra's token endpoint and Graph are faked.
  const AS_APP = 'cccccccc-0000-0000-0000-00000000000a';
  const TOKEN_URL = `https://entra.test/${TENANT}/oauth2/v2.0/token`;
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  async function signIn(token: () => Response, graph: () => Response) {
    const logs: Array<{ event: string; f: Record<string, string | number> }> = [];
    const graphAuth: string[] = [];
    const fetchImpl = (async (u: string, init: RequestInit) => {
      if (String(u) === TOKEN_URL) return token();
      graphAuth.push((init.headers as Record<string, string>).authorization ?? '');
      return graph();
    }) as unknown as typeof fetch;
    const membership = graphMembershipAsApp({
      cloud: 'gcc-high', authorityHost: 'entra.test', entraTenantId: TENANT, asClientId: AS_APP, getToken: async (s) => `mi-token-for:${s}`, fetchImpl,
    });
    const c = await boot({ graph: membership, log: (event, f) => logs.push({ event, f }) });
    await c.registerApp('app-1');
    await c.bind({ [G_READER]: 'fhir-data-reader' });
    const { redirect } = await c.authorizeAndLogin({ scope: 'user/*.rs' });
    return { redirect, graphAuth, logs, membership: logs.filter((l) => l.event === 'auth.membership_error').map((l) => l.f) };
  }

  it('happy path: checkMemberGroups is called with the AS-app token and a code is issued', async () => {
    const r = await signIn(() => json({ access_token: 'as-app-token', expires_in: 3599 }), () => json({ value: [G_READER] }));
    expect(r.redirect.searchParams.get('error')).toBeNull();
    expect(r.redirect.searchParams.get('code')).toMatch(/.+/); // breaks if membership fails on the AS-app path
    expect(r.graphAuth).toEqual(['Bearer as-app-token']); // breaks if Graph is called with the MI's own token
    expect(r.membership).toEqual([]);
  });
  it('a token-endpoint 400 invalid_client/700016 logs token_acquisition (not consent), with no body', async () => {
    const r = await signIn(
      () => json({ error: 'invalid_client', error_description: 'AADSTS700016 Trace ID: trace-q-1', error_codes: [700016] }, 400),
      () => json({ value: [G_READER] }),
    );
    expect(r.redirect.searchParams.get('error')).toBe('server_error');
    expect(r.graphAuth).toEqual([]); // Graph is never asked without a token
    // Breaks on the old `{error:'Error', consent:1}` shape, or on consent:1 for a token failure.
    expect(r.membership).toEqual([{ error: 'GraphTokenError', cause: 'token_acquisition', consent: 0, reason: 'token_endpoint_400', entraError: 'invalid_client', entraErrorCode: 700016 }]);
    expect(JSON.stringify(r.logs)).not.toContain('trace-q-1');
    expect(JSON.stringify(r.logs)).not.toContain('mi-token-for'); // the assertion is never logged
  });
  it('a Graph 403 with a token logs the graph_refused consent class', async () => {
    const r = await signIn(() => json({ access_token: 'as-app-token', expires_in: 3599 }), () => json({}, 403));
    expect(r.redirect.searchParams.get('error')).toBe('server_error');
    expect(r.membership).toEqual([{ error: 'GraphConsentRequiredError', cause: 'graph_refused', consent: 1 }]); // breaks if it reads as a token failure
  });

  // Readiness probes the all-zero object id: a CONSENTED app gets 404 (authorized, object absent), so 404 must read ok.
  async function readinessWith(graphStatus: number) {
    const fetchImpl = (async (u: string) =>
      String(u) === TOKEN_URL ? json({ access_token: 'as-app-token', expires_in: 3599 }) : json({ error: { code: 'x' } }, graphStatus)) as unknown as typeof fetch;
    const membership = graphMembershipAsApp({ cloud: 'gcc-high', authorityHost: 'entra.test', entraTenantId: TENANT, asClientId: AS_APP, getToken: async (s) => `mi:${s}`, fetchImpl });
    const c = await boot({ graph: membership });
    return (await c.admin('GET', '/api/health/auth/readiness')).json.data.status;
  }
  it('readiness: Graph 404 on the probe id reads ok (the permission works), 403 needs-consent, 500 unknown', async () => {
    expect(await readinessWith(404)).toBe('ok'); // breaks on the old behaviour: 404 fell through to `unknown` for ever
    expect(await readinessWith(403)).toBe('needs-consent'); // breaks if 404 handling swallows the consent gate
    expect(await readinessWith(500)).toBe('unknown'); // breaks if every non-403 failure reads ok
  });
});

describe('token endpoint 500 is diagnosable from the log (#5410)', () => {
  // Mimics @azure/core-rest-pipeline RestError: statusCode + code on an Error subclass.
  class FakeRestError extends Error {
    constructor(message: string, readonly statusCode: number, readonly code: string) {
      super(message);
      this.name = 'RestError';
    }
  }
  const SECRET_MSG = 'Forbidden: caller lacks sign permission on vault kv-secret-name';

  class ThrowingSigner extends LocalSigner {
    override async sign(): Promise<Buffer> {
      throw new FakeRestError(SECRET_MSG, 403, 'Forbidden');
    }
  }

  it('a signer whose sign() throws RestError(403) logs step=sign + statusCode=403 + code, and the response stays generic (breaks on the old name-only log, or if the message reaches the body)', async () => {
    const logs: Array<{ event: string; f: Record<string, string | number> }> = [];
    const c = await boot({ signer: new ThrowingSigner(), log: (event, f) => logs.push({ event, f }) });
    const { publicKey, privateKey } = await generateKeyPair('ES384');
    const pub = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES384' } as JWK;
    const reg = await c.admin('POST', '/api/health/auth/clients', {
      clientId: 'svc-500', tenant: 'visn-01', clientType: 'backend', displayName: 'svc-500',
      allowedScopes: ['system/*.rs'], roleIds: ['fhir-data-exporter'], jwks: { keys: [pub] },
    });
    expect(reg.status).toBe(201);
    const assertion = await new SignJWT({}).setProtectedHeader({ alg: 'ES384', typ: 'JWT', kid: 'k1' })
      .setIssuer('svc-500').setSubject('svc-500').setAudience(`${ISSUER}/visn-01/token`)
      .setJti(randomBytes(8).toString('hex')).setExpirationTime(Math.floor(Date.now() / 1000) + 120).sign(privateKey);
    const res = await c.call('POST', '/auth/visn-01/token', { form: { grant_type: 'client_credentials', scope: 'system/*.rs', client_assertion_type: ASSERTION_TYPE, client_assertion: assertion } });
    // positive: the 500 is the generic one and the log names the step and the SDK status
    expect(res.status).toBe(500);
    expect(res.json).toEqual({ error: 'server_error', error_description: 'internal error' });
    const entry = logs.find((l) => l.event === 'auth.internal_error');
    expect(entry?.f).toMatchObject({ error: 'RestError', step: 'sign', statusCode: 403, code: 'Forbidden' });
    expect(String(entry?.f.message)).toContain('Forbidden');
    // absence: the message is not in the response, and the assertion is never logged
    expect(JSON.stringify(res.json)).not.toContain('Forbidden');
    expect(JSON.stringify(logs)).not.toContain(assertion);
  });
});

// ---- W1b-3a A1 + A2 (#5454): Inferno SMART STU2.2 protocol gaps ----

/** A confidential app client (asymmetric, jwksUrl) and a signer for its RFC 7523 assertions. */
async function confidentialApp(c: Ctx, id: string) {
  const { publicKey, privateKey } = await generateKeyPair('ES384');
  const jwksUrl = `https://${id}.client.test/jwks.json`;
  c.jwksByUrl.set(jwksUrl, [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES384' } as JWK]);
  const r = await c.admin('POST', '/api/health/auth/clients', {
    clientId: id, tenant: 'visn-01', clientType: 'app', displayName: id,
    allowedScopes: ['user/*.cruds', 'patient/*.cruds'], redirectUris: ['https://app.test/cb'], jwksUrl,
  });
  expect(r.status).toBe(201);
  const assertion = (o: { iss?: string; signWith?: CryptoKey } = {}) =>
    new SignJWT({}).setProtectedHeader({ alg: 'ES384', typ: 'JWT', kid: 'k1' })
      .setIssuer(o.iss ?? id).setSubject(o.iss ?? id).setAudience(`${ISSUER}/visn-01/token`)
      .setJti(randomBytes(8).toString('hex')).setExpirationTime(Math.floor(Date.now() / 1000) + 120)
      .sign(o.signWith ?? privateKey);
  return { assertion };
}

/** Authorize + sign in as `client`; returns the code and the PKCE verifier. */
async function codeFor(c: Ctx, client: string, scope = 'user/*.rs') {
  const { verifier, challenge } = pkce();
  const { redirect } = await c.authorizeAndLogin({ client, scope, challenge });
  expect(redirect.searchParams.get('code'), `no code for ${client}: ${redirect}`).toBeTruthy();
  return { code: redirect.searchParams.get('code')!, verifier };
}

describe('client identified by its assertion iss when client_id is absent (RFC 7523 s3, #5454 A1)', () => {
  async function setup() {
    const c = await boot();
    await c.registerApp('app-1'); // public: no jwks
    await c.bind({ [G_READER]: 'fhir-data-reader' });
    c.graph.members.set(USER, new Set([G_READER]));
    return c;
  }
  const codeForm = (code: string, verifier: string, extra: Record<string, string>) => ({
    grant_type: 'authorization_code', code, redirect_uri: 'https://app.test/cb', code_verifier: verifier, ...extra,
  });

  it('a confidential client with a valid assertion and NO client_id is issued a token (code and refresh grants)', async () => {
    const c = await setup();
    const conf = await confidentialApp(c, 'conf-1');
    const { code, verifier } = await codeFor(c, 'conf-1', 'user/*.rs offline_access');
    const r = await c.call('POST', '/auth/visn-01/token', { form: codeForm(code, verifier, { client_assertion_type: ASSERTION_TYPE, client_assertion: await conf.assertion() }) });
    // Breaks (401 invalid_client) on the pre-#5454 lookup by client_id alone: the input is a form with no client_id.
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await claims(c, r.json.access_token)).client_id).toBe('conf-1');
    const rr = await c.call('POST', '/auth/visn-01/token', { form: { grant_type: 'refresh_token', refresh_token: r.json.refresh_token, client_assertion_type: ASSERTION_TYPE, client_assertion: await conf.assertion() } });
    expect(rr.status, JSON.stringify(rr.json)).toBe(200); // same fallback on the refresh grant
  });

  it('the assertion is still VERIFIED: a confidential client identified by iss but signed by a stranger key is refused', async () => {
    const c = await setup();
    const conf = await confidentialApp(c, 'conf-1');
    const { code, verifier } = await codeFor(c, 'conf-1');
    const stranger = await generateKeyPair('ES384');
    const bad = await c.call('POST', '/auth/visn-01/token', { form: codeForm(code, verifier, { client_assertion_type: ASSERTION_TYPE, client_assertion: await conf.assertion({ signWith: stranger.privateKey }) }) });
    expect([bad.status, bad.json.error]).toEqual([401, 'invalid_client']); // breaks (200) if an iss-identified client skips verification
    // Paired permit: the genuine key redeems the same (unconsumed) code.
    expect((await c.call('POST', '/auth/visn-01/token', { form: codeForm(code, verifier, { client_assertion_type: ASSERTION_TYPE, client_assertion: await conf.assertion() }) })).status).toBe(200);
  });

  it('SECURITY: a PUBLIC client named only by an unverified assertion iss is invalid_client; the same client with client_id succeeds', async () => {
    const c = await setup();
    const { code, verifier } = await codeFor(c, 'app-1');
    const forger = await generateKeyPair('ES384');
    const forged = await new SignJWT({}).setProtectedHeader({ alg: 'ES384', typ: 'JWT', kid: 'k1' })
      .setIssuer('app-1').setSubject('app-1').setAudience(`${ISSUER}/visn-01/token`).setJti('j-forged')
      .setExpirationTime(Math.floor(Date.now() / 1000) + 120).sign(forger.privateKey);
    const r = await c.call('POST', '/auth/visn-01/token', { form: codeForm(code, verifier, { client_assertion_type: ASSERTION_TYPE, client_assertion: forged }) });
    // Breaks (200) if the `!formId && !confidential` guard is removed: authenticateClient never checks a public
    // client's assertion, so the forged iss alone would redeem the code. Mutation-proven RED in the W1b-3a PR.
    expect([r.status, r.json.error]).toEqual([401, 'invalid_client']);
    expect(r.json.access_token).toBeUndefined();
    // Paired permit: the code was not consumed by the refusal, and the public client with client_id redeems it.
    const ok = await c.call('POST', '/auth/visn-01/token', { form: codeForm(code, verifier, { client_id: 'app-1' }) });
    expect(ok.status).toBe(200);
  });

  it('SECURITY: client_id different from the assertion iss is invalid_client, even when the assertion is valid', async () => {
    const c = await setup();
    const conf = await confidentialApp(c, 'conf-1');
    const { code, verifier } = await codeFor(c, 'app-1');
    // A genuine conf-1 assertion stapled to a public app-1 code: the two identities disagree.
    const r = await c.call('POST', '/auth/visn-01/token', { form: codeForm(code, verifier, { client_id: 'app-1', client_assertion_type: ASSERTION_TYPE, client_assertion: await conf.assertion() }) });
    // Breaks (200) if the client_id/iss mismatch check is removed: app-1 is public, so its client_id alone would
    // pass and the conf-1 assertion would be silently ignored. Mutation-proven RED in the W1b-3a PR.
    expect([r.status, r.json.error]).toEqual([401, 'invalid_client']);
    // Paired permit: without the disagreeing assertion, the same code redeems.
    expect((await c.call('POST', '/auth/visn-01/token', { form: codeForm(code, verifier, { client_id: 'app-1' }) })).status).toBe(200);
  });
});

describe('CORS (#5454 A1)', () => {
  it('token: ACAO * for a public client on success AND on an OAuth error; absent for a confidential client', async () => {
    const c = await boot();
    await c.registerApp('app-1');
    await c.bind({ [G_READER]: 'fhir-data-reader' });
    c.graph.members.set(USER, new Set([G_READER]));
    const pub = await flow(c, 'user/*.rs');
    expect(pub.token!.status).toBe(200);
    // Breaks (null) if the token endpoint never sets the header: Inferno cors_token_exchange fails on exactly that.
    expect(pub.token!.headers.get('access-control-allow-origin')).toBe('*');
    expect(pub.token!.headers.get('access-control-allow-credentials')).toBeNull(); // breaks if credentials are ever allowed
    const replay = await c.exchange({ redirect: pub.redirect, verifier: pub.verifier! }); // used code => invalid_grant
    expect(replay.json.error).toBe('invalid_grant');
    expect(replay.headers.get('access-control-allow-origin')).toBe('*'); // breaks if the error path drops the header
    const conf = await confidentialApp(c, 'conf-1');
    const { code, verifier } = await codeFor(c, 'conf-1');
    const r = await c.call('POST', '/auth/visn-01/token', { form: { grant_type: 'authorization_code', code, redirect_uri: 'https://app.test/cb', code_verifier: verifier, client_assertion_type: ASSERTION_TYPE, client_assertion: await conf.assertion() } });
    expect(r.status).toBe(200); // positive: the confidential exchange works ...
    expect(r.headers.get('access-control-allow-origin')).toBeNull(); // ... and breaks ('*') if CORS is applied to every client
  });

  it('discovery, jwks and both openid-configuration documents carry ACAO *, never Allow-Credentials', async () => {
    const c = await boot();
    for (const p of ['/auth/jwks.json', '/auth/.well-known/openid-configuration', '/auth/visn-01/.well-known/smart-configuration',
      '/auth/visn-01/.well-known/openid-configuration', '/visn-01/fhir/.well-known/smart-configuration']) {
      const r = await c.call('GET', p);
      expect(r.status, p).toBe(200);
      expect(r.headers.get('access-control-allow-origin'), p).toBe('*'); // breaks (null) if this route is not CORS-enabled
      expect(r.headers.get('access-control-allow-credentials'), p).toBeNull();
    }
  });

  it('OPTIONS preflight: 204 with GET on discovery and POST on token; a non-CORS AS path is not answered', async () => {
    const c = await boot();
    const d = await fetch(`${c.url}/visn-01/fhir/.well-known/smart-configuration`, { method: 'OPTIONS' });
    expect(d.status).toBe(204); // breaks (405) without the preflight branch
    expect(d.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
    expect(d.headers.get('access-control-allow-origin')).toBe('*');
    const t = await fetch(`${c.url}/auth/visn-01/token`, { method: 'OPTIONS' });
    expect(t.status).toBe(204);
    expect(t.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS'); // breaks if token advertises GET
    expect(t.headers.get('access-control-allow-credentials')).toBeNull();
    expect((await fetch(`${c.url}/auth/callback`, { method: 'OPTIONS' })).status).toBe(404); // not a CORS route: falls through
  });
});

describe('discovery documents (#5454 A1 + A2)', () => {
  it('the tenant-independent openid-configuration body is byte-identical to the #5160 contract', async () => {
    const c = await boot();
    const text = await (await fetch(`${c.url}/auth/.well-known/openid-configuration`)).text();
    // Breaks if any field is added, removed, reordered or retargeted: APIM validate-jwt reads this document.
    expect(text).toBe('{"issuer":"https://cp.test/auth","jwks_uri":"https://cp.test/auth/jwks.json"}');
  });

  it('the per-tenant openid-configuration carries the OIDC required fields with the per-tenant issuer', async () => {
    const c = await boot();
    const r = await c.call('GET', '/auth/visn-01/.well-known/openid-configuration');
    expect(r.status).toBe(200);
    // Breaks on any missing/extra field, on issuer = the tenant-independent one, or on an alg other than the signer's.
    expect(r.json).toEqual({
      issuer: `${ISSUER}/visn-01`,
      authorization_endpoint: `${ISSUER}/visn-01/authorize`,
      token_endpoint: `${ISSUER}/visn-01/token`,
      jwks_uri: `${ISSUER}/jwks.json`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'], // A7: breaks on ['ES384'] (the pre-A7 value) or an empty list
      scopes_supported: ['openid', 'fhirUser', 'launch', 'launch/patient', 'offline_access', 'patient/*.rs', 'user/*.rs', 'system/*.rs'],
      token_endpoint_auth_methods_supported: ['private_key_jwt', 'none'],
      code_challenge_methods_supported: ['S256'],
    });
    expect((await c.call('GET', '/auth/visn-02/.well-known/openid-configuration')).status).toBe(400); // suspended tenant: no issuer document (T4)
  });

  it('smart-configuration advertises `none` and the per-tenant issuer', async () => {
    const c = await boot();
    const j = (await c.call('GET', '/auth/visn-01/.well-known/smart-configuration')).json;
    expect(j.token_endpoint_auth_methods_supported).toEqual(['private_key_jwt', 'none']); // breaks if `none` is dropped
    expect(j.issuer).toBe(`${ISSUER}/visn-01`); // breaks if it stays the tenant-independent issuer
  });

  it('the FHIR-base path serves the same smart-configuration; an unknown tenant there reads like the issuer path', async () => {
    const c = await boot();
    const viaFhir = await c.call('GET', '/visn-01/fhir/.well-known/smart-configuration');
    const viaIssuer = await c.call('GET', '/auth/visn-01/.well-known/smart-configuration');
    expect(viaFhir.status).toBe(200); // breaks (404 from the test host) if the AS does not claim the FHIR-base path
    expect(viaFhir.json).toEqual(viaIssuer.json);
    expect(viaFhir.json.token_endpoint).toBe(`${ISSUER}/visn-01/token`);
    const unknownFhir = await c.call('GET', '/no-such/fhir/.well-known/smart-configuration');
    const unknownIssuer = await c.call('GET', '/auth/no-such/.well-known/smart-configuration');
    expect(unknownFhir.status).toBe(400); // breaks (200) if the FHIR-base route skips the active-tenant check
    expect([unknownFhir.status, unknownFhir.json]).toEqual([unknownIssuer.status, unknownIssuer.json]);
    // The AS owns only the discovery leaf under /{tenant}/fhir: everything else falls through to the host.
    expect((await c.call('GET', '/visn-01/fhir/metadata')).status).toBe(404);
  });

  it('id_token iss equals the per-tenant openid-configuration issuer; the access token keeps the tenant-independent iss', async () => {
    const c = await boot();
    await c.registerApp('app-1');
    await c.bind({ [G_READER]: 'fhir-data-reader' });
    c.graph.members.set(USER, new Set([G_READER]));
    const t = (await flow(c, 'openid user/*.rs')).token!;
    const oidc = (await c.call('GET', '/auth/visn-01/.well-known/openid-configuration')).json;
    const jwks = createLocalJWKSet((await c.call('GET', '/auth/jwks.json')).json);
    // Breaks (JWTClaimValidationFailed) if the id_token keeps iss = ISSUER.
    const id = (await jwtVerify(t.json.id_token, jwks, { issuer: oidc.issuer, audience: 'app-1' })).payload;
    expect(id.iss).toBe(`${ISSUER}/visn-01`);
    expect(decodeJwt(t.json.access_token).iss).toBe(ISSUER); // breaks if the access-token iss moves too (the PDP pins it)
  });
});

describe('fhirContext objects (SMART STU2.2, #5454 A1)', () => {
  async function setup() {
    const c = await boot();
    await c.registerApp('app-1');
    await c.bind({ [G_READER]: 'fhir-data-reader' });
    c.graph.members.set(USER, new Set([G_READER]));
    return c;
  }
  const launch = (c: Ctx, fhirContext: unknown) =>
    c.admin('POST', '/api/health/auth/launch', { tenant: 'visn-01', oid: USER, clientId: 'app-1', patient: 'pat-1', ...(fhirContext === undefined ? {} : { fhirContext }) });

  it('a bare string becomes {reference}; objects pass through; both are EMITTED in the token and refresh responses', async () => {
    const c = await setup();
    const obj = { canonical: 'http://example.org/Questionnaire/q1|1.0', type: 'Questionnaire', role: 'http://example.org/role/x' };
    const l = await launch(c, ['Observation/obs-1', obj]);
    expect(l.status).toBe(201);
    const t = (await flow(c, 'launch patient/*.rs offline_access', { launch: l.json.data.launch })).token!;
    expect(t.status).toBe(200);
    // Breaks if the field is not emitted (undefined: the pre-#5454 behaviour), or if the string is emitted unconverted.
    expect(t.json.fhirContext).toEqual([{ reference: 'Observation/obs-1' }, obj]);
    const rr = await c.call('POST', '/auth/visn-01/token', { form: { grant_type: 'refresh_token', client_id: 'app-1', refresh_token: t.json.refresh_token } });
    expect(rr.status).toBe(200);
    expect(rr.json.fhirContext).toEqual(t.json.fhirContext); // breaks if the refresh grant drops the context
  });

  it('a launch without fhirContext emits none; an object with none of reference/canonical/identifier is refused', async () => {
    const c = await setup();
    const l = await launch(c, undefined);
    const t = (await flow(c, 'launch patient/*.rs', { launch: l.json.data.launch })).token!;
    expect(t.status).toBe(200); // positive control for the absence below
    expect(t.json.fhirContext).toBeUndefined();
    expect((await launch(c, [{ type: 'Observation' }])).status).toBe(400); // breaks (201) without the at-least-one refine
    expect((await launch(c, [{ reference: 'x'.repeat(201) }])).status).toBe(400); // breaks if the 200-char bound is lost
    expect((await launch(c, [{ identifier: { system: '', value: 'v1' } }])).status).toBe(400); // breaks (201) without system .min(1)
    expect((await launch(c, [{ identifier: { system: 'urn:x', value: 'v1' } }])).status).toBe(201); // paired permit
    expect((await launch(c, [{ identifier: { value: 'v1' } }])).status).toBe(201); // system stays optional
  });

  it('a stored pre-STU2.2 string fhirContext is normalised to {reference} on read', async () => {
    const c = await setup();
    const l = await launch(c, ['Observation/obs-1']);
    // Rewrite the stored launch doc to the legacy string shape a pre-#5454 CP wrote.
    const doc = [...c.stores.grants.docs.values()].find((d: any) => d.kind === 'launch') as any;
    c.stores.grants.docs.set(doc.id, { ...doc, fhirContext: ['Encounter/enc-9'] } as never);
    const t = (await flow(c, 'launch patient/*.rs', { launch: l.json.data.launch })).token!;
    expect(t.json.fhirContext).toEqual([{ reference: 'Encounter/enc-9' }]); // breaks (['Encounter/enc-9']) without normalizeFhirContext
  });
});

// ---- W1b-3a A3 + A4 (#5454): fhirUser mapping, launchUri, review notes from PR 1 ----

const FU = (t: string, oid: string) => `/api/health/auth/tenants/${t}/fhir-users/${oid}`;

describe('fhirUser mapping admin API (#5454 A3)', () => {
  it('read routes need a reader, write routes need write, and no bearer is 401', async () => {
    const c = await boot();
    const body = { resource: 'Practitioner/p1' };
    // No bearer: every verb is 401 (breaks if a route skips deps.authenticate).
    expect((await c.call('PUT', FU('visn-01', USER), { json: body })).status).toBe(401);
    expect((await c.call('GET', FU('visn-01', USER))).status).toBe(401);
    expect((await c.call('DELETE', FU('visn-01', USER))).status).toBe(401);
    expect((await c.call('GET', '/api/health/auth/tenants/visn-01/fhir-users')).status).toBe(401);
    // Reader: write verbs 403 (breaks if PUT/DELETE ask for 'read'), read verbs allowed.
    const reader = await readerToken();
    expect((await c.call('PUT', FU('visn-01', USER), { token: reader, json: body })).status).toBe(403);
    expect((await c.call('DELETE', FU('visn-01', USER), { token: reader })).status).toBe(403);
    expect(c.stores.fhirUsers.docs.size).toBe(0); // the refused PUT wrote nothing
    expect((await c.admin('PUT', FU('visn-01', USER), body)).status).toBe(200); // paired: admin writes
    expect((await c.call('GET', FU('visn-01', USER), { token: reader })).status).toBe(200);
    expect((await c.call('GET', '/api/health/auth/tenants/visn-01/fhir-users', { token: reader })).status).toBe(200);
  });

  it('PUT/GET/list/DELETE round-trip; the mapping is returned as an absolute URL on the tenant FHIR base', async () => {
    const c = await boot();
    const put = await c.admin('PUT', FU('visn-01', USER.toUpperCase()), { resource: 'Practitioner/p1' });
    expect(put.status).toBe(200);
    // oid normalised to lower case (breaks if an upper-case PUT makes a key sign-in never reads)
    expect(put.json.data).toMatchObject({ tenant: 'visn-01', oid: USER, resource: 'Practitioner/p1', fhirUser: `${fhir('visn-01')}/Practitioner/p1` });
    expect(put.json.data.updatedBy).toBeTruthy();
    expect((await c.admin('PUT', FU('visn-01', USER), { resource: 'Patient/pat-9' })).json.data.resource).toBe('Patient/pat-9'); // replace
    expect((await c.admin('GET', FU('visn-01', USER))).json.data.resource).toBe('Patient/pat-9');
    await c.admin('PUT', FU('visn-01', OTHER_USER), { resource: 'RelatedPerson/r1' });
    await c.tenants.create({ id: 'visn-03', displayName: 'V3', status: 'active', stampId: 'stamp-a', quotas: { maxRequestsPerMinute: 1, maxStorageGiB: 1 }, createdAt: 't', updatedAt: 't', updatedBy: 'x' });
    await c.admin('PUT', FU('visn-03', USER), { resource: 'Person/x1' });
    const list = (await c.admin('GET', '/api/health/auth/tenants/visn-01/fhir-users')).json.data.fhirUsers;
    // breaks if the route lists another tenant (visn-03's Person/x1 appears) or drops a visn-01 row
    expect(list.map((x: { oid: string; resource: string }) => `${x.oid}=${x.resource}`).sort()).toEqual([`${USER}=Patient/pat-9`, `${OTHER_USER}=RelatedPerson/r1`].sort());
    expect(JSON.stringify(list)).not.toContain('_etag');
    const del = await c.call('DELETE', FU('visn-01', USER), { token: await adminToken() });
    expect(del.status).toBe(204);
    expect((await c.admin('GET', FU('visn-01', USER))).status).toBe(404); // breaks if DELETE is a no-op
    expect((await c.admin('GET', FU('visn-03', USER))).status).toBe(200); // paired: the other tenant's row survives
    expect((await c.call('DELETE', FU('visn-01', USER), { token: await adminToken() })).status).toBe(204); // idempotent
  });

  it('refuses a non-SMART resource type, a bad id, a non-GUID oid and an unknown tenant', async () => {
    const c = await boot();
    const put = async (t: string, oid: string, resource: unknown) => (await c.admin('PUT', FU(t, oid), { resource })).status;
    expect(await put('visn-01', USER, 'Organization/o1')).toBe(400); // breaks if any resource type is accepted
    expect(await put('visn-01', USER, 'Practitioner/a b')).toBe(400); // id outside the FHIR id rule
    expect(await put('visn-01', USER, 'Practitioner/p1/_history/2')).toBe(400);
    expect(await put('visn-01', USER, 'https://evil.test/fhir/Practitioner/p1')).toBe(400); // only a relative reference
    expect(await put('visn-01', 'not-a-guid', 'Practitioner/p1')).toBe(400);
    expect(await put('no-such', USER, 'Practitioner/p1')).toBe(404);
    expect((await c.admin('PUT', FU('visn-01', USER), { resource: 'Practitioner/p1', extra: 1 })).status).toBe(400); // strict body
    expect(c.stores.fhirUsers.docs.size).toBe(0);
    for (const r of ['Practitioner/p1', 'Patient/p1', 'RelatedPerson/p1', 'Person/p1']) expect(await put('visn-01', USER, r), r).toBe(200); // paired permits
  });
});

describe('fhirUser claim from the mapping (#5454 A4)', () => {
  async function setup() {
    const c = await boot();
    await c.registerApp('app-1');
    await c.bind({ [G_READER]: 'fhir-data-reader' });
    c.graph.members.set(USER, new Set([G_READER]));
    return c;
  }
  const SCOPE = 'openid fhirUser user/*.rs';

  it('with a mapping: fhirUser is granted and the SAME absolute URL is in the id_token and the access token; without one: neither', async () => {
    const c = await setup();
    const without = (await flow(c, SCOPE)).token!;
    expect(without.status).toBe(200);
    expect(without.json.id_token).toBeTruthy(); // positive control for the absences below
    expect(without.json.scope.split(' ')).not.toContain('fhirUser'); // breaks if fhirUser is granted with no mapping
    expect(decodeJwt(without.json.id_token).fhirUser).toBeUndefined();

    expect((await c.admin('PUT', FU('visn-01', USER), { resource: 'Practitioner/p1' })).status).toBe(200);
    const withMap = (await flow(c, SCOPE)).token!;
    expect(withMap.status).toBe(200);
    const url = `${fhir('visn-01')}/Practitioner/p1`;
    expect(withMap.json.scope.split(' ')).toContain('fhirUser'); // breaks if resolveFhirUser is not wired
    expect(decodeJwt(withMap.json.id_token).fhirUser).toBe(url); // breaks on a relative reference or another base
    expect((await claims(c, withMap.json.access_token)).fhirUser).toBe(url); // the two claims agree
  });

  it('a mapping in one tenant gives nothing in another tenant (cross-tenant)', async () => {
    const c = await setup();
    await c.tenants.create({ id: 'visn-03', displayName: 'V3', status: 'active', stampId: 'stamp-a', quotas: { maxRequestsPerMinute: 1, maxStorageGiB: 1 }, createdAt: 't', updatedAt: 't', updatedBy: 'x' });
    await c.registerApp('app-3', { tenant: 'visn-03' });
    await c.bind({ [G_READER]: 'fhir-data-reader' }, false, 'visn-03');
    await c.admin('PUT', FU('visn-01', USER), { resource: 'Practitioner/p1' });
    const run = async (client: string, tenant: string) => {
      const { verifier, challenge } = pkce();
      const { redirect } = await c.authorizeAndLogin({ client, tenant, scope: SCOPE, challenge });
      return (await c.exchange({ client, tenant, redirect, verifier })).json;
    };
    const home = await run('app-1', 'visn-01');
    expect(decodeJwt(home.id_token).fhirUser).toBe(`${fhir('visn-01')}/Practitioner/p1`); // paired permit, same user
    const away = await run('app-3', 'visn-03');
    expect(away.id_token).toBeTruthy();
    // Breaks if the mapping is looked up by oid alone: visn-03 would get `${fhir('visn-03')}/Practitioner/p1`.
    expect(decodeJwt(away.id_token).fhirUser).toBeUndefined();
    expect(away.scope.split(' ')).not.toContain('fhirUser');
  });

  it('a store failure fails the sign-in closed (server_error, no code); a request without fhirUser never consults the store', async () => {
    const logs: string[] = [];
    const c = await boot({ log: (e) => logs.push(e) });
    await c.registerApp('app-1');
    await c.bind({ [G_READER]: 'fhir-data-reader' });
    c.graph.members.set(USER, new Set([G_READER]));
    await c.admin('PUT', FU('visn-01', USER), { resource: 'Practitioner/p1' });
    c.stores.fhirUsers.failWith = new Error('cosmos down');
    const failed = await flow(c, SCOPE);
    // Breaks (a code) if the error is swallowed into a session that silently lost fhirUser.
    expect(failed.redirect.searchParams.get('error')).toBe('server_error');
    expect(failed.redirect.searchParams.get('code')).toBeNull();
    expect(failed.redirect.searchParams.get('state')).toBe('client-state'); // the app gets a proper OAuth error redirect, not a 500
    expect(logs).toContain('auth.fhir_user_error');
    const noAsk = (await flow(c, 'openid user/*.rs')).token!;
    expect(noAsk.status).toBe(200); // breaks if the resolver runs (and throws) when fhirUser was not requested
    expect(decodeJwt(noAsk.json.id_token).fhirUser).toBeUndefined();
  });

  it('a mapping is not disclosed when the app did not ask for fhirUser', async () => {
    const c = await setup();
    await c.admin('PUT', FU('visn-01', USER), { resource: 'Practitioner/p1' });
    const t = (await flow(c, 'openid user/*.rs')).token!;
    expect(t.json.id_token).toBeTruthy(); // positive control
    expect(decodeJwt(t.json.id_token).fhirUser).toBeUndefined(); // breaks if the resolver runs regardless of scope
    expect((await claims(c, t.json.access_token)).fhirUser).toBeUndefined();
  });
});

describe('client launchUri (#5454 A3)', () => {
  const app = (over: Record<string, unknown> = {}) => ({
    clientId: 'app-l', tenant: 'visn-01', clientType: 'app', displayName: 'l', allowedScopes: ['user/*.rs'], redirectUris: ['https://app.test/cb'], ...over,
  });
  const backendBody = (over: Record<string, unknown> = {}) => ({
    clientId: 'svc-l', tenant: 'visn-01', clientType: 'backend', displayName: 'b', allowedScopes: ['system/*.rs'], roleIds: ['fhir-data-exporter'], jwksUrl: 'https://x.test/jwks', ...over,
  });

  it('is validated like a redirectUri on create, refused for a backend client, and returned in the list', async () => {
    const c = await boot();
    const post = async (b: Record<string, unknown>) => (await c.admin('POST', '/api/health/auth/clients', b)).status;
    expect(await post(app({ launchUri: 'http://app.test/launch' }))).toBe(400); // breaks if plain http off loopback is accepted
    expect(await post(app({ launchUri: 'https://app.test/launch#x' }))).toBe(400); // fragment
    expect(await post(app({ launchUri: 'https://u:p@app.test/launch' }))).toBe(400); // credentials
    expect(await post(backendBody({ launchUri: 'https://app.test/launch' }))).toBe(400); // breaks if a backend client may carry one
    expect(await post(backendBody())).toBe(201); // paired: the same backend without it
    expect(await post(app({ launchUri: 'https://app.test/launch' }))).toBe(201);
    expect(await post(app({ clientId: 'app-lo', launchUri: 'http://localhost:9000/launch' }))).toBe(201); // loopback http allowed
    expect(await post(app({ clientId: 'app-none' }))).toBe(201); // optional
    const l = (await c.admin('GET', '/api/health/auth/clients')).json.data.clients as Array<{ clientId: string; launchUri?: string }>;
    const by = Object.fromEntries(l.map((x) => [x.clientId, x.launchUri]));
    expect(by).toEqual({ 'app-l': 'https://app.test/launch', 'app-lo': 'http://localhost:9000/launch', 'app-none': undefined, 'svc-l': undefined });
  });

  it('PATCH sets and clears it, keeps status behaviour, and refuses a bad URI, a backend client and an empty body', async () => {
    const c = await boot();
    expect((await c.admin('POST', '/api/health/auth/clients', app())).status).toBe(201);
    expect((await c.admin('POST', '/api/health/auth/clients', backendBody())).status).toBe(201);
    const patch = (id: string, b: unknown) => c.admin('PATCH', `/api/health/auth/clients/${id}`, b);
    const set = await patch('app-l', { launchUri: 'https://app.test/launch' });
    expect(set.status).toBe(200);
    expect(set.json.data.launchUri).toBe('https://app.test/launch');
    expect(set.json.data.status).toBe('active'); // a launchUri-only PATCH leaves status alone
    const both = await patch('app-l', { status: 'disabled', launchUri: 'https://app.test/launch2' });
    expect([both.json.data.status, both.json.data.launchUri]).toEqual(['disabled', 'https://app.test/launch2']);
    const st = await patch('app-l', { status: 'active' });
    expect(st.json.data.launchUri).toBe('https://app.test/launch2'); // a status-only PATCH keeps the launchUri
    const cleared = await patch('app-l', { launchUri: null });
    expect(cleared.status).toBe(200);
    expect('launchUri' in cleared.json.data).toBe(false); // breaks if null is ignored or stored
    expect(cleared.json.data.clientId).toBe('app-l'); // positive control for the absence
    expect((await patch('app-l', { launchUri: 'http://app.test/x' })).status).toBe(400);
    expect((await patch('app-l', { launchUri: 'https://app.test/x#f' })).status).toBe(400);
    expect((await patch('svc-l', { launchUri: 'https://app.test/launch' })).status).toBe(400); // backend refused
    expect((await patch('svc-l', { status: 'disabled' })).status).toBe(200); // paired: status still works on it
    expect((await patch('app-l', {})).status).toBe(400); // at least one member
    const bad = await patch('app-l', { status: 'gone' });
    expect([bad.status, bad.json.error.message]).toEqual([400, 'status: must be active or disabled']); // unchanged message
    expect((await patch('no-such', { status: 'active' })).status).toBe(404);
    expect((await c.call('PATCH', '/api/health/auth/clients/app-l', { token: await readerToken(), json: { launchUri: null } })).status).toBe(403);
  });
});

describe('token CORS before the client is resolved (#5454 review)', () => {
  it('no client_assertion: an invalid_client for an unknown client carries ACAO *; with an assertion it does not', async () => {
    const c = await boot();
    await c.registerApp('app-1');
    const form = { grant_type: 'authorization_code', code: 'x', redirect_uri: 'https://app.test/cb', code_verifier: 'v'.repeat(43) };
    const unknown = await c.call('POST', '/auth/visn-01/token', { form: { ...form, client_id: 'nobody' } });
    expect([unknown.status, unknown.json.error]).toEqual([401, 'invalid_client']);
    // Breaks (null) if the header is still set only after the client resolves: a browser app could not read this error.
    expect(unknown.headers.get('access-control-allow-origin')).toBe('*');
    // A public client sending client_id plus a non-JWT client_assertion is refused, and the request named an
    // assertion, so it is treated as a confidential caller: no CORS.
    const withAssertion = await c.call('POST', '/auth/visn-01/token', {
      form: { ...form, client_id: 'app-1', client_assertion_type: ASSERTION_TYPE, client_assertion: 'not-a-jwt' },
    });
    expect([withAssertion.status, withAssertion.json.error]).toEqual([401, 'invalid_client']);
    expect(withAssertion.headers.get('access-control-allow-origin')).toBeNull(); // breaks ('*') if CORS is applied to every request
  });
});

describe('standalone patient picker (#5454 A5)', () => {
  /** The PatientSearch seam: `visible` is what this user may read; search matches names case-insensitively. */
  class FakeSearch implements PatientSearch {
    visible = new Map<string, PatientSummary>();
    calls: string[] = [];
    fail = false;
    async search(tenant: string, oid: string, _roles: readonly string[], q: PatientQuery): Promise<PatientSummary[]> {
      this.calls.push(`search ${tenant} ${oid} ${q.name}`);
      if (this.fail) throw new PatientSearchUnavailableError('no response');
      return [...this.visible.values()].filter((p) => p.name.toLowerCase().includes(q.name.toLowerCase()));
    }
    async read(tenant: string, oid: string, _roles: readonly string[], id: string): Promise<PatientSummary | undefined> {
      this.calls.push(`read ${tenant} ${oid} ${id}`);
      if (this.fail) throw new PatientSearchUnavailableError('no response');
      return this.visible.get(id);
    }
  }
  const PICK_SCOPE = 'openid launch/patient patient/*.rs user/*.rs offline_access';
  const XSS_NAME = `<script>alert("x")</script> & O'Brien`;

  async function setup(o: { search?: FakeSearch; fetchFhir?: typeof fetch; log?: (event: string, f: Record<string, string | number>) => void } = {}) {
    const search = o.search ?? new FakeSearch();
    search.visible.set('pat-1', { id: 'pat-1', name: 'Ada Smith', birthDate: '1970-01-02', gender: 'female' });
    search.visible.set('pat-x', { id: 'pat-x', name: XSS_NAME });
    const c = await boot({ ...(o.fetchFhir ? { fetchFhir: o.fetchFhir } : { patientSearch: search }), ...(o.log ? { log: o.log } : {}) });
    await c.registerApp('app-1');
    await c.bind({ [G_READER]: 'fhir-data-reader' });
    c.graph.members.set(USER, new Set([G_READER]));
    return { c, search };
  }

  /** authorize + Entra callback, stopping at the callback's redirect (the picker, or the app). */
  async function signIn(c: Ctx, scope = PICK_SCOPE, extra: Record<string, string> = {}) {
    const { verifier, challenge } = pkce();
    const q = new URLSearchParams({
      response_type: 'code', client_id: 'app-1', redirect_uri: 'https://app.test/cb', scope, state: 'client-state',
      aud: fhir('visn-01'), code_challenge: challenge, code_challenge_method: 'S256', ...extra,
    });
    const a = await c.call('GET', `/auth/visn-01/authorize?${q}`);
    const arCookie = (a.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const cb = await c.page('GET', `/auth/callback?code=entra-code&state=${new URL(a.headers.get('location')!).searchParams.get('state')}`, { cookie: arCookie });
    expect(cb.status).toBe(302);
    const location = new URL(cb.headers.get('location')!);
    const setCookie = cb.headers.get('set-cookie') ?? '';
    return { verifier, location, setCookie, cookie: setCookie.split(';')[0] ?? '', req: location.searchParams.get('req') ?? '' };
  }
  const pickPath = (req: string, query = '') => `/auth/visn-01/pick?req=${req}${query}`;
  const csrfOf = (html: string): string => /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';
  const codes = (c: Ctx) => [...c.stores.grants.docs.values()].filter((d: any) => d.kind === 'code').length;
  /** Render the empty form (GET), then search as the form does: POST action=search with the page's CSRF. */
  async function searchVia(c: Ctx, s: { req: string; cookie: string }, q: string) {
    const csrf = csrfOf((await c.page('GET', pickPath(s.req), { cookie: s.cookie })).text);
    return c.page('POST', '/auth/visn-01/pick', { cookie: s.cookie, form: { req: s.req, csrf, action: 'search', q } });
  }
  const LOCKDOWN_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
  /** A page for one pick: form-action also allows the origin of the pick's stored redirect_uri (https://app.test/cb). */
  const PICK_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://app.test; frame-ancestors 'none'; base-uri 'none'";

  it('a standalone launch/patient sign-in goes to the picker with no code, and sets a path-scoped HttpOnly cookie', async () => {
    const { c } = await setup();
    const s = await signIn(c);
    // Breaks if the callback issues the code directly (pre-A5 behaviour): the location would be the app with ?code=.
    expect(`${s.location.origin}${s.location.pathname}`).toBe(`${ISSUER}/visn-01/pick`);
    expect(s.location.searchParams.get('code')).toBeNull();
    expect(s.req).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(codes(c)).toBe(0); // breaks if a code is stored before the pick
    expect(s.setCookie).toMatch(new RegExp(`^lhds_pk_${s.req}=[A-Za-z0-9_-]+;`));
    for (const attr of ['HttpOnly', 'SameSite=Lax', 'Path=/auth/visn-01/pick', 'Max-Age=600', 'Secure']) expect(s.setCookie).toContain(attr);
  });

  it('the page escapes every patient value, sends the lock-down headers, carries no script, and searched as the user', async () => {
    const { c, search } = await setup();
    const s = await signIn(c);
    const start = await c.page('GET', pickPath(s.req), { cookie: s.cookie });
    expect(start.status).toBe(200);
    expect(start.text).toContain('<label for="q">Patient name</label>');
    expect(search.calls).toEqual([]); // no query yet: nothing searched
    const r = await searchVia(c, s, 'a');
    expect(r.status).toBe(200);
    expect(search.calls).toEqual([`search visn-01 ${USER} a`]); // breaks if the search is not bound to the signed-in oid
    expect(r.text).toContain('<form method="post" action="/auth/visn-01/pick" class="search"'); // the form never GETs terms
    // Breaks if the name is interpolated raw: the literal <script> would appear.
    expect(r.text).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; O&#39;Brien');
    expect(r.text).not.toContain('<script');
    expect(r.text).toContain('value="pat-1"'); // positive: the visible patient is offered
    expect(r.text).toContain('type="radio"');
    expect(r.headers.get('content-security-policy')).toBe(PICK_CSP); // breaks ('self' only) if the redirect after a pick is blocked
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
  });

  it('search terms never travel in a URL: a GET with ?q= does not search or echo; search POST needs the cookie and CSRF', async () => {
    const { c, search } = await setup();
    const s = await signIn(c);
    const leak = 'Zebedee-1970';
    const g = await c.page('GET', pickPath(s.req, `&q=${leak}&birthdate=1970-01-02`), { cookie: s.cookie });
    expect(g.status).toBe(200);
    expect(search.calls).toEqual([]); // breaks if GET still searches: PHI in the query string reaches edge access logs
    expect(g.text).not.toContain(leak); // breaks if the query value is echoed back into the form
    expect(g.text).not.toContain('1970-01-02');
    expect(g.text).toContain('name="q" type="search" value=""'); // positive: the empty search form IS rendered
    const csrf = csrfOf(g.text);
    const form = { req: s.req, csrf, action: 'search', q: 'ada' };
    const noCookie = await c.page('POST', '/auth/visn-01/pick', { form });
    expect([noCookie.status, noCookie.text.includes('Ada Smith')]).toEqual([400, false]);
    const badCsrf = await c.page('POST', '/auth/visn-01/pick', { cookie: s.cookie, form: { ...form, csrf: 'A'.repeat(32) } });
    expect([badCsrf.status, badCsrf.text.includes('Ada Smith')]).toEqual([400, false]);
    expect(search.calls).toEqual([]); // neither refused POST reached the search
    const ok = await c.page('POST', '/auth/visn-01/pick', { cookie: s.cookie, form });
    expect(ok.status).toBe(200);
    expect(ok.text).toContain('Ada Smith'); // paired permit: same form with cookie + CSRF searches
    expect(search.calls).toEqual([`search visn-01 ${USER} ada`]);
    expect(csrfOf(ok.text)).not.toBe(csrf); // re-rendered with a fresh CSRF
  });

  it('a valid pick issues a code whose token carries the patient and KEEPS patient/ scopes; without launch/patient they are dropped', async () => {
    const { c, search } = await setup();
    const s = await signIn(c);
    const csrf = csrfOf((await searchVia(c, s, 'ada')).text);
    const post = await c.page('POST', '/auth/visn-01/pick', { cookie: s.cookie, form: { req: s.req, csrf, patient: 'pat-1', action: 'select' } });
    expect(post.status).toBe(302);
    const back = new URL(post.headers.get('location')!);
    expect(`${back.origin}${back.pathname}`).toBe('https://app.test/cb');
    expect(back.searchParams.get('state')).toBe('client-state');
    expect(search.calls).toContain(`read visn-01 ${USER} pat-1`); // the visibility re-check ran as the user
    const t = await c.exchange({ redirect: back, verifier: s.verifier });
    expect(t.status).toBe(200);
    expect(t.json.patient).toBe('pat-1');
    expect(t.json.need_patient_banner).toBe(true); // standalone: the app must show the banner
    expect(t.json.scope.split(' ')).toContain('patient/*.rs'); // breaks if the grant is not recomputed WITH the patient
    expect((await claims(c, t.json.access_token)).patient).toBe('pat-1');
    // The refresh grant keeps the patient and its scopes.
    const rt = await c.call('POST', '/auth/visn-01/token', { form: { grant_type: 'refresh_token', client_id: 'app-1', refresh_token: t.json.refresh_token } });
    expect([rt.status, rt.json.patient]).toEqual([200, 'pat-1']);
    expect(rt.json.scope.split(' ')).toContain('patient/*.rs');

    // Paired control, the pre-A5 shape: patient/ without launch/patient never reaches the picker and loses patient/.
    const plain = await signIn(c, 'patient/*.rs user/*.rs');
    expect(plain.location.searchParams.get('code')).toBeTruthy();
    const pt = await c.exchange({ redirect: plain.location, verifier: plain.verifier });
    expect(pt.json.scope).toBe('user/*.rs');
    expect(pt.json.patient).toBeUndefined();
  });

  it('refuses a missing or foreign cookie, a wrong CSRF, another tenant, an invisible patient and a dot-only id; none issues a code or burns the pick', async () => {
    const { c, search } = await setup();
    await c.tenants.create({ id: 'visn-03', displayName: 'V3', status: 'active', stampId: 'stamp-a', quotas: { maxRequestsPerMinute: 1, maxStorageGiB: 1 }, createdAt: 't', updatedAt: 't', updatedBy: 'x' });
    const s = await signIn(c);
    const other = await signIn(c); // a second pending pick in the same browser: its cookie is valid, but for ITS pick
    const csrf = csrfOf((await searchVia(c, s, 'ada')).text);
    expect(csrf).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const form = { req: s.req, csrf, patient: 'pat-1', action: 'select' };
    const post = (o: { cookie?: string; form?: Record<string, string>; path?: string }) =>
      c.page('POST', o.path ?? '/auth/visn-01/pick', { ...(o.cookie !== undefined ? { cookie: o.cookie } : {}), form: o.form ?? form });

    const noCookie = await post({});
    expect([noCookie.status, noCookie.headers.get('location')]).toEqual([400, null]); // breaks if the cookie binding is not checked
    expect(noCookie.text).toContain('This patient selection is no longer valid');
    expect(noCookie.headers.get('content-security-policy')).toBe(LOCKDOWN_CSP); // the refusal page is locked down too
    expect(noCookie.headers.get('x-frame-options')).toBe('DENY');
    expect((await post({ cookie: `lhds_pk_${s.req}=${other.cookie.split('=')[1]}` })).status).toBe(400); // another pick's secret under this name
    const badCsrf = await post({ cookie: s.cookie, form: { ...form, csrf: 'A'.repeat(32) } });
    expect([badCsrf.status, badCsrf.headers.get('location')]).toEqual([400, null]); // breaks if the CSRF value is not compared
    expect((await post({ cookie: s.cookie, form: { ...form, csrf: '' } })).status).toBe(400);
    expect((await post({ cookie: s.cookie, path: '/auth/visn-03/pick' })).status).toBe(400); // pick belongs to visn-01

    const hidden = await post({ cookie: s.cookie, form: { ...form, patient: 'pat-hidden' } });
    // Breaks (302 with a code) if the posted id is trusted without PatientSearch.read confirming this user can see it.
    expect([hidden.status, hidden.headers.get('location')]).toEqual([403, null]);
    expect(hidden.text).toContain('That patient is not available');
    const readsBefore = search.calls.filter((x) => x.startsWith('read')).length;
    for (const bad of ['..', '.', 'a b']) {
      // Dot-only ids would build Patient/.. (the FHIR base): refused before any FHIR call. Fresh CSRF per render.
      const fresh = csrfOf((await c.page('GET', pickPath(s.req), { cookie: s.cookie })).text);
      const r = await post({ cookie: s.cookie, form: { ...form, csrf: fresh, patient: bad } });
      expect([bad, r.status]).toEqual([bad, 400]);
    }
    expect(search.calls.filter((x) => x.startsWith('read')).length).toBe(readsBefore); // breaks if a dot-only id reaches read
    expect(codes(c)).toBe(0);

    // Paired permit: the same pick, right cookie + the latest CSRF + a visible patient, still succeeds (nothing above burned it).
    const latest = csrfOf((await c.page('GET', pickPath(s.req), { cookie: s.cookie })).text);
    const ok = await post({ cookie: s.cookie, form: { ...form, csrf: latest } });
    expect(ok.status).toBe(302);
    expect(new URL(ok.headers.get('location')!).searchParams.get('code')).toBeTruthy();
    expect(codes(c)).toBe(1);
    // Replay of the used pick, with every other input valid: refused, no second code.
    const replay = await post({ cookie: s.cookie, form: { ...form, csrf: latest } });
    expect([replay.status, replay.headers.get('location')]).toEqual([400, null]);
    expect(codes(c)).toBe(1);
  });

  it('an earlier page\'s CSRF value stops working once the page is rendered again', async () => {
    const { c } = await setup();
    const s = await signIn(c);
    const first = csrfOf((await c.page('GET', pickPath(s.req), { cookie: s.cookie })).text);
    const second = csrfOf((await c.page('GET', pickPath(s.req), { cookie: s.cookie })).text);
    expect(first).not.toBe(second);
    const stale = await c.page('POST', '/auth/visn-01/pick', { cookie: s.cookie, form: { req: s.req, csrf: first, patient: 'pat-1' } });
    expect(stale.status).toBe(400); // breaks if the CSRF is not rotated (or not checked)
    const fresh = await c.page('POST', '/auth/visn-01/pick', { cookie: s.cookie, form: { req: s.req, csrf: second, patient: 'pat-1' } });
    expect(fresh.status).toBe(302);
  });

  it('an expired pick is refused; the same pick before expiry renders', async () => {
    const { c } = await setup();
    const s = await signIn(c);
    expect((await c.page('GET', pickPath(s.req), { cookie: s.cookie })).status).toBe(200); // paired: live
    const doc = c.stores.grants.docs.get(s.req) as any;
    c.stores.grants.docs.set(s.req, { ...doc, expiresAt: new Date(Date.now() - 1000).toISOString() } as never);
    const r = await c.page('GET', pickPath(s.req), { cookie: s.cookie });
    expect(r.status).toBe(400); // breaks if expiresAt is not enforced in code
    expect(r.text).not.toContain('name="csrf"'); // a dead end: nothing to submit
  });

  describe('form-action covers the redirect back to the client (Chromium blocks a 302 the page CSP does not allow)', () => {
    const cspOf = (r: { headers: Headers }) => r.headers.get('content-security-policy') ?? '';
    const formAction = (csp: string) => csp.split(';').map((d) => d.trim()).filter((d) => d.startsWith('form-action'));
    /** Re-point the STORED pick at another redirect_uri, as a client registered with it would have. */
    const storeRedirect = (c: Ctx, req: string, redirectUri: string) =>
      c.stores.grants.docs.set(req, { ...(c.stores.grants.docs.get(req) as any), redirectUri } as never);

    it('the page for a pick allows exactly self + the ORIGIN of its stored redirect_uri; the request cannot choose it', async () => {
      const { c } = await setup();
      const s = await signIn(c);
      storeRedirect(c, s.req, 'https://app.example:8443/cb?x=1');
      // A redirect_uri in the request must change nothing: only the stored grant counts.
      const r = await c.page('GET', pickPath(s.req, '&redirect_uri=https%3A%2F%2Fevil.test%2Fcb'), { cookie: s.cookie });
      expect(r.status).toBe(200);
      // Breaks: 'self' only (the live defect); '*'; the full URL (path/query kept); the request's redirect_uri; the
      // authorize-time app.test origin instead of the stored one.
      expect(formAction(cspOf(r))).toEqual(["form-action 'self' https://app.example:8443"]);
      expect(cspOf(r)).not.toMatch(/evil\.test|\/cb|x=1|\*/);
      // The redirect that header allows really goes to that origin.
      const csrf = csrfOf(r.text);
      const sel = await c.page('POST', '/auth/visn-01/pick', { cookie: s.cookie, form: { req: s.req, csrf, patient: 'pat-1', action: 'select' } });
      expect(sel.status).toBe(302);
      expect(new URL(sel.headers.get('location')!).origin).toBe('https://app.example:8443');
    });

    it('every state rendered for a pick carries it: start, results, empty, invalid input, not-permitted, roles unavailable', async () => {
      const { c } = await setup();
      const s = await signIn(c);
      const seen: Array<[string, number, string[]]> = [];
      const start = await c.page('GET', pickPath(s.req), { cookie: s.cookie });
      seen.push(['start', start.status, formAction(cspOf(start))]);
      const post = (form: Record<string, string>, csrf: string) => c.page('POST', '/auth/visn-01/pick', { cookie: s.cookie, form: { req: s.req, csrf, ...form } });
      const results = await post({ action: 'search', q: 'ada' }, csrfOf(start.text));
      seen.push(['results', results.status, formAction(cspOf(results))]);
      const empty = await post({ action: 'search', q: 'nobody' }, csrfOf(results.text));
      seen.push(['empty', empty.status, formAction(cspOf(empty))]);
      const invalid = await post({ action: 'search', q: '' }, csrfOf(empty.text));
      seen.push(['invalid', invalid.status, formAction(cspOf(invalid))]);
      c.graph.members.set(USER, new Set());
      const denied = await c.page('GET', pickPath(s.req), { cookie: s.cookie });
      seen.push(['not-permitted', denied.status, formAction(cspOf(denied))]);
      c.graph.failWith = new Error('graph down');
      const noRoles = await c.page('GET', pickPath(s.req), { cookie: s.cookie });
      seen.push(['roles-unavailable', noRoles.status, formAction(cspOf(noRoles))]);
      const want = ["form-action 'self' https://app.test"];
      expect(seen).toEqual([
        ['start', 200, want], ['results', 200, want], ['empty', 200, want], ['invalid', 400, want], ['not-permitted', 403, want], ['roles-unavailable', 503, want],
      ]);
    });

    it('Cancel: the page offering it allows the redirect, and Cancel does redirect to that origin', async () => {
      const { c } = await setup();
      const s = await signIn(c);
      const pg = await c.page('GET', pickPath(s.req), { cookie: s.cookie });
      expect(pg.text).toContain('value="cancel"');
      expect(formAction(cspOf(pg))).toEqual(["form-action 'self' https://app.test"]); // breaks ('self' only) if Cancel's 302 is blocked
      const r = await c.page('POST', '/auth/visn-01/pick', { cookie: s.cookie, form: { req: s.req, csrf: csrfOf(pg.text), action: 'cancel' } });
      expect(r.status).toBe(302);
      const back = new URL(r.headers.get('location')!);
      expect([back.origin, back.searchParams.get('error')]).toEqual(['https://app.test', 'access_denied']);
    });

    it('a page with no pick context (refusal, unreadable request) keeps form-action self only', async () => {
      const { c } = await setup();
      const s = await signIn(c);
      const noCookie = await c.page('GET', pickPath(s.req));
      expect(noCookie.status).toBe(400);
      expect(cspOf(noCookie)).toBe(LOCKDOWN_CSP); // breaks if a refusal page names any client origin
      const garbled = await c.page('POST', '/auth/visn-01/pick', { cookie: s.cookie }); // no form content-type: unreadable
      expect([garbled.status, garbled.text.includes('This request could not be read')]).toEqual([400, true]);
      expect(garbled.headers.get('content-security-policy')).toBe(LOCKDOWN_CSP);
      // Paired: the same pick WITH its cookie gets the origin.
      expect(formAction(cspOf(await c.page('GET', pickPath(s.req), { cookie: s.cookie })))).toEqual(["form-action 'self' https://app.test"]);
    });

    it('a redirect_uri the validator rejects is never registered, and an unregistered one never creates a pick', async () => {
      const { c } = await setup();
      for (const bad of ['javascript:alert(1)', 'http://evil.test/cb', 'https://u:p@app.test/cb', 'https://app.test/cb#f', 'not a url']) {
        const r = await c.admin('POST', '/api/health/auth/clients', {
          clientId: 'app-bad', tenant: 'visn-01', clientType: 'app', displayName: 'bad', allowedScopes: ['patient/*.rs'], redirectUris: [bad],
        });
        expect([bad, r.status]).toEqual([bad, 400]); // breaks if the registration validator admits it
      }
      const { challenge } = pkce();
      const q = new URLSearchParams({ response_type: 'code', client_id: 'app-1', redirect_uri: 'https://evil.test/cb', scope: PICK_SCOPE, state: 's', aud: fhir('visn-01'), code_challenge: challenge, code_challenge_method: 'S256' });
      const a = await c.call('GET', `/auth/visn-01/authorize?${q}`);
      expect(a.status).toBe(400);
      expect([...c.stores.grants.docs.values()].filter((d: any) => d.kind === 'pick').length).toBe(0);
      expect((await signIn(c)).req).toMatch(/^[A-Za-z0-9_-]{32}$/); // paired: the registered one does create a pick
    });

    it('an origin the URL parser accepts but CSP cannot carry (; , quotes, *, IPv6) is refused and logged; the page keeps self only', async () => {
      const logs: Array<{ event: string; f: Record<string, string | number> }> = [];
      const { c } = await setup({ log: (event, f) => logs.push({ event, f }) });
      // new URL('https://evil;script-src/cb').origin is 'https://evil;script-src': written raw, the ';' would end
      // form-action and open an attacker-named directive. The registration validator ACCEPTS this shape today.
      const reg = await c.admin('POST', '/api/health/auth/clients', {
        clientId: 'app-semi', tenant: 'visn-01', clientType: 'app', displayName: 'semi', allowedScopes: ['patient/*.rs'], redirectUris: ['https://evil;script-src/cb'],
      });
      expect(reg.status).toBe(201);
      const s = await signIn(c);
      const crafted = ['https://evil;script-src/cb', 'https://a,b.test/cb', "https://a'b.test/cb", 'https://a"b.test/cb', 'https://*.test/cb', 'https://[::1]:8443/cb'];
      for (const uri of crafted) {
        storeRedirect(c, s.req, uri);
        const r = await c.page('GET', pickPath(s.req), { cookie: s.cookie });
        expect([uri, r.status, cspOf(r)]).toEqual([uri, 200, LOCKDOWN_CSP]); // breaks if the raw origin is emitted
      }
      const refused = () => logs.filter((l) => l.event === 'auth.pick_csp_origin_refused');
      expect(refused().map((l) => l.f.reason)).toEqual(crafted.map(() => 'not-serializable'));
      // Paired: a plain loopback origin on the same pick is emitted and nothing more is logged.
      storeRedirect(c, s.req, 'http://localhost:3000/cb');
      const ok = await c.page('GET', pickPath(s.req), { cookie: s.cookie });
      expect(formAction(cspOf(ok))).toEqual(["form-action 'self' http://localhost:3000"]);
      expect(refused().length).toBe(crafted.length);
    });
  });

  it('Cancel returns access_denied with the state, and consumes the pick', async () => {
    const { c } = await setup();
    const s = await signIn(c);
    const csrf = csrfOf((await c.page('GET', pickPath(s.req), { cookie: s.cookie })).text);
    const r = await c.page('POST', '/auth/visn-01/pick', { cookie: s.cookie, form: { req: s.req, csrf, action: 'cancel' } });
    expect(r.status).toBe(302);
    const back = new URL(r.headers.get('location')!);
    expect([back.searchParams.get('error'), back.searchParams.get('state'), back.searchParams.get('code')]).toEqual(['access_denied', 'client-state', null]);
    expect(r.headers.get('set-cookie')).toContain('Max-Age=0'); // the binding cookie is cleared
    const after = await c.page('POST', '/auth/visn-01/pick', { cookie: s.cookie, form: { req: s.req, csrf, patient: 'pat-1' } });
    expect(after.status).toBe(400); // breaks if cancel leaves the pick usable
  });

  it('FHIR unreachable: an honest unavailable page and no patients; the search used a 60 s user token for user/Patient.rs', async () => {
    const seen: Array<{ url: string; auth: string }> = [];
    const fetchFhir = (async (u: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(u), auth: String((init?.headers as Record<string, string>)?.authorization ?? '') });
      throw new TypeError('fetch failed'); // what undici throws for ECONNREFUSED / DNS failure
    }) as typeof fetch;
    const { c } = await setup({ fetchFhir });
    const s = await signIn(c);
    // The callback only admits identity.tid === entraTenantId, so in the flow the two are equal and a test could not
    // tell which one the token used. Give the stored pick a DISTINCT tid: breaks if the token takes deps.entraTenantId.
    const PICK_TID = 'cccccccc-0000-0000-0000-00000000000c';
    c.stores.grants.docs.set(s.req, { ...(c.stores.grants.docs.get(s.req) as any), idpTid: PICK_TID } as never);
    const r = await searchVia(c, s, 'smith');
    expect(r.status).toBe(503);
    expect(r.headers.get('content-security-policy')).toBe(PICK_CSP); // the 503 state (Cancel only) goes through pickHeaders too
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.text).toContain('Patient search is unavailable');
    expect(r.text).toContain('The tenant FHIR endpoint could not be searched');
    expect(r.text).not.toContain('type="radio"'); // breaks if any patient is rendered without a FHIR answer
    expect(r.text).toContain('value="cancel"'); // Cancel stays available
    expect(seen.map((x) => x.url)).toEqual([`${fhir('visn-01')}/Patient?name=smith&_count=20`]);
    const tok = await claims(c, seen[0]!.auth.replace(/^Bearer /, ''));
    expect([tok.sub, tok.sub_type, tok.scope, tok.client_id, tok.aud, tok.exp - tok.iat]).toEqual([USER, 'user', 'user/Patient.rs', 'lhds-patient-picker', fhir('visn-01'), 60]);
    expect(tok.idp_tid).toBe(PICK_TID); // the user's own tid from sign-in
    // A POST while FHIR is down issues nothing either.
    const csrf = csrfOf(r.text);
    const post = await c.page('POST', '/auth/visn-01/pick', { cookie: s.cookie, form: { req: s.req, csrf, patient: 'pat-1' } });
    expect([post.status, post.headers.get('location')]).toEqual([503, null]);
    expect(codes(c)).toBe(0);
  });

  it('a user who lost the patient-read role since sign-in sees the not-permitted state, nothing is searched, Cancel works', async () => {
    const { c, search } = await setup();
    const s = await signIn(c);
    c.graph.members.set(USER, new Set()); // membership removed between sign-in and the pick
    const r = await searchVia(c, s, 'ada');
    expect(r.status).toBe(403);
    expect(r.text).toContain('You are not permitted to search patients in this tenant');
    expect(r.text).not.toContain('name="q"'); // no search box in this state
    expect(search.calls).toEqual([]); // breaks if the role check runs after (or instead of) the search
    const post = await c.page('POST', '/auth/visn-01/pick', { cookie: s.cookie, form: { req: s.req, csrf: csrfOf(r.text), patient: 'pat-1' } });
    expect([post.status, codes(c)]).toEqual([403, 0]);
    const cancel = await c.page('POST', '/auth/visn-01/pick', { cookie: s.cookie, form: { req: s.req, csrf: csrfOf(post.text), action: 'cancel' } });
    expect(new URL(cancel.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
  });

  describe('Continue without a patient (not-permitted state only)', () => {
    const G_SP = 'bbbbbbbb-0000-0000-0000-000000000005';
    // user/SearchParameter.rs survives without user/Patient.rs: the search-parameter-manager role grants it, and
    // no other role of this user remains after the reader group is removed.
    const SCOPE = 'openid launch/patient patient/*.rs user/SearchParameter.rs offline_access';
    async function notPermitted() {
      const { c, search } = await setup();
      await c.bind({ [G_READER]: 'fhir-data-reader', [G_SP]: 'fhir-search-parameter-manager' });
      c.graph.members.set(USER, new Set([G_READER, G_SP]));
      const s = await signIn(c, SCOPE);
      expect(s.location.pathname).toBe('/auth/visn-01/pick'); // the reader role made patient/ grantable at sign-in
      return { c, search, s };
    }
    const cont = (c: Ctx, s: { req: string }, o: { cookie?: string; csrf: string }) =>
      c.page('POST', '/auth/visn-01/pick', { ...(o.cookie !== undefined ? { cookie: o.cookie } : {}), form: { req: s.req, csrf: o.csrf, action: 'continue' } });

    it('issues a code with no patient and no patient/ scope, keeping the non-patient ones; select keeps patient/', async () => {
      const { c, s } = await notPermitted();
      c.graph.members.set(USER, new Set([G_SP])); // the reader group is removed: not permitted to search
      const page = await c.page('GET', pickPath(s.req), { cookie: s.cookie });
      expect(page.status).toBe(403);
      expect(page.text).toContain('value="continue"'); // offered here
      const r = await cont(c, s, { cookie: s.cookie, csrf: csrfOf(page.text) });
      expect(r.status).toBe(302);
      const back = new URL(r.headers.get('location')!);
      expect(back.searchParams.get('state')).toBe('client-state');
      const t = await c.exchange({ redirect: back, verifier: s.verifier });
      expect(t.status).toBe(200);
      expect(t.json.patient).toBeUndefined();
      expect(t.json.need_patient_banner).toBeUndefined();
      // Breaks if continue grants patient/ (no patient context) or drops the non-patient scopes.
      expect(t.json.scope.split(' ').sort()).toEqual(['offline_access', 'openid', 'user/SearchParameter.rs']);
      expect((await claims(c, t.json.access_token)).patient).toBeUndefined();
      // Pair: the SAME request by a user who keeps the reader role, through select, keeps patient/ and the patient.
      c.graph.members.set(USER, new Set([G_READER, G_SP]));
      const s2 = await signIn(c, SCOPE);
      const csrf = csrfOf((await searchVia(c, s2, 'ada')).text);
      const sel = await c.page('POST', '/auth/visn-01/pick', { cookie: s2.cookie, form: { req: s2.req, csrf, patient: 'pat-1', action: 'select' } });
      const t2 = await c.exchange({ redirect: new URL(sel.headers.get('location')!), verifier: s2.verifier });
      expect(t2.json.patient).toBe('pat-1');
      expect(t2.json.scope.split(' ')).toContain('patient/*.rs');
    });

    it('a continue without the cookie or with a bad CSRF is refused; the pick survives for the genuine one', async () => {
      const { c, s } = await notPermitted();
      c.graph.members.set(USER, new Set([G_SP]));
      const csrf = csrfOf((await c.page('GET', pickPath(s.req), { cookie: s.cookie })).text);
      const noCookie = await cont(c, s, { csrf });
      expect([noCookie.status, noCookie.headers.get('location')]).toEqual([400, null]);
      const badCsrf = await cont(c, s, { cookie: s.cookie, csrf: 'A'.repeat(32) });
      expect([badCsrf.status, badCsrf.headers.get('location')]).toEqual([400, null]);
      expect(codes(c)).toBe(0);
      expect((await cont(c, s, { cookie: s.cookie, csrf })).status).toBe(302); // paired permit
      expect(codes(c)).toBe(1);
      expect((await cont(c, s, { cookie: s.cookie, csrf })).status).toBe(400); // single use
    });

    it('a forged continue from a user who MAY search is refused and issues nothing; the button is not offered there', async () => {
      const { c, s } = await notPermitted(); // still holds the reader role
      const page = await c.page('GET', pickPath(s.req), { cookie: s.cookie });
      expect(page.status).toBe(200);
      expect(page.text).not.toContain('value="continue"'); // not on the search page
      const r = await cont(c, s, { cookie: s.cookie, csrf: csrfOf(page.text) });
      // Breaks (302 with a code) if continue works without the not-permitted guard: a patient/ app would be
      // handed a session the user skipped choosing a patient for.
      expect([r.status, r.headers.get('location'), codes(c)]).toEqual([400, null, 0]);
      expect(r.text).toContain('Choose a patient');
      const sel = await c.page('POST', '/auth/visn-01/pick', { cookie: s.cookie, form: { req: s.req, csrf: csrfOf(r.text), patient: 'pat-1' } });
      expect(sel.status).toBe(302); // the refused continue did not burn the pick
    });

    it('the 503 unavailable page does not offer continue', async () => {
      const fetchFhir = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
      const { c } = await setup({ fetchFhir });
      const s = await signIn(c);
      const r = await searchVia(c, s, 'smith');
      expect(r.status).toBe(503);
      expect(r.text).toContain('value="cancel"'); // positive: the actions row rendered
      expect(r.text).not.toContain('value="continue"');
    });
  });

  it('no picker when nothing patient-level would be granted, or on an EHR launch', async () => {
    const { c } = await setup();
    // launch/patient but only user/ scopes: issued directly (breaks if every launch/patient goes to the picker).
    const noPatientScope = await signIn(c, 'launch/patient user/*.rs');
    expect(noPatientScope.location.searchParams.get('code')).toBeTruthy();
    // A client that may not receive patient/ scopes: also direct.
    await c.registerApp('app-u', { scopes: ['user/*.rs'] });
    const { challenge } = pkce();
    const q = new URLSearchParams({ response_type: 'code', client_id: 'app-u', redirect_uri: 'https://app.test/cb', scope: PICK_SCOPE, state: 's', aud: fhir('visn-01'), code_challenge: challenge, code_challenge_method: 'S256' });
    const a = await c.call('GET', `/auth/visn-01/authorize?${q}`);
    const cb = await c.page('GET', `/auth/callback?code=e&state=${new URL(a.headers.get('location')!).searchParams.get('state')}`, { cookie: (a.headers.get('set-cookie') ?? '').split(';')[0] ?? '' });
    expect(new URL(cb.headers.get('location')!).searchParams.get('code')).toBeTruthy();
    // EHR launch carrying launch/patient: the handle supplies the patient, no picker.
    const h = (await c.admin('POST', '/api/health/auth/launch', { tenant: 'visn-01', oid: USER, clientId: 'app-1', patient: 'pat-1' })).json.data.launch as string;
    const ehr = await signIn(c, `launch ${PICK_SCOPE}`, { launch: h });
    expect(ehr.location.pathname).toBe('/cb');
    const t = await c.exchange({ redirect: ehr.location, verifier: ehr.verifier });
    expect([t.json.patient, t.json.need_patient_banner]).toEqual(['pat-1', false]);
  });

  it('dot-only ids are refused in the fhirUser mapping and the launch patient; a dotted id is accepted (PR2 review)', async () => {
    const { c } = await setup();
    const put = async (resource: string) => (await c.admin('PUT', FU('visn-01', USER), { resource })).status;
    expect(await put('Patient/..')).toBe(400); // breaks on the PR2 regex, which accepted it
    expect(await put('Practitioner/.')).toBe(400);
    expect(await put('Patient/a.b')).toBe(200); // paired: dots inside an id stay legal
    const launch = async (patient: string) => (await c.admin('POST', '/api/health/auth/launch', { tenant: 'visn-01', oid: USER, clientId: 'app-1', patient })).status;
    expect(await launch('..')).toBe(400);
    expect(await launch('pat.1')).toBe(201);
  });
});

// ---- W1b-3a A7 (#5454): RS256 id_tokens, ES384 access tokens, one JWKS with both keys ----
describe('RS256 id_tokens (#5454 A7)', () => {
  async function signedIn(over: Parameters<typeof boot>[0] = {}) {
    const c = await boot(over);
    await c.registerApp('app-1');
    await c.bind({ [G_READER]: 'fhir-data-reader' });
    c.graph.members.set(USER, new Set([G_READER]));
    return c;
  }
  const PRIVATE = ['d', 'p', 'q', 'dp', 'dq', 'qi'];

  it('the id_token is RS256, its kid is in the published JWKS, and it verifies against that JWKS', async () => {
    const c = await signedIn();
    const t = (await flow(c, 'openid user/*.rs')).token!;
    expect(t.status).toBe(200);
    const jwks = (await c.call('GET', '/auth/jwks.json')).json as { keys: JWK[] };
    const header = decodeProtectedHeader(t.json.id_token);
    // Breaks on an ES384-signed id_token (the pre-A7 signer, or a fallback to the access-token key).
    expect(header.alg).toBe('RS256');
    // Breaks if the id_token kid is absent from the JWKS a relying party fetches.
    expect(jwks.keys.map((k) => k.kid)).toContain(header.kid);
    // Real verification, restricted to RS256: breaks on an ES384 id_token, a kid missing from the JWKS, or a
    // signature that is not RSASSA-PKCS1-v1_5/SHA-256 over the signing input.
    const { payload, protectedHeader } = await jwtVerify(t.json.id_token, createLocalJWKSet(jwks), {
      algorithms: ['RS256'], issuer: `${ISSUER}/visn-01`, audience: 'app-1',
    });
    expect(protectedHeader.kid).toBe(await c.idTokenSigner.kid());
    expect(payload.sub).toBe(USER);
  });

  it('the access token stays ES384 and verifies against the EC JWK alone', async () => {
    const c = await signedIn();
    const t = (await flow(c, 'openid user/*.rs')).token!;
    const jwks = (await c.call('GET', '/auth/jwks.json')).json as { keys: JWK[] };
    const ec = jwks.keys.filter((k) => k.kty === 'EC');
    expect(ec).toHaveLength(1);
    // Breaks if the access token moves to RS256 (the PDP and APIM pin ES384), or is signed by the RSA key.
    expect(decodeProtectedHeader(t.json.access_token).alg).toBe('ES384');
    await expect(jwtVerify(t.json.access_token, createLocalJWKSet({ keys: ec }), { algorithms: ['ES384'], issuer: ISSUER })).resolves.toBeTruthy();
  });

  it('the JWKS publishes exactly the EC (ES384) and RSA (RS256) keys, public members only', async () => {
    const c = await boot();
    const { keys } = (await c.call('GET', '/auth/jwks.json')).json as { keys: JWK[] };
    // Breaks if the RSA key is missing (one key, the pre-A7 JWKS), or if a key is published twice.
    expect(keys).toHaveLength(2);
    const ec = keys.find((k) => k.kty === 'EC')!;
    const rsa = keys.find((k) => k.kty === 'RSA')!;
    // Positive: each key carries its public material, alg and use; breaks if either key is absent or mislabelled.
    expect([ec.alg, ec.crv, typeof ec.x, typeof ec.y, ec.use]).toEqual(['ES384', 'P-384', 'string', 'string', 'sig']);
    expect([rsa.alg, typeof rsa.n, rsa.e, rsa.use]).toEqual(['RS256', 'string', 'AQAB', 'sig']);
    expect(ec.kid).not.toBe(rsa.kid); // breaks if both keys share one kid
    // Absence, paired with the positives above: breaks if any private member reaches the public document.
    for (const k of keys) for (const m of PRIVATE) expect(m in k, `${k.kty}.${m}`).toBe(false);
  });

  it('an unavailable id_token key fails the openid token request with step=id_token and never falls back to ES384; the JWKS keeps the EC key', async () => {
    class DeniedRsa extends LocalRsaSigner {
      override async kid(): Promise<string> {
        throw Object.assign(new Error('key vault returned 403 creating id_token key lhds-as-idtoken-rs256'), { statusCode: 403 });
      }
      override async publicJwks(): Promise<JWK[]> {
        throw Object.assign(new Error('key vault returned 403 creating id_token key lhds-as-idtoken-rs256'), { statusCode: 403 });
      }
    }
    const logs: Array<{ event: string; f: Record<string, string | number> }> = [];
    const c = await signedIn({ idTokenSigner: new DeniedRsa(), log: (event, f) => logs.push({ event, f }) });
    const withOpenid = (await flow(c, 'openid user/*.rs')).token!;
    // Breaks (200 with an ES384 id_token) if the server falls back to the access-token signer.
    expect(withOpenid.status).toBe(500);
    expect(withOpenid.json.id_token).toBeUndefined();
    expect(logs.find((l) => l.event === 'auth.internal_error')?.f).toMatchObject({ step: 'id_token', statusCode: 403 });
    // Paired permit: without `openid` the same server still issues an access token.
    const noOpenid = (await flow(c, 'user/*.rs')).token!;
    expect(noOpenid.status).toBe(200);
    const { keys } = (await c.call('GET', '/auth/jwks.json')).json as { keys: JWK[] };
    // Breaks (500 or no keys) if an id_token key failure takes the access-token key out of the JWKS.
    expect(keys.map((k) => k.kty)).toEqual(['EC']);
    expect(logs.some((l) => l.event === 'auth.idtoken_key_unavailable' && l.f.statusCode === 403)).toBe(true);
  });
});
