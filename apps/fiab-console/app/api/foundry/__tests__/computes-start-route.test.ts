/**
 * BFF route test for POST /api/foundry/computes/{id}/start.
 *
 * Asserts: (1) unauthed → 401, (2) happy path → 202 { ok, data:{ name, state } }
 * with the ARM start endpoint hit + a live state snapshot from getCompute,
 * (3) honest gate → 403 { ok:false, roleGate:true, requiredRole } when ARM
 * returns AuthorizationFailed (missing AzureML Compute Operator).
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

function stubFetch(impl: (url: string, init?: any) => { status?: number; body?: unknown }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
    const r = impl(String(url), init);
    return new Response(r.body == null ? '' : JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }));
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe('POST /api/foundry/computes/{id}/start', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { POST } = await import('@/app/api/foundry/computes/[id]/start/route');
    const r = await POST({} as any, ctx('ci-1'));
    expect(r.status).toBe(401);
  });

  it('202 + state snapshot when ARM accepts the start (Stopped → Starting)', async () => {
    let startHit = false;
    stubFetch((url) => {
      if (/\/computes\/ci-1\/start\?api-version=/.test(url)) { startHit = true; return { status: 202, body: null }; }
      if (/\/computes\/ci-1\?api-version=/.test(url)) {
        return { body: { id: '/x/computes/ci-1', name: 'ci-1', properties: { computeType: 'ComputeInstance', provisioningState: 'Succeeded', properties: { state: 'Starting', vmSize: 'STANDARD_DS3_V2' } } } };
      }
      return { status: 404, body: { error: { message: 'unexpected url' } } };
    });
    const { POST } = await import('@/app/api/foundry/computes/[id]/start/route');
    const r = await POST({} as any, ctx('ci-1'));
    const j = await r.json();
    expect(r.status).toBe(202);
    expect(startHit).toBe(true);
    expect(j.ok).toBe(true);
    expect(j.data).toMatchObject({ name: 'ci-1', state: 'Starting', provisioningState: 'Succeeded' });
  });

  it('still 202 ok:true even if the post-start snapshot fails', async () => {
    stubFetch((url) => {
      if (/\/computes\/ci-1\/start\?api-version=/.test(url)) return { status: 202, body: null };
      return { status: 500, body: { error: { message: 'transient' } } };
    });
    const { POST } = await import('@/app/api/foundry/computes/[id]/start/route');
    const r = await POST({} as any, ctx('ci-1'));
    const j = await r.json();
    expect(r.status).toBe(202);
    expect(j.ok).toBe(true);
    expect(j.data.state).toBe('Starting'); // fallback when snapshot unavailable
  });

  it('403 honest gate when AzureML Compute Operator is missing', async () => {
    stubFetch((url) => {
      if (/\/computes\/ci-1\/start\?api-version=/.test(url)) {
        return { status: 403, body: { error: { code: 'AuthorizationFailed', message: "does not have authorization to perform action 'Microsoft.MachineLearningServices/workspaces/computes/start/action'" } } };
      }
      return { status: 404, body: null };
    });
    const { POST } = await import('@/app/api/foundry/computes/[id]/start/route');
    const r = await POST({} as any, ctx('ci-1'));
    const j = await r.json();
    expect(r.status).toBe(403);
    expect(j.ok).toBe(false);
    expect(j.roleGate).toBe(true);
    expect(j.requiredRole).toBe('AzureML Compute Operator');
    expect(j.roleId).toBe('e503ece1-11d0-4e8e-8e2c-7a6c3bf38815');
  });
});
