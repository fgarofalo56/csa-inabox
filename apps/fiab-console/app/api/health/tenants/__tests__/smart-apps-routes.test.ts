/**
 * /api/health/tenants/[id]/apps/** - SMART apps + EHR launcher BFF (#5454 A6).
 *
 * The REAL health.tenant-admin gate runs; the grants store, the item store and
 * the control-plane client methods are faked. Each load-bearing assertion names
 * the value that breaks it. Mutation receipts for the oid test are in the PR.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { selfSignedCertB64 } from '@/lib/health/__tests__/self-signed-cert';

const grants = vi.hoisted(() => ({ rows: [] as any[] }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(),
  featurePermissionsContainer: async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: grants.rows }) }) },
  }),
}));
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: class {},
  ManagedIdentityCredential: class {},
  ChainedTokenCredential: class {},
}));
vi.mock('@/lib/azure/aca-managed-identity', () => ({ AcaManagedIdentityCredential: class {} }));
vi.mock('@/lib/auth/session', async (orig) => ({ ...(await orig<typeof import('@/lib/auth/session')>()), getSession: vi.fn() }));

const loadOwnedItem = vi.hoisted(() => vi.fn(async (..._a: any[]) => null as any));
vi.mock('@/app/api/items/_lib/item-crud', () => ({ loadOwnedItem: (...a: any[]) => loadOwnedItem(...a) }));

import { getSession } from '@/lib/auth/session';
import { cp, CpError, type CpSmartClient } from '../_lib/cp-client';
import { CLIENT_ID, SMART_SCOPE_CHOICES, buildLaunchUrl, generateClientId, parseRegister } from '../_lib/smart-apps';
import { GET as listApps, POST as registerApp } from '../[id]/apps/route';
import { PATCH as patchApp } from '../[id]/apps/[clientId]/route';
import { POST as launchApp } from '../[id]/apps/[clientId]/launch/route';
import { POST as searchPatients } from '../[id]/apps/patient-search/route';

const SESSION_OID = '11111111-2222-3333-4444-555555555555';
const FORGED_OID = '99999999-8888-7777-6666-555555555555';
const SESSION = { claims: { oid: SESSION_OID, tid: 'tid-1', upn: 'a@b.c', groups: [] } };
const FHIR_BASE = 'https://lhds-edge.example/mercy-general/fhir';
const BINDING = { tenantId: 'mercy-general', sourceName: 'Mercy General', tenantIdSanitized: false, stampId: 'dev01', status: 'bound', resources: [] };
const req = (body?: unknown) => ({ nextUrl: { pathname: '/api/health/tenants/item-1/apps' }, json: async () => body ?? {} }) as any;
const ctx = (p: Record<string, string> = {}) => ({ params: Promise.resolve({ id: 'item-1', ...p }) }) as any;
const grant = (role: string) => [{ capabilityId: 'health.tenant-admin', principalId: SESSION_OID, role, tenantId: 'tid-1' }];

// Keys generated at test time: no key material is committed. RSA_PRIV is a full private JWK (d, p, q, dp, dq, qi).
const RSA_KP = generateKeyPairSync('rsa', { modulusLength: 2048 });
const RSA_PUB: Record<string, unknown> = { ...(RSA_KP.publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'rsa-1', alg: 'RS384' };
const RSA_PRIV = { ...(RSA_KP.privateKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'rsa-1', alg: 'RS384' };
const EC_PUB: Record<string, unknown> = { ...(generateKeyPairSync('ec', { namedCurve: 'P-384' }).publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'ec-1', alg: 'ES384' };

const client = (over: Partial<CpSmartClient> = {}): CpSmartClient => ({
  clientId: 'growth-chart', tenant: 'mercy-general', clientType: 'app', displayName: 'Growth Chart', status: 'active',
  allowedScopes: ['patient/*.rs'], roleIds: [], redirectUris: ['https://app.example/cb'], launchUri: 'https://app.example/launch', ...over,
});

beforeEach(() => {
  vi.mocked(getSession).mockReturnValue(SESSION as any);
  grants.rows = grant('Contributor');
  loadOwnedItem.mockResolvedValue({ id: 'item-1', workspaceId: 'ws-1', itemType: 'health-tenant', displayName: 'Mercy General', state: { healthTenant: BINDING } });
  vi.stubEnv('LOOM_HEALTH_CP_URL', '');
  vi.stubEnv('LOOM_HEALTH_CP_AUDIENCE', '');
  vi.stubEnv('LOOM_TENANT_ADMIN_OID', '');
  vi.stubEnv('LOOM_TENANT_ADMIN_GROUP_ID', '');
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); vi.restoreAllMocks(); });

describe('buildLaunchUrl', () => {
  it('sets iss (URL-encoded FHIR base) and launch on the launch URI', () => {
    // Breaks if iss is appended raw (https://... unencoded) or the handle is dropped.
    expect(buildLaunchUrl('https://app.example/launch', FHIR_BASE, 'h-1_x'))
      .toBe('https://app.example/launch?iss=https%3A%2F%2Flhds-edge.example%2Fmercy-general%2Ffhir&launch=h-1_x');
    // A launch URI with its own query keeps it; an existing iss is replaced, never duplicated.
    expect(buildLaunchUrl('https://app.example/launch?app=1&iss=evil', FHIR_BASE, 'h'))
      .toBe('https://app.example/launch?app=1&iss=https%3A%2F%2Flhds-edge.example%2Fmercy-general%2Ffhir&launch=h');
  });
});

describe('parseRegister', () => {
  const ok = { displayName: 'Growth Chart', redirectUris: ['https://app.example/cb'], launchUri: 'https://app.example/launch', allowedScopes: ['patient/*.rs'], kind: 'public' };
  it('refuses a non-https launch URI, a scope outside the list, and a keyless asymmetric client', () => {
    // Each breaks if that rule is removed (the parse would succeed).
    expect(parseRegister({ ...ok, launchUri: 'http://app.example/launch' })).toEqual({ error: expect.stringMatching(/^launchUri/) });
    expect(parseRegister({ ...ok, launchUri: 'http://localhost:9000/launch' })).toEqual({ error: expect.stringMatching(/^launchUri/) }); // loopback too
    expect(parseRegister({ ...ok, allowedScopes: ['system/*.cruds'] })).toEqual({ error: expect.stringMatching(/^allowedScopes/) });
    expect(parseRegister({ ...ok, kind: 'asymmetric' })).toEqual({ error: expect.stringMatching(/^jwksUrl/) });
    // Paired permits.
    expect(parseRegister(ok)).toEqual({ app: { ...ok, clientType: 'app', roleIds: [] } });
    expect(parseRegister({ ...ok, kind: 'asymmetric', jwksUrl: 'https://app.example/jwks' })).toMatchObject({ app: { kind: 'asymmetric', jwksUrl: 'https://app.example/jwks' } });
  });
  it('every offered scope is one the CP grammar accepts (patient|user / type / v2 perms)', () => {
    // Breaks if a v1 (.read) or system/ scope is added to the picker list; the CP would 400 every registration using it.
    const V2 = /^(patient|user)\/(\*|[A-Z][A-Za-z]+)\.(?=[cruds])c?r?u?d?s?$/;
    for (const c of SMART_SCOPE_CHOICES) expect([c.scope, V2.test(c.scope)]).toEqual([c.scope, true]);
    // The probe itself must refuse what the CP refuses: an empty permission, v1, system/, and out-of-order perms.
    for (const bad of ['patient/*.', 'patient/*.read', 'system/*.rs', 'user/*.sr']) expect([bad, V2.test(bad)]).toEqual([bad, false]);
  });
});

describe('POST /apps/[clientId]/launch', () => {
  const launch = (body: unknown, clientId = 'growth-chart') => launchApp(req(body), ctx({ clientId }));

  it('mints the launch for the SESSION oid and ignores an oid in the body (forged-oid test)', async () => {
    vi.spyOn(cp, 'listClients').mockResolvedValue([client()]);
    const mint = vi.spyOn(cp, 'mintLaunch').mockResolvedValue({ launch: 'handle-1', expiresAt: 'x', iss: FHIR_BASE });
    const res = await launch({ oid: FORGED_OID, patient: 'pat-1' });
    expect(res.status).toBe(200);
    // Breaks if the route reads body.oid: the CP would be asked for FORGED_OID.
    expect(mint).toHaveBeenCalledWith({ tenant: 'mercy-general', oid: SESSION_OID, clientId: 'growth-chart', patient: 'pat-1' });
    const j = await res.json();
    // Breaks if iss is not encoded, the handle is not the CP's, or the base is derived instead of taken from the CP.
    expect(j).toMatchObject({ ok: true, url: 'https://app.example/launch?iss=https%3A%2F%2Flhds-edge.example%2Fmercy-general%2Ffhir&launch=handle-1' });
  });

  it('without a patient sends no patient to the CP', async () => {
    vi.spyOn(cp, 'listClients').mockResolvedValue([client()]);
    const mint = vi.spyOn(cp, 'mintLaunch').mockResolvedValue({ launch: 'h', expiresAt: 'x', iss: FHIR_BASE });
    expect((await launch({})).status).toBe(200);
    expect(mint.mock.calls[0]?.[0]).toEqual({ tenant: 'mercy-general', oid: SESSION_OID, clientId: 'growth-chart' });
  });

  it('refuses another tenant\'s client, a disabled client, a client with no launch URI, and a bad patient id', async () => {
    const mint = vi.spyOn(cp, 'mintLaunch').mockResolvedValue({ launch: 'h', expiresAt: 'x', iss: FHIR_BASE });
    const list = vi.spyOn(cp, 'listClients');
    list.mockResolvedValue([client({ tenant: 'other-tenant' })]);
    expect((await launch({})).status).toBe(404); // breaks if the tenant filter is dropped (200)
    list.mockResolvedValue([client({ status: 'disabled' })]);
    expect((await launch({})).status).toBe(409);
    list.mockResolvedValue([client({ launchUri: undefined })]);
    expect((await launch({})).status).toBe(409);
    list.mockResolvedValue([client()]);
    expect((await launch({ patient: 'a/b' })).status).toBe(400);
    expect(mint).not.toHaveBeenCalled();
    expect((await launch({})).status).toBe(200); // paired permit
  });

  it('a malformed stored launch URI is a 409 launch_uri_invalid, not a raw 500, and no handle is minted', async () => {
    vi.spyOn(cp, 'listClients').mockResolvedValue([client({ launchUri: 'not a url' })]);
    const mint = vi.spyOn(cp, 'mintLaunch').mockResolvedValue({ launch: 'h', expiresAt: 'x', iss: FHIR_BASE });
    const res = await launch({});
    // Breaks without the parse check: buildLaunchUrl's `new URL('not a url')` throws and withSession answers 500.
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, code: 'launch_uri_invalid' });
    expect(mint).not.toHaveBeenCalled();
  });

  it('a CP that returns no iss is a 502 that says so, not a URL with iss=undefined', async () => {
    vi.spyOn(cp, 'listClients').mockResolvedValue([client()]);
    vi.spyOn(cp, 'mintLaunch').mockResolvedValue({ launch: 'h', expiresAt: 'x' });
    const res = await launch({});
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('iss_missing');
  });

  it('with no health.tenant-admin grant is 403 and never reaches the CP', async () => {
    grants.rows = [];
    const list = vi.spyOn(cp, 'listClients').mockResolvedValue([client()]);
    expect((await launch({})).status).toBe(403);
    expect(list).not.toHaveBeenCalled();
  });
});

describe('POST /apps (register)', () => {
  const body = { clientId: 'growth-chart', displayName: 'Growth Chart', redirectUris: ['https://app.example/cb'], launchUri: 'https://app.example/launch', allowedScopes: ['patient/*.rs'], kind: 'public', tenant: 'someone-else' };
  it('refuses a non-https launch URI before calling the CP', async () => {
    const create = vi.spyOn(cp, 'createClient').mockResolvedValue(client());
    const res = await registerApp(req({ ...body, launchUri: 'http://app.example/launch' }), ctx());
    expect(res.status).toBe(400); // breaks if the https rule is dropped (201)
    expect(create).not.toHaveBeenCalled();
  });
  const GENERATED = /^growth-chart-[a-z2-7]{8}$/;
  it('registers on the BOUND tenant with a GENERATED client id; body tenant and body clientId are ignored', async () => {
    const create = vi.spyOn(cp, 'createClient').mockImplementation(async (b) => client({ clientId: b.clientId }));
    const res = await registerApp(req({ ...body, clientId: 'patient-search' }), ctx());
    expect(res.status).toBe(201);
    const sent = create.mock.calls[0]?.[0];
    // Breaks if body.clientId ('patient-search') or body.tenant ('someone-else') reaches the CP.
    expect(sent?.clientId).toMatch(GENERATED);
    expect(sent).toEqual({
      clientId: sent?.clientId, tenant: 'mercy-general', clientType: 'app', displayName: 'Growth Chart',
      allowedScopes: ['patient/*.rs'], redirectUris: ['https://app.example/cb'], launchUri: 'https://app.example/launch',
    });
    // The generated id is returned so the tab can show it (read-only, with Copy).
    expect((await res.json()).app).toMatchObject({ clientId: sent?.clientId, kind: 'public', status: 'active' });
  });
  it('registers without any client id in the body', async () => {
    const { clientId: _drop, ...noId } = body;
    vi.spyOn(cp, 'createClient').mockImplementation(async (b) => client({ clientId: b.clientId }));
    const res = await registerApp(req(noId), ctx());
    expect(res.status).toBe(201); // breaks if a client id is still required from the user
    expect((await res.json()).app.clientId).toMatch(GENERATED);
  });
  it('needs Contributor: a Reader grant is refused', async () => {
    grants.rows = grant('Reader');
    expect((await registerApp(req(body), ctx())).status).toBe(403);
  });
  it('a CP 409 is retried ONCE with a fresh id; a second 409 is passed through as 409', async () => {
    const create = vi.spyOn(cp, 'createClient')
      .mockRejectedValueOnce(new CpError(409, 'conflict', 'client already exists'))
      .mockImplementationOnce(async (b) => client({ clientId: b.clientId }));
    expect((await registerApp(req(body), ctx())).status).toBe(201); // breaks without the retry (409)
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]?.[0].clientId).not.toBe(create.mock.calls[1]?.[0].clientId); // a fresh id, not the same one
    create.mockReset();
    create.mockRejectedValue(new CpError(409, 'conflict', 'client already exists'));
    expect((await registerApp(req(body), ctx())).status).toBe(409);
    expect(create).toHaveBeenCalledTimes(2); // breaks if it loops
  });
});

describe('POST /apps (inline JWKS and backend clients, #5151)', () => {
  const app = { displayName: 'Inferno', redirectUris: ['https://app.example/cb'], launchUri: 'https://app.example/launch', allowedScopes: ['patient/*.rs'], kind: 'asymmetric' };
  const backend = { displayName: 'Inferno Bulk', clientType: 'backend', kind: 'asymmetric', allowedScopes: ['system/*.rs'], roleIds: ['fhir-data-exporter'] };
  const created = () => vi.spyOn(cp, 'createClient').mockImplementation(async (b) => client({ clientId: b.clientId }));
  // Backend clients need Admin (operator decision 2026-11-28); the Contributor/Admin split is pinned in its own block.
  beforeEach(() => { grants.rows = grant('Admin'); });

  it('the review probes (#5517) on a valid EC public key are each a 400 and NOTHING reaches the CP', async () => {
    const create = created();
    const ecJson = JSON.stringify(EC_PUB).slice(0, -1);
    for (const extra of ['"__proto__":{"d":"AQAB"}', '"D":"AQAB"', '"x5c":["MIIEvQIBADANBgkqhkiG9w0BAQEFAASC"]']) {
      // Parsed from JSON text exactly as req.json() would: "__proto__" is then an OWN member.
      const body = JSON.parse(`{"displayName":"Probe","clientType":"backend","kind":"asymmetric","allowedScopes":["system/*.rs"],"roleIds":["fhir-data-reader"],"jwks":{"keys":[${ecJson},${extra}}]}}`);
      const res = await registerApp(req(body), ctx());
      // Each was a 201 with the member forwarded before the allowlist + x5c parse (the CP stores unknown members).
      expect([extra, res.status]).toEqual([extra, 400]);
    }
    expect(create).not.toHaveBeenCalled();
  });

  it('a JWKS carrying a private key (d) is a 400 and NOTHING reaches the CP', async () => {
    const create = created();
    const res = await registerApp(req({ ...app, jwks: { keys: [RSA_PRIV] } }), ctx());
    // Breaks if the private-member check is removed: the RSA private key is otherwise a valid 2048-bit RSA JWK (201).
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/private key material \(d, p, q, dp, dq, qi\)/);
    expect(create).not.toHaveBeenCalled();
    // Same for a backend client: one private EC member on an otherwise public key.
    expect((await registerApp(req({ ...backend, jwks: { keys: [{ ...EC_PUB, d: 'AAAA' }] } }), ctx())).status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('a certificate with a PKCS#8 PRIVATE key appended in x5c is a 400 and NOTHING reaches the CP (review of 68d573903)', async () => {
    const create = created();
    const kp = generateKeyPairSync('ec', { namedCurve: 'P-384' });
    const pub = { ...(kp.publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'smuggle', alg: 'ES384' };
    const cert = Buffer.from(selfSignedCertB64(kp.publicKey, kp.privateKey), 'base64');
    const smuggled = Buffer.concat([cert, kp.privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer]).toString('base64');
    // On 68d573903 this was a 201 whose forwarded jwks carried the whole private key (X509Certificate ignores the tail).
    const res = await registerApp(req({ ...backend, jwks: { keys: [{ ...pub, x5c: [smuggled] }] } }), ctx());
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
    // Paired permit: the bare certificate registers, and what is forwarded is the certificate's own DER.
    expect((await registerApp(req({ ...backend, jwks: { keys: [{ ...pub, x5c: [cert.toString('base64')] }] } }), ctx())).status).toBe(201);
    expect((create.mock.calls[0]?.[0].jwks?.keys[0] as any)?.x5c).toEqual([cert.toString('base64')]);
  });

  it('a caller-supplied x5t (SHA-1) is a 400 with a true message and NOTHING reaches the CP', async () => {
    const create = created();
    const kp = generateKeyPairSync('ec', { namedCurve: 'P-384' });
    const pub = { ...(kp.publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'thumb', alg: 'ES384' };
    const cert = selfSignedCertB64(kp.publicKey, kp.privateKey);
    const res = await registerApp(req({ ...backend, jwks: { keys: [{ ...pub, x5c: [cert], x5t: 'A'.repeat(27) }] } }), ctx());
    // Breaks if x5t is accepted again (201 with an x5t forwarded).
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('jwks: key 1: x5t (SHA-1) is not accepted; use x5t#S256 or omit it');
    expect(create).not.toHaveBeenCalled();
    // Paired permit: without x5t the same key and certificate register, and no x5t is emitted.
    expect((await registerApp(req({ ...backend, jwks: { keys: [{ ...pub, x5c: [cert] }] } }), ctx())).status).toBe(201);
    expect('x5t' in (create.mock.calls[0]?.[0].jwks?.keys[0] ?? {})).toBe(false);
  });

  it('public RSA + EC keys are forwarded EXACTLY, with no jwksUrl', async () => {
    const create = created();
    const jwks = { keys: [RSA_PUB, EC_PUB] };
    const res = await registerApp(req({ ...app, jwks }), ctx());
    expect(res.status).toBe(201);
    const sent = create.mock.calls[0]?.[0];
    // Breaks if the BFF drops, rebuilds or reorders key members, or sends a jwksUrl alongside.
    expect(sent?.jwks).toEqual(jwks);
    expect(sent?.jwks).not.toBe(jwks); // the allowlist rebuild, never the request's object
    expect(sent && 'jwksUrl' in sent).toBe(false);
    expect(sent).toMatchObject({ clientType: 'app', launchUri: 'https://app.example/launch' });
  });

  it('both jwks and jwksUrl is a 400 (exactly one key source); neither is a 400 too', async () => {
    const create = created();
    const both = await registerApp(req({ ...app, jwks: { keys: [RSA_PUB] }, jwksUrl: 'https://k.example/jwks' }), ctx());
    // Breaks if exclusivity is removed: the jwks branch would accept it and forward a client with two key sources.
    expect(both.status).toBe(400);
    expect((await both.json()).error).toMatch(/supply exactly one/);
    expect((await registerApp(req(app), ctx())).status).toBe(400);
    expect(create).not.toHaveBeenCalled();
    expect((await registerApp(req({ ...app, jwksUrl: 'https://k.example/jwks' }), ctx())).status).toBe(201); // paired permit
  });

  it('an oversize JWKS is a 400 before the CP', async () => {
    const create = created();
    // One valid public key padded past 16 KB with an inert member: only the size cap can refuse it.
    const res = await registerApp(req({ ...backend, jwks: { keys: [{ ...EC_PUB, note: 'a'.repeat(16 * 1024) }] } }), ctx());
    expect(res.status).toBe(400); // breaks if the size cap is removed (201)
    expect((await res.json()).error).toBe('jwks: larger than 16 KB');
    expect(create).not.toHaveBeenCalled();
  });

  it('a backend client without roles is a 400; with roles it is forwarded as backend with roleIds and no launch/redirect', async () => {
    const create = created();
    const none = await registerApp(req({ ...backend, roleIds: [], jwks: { keys: [EC_PUB] } }), ctx());
    expect(none.status).toBe(400); // breaks if the roles rule is dropped (201)
    expect((await none.json()).error).toMatch(/^roleIds: a backend client needs at least one role/);
    expect((await registerApp(req({ ...backend, roleIds: undefined, jwks: { keys: [EC_PUB] } }), ctx())).status).toBe(400);
    expect((await registerApp(req({ ...backend, roleIds: ['health-tenant-admin'], jwks: { keys: [EC_PUB] } }), ctx())).status).toBe(400); // not a system role
    expect(create).not.toHaveBeenCalled();
    const ok = await registerApp(req({ ...backend, jwks: { keys: [EC_PUB] }, tenant: 'someone-else' }), ctx());
    expect(ok.status).toBe(201);
    const sent = create.mock.calls[0]?.[0];
    // Breaks if clientType is still hard-coded 'app', roleIds are not forwarded, or a launchUri key is sent.
    expect(sent).toEqual({
      clientId: sent?.clientId, tenant: 'mercy-general', clientType: 'backend', displayName: 'Inferno Bulk',
      allowedScopes: ['system/*.rs'], redirectUris: [], roleIds: ['fhir-data-exporter'], jwks: { keys: [EC_PUB] },
    });
  });

  it('introspect: an app client asking for it is a 400; a backend client forwards introspect:true; off sends no field', async () => {
    const create = created();
    const appRes = await registerApp(req({ ...app, jwksUrl: 'https://k.example/jwks', introspect: true }), ctx());
    // Breaks if the BFF lets an app client ask for introspection (it would reach the CP: 201 here).
    expect(appRes.status).toBe(400);
    expect((await appRes.json()).error).toBe('introspect: only a backend client may introspect');
    expect((await registerApp(req({ ...backend, jwks: { keys: [EC_PUB] }, introspect: 'yes' }), ctx())).status).toBe(400);
    expect(create).not.toHaveBeenCalled();
    expect((await registerApp(req({ ...backend, jwks: { keys: [EC_PUB] }, introspect: true }), ctx())).status).toBe(201);
    // Breaks if the route drops the flag (undefined) or renames it (the CP field is exactly `introspect`).
    expect(create.mock.calls[0]?.[0].introspect).toBe(true);
    expect((await registerApp(req({ ...backend, jwks: { keys: [EC_PUB] }, introspect: false }), ctx())).status).toBe(201);
    // Off is OMITTED, not sent as false, so a CP without the field (before #5515) still accepts the client.
    expect(create.mock.calls[1]?.[0] && 'introspect' in create.mock.calls[1][0]).toBe(false);
    // And the list reports it.
    vi.spyOn(cp, 'listClients').mockResolvedValue([client({ clientId: 'svc', clientType: 'backend', jwksUrl: 'https://k.example/s', introspect: true }), client()]);
    const rows = (await (await listApps(req(), ctx())).json()).apps;
    expect(rows.map((r: any) => [r.clientId, r.introspect])).toEqual([['svc', true], ['growth-chart', false]]);
  });

  it('a backend client refuses patient/ scopes, a launch URI, redirect URIs and the public kind; an app refuses system/ scopes and roles', async () => {
    const create = created();
    const k = { jwks: { keys: [EC_PUB] } };
    for (const bad of [
      { ...backend, ...k, allowedScopes: ['patient/*.rs'] },
      { ...backend, ...k, launchUri: 'https://app.example/launch' },
      { ...backend, ...k, redirectUris: ['https://app.example/cb'] },
      { ...backend, kind: 'public' },
      { ...app, ...k, allowedScopes: ['system/*.rs'] },
      { ...app, ...k, roleIds: ['fhir-data-reader'] },
    ]) {
      expect([bad, (await registerApp(req(bad), ctx())).status]).toEqual([bad, 400]);
    }
    expect(create).not.toHaveBeenCalled();
  });
});

describe('Admin for backend clients and introspection (operator decision 2026-11-28, #5151)', () => {
  const backend = { displayName: 'Inferno Bulk', clientType: 'backend', kind: 'asymmetric', allowedScopes: ['system/*.rs'], roleIds: ['fhir-data-reader'], jwks: { keys: [EC_PUB] } };
  const appBody = { displayName: 'Growth Chart', redirectUris: ['https://app.example/cb'], launchUri: 'https://app.example/launch', allowedScopes: ['patient/*.rs'], kind: 'public' };

  it('a Contributor creating a backend client is 403 and the CP is never called; creating an app is 201', async () => {
    grants.rows = grant('Contributor');
    const create = vi.spyOn(cp, 'createClient').mockImplementation(async (b) => client({ clientId: b.clientId }));
    const res = await registerApp(req(backend), ctx());
    // Breaks if the Admin check is removed: the Contributor wrapper alone admits it (201).
    expect(res.status).toBe(403);
    expect((await res.json()).requiredRole).toBe('Admin');
    expect(create).not.toHaveBeenCalled();
    expect((await registerApp(req(appBody), ctx())).status).toBe(201); // breaks if Admin is required for every client
  });

  it('an Admin creating a backend client is 201', async () => {
    grants.rows = grant('Admin');
    vi.spyOn(cp, 'createClient').mockImplementation(async (b) => client({ clientId: b.clientId }));
    expect((await registerApp(req(backend), ctx())).status).toBe(201);
  });

  it('GET reports canRegisterBackend from the caller\'s grant', async () => {
    vi.spyOn(cp, 'listClients').mockResolvedValue([]);
    grants.rows = grant('Contributor');
    expect((await (await listApps(req(), ctx())).json()).canRegisterBackend).toBe(false);
    grants.rows = grant('Admin');
    expect((await (await listApps(req(), ctx())).json()).canRegisterBackend).toBe(true); // breaks if hard-coded false
  });

  it('PATCH introspect needs Admin, only on a backend client; status stays at Contributor', async () => {
    const svc = client({ clientId: 'svc', clientType: 'backend', jwksUrl: 'https://k.example/s' });
    vi.spyOn(cp, 'listClients').mockResolvedValue([svc, client()]);
    const update = vi.spyOn(cp, 'updateClient').mockResolvedValue(svc);
    grants.rows = grant('Contributor');
    const denied = await patchApp(req({ introspect: true }), ctx({ clientId: 'svc' }));
    expect(denied.status).toBe(403); // breaks if PATCH introspect skips the Admin check (200)
    expect((await patchApp(req({ introspect: false }), ctx({ clientId: 'svc' }))).status).toBe(403);
    expect(update).not.toHaveBeenCalled();
    expect((await patchApp(req({ status: 'disabled' }), ctx({ clientId: 'svc' }))).status).toBe(200);
    update.mockClear();
    grants.rows = grant('Admin');
    expect((await patchApp(req({ introspect: true }), ctx({ clientId: 'growth-chart' }))).status).toBe(400); // app client
    expect(update).not.toHaveBeenCalled();
    expect((await patchApp(req({ introspect: true }), ctx({ clientId: 'svc' }))).status).toBe(200);
    expect(update).toHaveBeenCalledWith('svc', { introspect: true });
    expect((await patchApp(req({ introspect: 'yes' }), ctx({ clientId: 'svc' }))).status).toBe(400);
  });
});

describe('generateClientId', () => {
  it('slugs the display name to 40, appends 8 base32 chars, and fits the CP grammar', () => {
    const zeros = (n: number) => new Uint8Array(n); // byte 0 -> 'a'
    expect(generateClientId('Growth Chart!', zeros)).toBe('growth-chart-aaaaaaaa');
    expect(generateClientId('x'.repeat(80), zeros)).toBe(`${'x'.repeat(40)}-aaaaaaaa`); // breaks if the 40 cap goes
    expect(generateClientId('***', zeros)).toBe('app-aaaaaaaa'); // empty slug falls back
    expect(generateClientId('A', (n) => new Uint8Array(n).fill(31))).toBe('a-77777777');
    expect(CLIENT_ID.test(generateClientId('Ünïcode app — v2'))).toBe(true);
  });
});

describe('GET /apps and PATCH /apps/[clientId]', () => {
  it('lists only this tenant\'s clients (app AND backend), with the type derived from the key source', async () => {
    vi.spyOn(cp, 'listClients').mockResolvedValue([
      client(), client({ clientId: 'conf-app', jwksUrl: 'https://k.example/jwks' }),
      client({ clientId: 'other', tenant: 'other-tenant' }), client({ clientId: 'svc', clientType: 'backend', jwksUrl: 'https://k.example/svc' }),
    ]);
    const j = await (await listApps(req(), ctx())).json();
    // Breaks if the tenant filter is removed (4 rows), backend clients are dropped (2 rows), or kind ignores jwksUrl.
    expect(j.apps.map((a: any) => [a.clientId, a.clientType, a.kind, a.keySource])).toEqual([
      ['growth-chart', 'app', 'public', 'none'], ['conf-app', 'app', 'asymmetric', 'url'], ['svc', 'backend', 'asymmetric', 'url'],
    ]);
  });
  it('an inline-JWKS client is listed as a key count + kids; the key material never leaves the BFF', async () => {
    const keys = [{ ...EC_PUB }, { ...RSA_PUB }];
    vi.spyOn(cp, 'listClients').mockResolvedValue([client({ clientId: 'inferno', clientType: 'backend', jwks: { keys } })]);
    const body = await (await listApps(req(), ctx())).text();
    const row = JSON.parse(body).apps[0];
    expect(row).toMatchObject({ keySource: 'inline', keyCount: 2, kids: ['ec-1', 'rsa-1'] });
    // Breaks if toAppRow passes `jwks` through: the modulus and the EC x coordinate would be in the response.
    expect(body.includes(String(RSA_PUB.n))).toBe(false);
    expect(body.includes(String(EC_PUB.x))).toBe(false);
    expect('jwks' in row).toBe(false);
  });
  it('a launch is refused for a backend client (no user launch)', async () => {
    vi.spyOn(cp, 'listClients').mockResolvedValue([client({ clientType: 'backend', jwksUrl: 'https://k.example/svc' })]);
    const mint = vi.spyOn(cp, 'mintLaunch').mockResolvedValue({ launch: 'h', expiresAt: 'x', iss: FHIR_BASE });
    // Breaks if launch switches to clientsOfTenant: the backend client would be found and minted for (200).
    expect((await launchApp(req({}), ctx({ clientId: 'growth-chart' }))).status).toBe(404);
    expect(mint).not.toHaveBeenCalled();
  });
  it('with the CP unconfigured the list is the 503 gate envelope, not an empty list', async () => {
    const res = await listApps(req(), ctx());
    expect(res.status).toBe(503);
    expect((await res.json()).gated).toBe(true);
  });
  it('PATCH refuses another tenant\'s client and a non-https launch URI; patches its own', async () => {
    const update = vi.spyOn(cp, 'updateClient').mockResolvedValue(client({ status: 'disabled' }));
    vi.spyOn(cp, 'listClients').mockResolvedValue([client({ tenant: 'other-tenant' })]);
    expect((await patchApp(req({ status: 'disabled' }), ctx({ clientId: 'growth-chart' }))).status).toBe(404);
    expect(update).not.toHaveBeenCalled(); // breaks if the ownership check is dropped
    vi.spyOn(cp, 'listClients').mockResolvedValue([client()]);
    expect((await patchApp(req({ launchUri: 'http://app.example/l' }), ctx({ clientId: 'growth-chart' }))).status).toBe(400);
    const res = await patchApp(req({ status: 'disabled' }), ctx({ clientId: 'growth-chart' }));
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith('growth-chart', { status: 'disabled' });
  });
});

describe('POST /apps/patient-search', () => {
  it('searches as the session oid; an unavailable search is an honest flag with zero rows', async () => {
    const search = vi.spyOn(cp, 'patientSearch').mockResolvedValue({ unavailable: true, reason: 'FHIR edge unreachable' });
    const res = await searchPatients(req({ q: 'ada', oid: FORGED_OID }), ctx());
    expect(res.status).toBe(200);
    expect(search).toHaveBeenCalledWith('mercy-general', { oid: SESSION_OID, q: 'ada' }); // breaks on body.oid
    expect(await res.json()).toEqual({ ok: true, unavailable: true, reason: 'FHIR edge unreachable', patients: [] });
  });
  it('passes rows through and validates the query', async () => {
    vi.spyOn(cp, 'patientSearch').mockResolvedValue({ patients: [{ id: 'pat-1', name: 'Ada Smith' }] });
    expect((await (await searchPatients(req({ q: 'ada', birthdate: '1970-01-02' }), ctx())).json()).patients).toEqual([{ id: 'pat-1', name: 'Ada Smith' }]);
    expect((await searchPatients(req({ q: '' }), ctx())).status).toBe(400);
    expect((await searchPatients(req({ q: 'ada', birthdate: '02/01/1970' }), ctx())).status).toBe(400);
  });
});
