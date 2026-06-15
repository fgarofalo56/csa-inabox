/**
 * BFF contract tests for GET /api/setup/existing-aoai (deploy-readiness AOAI
 * scan-and-choose). Pins:
 *   - 401 unauthenticated
 *   - Resource Graph query for AIServices/OpenAI accounts, then ARM deployment
 *     enumeration per account, classifying chat (gpt-4o-class) + embeddings
 *   - recommendation = 'reuse' when an account already has a chat+embed pair,
 *     else 'new'
 *   - empty list when the principal sees no accounts (no mock data)
 *   - 502 on Resource Graph error status
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getSessionMock = vi.fn(
  () => ({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

vi.mock('@azure/identity', () => {
  class Cred {
    async getToken() {
      return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 };
    }
  }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

beforeEach(() => {
  delete process.env.LOOM_ARM_ENDPOINT;
  delete process.env.LOOM_UAMI_CLIENT_ID;
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-test' }, exp: Date.now() / 1000 + 3600 } as any);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

function stubFetch(impl: (url: string) => { status?: number; body?: unknown; contentType?: string }) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(String(url));
      const r = impl(String(url));
      const ct = r.contentType ?? 'application/json';
      return new Response(JSON.stringify(r.body ?? {}), {
        status: r.status ?? 200,
        headers: { 'content-type': ct },
      });
    }),
  );
  return calls;
}

describe('GET /api/setup/existing-aoai', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { GET } = await import('@/app/api/setup/existing-aoai/route');
    const r = await GET();
    expect(r.status).toBe(401);
  });

  it('lists AIServices accounts + classifies chat/embed and recommends reuse', async () => {
    const calls = stubFetch((url) => {
      if (url.includes('Microsoft.ResourceGraph/resources')) {
        return {
          body: {
            data: [
              {
                name: 'aifndry-loom-eastus2',
                resourceGroup: 'rg-csa-loom-admin-eastus2',
                subscriptionId: 'sub-1',
                location: 'eastus2',
                kind: 'AIServices',
              },
            ],
          },
        };
      }
      // ARM deployment enumeration for the account.
      if (url.includes('/deployments?api-version=')) {
        return {
          body: {
            value: [
              { name: 'chat', properties: { model: { name: 'gpt-4o' } } },
              { name: 'text-embedding-ada-002', properties: { model: { name: 'text-embedding-ada-002' } } },
            ],
          },
        };
      }
      return { body: {} };
    });
    const { GET } = await import('@/app/api/setup/existing-aoai/route');
    const r = await GET();
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.recommendation).toBe('reuse');
    expect(j.accounts).toHaveLength(1);
    expect(j.accounts[0].chatDeployment).toBe('chat');
    expect(j.accounts[0].embedDeployment).toBe('text-embedding-ada-002');
    // Resource Graph first, then ARM deployments enumeration.
    expect(calls[0]).toMatch(/Microsoft\.ResourceGraph\/resources/);
    expect(calls.some((c) => /\/deployments\?api-version=/.test(c))).toBe(true);
  });

  it('recommends new when no account has a complete chat+embed pair', async () => {
    stubFetch((url) => {
      if (url.includes('Microsoft.ResourceGraph/resources')) {
        return {
          body: {
            data: [
              { name: 'oai-x', resourceGroup: 'rg', subscriptionId: 'sub-1', location: 'eastus', kind: 'OpenAI' },
            ],
          },
        };
      }
      if (url.includes('/deployments?api-version=')) {
        return { body: { value: [{ name: 'chat', properties: { model: { name: 'gpt-4o' } } }] } };
      }
      return { body: {} };
    });
    const { GET } = await import('@/app/api/setup/existing-aoai/route');
    const r = await GET();
    const j = await r.json();
    expect(j.recommendation).toBe('new');
    expect(j.accounts[0].embedDeployment).toBe('');
  });

  it('returns an empty list (no mock data) when the principal sees no accounts', async () => {
    stubFetch((url) => {
      if (url.includes('Microsoft.ResourceGraph/resources')) return { body: { data: [] } };
      return { body: {} };
    });
    const { GET } = await import('@/app/api/setup/existing-aoai/route');
    const r = await GET();
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.accounts).toEqual([]);
    expect(j.recommendation).toBe('new');
  });

  it('502 on Resource Graph error status', async () => {
    stubFetch(() => ({ status: 403, body: { error: 'forbidden' } }));
    const { GET } = await import('@/app/api/setup/existing-aoai/route');
    const r = await GET();
    expect(r.status).toBe(502);
  });
});
