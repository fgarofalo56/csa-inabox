// End-to-end contract tests for the Authorization Server over real HTTP, with
// fakes only at the seams (Entra, Graph, JWKS fetch, stores, signer). Rows are
// named after the negative-scope matrix in docs/fiab/health/security.md A9.
// Every deny is paired with a permit control that differs by ONE variable.

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, type JWK } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuthenticator } from '../src/middleware/auth.js';
import { createAuthServer } from '../src/auth/server.js';
import { ASSERTION_TYPE } from '../src/auth/backend-auth.js';
import { GraphConsentRequiredError, type Federation, type GraphMembership } from '../src/auth/federation.js';
import { LocalSigner } from '../src/auth/signer.js';
import type { AuthStores } from '../src/auth/types.js';
import type { TenantDoc } from '../src/registry/types.js';
import { AUDIENCE, AUTHORITY, MemoryCollection, TENANT, adminToken, readerToken, testKeyResolver } from './helpers.js';

const ISSUER = 'https://cp.test/auth';
const fhir = (t: string) => `https://${t}.health.test/fhir`;
const USER = 'aaaaaaaa-1111-1111-1111-000000000001';
const OTHER_USER = 'aaaaaaaa-1111-1111-1111-000000000002';
const G_SMART = 'bbbbbbbb-0000-0000-0000-000000000001';
const G_READER = 'bbbbbbbb-0000-0000-0000-000000000002';
const G_ADMIN = 'bbbbbbbb-0000-0000-0000-000000000003';
const G_EXPORT = 'bbbbbbbb-0000-0000-0000-000000000004';

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
  async memberOf(oid: string, groupIds: string[]): Promise<string[]> {
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
  stores: AuthStores & { replay: MemoryCollection<never>; grants: MemoryCollection<never> };
  tenants: MemoryCollection<TenantDoc>;
  jwksFetched: string[];
  jwksByUrl: Map<string, JWK[]>;
  signer: LocalSigner;
  call(method: string, path: string, o?: { token?: string; json?: unknown; form?: Record<string, string> }): Promise<{ status: number; json: any; headers: Headers }>;
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

async function boot(): Promise<Ctx> {
  const tenants = new MemoryCollection<TenantDoc>();
  const base = { stampId: 'stamp-a', quotas: { maxRequestsPerMinute: 1, maxStorageGiB: 1 }, createdAt: 't', updatedAt: 't', updatedBy: 'x' };
  await tenants.create({ id: 'visn-01', displayName: 'V1', status: 'active', ...base });
  await tenants.create({ id: 'visn-02', displayName: 'V2', status: 'suspended', ...base });
  const stores = {
    bindings: new MemoryCollection(),
    clients: new MemoryCollection(),
    replay: new MemoryCollection(),
    grants: new MemoryCollection(),
  } as unknown as Ctx['stores'];
  const fed = new FakeFed();
  const graph = new FakeGraph();
  const signer = new LocalSigner();
  const jwksFetched: string[] = [];
  const jwksByUrl = new Map<string, JWK[]>();
  const authSrv = createAuthServer({
    issuer: ISSUER,
    cloud: 'gcc-high',
    entraTenantId: TENANT,
    stores,
    tenants,
    signer,
    federation: fed,
    graph,
    fhirBaseFor: fhir,
    authenticate: createAuthenticator({ authorityHost: AUTHORITY, entraTenantId: TENANT, audiences: [AUDIENCE], allowedCallerAppIds: [], keyResolver: testKeyResolver }),
    fetchJwks: async (u) => {
      jwksFetched.push(u);
      const keys = jwksByUrl.get(u);
      if (!keys) throw new Error('404');
      return { keys, maxAgeS: 0 };
    },
    graphConsentUrl: 'https://login.microsoftonline.us/consent',
    log: () => undefined,
  });
  const server: Server = createServer((req, res) => void authSrv.handle(req, res).then((h) => { if (!h) { res.writeHead(404); res.end(); } }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const call: Ctx['call'] = async (method, path, o = {}) => {
    const headers: Record<string, string> = {};
    if (o.token) headers.authorization = `Bearer ${o.token}`;
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
  const admin: Ctx['admin'] = async (method, path, json) => call(method, path, { token: await adminToken(), ...(json !== undefined ? { json } : {}) });

  const ctx: Ctx = {
    url, fed, graph, stores, tenants, jwksFetched, jwksByUrl, signer, call, admin,
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
      const cb = await call('GET', `/auth/callback?code=entra-code&state=${loc.searchParams.get('state')}`);
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
  it('jwks.json carries the public key only', async () => {
    const c = await boot();
    const j = (await c.call('GET', '/auth/jwks.json')).json;
    expect(j.keys).toHaveLength(1);
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
