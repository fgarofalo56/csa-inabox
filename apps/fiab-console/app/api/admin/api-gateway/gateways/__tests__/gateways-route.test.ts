/**
 * W1-2 routes: session validation, {ok,data,error} envelope, and the unreadable-service
 * remediation carried through the HTTP boundary.
 *
 * Breaking values:
 *  - 401: a route without the session wrapper answers 200 with no session.
 *  - 403: a route without the admin wrapper answers 200 for a non-admin oid.
 *  - remediation: error must CONTAIN the literal role name, role GUID, scope and the whole
 *    az command; dropping any one from buildMissingRole/accessDeniedMessage fails here.
 *  - auto-registration: GET twice leaves exactly one gateway (a second insert makes it 2).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryGatewayRepo } from '@/lib/api-gateway/registry/__tests__/memory-gateway-repo';
import type { RegistryDeps } from '@/lib/api-gateway/registry/gateway-service';
import type { GatewayDoc } from '@/lib/api-gateway/registry/types';
import { armDouble, CONTRIBUTOR_PERMS, GW_ID, OID } from '@/lib/api-gateway/registry/__tests__/arm-double';

vi.mock('@/lib/auth/session', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/session')>()),
  getSession: vi.fn(),
}));
const depsRef: { current: RegistryDeps } = { current: undefined as unknown as RegistryDeps };
vi.mock('@/lib/api-gateway/registry/deps', () => ({
  registryDeps: () => depsRef.current,
  cosmosGatewayRepo: () => depsRef.current.repo,
}));

import { getSession } from '@/lib/auth/session';
import { DELETE } from '../[id]/route';
import { GET, POST } from '../route';

const ADMIN = 'admin-oid-0001';
const session = (oid: string) => ({ claims: { oid, tid: 'tenant-1', name: 'N', upn: 'n@x', groups: [] } }) as never;
const jsonReq = (body: unknown) => ({ nextUrl: new URL('http://x/'), url: 'http://x/', json: async () => body }) as never;
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });

let repo: MemoryGatewayRepo;
let audits: unknown[];

function setDeps(arm: ReturnType<typeof armDouble>) {
  depsRef.current = {
    repo,
    arm,
    writeAudit: async (r) => {
      audits.push(r);
    },
    cloud: () => 'AzureCloud',
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  repo = new MemoryGatewayRepo();
  audits = [];
  process.env.LOOM_TENANT_ADMIN_OID = ADMIN;
  delete process.env.LOOM_APIPLANE_DEPLOY_GATEWAY_ID;
  (getSession as ReturnType<typeof vi.fn>).mockReturnValue(session(ADMIN));
  setDeps(armDouble({ permissions: CONTRIBUTOR_PERMS }));
});

describe('session and admin validation on every route', () => {
  it('401 without a session on GET, POST and DELETE', async () => {
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(null);
    expect((await GET(jsonReq({}), undefined as never)).status).toBe(401);
    expect((await POST(jsonReq({ resourceId: GW_ID }), undefined as never)).status).toBe(401);
    expect((await DELETE(jsonReq({}), idCtx('gw-x') as never)).status).toBe(401);
  });

  it('403 for a signed-in non-admin on all three routes, and nothing is written', async () => {
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(session('someone-else'));
    expect((await GET(jsonReq({}), undefined as never)).status).toBe(403);
    expect((await POST(jsonReq({ resourceId: GW_ID }), undefined as never)).status).toBe(403);
    expect((await DELETE(jsonReq({}), idCtx('gw-x') as never)).status).toBe(403);
    expect(await repo.list('tenant-1')).toHaveLength(0);
  });
});

describe('POST register', () => {
  it('unreadable service: ok:false 422 carrying the exact role, scope and az command', async () => {
    setDeps(armDouble({ permissions: [] }));
    const res = await POST(jsonReq({ resourceId: GW_ID }), undefined as never);
    expect(res.status).toBe(422);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.code).toBe('gateway_role_missing');
    expect(j.error).toContain('Grant role "Reader" (acdd72a7-3385-48ef-bd42-f606fba81ae7)');
    expect(j.error).toContain(`at scope ${GW_ID}`);
    expect(j.error).toContain(
      `az role assignment create --assignee-object-id ${OID} --assignee-principal-type ServicePrincipal --role acdd72a7-3385-48ef-bd42-f606fba81ae7 --scope ${GW_ID}`,
    );
    expect(j.data.missingRole.scope).toBe(GW_ID);
    expect(await repo.list('tenant-1')).toHaveLength(0);
  });

  it('readable service: 201 {ok:true,data} and the gateway is listed afterwards', async () => {
    const res = await POST(jsonReq({ resourceId: GW_ID, displayName: 'Mine' }), undefined as never);
    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.data.displayName).toBe('Mine');
    expect(j.data.access.canRead).toBe(true);
    const list = await (await GET(jsonReq({}), undefined as never)).json();
    expect(list.data.gateways.map((g: GatewayDoc) => g.id)).toEqual([j.data.id]);
  });

  it('400 on malformed JSON and on a non-APIM resource id', async () => {
    const bad = { nextUrl: new URL('http://x/'), json: async () => { throw new Error('bad'); } } as never;
    expect((await POST(bad, undefined as never)).status).toBe(400);
    const r = await POST(jsonReq({ resourceId: '/subscriptions/x' }), undefined as never);
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe('invalid_resource_id');
  });
});

describe('GET list + auto-registration', () => {
  it('registers the deploy-owned gateway on first admin load and not again on the second', async () => {
    process.env.LOOM_APIPLANE_DEPLOY_GATEWAY_ID = GW_ID;
    const a = await (await GET(jsonReq({}), undefined as never)).json();
    const b = await (await GET(jsonReq({}), undefined as never)).json();
    expect(a.ok).toBe(true);
    expect(a.data.gateways).toHaveLength(1);
    expect(a.data.gateways[0].ownedBy).toBe('deploy');
    expect(a.data.gateways[0].access.canRead).toBe(true);
    expect(b.data.gateways).toHaveLength(1);
    expect(b.data.gateways[0].id).toBe(a.data.gateways[0].id);
    expect(audits).toHaveLength(1);
  });

  it('a broken deploy-gateway id does not break the list; it is reported in deployRegistration', async () => {
    process.env.LOOM_APIPLANE_DEPLOY_GATEWAY_ID = 'garbage';
    const j = await (await GET(jsonReq({}), undefined as never)).json();
    expect(j.ok).toBe(true);
    expect(j.data.deployRegistration.ok).toBe(false);
    expect(j.data.deployRegistration.error).toContain('LOOM_APIPLANE_DEPLOY_GATEWAY_ID');
  });
});

describe('DELETE', () => {
  it('removes a registered gateway; 404 for an unknown id; 409 for the deploy-owned one', async () => {
    const reg = await (await POST(jsonReq({ resourceId: GW_ID }), undefined as never)).json();
    const del = await DELETE(jsonReq({}), idCtx(reg.data.id) as never);
    expect(del.status).toBe(200);
    expect((await del.json()).data.id).toBe(reg.data.id);
    expect((await DELETE(jsonReq({}), idCtx('gw-missing') as never)).status).toBe(404);

    process.env.LOOM_APIPLANE_DEPLOY_GATEWAY_ID = GW_ID;
    const list = await (await GET(jsonReq({}), undefined as never)).json();
    const owned = await DELETE(jsonReq({}), idCtx(list.data.gateways[0].id) as never);
    expect(owned.status).toBe(409);
  });
});
