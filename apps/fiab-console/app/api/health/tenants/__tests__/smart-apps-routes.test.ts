/**
 * /api/health/tenants/[id]/apps/** - SMART apps + EHR launcher BFF (#5454 A6).
 *
 * The REAL health.tenant-admin gate runs; the grants store, the item store and
 * the control-plane client methods are faked. Each load-bearing assertion names
 * the value that breaks it. Mutation receipts for the oid test are in the PR.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { SMART_SCOPE_CHOICES, buildLaunchUrl, parseRegister } from '../_lib/smart-apps';
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
  const ok = { clientId: 'growth-chart', displayName: 'Growth Chart', redirectUris: ['https://app.example/cb'], launchUri: 'https://app.example/launch', allowedScopes: ['patient/*.rs'], kind: 'public' };
  it('refuses a non-https launch URI, a scope outside the list, and a keyless asymmetric client', () => {
    // Each breaks if that rule is removed (the parse would succeed).
    expect(parseRegister({ ...ok, launchUri: 'http://app.example/launch' })).toEqual({ error: expect.stringMatching(/^launchUri/) });
    expect(parseRegister({ ...ok, launchUri: 'http://localhost:9000/launch' })).toEqual({ error: expect.stringMatching(/^launchUri/) }); // loopback too
    expect(parseRegister({ ...ok, allowedScopes: ['system/*.cruds'] })).toEqual({ error: expect.stringMatching(/^allowedScopes/) });
    expect(parseRegister({ ...ok, kind: 'asymmetric' })).toEqual({ error: expect.stringMatching(/^jwksUrl/) });
    expect(parseRegister({ ...ok, clientId: 'patient-search' })).toEqual({ error: expect.stringMatching(/reserved/) });
    // Paired permits.
    expect(parseRegister(ok)).toEqual({ app: { ...ok } });
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
  it('registers on the BOUND tenant, not a tenant named in the body', async () => {
    const create = vi.spyOn(cp, 'createClient').mockResolvedValue(client());
    const res = await registerApp(req(body), ctx());
    expect(res.status).toBe(201);
    // Breaks if body.tenant reaches the CP ('someone-else').
    expect(create.mock.calls[0]?.[0]).toEqual({
      clientId: 'growth-chart', tenant: 'mercy-general', clientType: 'app', displayName: 'Growth Chart',
      allowedScopes: ['patient/*.rs'], redirectUris: ['https://app.example/cb'], launchUri: 'https://app.example/launch',
    });
    expect((await res.json()).app).toMatchObject({ clientId: 'growth-chart', kind: 'public', status: 'active' });
  });
  it('needs Contributor: a Reader grant is refused', async () => {
    grants.rows = grant('Reader');
    expect((await registerApp(req(body), ctx())).status).toBe(403);
  });
  it('a CP 409 (client exists) is passed through as 409', async () => {
    vi.spyOn(cp, 'createClient').mockRejectedValue(new CpError(409, 'conflict', 'client already exists'));
    expect((await registerApp(req(body), ctx())).status).toBe(409);
  });
});

describe('GET /apps and PATCH /apps/[clientId]', () => {
  it('lists only this tenant\'s app clients, with the type derived from the key source', async () => {
    vi.spyOn(cp, 'listClients').mockResolvedValue([
      client(), client({ clientId: 'conf-app', jwksUrl: 'https://k.example/jwks' }),
      client({ clientId: 'other', tenant: 'other-tenant' }), client({ clientId: 'svc', clientType: 'backend' }),
    ]);
    const j = await (await listApps(req(), ctx())).json();
    // Breaks if the tenant or clientType filter is removed (4 rows), or kind ignores jwksUrl.
    expect(j.apps.map((a: any) => [a.clientId, a.kind])).toEqual([['growth-chart', 'public'], ['conf-app', 'asymmetric']]);
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
