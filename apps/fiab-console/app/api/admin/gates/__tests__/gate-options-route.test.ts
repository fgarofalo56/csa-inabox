/**
 * BFF contract tests for GET /api/admin/gates/[id]/options — the ARM
 * discovery behind a gate's Fix-it picker.
 *
 * Two regressions from the first cut of #2557 are locked here:
 *
 *  1. `listResources` broke the OUTER for-over-subscriptions on the 100-row
 *     cap. In a DLZ deployment (LOOM_SUBSCRIPTION_ID + LOOM_DLZ_SUBSCRIPTION_ID)
 *     where the admin sub alone yields >= 100 matching resources, every DLZ
 *     resource silently vanished from the picker. The cap must break only the
 *     inner PAGE loop.
 *  2. The route created a fresh 15s budget per required setting (and the
 *     `aoai-deployments` path fired up to 10 unbounded 30s armGets), so a
 *     `maxDuration = 30` route could still await for minutes. One budget now
 *     covers the whole request, and a deadline TRUNCATES the picker instead of
 *     throwing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getSessionMock = vi.fn(
  () => ({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({
  getSession: () => getSessionMock(),
  tenantScopeId: (s: any) => s?.claims?.tid ?? s?.claims?.oid,
}));
vi.mock('@/lib/auth/feature-gate', () => ({ enforceCapability: async () => null }));

vi.mock('@azure/identity', () => {
  class Cred {
    async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; }
  }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});
vi.mock('@/lib/azure/aca-managed-identity', () => {
  class Cred {
    async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; }
  }
  return { AcaManagedIdentityCredential: Cred };
});

const ADMIN_SUB = 'aaaaaaaa-1111-2222-3333-444444444444';
const DLZ_SUB = 'dddddddd-1111-2222-3333-444444444444';

beforeEach(() => {
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-test' }, exp: Date.now() / 1000 + 3600 } as any);
  process.env.LOOM_SUBSCRIPTION_ID = ADMIN_SUB;
  process.env.LOOM_DLZ_SUBSCRIPTION_ID = DLZ_SUB;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  delete process.env.LOOM_SUBSCRIPTION_ID;
  delete process.env.LOOM_DLZ_SUBSCRIPTION_ID;
  delete process.env.LOOM_ARM_PAGING_BUDGET_MS;
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function workspaces(sub: string, n: number, prefix: string) {
  return Array.from({ length: n }, (_, i) => ({
    id: `/subscriptions/${sub}/resourceGroups/rg/providers/Microsoft.Synapse/workspaces/${prefix}-${i}`,
    name: `${prefix}-${i}`,
    location: 'eastus',
  }));
}

/** `svc-synapse` maps LOOM_SYNAPSE_WORKSPACE → the Microsoft.Synapse loader. */
const GATE_ID = 'svc-synapse';

async function callRoute() {
  const { GET } = await import('@/app/api/admin/gates/[id]/options/route');
  return (GET as any)(new Request(`https://x/api/admin/gates/${GATE_ID}/options`), {
    params: Promise.resolve({ id: GATE_ID }),
  });
}

describe('GET /api/admin/gates/[id]/options', () => {
  it('401s without a session', async () => {
    getSessionMock.mockReturnValue(null as any);
    const res = await callRoute();
    expect(res.status).toBe(401);
  });

  it('503s with the honest gate when LOOM_SUBSCRIPTION_ID is unset', async () => {
    delete process.env.LOOM_SUBSCRIPTION_ID;
    const res = await callRoute();
    const j = await res.json();
    expect(res.status).toBe(503);
    expect(j.missing).toBe('LOOM_SUBSCRIPTION_ID');
  });

  it('lists resources from BOTH subscriptions', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const sub = /\/subscriptions\/([^/]+)\//.exec(String(url))?.[1] ?? '';
      return json({ value: workspaces(sub, 2, sub === ADMIN_SUB ? 'admin' : 'dlz') });
    }));
    const res = await callRoute();
    const j = await res.json();
    const names = j.options.LOOM_SYNAPSE_WORKSPACE.map((o: any) => o.value);
    expect(names).toEqual(['admin-0', 'admin-1', 'dlz-0', 'dlz-1']);
  });

  it('still queries the DLZ subscription when the admin sub alone fills the 100-row cap', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const sub = /\/subscriptions\/([^/]+)\//.exec(String(url))?.[1] ?? '';
      // Admin sub floods past the picker cap; DLZ has the one the operator wants.
      if (sub === ADMIN_SUB) return json({ value: workspaces(sub, 120, 'admin') });
      return json({ value: workspaces(sub, 1, 'dlz') });
    }));

    const res = await callRoute();
    const j = await res.json();
    const names: string[] = j.options.LOOM_SYNAPSE_WORKSPACE.map((o: any) => o.value);

    // The row cap bounds the PAGE loop, not the fan-out: the DLZ workspace must
    // still be pickable. Breaking the outer loop made it silently disappear.
    expect(names).toContain('dlz-0');
  });

  it('truncates the picker instead of failing the request when ARM hangs', async () => {
    process.env.LOOM_ARM_PAGING_BUDGET_MS = '100';
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      const sub = /\/subscriptions\/([^/]+)\//.exec(String(url))?.[1] ?? '';
      if (sub === ADMIN_SUB) return Promise.resolve(json({ value: workspaces(sub, 2, 'admin') }));
      return new Promise<Response>((_res, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        const onAbort = () => {
          const err: any = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
    }));

    const res = await callRoute();
    const j = await res.json();

    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    // Honest: the response says the list is short because ARM was slow.
    expect(j.truncated).toBe('time');
    expect(j.options.LOOM_SYNAPSE_WORKSPACE.map((o: any) => o.value)).toEqual(['admin-0', 'admin-1']);
  });
});
