/**
 * BFF route test for GET /api/foundry/computes/{id}/status.
 *
 * Asserts: (1) unauthed → 401, (2) happy path → 200 { ok, data } with the live
 * ComputeInstance state (Running), (3) 404 when the instance does not exist,
 * (4) honest gate → 403 { ok:false, roleGate:true } when the operator role is
 * missing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 }) as any);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

beforeEach(() => {
  process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
  process.env.LOOM_FOUNDRY_RG = 'rg-foundry';
  process.env.LOOM_FOUNDRY_NAME = 'ws-foundry';
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 } as any);
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

function stubFetch(impl: (url: string) => { status?: number; body?: unknown }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const r = impl(String(url));
    return new Response(r.body == null ? '' : JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }));
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe('GET /api/foundry/computes/{id}/status', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { GET } = await import('@/app/api/foundry/computes/[id]/status/route');
    const r = await GET({} as any, ctx('ci-1'));
    expect(r.status).toBe(401);
  });

  it('200 + live ComputeInstance state', async () => {
    stubFetch((url) => {
      if (/\/computes\/ci-1\?api-version=/.test(url)) {
        return { body: { id: '/x/computes/ci-1', name: 'ci-1', properties: { computeType: 'ComputeInstance', provisioningState: 'Succeeded', properties: { state: 'Running', vmSize: 'STANDARD_DS3_V2' } } } };
      }
      return { status: 404, body: null };
    });
    const { GET } = await import('@/app/api/foundry/computes/[id]/status/route');
    const r = await GET({} as any, ctx('ci-1'));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.data).toMatchObject({ name: 'ci-1', state: 'Running', computeType: 'ComputeInstance' });
  });

  it('404 when the compute instance does not exist', async () => {
    stubFetch(() => ({ status: 404, body: null }));
    const { GET } = await import('@/app/api/foundry/computes/[id]/status/route');
    const r = await GET({} as any, ctx('missing'));
    const j = await r.json();
    expect(r.status).toBe(404);
    expect(j.ok).toBe(false);
  });

  it('403 honest gate when AzureML Compute Operator is missing', async () => {
    stubFetch((url) => {
      if (/\/computes\/ci-1\?api-version=/.test(url)) {
        return { status: 403, body: { error: { code: 'AuthorizationFailed', message: 'does not have authorization to perform action' } } };
      }
      return { status: 404, body: null };
    });
    const { GET } = await import('@/app/api/foundry/computes/[id]/status/route');
    const r = await GET({} as any, ctx('ci-1'));
    const j = await r.json();
    expect(r.status).toBe(403);
    expect(j.ok).toBe(false);
    expect(j.roleGate).toBe(true);
    expect(j.requiredRole).toBe('AzureML Compute Operator');
  });
});
