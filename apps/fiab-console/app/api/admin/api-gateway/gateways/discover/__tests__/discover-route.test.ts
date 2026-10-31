/**
 * W1-9 discover route.
 *
 * Breaking values:
 *  - 401/403: a route without the gate answers 200 for no session / a non-admin oid. The 403
 *    BODY must equal the sibling GET /gateways 403 body, so a differently-worded gate fails.
 *  - partial over HTTP: sub B answers 403 -> body.data.partial true and failures[0].scope == SUB_B
 *    with status 403; the paired double (both readable) must answer partial:false.
 *  - zero writes: repo.writes stays 0 after the GET; positive control: POST /gateways in the same
 *    harness raises it to 1 (so the counter can move).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryGatewayRepo } from '@/lib/api-gateway/registry/__tests__/memory-gateway-repo';
import type { RegistryDeps } from '@/lib/api-gateway/registry/gateway-service';
import { CONTRIBUTOR_PERMS, fakeJwt, OID } from '@/lib/api-gateway/registry/__tests__/arm-double';
import type { ArmPort } from '@/lib/api-gateway/registry/preflight';

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
import { GET as LIST, POST } from '../../route';
import { GET } from '../route';

const ADMIN = 'admin-oid-0001';
const SUB_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const SUB_B = 'bbbbbbbb-1111-2222-3333-444444444444';
const rid = (sub: string, name: string) =>
  `/subscriptions/${sub}/resourceGroups/rg/providers/Microsoft.ApiManagement/service/${name}`;
const session = (oid: string) => ({ claims: { oid, tid: 'tenant-1', name: 'N', upn: 'n@x', groups: [] } }) as never;
const req = (body?: unknown) => ({ nextUrl: new URL('http://x/'), url: 'http://x/', json: async () => body }) as never;

let repo: MemoryGatewayRepo;

function arm(bReadable: boolean): ArmPort {
  return {
    armBase: () => 'https://management.azure.com',
    getToken: async () => fakeJwt({ oid: OID }),
    async get(url) {
      if (url.includes('/subscriptions?api-version')) return { status: 200, body: { value: [{ subscriptionId: SUB_A }, { subscriptionId: SUB_B }] } };
      if (url.includes(`/subscriptions/${SUB_A}/providers/Microsoft.ApiManagement/service?`)) {
        return { status: 200, body: { value: [{ id: rid(SUB_A, 'apim-a'), name: 'apim-a', location: 'eastus2', sku: { name: 'Developer' }, properties: { virtualNetworkType: 'None' } }] } };
      }
      if (url.includes(`/subscriptions/${SUB_B}/providers/Microsoft.ApiManagement/service?`)) {
        return bReadable
          ? { status: 200, body: { value: [{ id: rid(SUB_B, 'apim-b'), name: 'apim-b', location: 'eastus2', sku: { name: 'Premium' } }] } }
          : { status: 403, body: { error: { code: 'AuthorizationFailed', message: 'denied' } } };
      }
      if (url.includes('/providers/Microsoft.Authorization/permissions')) return { status: 200, body: { value: CONTRIBUTOR_PERMS } };
      return { status: 404, body: {} };
    },
  };
}

function setDeps(a: ArmPort) {
  depsRef.current = { repo, arm: a, writeAudit: async () => {}, cloud: () => 'AzureCloud' };
}

beforeEach(() => {
  vi.resetAllMocks();
  repo = new MemoryGatewayRepo();
  process.env.LOOM_TENANT_ADMIN_OID = ADMIN;
  delete process.env.LOOM_APIPLANE_DEPLOY_GATEWAY_ID;
  (getSession as ReturnType<typeof vi.fn>).mockReturnValue(session(ADMIN));
  setDeps(arm(false));
});

describe('gate', () => {
  it('401 without a session', async () => {
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(null);
    expect((await GET(req(), undefined as never)).status).toBe(401);
  });

  it('403 for a non-admin without the capability, identical to the sibling 403, and nothing is read or written', async () => {
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(session('someone-else'));
    const res = await GET(req(), undefined as never);
    const sibling = await LIST(req(), undefined as never);
    expect(res.status).toBe(403);
    expect(sibling.status).toBe(403);
    expect(await res.json()).toEqual(await sibling.json());
    expect(repo.writes).toBe(0);
  });
});

describe('GET /gateways/discover', () => {
  it('partial: unreadable subscription is named with its status; readable candidate still returned', async () => {
    const res = await GET(req(), undefined as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.partial).toBe(true);
    expect(body.data.failures[0]).toMatchObject({ scope: SUB_B, status: 403 });
    expect(body.data.candidates.map((c: { name: string }) => c.name)).toEqual(['apim-a']);
  });

  it('paired: both readable -> partial:false', async () => {
    setDeps(arm(true));
    const body = await (await GET(req(), undefined as never)).json();
    expect(body.data.partial).toBe(false);
    expect(body.data.candidates.map((c: { name: string }) => c.name)).toEqual(['apim-a', 'apim-b']);
  });

  it('registered candidate is marked, the other is not; discovery writes nothing, register does', async () => {
    const before = await (await GET(req(), undefined as never)).json();
    expect(before.data.candidates[0].alreadyRegistered).toBe(false);
    expect(repo.writes).toBe(0);

    const reg = await POST(req({ resourceId: rid(SUB_A, 'apim-a') }), undefined as never);
    expect(reg.status).toBe(201);
    expect(repo.writes).toBe(1);

    setDeps(arm(true));
    const after = await (await GET(req(), undefined as never)).json();
    const byName = Object.fromEntries(after.data.candidates.map((c: { name: string; alreadyRegistered: boolean }) => [c.name, c.alreadyRegistered]));
    expect(byName).toEqual({ 'apim-a': true, 'apim-b': false });
    expect(repo.writes).toBe(1);
  });
});
