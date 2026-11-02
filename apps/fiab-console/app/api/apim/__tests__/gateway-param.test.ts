/**
 * `?gateway=<id>` plumbing on /api/apim/*: absent = unchanged default behaviour; a registered id
 * retargets apim-client; an unknown id is a 404 (never a silent default).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn(), tenantScopeId: (s: any) => s.claims.tid }));
vi.mock('@/lib/azure/apim-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/apim-client');
  return { ...actual, apimConfigGate: () => null, listApis: vi.fn() };
});

import { GET } from '../apis/route';
import { getSession } from '@/lib/auth/session';
import { listApis } from '@/lib/azure/apim-client';
import { scopeRoute, resolveGateway } from '@/lib/api-gateway/registry/resolve-gateway';
import { MemoryGatewayRepo } from '@/lib/api-gateway/registry/__tests__/memory-gateway-repo';

const RID = '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg/providers/Microsoft.ApiManagement/service/other';
const req = (q = '') => ({ nextUrl: new URL('http://x/api/apim/apis' + q), url: 'http://x/api/apim/apis' + q, json: async () => ({}) }) as any;

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue({ claims: { oid: 'o', tid: 't1', roles: [] } });
  (listApis as any).mockResolvedValue([{ name: 'a' }]);
});

describe('/api/apim default behaviour without ?gateway', () => {
  it('GET /apis answers the unchanged envelope and never touches the registry', async () => {
    const res = await GET(req(), { params: Promise.resolve({}) } as any);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, apis: [{ name: 'a' }] });
  });
  it('an empty ?gateway= is the default too', async () => {
    const res = await GET(req('?gateway='), { params: Promise.resolve({}) } as any);
    expect(res.status).toBe(200);
  });
});

describe('scopeRoute / resolveGateway', () => {
  async function repoWith(over: object = {}) {
    const repo = new MemoryGatewayRepo();
    await repo.upsert({
      id: 'gw-9', tenantId: 't1', docType: 'gateway', kind: 'gateway', displayName: 'o', cloud: 'AzureCloud', resourceId: RID,
      managementMode: 'observe', environmentKey: null, access: { canRead: true, canWrite: false, checkedAt: 'x', source: 'permissions' },
      capabilities: { tier: 'v2', mcpServers: 'unknown', llmPolicies: 'unknown' },
      inventory: { apis: 0, products: 0, subscriptions: 0, backends: 0, namedValues: 0, mcpServers: 0, partialTypes: [] },
      ownedBy: 'registered', createdAt: 'x', createdBy: 'o', ...over,
    } as any);
    return repo;
  }

  it('a registered id runs the handler and passes the registered resource id (via the retarget)', async () => {
    const repo = await repoWith();
    const r = await resolveGateway(repo, 't1', 'gw-9');
    expect(r).toEqual({ kind: 'gateway', id: 'gw-9', resourceId: RID });
    const handler = vi.fn(async () => new Response('ok'));
    const res = await scopeRoute(handler as any, async () => repo)(req('?gateway=gw-9'), {});
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it('an unknown id is 404 and the handler is NOT run (breaks if it falls back to default)', async () => {
    const repo = await repoWith();
    const handler = vi.fn(async () => new Response('ok'));
    const res = await scopeRoute(handler as any, async () => repo)(req('?gateway=nope'), {});
    expect(res.status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
  });
  it('another tenant cannot address the gateway', async () => {
    const repo = await repoWith({ tenantId: 'other-tenant' });
    expect((await resolveGateway(repo, 't1', 'gw-9')).kind).toBe('error');
  });
  it('an unreadable gateway is 403', async () => {
    const repo = await repoWith({ access: { canRead: false, canWrite: false, checkedAt: 'x', source: 'probe' } });
    expect(await resolveGateway(repo, 't1', 'gw-9')).toMatchObject({ kind: 'error', status: 403 });
  });
});
