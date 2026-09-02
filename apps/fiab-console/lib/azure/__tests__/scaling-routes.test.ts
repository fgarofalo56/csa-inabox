/**
 * BFF route tests for /api/admin/scaling/*.
 *
 * Each test imports the route handler directly, stubs the underlying
 * Azure client, and asserts: (1) unauthed → 401, (2) bad body → 400,
 * (3) happy path → { ok: true }.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => ({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 })),
}));

// Short-circuit the DLZ gate (it calls loadTenantDomains → Cosmos → real
// network). Return null (allow access) so route handlers reach their
// actual logic without hanging on a Cosmos connection.
vi.mock('@/lib/auth/dlz-gate', () => ({
  denyIfNoDlzAccess: vi.fn(async () => null),
}));

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

beforeEach(() => {
  process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
  process.env.LOOM_DLZ_RG = 'rg-dlz';
  process.env.LOOM_ADMIN_RG = 'rg-admin';
  process.env.LOOM_SYNAPSE_WORKSPACE = 'syn-ws';
  process.env.LOOM_KUSTO_CLUSTER_NAME = 'adx-test';
  process.env.LOOM_AI_SEARCH_SERVICE = 'srch-test';
  process.env.LOOM_AI_SEARCH_SUB = 'sub-1';
  process.env.LOOM_AI_SEARCH_RG = 'rg-admin';
  process.env.LOOM_APIM_NAME = 'apim-test';
  process.env.LOOM_FOUNDRY_NAME = 'aif-test';
  process.env.LOOM_FOUNDRY_RG = 'rg-admin';
  process.env.LOOM_DATABRICKS_HOSTNAME = 'adb.azuredatabricks.net';
  process.env.LOOM_COSMOS_ENDPOINT = 'https://test.documents.azure.com:443/';
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

function makeReq(method: string, body?: unknown) {
  return new NextRequest('https://loom.test/api/admin/scaling/x', {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function stubFetch(impl: (url: string, init?: RequestInit) => { status?: number; body?: unknown }) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const r = impl(typeof url === 'string' ? url : (url as any).toString(), init);
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('POST /api/admin/scaling/capacity', () => {
  it('rejects body without resourceId', async () => {
    const { POST } = await import('@/app/api/admin/scaling/capacity/route');
    const r = await POST(makeReq('POST', { sku: 'F8' }));
    expect(r.status).toBe(400);
  });

  it('rejects body without sku', async () => {
    const { POST } = await import('@/app/api/admin/scaling/capacity/route');
    const r = await POST(makeReq('POST', { resourceId: '/x' }));
    expect(r.status).toBe(400);
  });

  it('forwards to updateCapacitySku', async () => {
    stubFetch(() => ({ body: { sku: { name: 'F16', tier: 'Fabric' } } }));
    const { POST } = await import('@/app/api/admin/scaling/capacity/route');
    const r = await POST(makeReq('POST', {
      resourceId: '/subscriptions/sub-1/resourceGroups/rg-admin/providers/Microsoft.Fabric/capacities/cap1',
      sku: 'F16',
    }));
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
  });
});

describe('POST /api/admin/scaling/synapse-dwu', () => {
  it('rejects missing pool', async () => {
    const { POST } = await import('@/app/api/admin/scaling/synapse-dwu/route');
    const r = await POST(makeReq('POST', { sku: 'DW500c' }));
    expect(r.status).toBe(400);
  });

  it('rejects invalid sku shape', async () => {
    const { POST } = await import('@/app/api/admin/scaling/synapse-dwu/route');
    const r = await POST(makeReq('POST', { pool: 'p1', sku: 'F100' }));
    expect(r.status).toBe(400);
  });

  it('accepts a valid DWU SKU', async () => {
    stubFetch(() => ({ body: { name: 'p1', sku: { name: 'DW500c' }, properties: { status: 'Scaling' } } }));
    const { POST } = await import('@/app/api/admin/scaling/synapse-dwu/route');
    const r = await POST(makeReq('POST', { pool: 'p1', sku: 'DW500c' }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.newSku).toBe('DW500c');
  });
});

describe('POST /api/admin/scaling/adx', () => {
  it('rejects missing sku', async () => {
    const { POST } = await import('@/app/api/admin/scaling/adx/route');
    const r = await POST(makeReq('POST', {}));
    expect(r.status).toBe(400);
  });

  it('accepts SKU + capacity', async () => {
    stubFetch(() => ({ body: { id: '/x', name: 'adx-test', location: 'eastus2', sku: { name: 'Standard_E4ads_v5', tier: 'Standard', capacity: 2 } } }));
    const { POST } = await import('@/app/api/admin/scaling/adx/route');
    const r = await POST(makeReq('POST', { sku: 'Standard_E4ads_v5', capacity: 2 }));
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
  });
});

describe('POST /api/admin/scaling/databricks-warehouse', () => {
  it('rejects missing id', async () => {
    const { POST } = await import('@/app/api/admin/scaling/databricks-warehouse/route');
    const r = await POST(makeReq('POST', { cluster_size: 'Large' }));
    expect(r.status).toBe(400);
  });

  it('rejects invalid cluster_size', async () => {
    const { POST } = await import('@/app/api/admin/scaling/databricks-warehouse/route');
    const r = await POST(makeReq('POST', { id: 'wh1', cluster_size: 'jumbo' }));
    expect(r.status).toBe(400);
  });

  it('accepts a valid cluster_size', async () => {
    stubFetch((url) => {
      if (url.endsWith('/edit')) return { body: {} };
      return { body: { id: 'wh1', name: 'WH', cluster_size: 'Small', warehouse_type: 'PRO' } };
    });
    const { POST } = await import('@/app/api/admin/scaling/databricks-warehouse/route');
    const r = await POST(makeReq('POST', { id: 'wh1', cluster_size: 'Large' }));
    expect(r.status).toBe(200);
  });
});

describe('POST /api/admin/scaling/databricks-cluster', () => {
  it('rejects missing cluster_id', async () => {
    const { POST } = await import('@/app/api/admin/scaling/databricks-cluster/route');
    const r = await POST(makeReq('POST', { num_workers: 4 }));
    expect(r.status).toBe(400);
  });

  it('accepts cluster_id + node_type_id', async () => {
    stubFetch((url) => {
      if (url.includes('/clusters/edit')) return { body: {} };
      // getCluster
      return { body: { cluster_id: 'c1', cluster_name: 'C1', spark_version: '14.3.x-scala2.12', node_type_id: 'Standard_DS3_v2', num_workers: 2 } };
    });
    const { POST } = await import('@/app/api/admin/scaling/databricks-cluster/route');
    const r = await POST(makeReq('POST', { cluster_id: 'c1', node_type_id: 'Standard_DS4_v2', num_workers: 4 }));
    expect(r.status).toBe(200);
  });
});

describe('POST /api/admin/scaling/ai-search', () => {
  it('rejects empty body', async () => {
    const { POST } = await import('@/app/api/admin/scaling/ai-search/route');
    const r = await POST(makeReq('POST', {}));
    expect(r.status).toBe(400);
  });

  it('rejects invalid sku', async () => {
    const { POST } = await import('@/app/api/admin/scaling/ai-search/route');
    const r = await POST(makeReq('POST', { sku: 'super-extra' }));
    expect(r.status).toBe(400);
  });

  it('accepts valid sku + replicaCount', async () => {
    stubFetch(() => ({ body: { name: 'srch-test', sku: { name: 'standard2' }, properties: { replicaCount: 3, partitionCount: 1 } } }));
    const { POST } = await import('@/app/api/admin/scaling/ai-search/route');
    const r = await POST(makeReq('POST', { sku: 'standard2', replicaCount: 3 }));
    expect(r.status).toBe(200);
  });
});

describe('POST /api/admin/scaling/apim', () => {
  it('rejects missing sku', async () => {
    const { POST } = await import('@/app/api/admin/scaling/apim/route');
    const r = await POST(makeReq('POST', { capacity: 2 }));
    expect(r.status).toBe(400);
  });

  it('rejects invalid sku', async () => {
    const { POST } = await import('@/app/api/admin/scaling/apim/route');
    const r = await POST(makeReq('POST', { sku: 'Enterprise' }));
    expect(r.status).toBe(400);
  });

  it('accepts Premium + capacity', async () => {
    stubFetch(() => ({ body: { name: 'apim-test', sku: { name: 'Premium', capacity: 2 } } }));
    const { POST } = await import('@/app/api/admin/scaling/apim/route');
    const r = await POST(makeReq('POST', { sku: 'Premium', capacity: 2 }));
    expect(r.status).toBe(200);
  });
});

// #3895 — the profile a container app may be moved onto is decided by its
// managed ENVIRONMENT, so these fixtures carry one. The previous `accepts a
// valid scale spec` fixture answered EVERY ARM call with
// `{ name:'aca1', properties:{ workloadProfileName:'D4' } }` — an app with no
// environment, a shape ARM cannot produce — and the route's new pre-flight
// correctly refuses it (409). Making the estate realistic is the fix; loosening
// the pre-flight would delete the check.
const ACA_ENV_ID = '/subscriptions/sub-1/resourceGroups/rg-admin/providers/Microsoft.App/managedEnvironments/cae-test';

/** ARM stub answering the app GET, the environment GET, and the PATCH. */
function stubAcaEstate(declared = ['Consumption', 'D4']) {
  return stubFetch((url, init) => {
    if (url.includes('/managedEnvironments/')) {
      return { body: { id: ACA_ENV_ID, name: 'cae-test', properties: { workloadProfiles: declared.map((n) => ({ name: n, workloadProfileType: n })) } } };
    }
    if (init?.method === 'PATCH') {
      return { body: { name: 'aca1', location: 'centralus', properties: { provisioningState: 'Updating' } } };
    }
    return { body: { id: '/x', name: 'aca1', location: 'centralus', properties: { environmentId: ACA_ENV_ID, workloadProfileName: 'Consumption', template: { scale: { minReplicas: 1, maxReplicas: 3 } } } } };
  });
}

describe('POST /api/admin/scaling/container-apps', () => {
  it('rejects missing name', async () => {
    const { POST } = await import('@/app/api/admin/scaling/container-apps/route');
    const r = await POST(makeReq('POST', { workloadProfileName: 'D4' }));
    expect(r.status).toBe(400);
  });

  it('rejects a malformed workloadProfileName BEFORE any ARM call', async () => {
    // #3895 — this case used to pass for an ACCIDENTAL reason and it was
    // MEASURED: with no fetch stub installed, the handler reached the real
    // `management.azure.com`, which answered 400 `InvalidSubscriptionId` about
    // the fixture's fake `sub-1`, and the route echoed that status. The
    // assertion was green on a live Azure error about a subscription, not on
    // this route's validation.
    //
    // Two changes make it a control again: the name is one the SHAPE gate must
    // reject — the old `X9` is well-formed and is now correctly decided by the
    // ENVIRONMENT, not by a hardcoded list — and `fetch` is stubbed to THROW, so
    // a 400 can only have come from the gate.
    const netCalls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: any) => {
      netCalls.push(String(u));
      throw new Error('no ARM call should be made for a malformed profile name');
    }));
    const { POST } = await import('@/app/api/admin/scaling/container-apps/route');
    const r = await POST(makeReq('POST', { name: 'aca1', workloadProfileName: 'not a profile!' }));
    expect(r.status).toBe(400);
    expect(netCalls).toEqual([]);
    expect((await r.json()).error).toMatch(/letters, digits or hyphens/);
  });

  it('rejects maxReplicas > 1000', async () => {
    const { POST } = await import('@/app/api/admin/scaling/container-apps/route');
    const r = await POST(makeReq('POST', { name: 'aca1', maxReplicas: 5000 }));
    expect(r.status).toBe(400);
  });

  it('accepts a valid scale spec', async () => {
    stubAcaEstate(['Consumption', 'D4']);
    const { POST } = await import('@/app/api/admin/scaling/container-apps/route');
    const r = await POST(makeReq('POST', { name: 'aca1', workloadProfileName: 'D4', minReplicas: 1, maxReplicas: 5 }));
    expect(r.status).toBe(200);
  });

  it('refuses a well-formed profile the ENVIRONMENT does not declare (#3895)', async () => {
    // The defect itself, at the route boundary: `D4` is in the old hardcoded
    // allowlist and passes the shape gate, but this environment declares only
    // Consumption and D8. Before, that reached ARM and came back a raw 400.
    const calls = stubAcaEstate(['Consumption', 'D8']);
    const { POST } = await import('@/app/api/admin/scaling/container-apps/route');
    const r = await POST(makeReq('POST', { name: 'aca1', workloadProfileName: 'D4' }));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error).toMatch(/not declared by this app's managed environment/);
    expect(j.error).toMatch(/The environment declares: Consumption, D8/);
    // …and nothing was PATCHed.
    expect(calls.mock.calls.some((c: any[]) => c[1]?.method === 'PATCH')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #4279 — SCALE-TO-ZERO THROUGH THIS ROUTE, DECIDED BY THE DEPLOY TEMPLATE
//
// The route accepted `minReplicas: 0` for ANY app: the only replica check was
// `< 0`, so zero — the one destructive value — passed straight to an ARM PATCH.
// That is the same unrecoverable loss the Brain executor was guarded against in
// #4257/#4261, reached through a door that predates the executor.
//
// These arms exercise the REAL committed deploy-templates/main.json (vitest cwd
// is apps/fiab-console, which is where `resolveDlzTemplateInlineOutcome` looks),
// so they are a real-data receipt, not a fixture agreeing with itself.
// ---------------------------------------------------------------------------
describe('POST /api/admin/scaling/container-apps — scale-to-zero (#4279)', () => {
  /** Stub `fetch` so ANY ARM call fails the test AND is recorded. */
  function forbidArm(): string[] {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: any) => {
      seen.push(String(u));
      throw new Error('no ARM call may be made for a refused scale-to-zero');
    }));
    return seen;
  }

  it('REFUSES a declared non-scalable app (loom-risingwave) before any ARM call', async () => {
    const seen = forbidArm();
    const { POST } = await import('@/app/api/admin/scaling/container-apps/route');
    const r = await POST(makeReq('POST', { name: 'loom-risingwave', minReplicas: 0, maxReplicas: 1 }));
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.ok).toBe(false);
    expect(j.refusal).toBe('pinned-singleton');
    // The bicep's OWN words reach the operator, not a paraphrase.
    expect(j.error).toMatch(/materialized view/i);
    // Nothing was attempted in Azure.
    expect(seen).toEqual([]);
  });

  it('THE CONTROL: an elastic app the deploy wires nothing to is still PERMITTED', async () => {
    // Without this arm, a guard that refused EVERYTHING would be
    // indistinguishable from a correct one — and on an estate that already
    // refuses plenty for other reasons, that failure mode is invisible.
    stubAcaEstate(['Consumption', 'D4']);
    const { POST } = await import('@/app/api/admin/scaling/container-apps/route');
    const r = await POST(makeReq('POST', { name: 'loom-presidio-analyzer', minReplicas: 0, maxReplicas: 3 }));
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
  });

  it('REFUSES when the declaration source cannot be READ — fail closed', async () => {
    // The DIFFERENTIAL that makes this arm mean something: the subject is the
    // very app the control above PERMITS. The only thing changed is that the
    // template read fails, so a refusal here can only have come from that.
    vi.resetModules();
    vi.doMock('@/lib/setup/user-arm-deploy', async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      resolveDlzTemplateInlineOutcome: () => ({
        status: 'unreadable',
        file: '/app/deploy-templates/main.json',
        detail: 'read failed (EIO): simulated transient IO failure',
      }),
    }));
    const seen = forbidArm();
    const { POST } = await import('@/app/api/admin/scaling/container-apps/route');
    const r = await POST(makeReq('POST', { name: 'loom-presidio-analyzer', minReplicas: 0 }));
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.refusal).toBe('declaration-unavailable');
    // R7: it says it could not establish the fact — it does NOT claim the app
    // is unsafe, and it does not claim it is safe either.
    expect(j.error).toMatch(/could not be consulted/);
    expect(j.error).toMatch(/fail-CLOSED/);
    expect(seen).toEqual([]);
    vi.doUnmock('@/lib/setup/user-arm-deploy');
  });

  it('the console may not scale ITSELF to zero', async () => {
    const seen = forbidArm();
    const { POST } = await import('@/app/api/admin/scaling/container-apps/route');
    const r = await POST(makeReq('POST', { name: 'loom-console', minReplicas: 0 }));
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.refusal).toBe('self');
    expect(j.error).toMatch(/THIS CONSOLE/);
    expect(seen).toEqual([]);
  });

  it('honours LOOM_CONSOLE_APP_NAME for the self-refusal', async () => {
    process.env.LOOM_CONSOLE_APP_NAME = 'loom-console-gov';
    try {
      const seen = forbidArm();
      const { POST } = await import('@/app/api/admin/scaling/container-apps/route');
      const r = await POST(makeReq('POST', { name: 'loom-console-gov', minReplicas: 0 }));
      expect(r.status).toBe(409);
      expect((await r.json()).refusal).toBe('self');
      expect(seen).toEqual([]);
    } finally {
      delete process.env.LOOM_CONSOLE_APP_NAME;
    }
  });

  it('a STRING minReplicas cannot step around the guard', async () => {
    // The narrow bypass the old `typeof === 'number'` shape check left open:
    // '0' is not a number, so it missed BOTH the negative test and a `=== 0`
    // guard, and reached ARM as a scale-to-zero in string clothing.
    const seen = forbidArm();
    const { POST } = await import('@/app/api/admin/scaling/container-apps/route');
    const r = await POST(makeReq('POST', { name: 'loom-risingwave', minReplicas: '0' }));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/non-negative integer/);
    expect(seen).toEqual([]);
  });

  it('the guard is keyed to ZERO, not to the app: min 1 on the pinned app still works', async () => {
    // Over-refusal control. Raising or holding the floor on loom-risingwave is
    // a legitimate operation and must remain one — only zero is refused.
    stubAcaEstate(['Consumption', 'D4']);
    const { POST } = await import('@/app/api/admin/scaling/container-apps/route');
    const r = await POST(makeReq('POST', { name: 'loom-risingwave', minReplicas: 1, maxReplicas: 1 }));
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
  });
});

describe('unauthenticated', () => {
  it('returns 401 from every POST when session missing', async () => {
    vi.doMock('@/lib/auth/session', () => ({ getSession: vi.fn(() => null) }));
    vi.resetModules();
    const { POST } = await import('@/app/api/admin/scaling/capacity/route');
    const r = await POST(makeReq('POST', { resourceId: '/x', sku: 'F8' }));
    expect(r.status).toBe(401);
  });
});

// Azure-native compute panel behind Admin → Capacity & compute → "Scale & manage".
// The route dynamically imports its ARM clients, so each test vi.doMock's the
// specific client before importing the handler (afterEach resets the registry).
const validSession = () => ({ getSession: vi.fn(() => ({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 })) });

describe('POST /api/admin/scaling/compute', () => {
  it('rejects an unsupported kind/action', async () => {
    vi.doMock('@/lib/auth/session', validSession);
    const { POST } = await import('@/app/api/admin/scaling/compute/route');
    const r = await POST(makeReq('POST', { kind: 'nope', action: 'scale' }));
    expect(r.status).toBe(400);
  });

  it('requires a sku for an ADX scale', async () => {
    vi.doMock('@/lib/auth/session', validSession);
    const { POST } = await import('@/app/api/admin/scaling/compute/route');
    const r = await POST(makeReq('POST', { kind: 'adx', action: 'scale' }));
    expect(r.status).toBe(400);
  });

  it('scales ADX to a new SKU via updateKustoClusterSku', async () => {
    vi.doMock('@/lib/auth/session', validSession);
    const updateKustoClusterSku = vi.fn(async () => ({ state: 'Updating' }));
    vi.doMock('@/lib/azure/kusto-arm-client', () => ({ updateKustoClusterSku }));
    const { POST } = await import('@/app/api/admin/scaling/compute/route');
    const r = await POST(makeReq('POST', { kind: 'adx', action: 'scale', sku: 'Standard_E4ads_v5' }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.kind).toBe('adx');
    expect(updateKustoClusterSku).toHaveBeenCalledWith('Standard_E4ads_v5', undefined);
  });

  it('pauses and resumes the Synapse dedicated pool', async () => {
    vi.doMock('@/lib/auth/session', validSession);
    const pausePool = vi.fn(async () => {});
    const resumePool = vi.fn(async () => {});
    vi.doMock('@/lib/azure/synapse-pool-arm', () => ({ pausePool, resumePool }));
    const { POST } = await import('@/app/api/admin/scaling/compute/route');
    const pr = await POST(makeReq('POST', { kind: 'synapse-pool', action: 'pause' }));
    expect(pr.status).toBe(200);
    expect(pausePool).toHaveBeenCalledTimes(1);
    const rr = await POST(makeReq('POST', { kind: 'synapse-pool', action: 'resume' }));
    expect(rr.status).toBe(200);
    expect(resumePool).toHaveBeenCalledTimes(1);
  });

  it('scales the SHIR VMSS to a node count via scaleVmss', async () => {
    vi.doMock('@/lib/auth/session', validSession);
    const scaleVmss = vi.fn(async () => {});
    vi.doMock('@/lib/azure/vmss-client', () => ({
      shirVmssConfig: () => ({ subscriptionId: 's', resourceGroup: 'rg', name: 'vmss-shir' }),
      purviewShirVmssConfig: () => null,
      scaleVmss,
    }));
    const { POST } = await import('@/app/api/admin/scaling/compute/route');
    const r = await POST(makeReq('POST', { kind: 'shir-vmss', action: 'scale', capacity: 4 }));
    expect(r.status).toBe(200);
    expect(scaleVmss).toHaveBeenCalledWith(expect.objectContaining({ name: 'vmss-shir' }), 4);
  });

  it('returns an honest 400 when the SHIR VMSS is not configured', async () => {
    vi.doMock('@/lib/auth/session', validSession);
    vi.doMock('@/lib/azure/vmss-client', () => ({
      shirVmssConfig: () => null,
      purviewShirVmssConfig: () => null,
      scaleVmss: vi.fn(),
    }));
    const { POST } = await import('@/app/api/admin/scaling/compute/route');
    const r = await POST(makeReq('POST', { kind: 'shir-vmss', action: 'scale', capacity: 4 }));
    expect(r.status).toBe(400);
  });

  it('returns 401 when unauthenticated', async () => {
    vi.doMock('@/lib/auth/session', () => ({ getSession: vi.fn(() => null) }));
    const { POST } = await import('@/app/api/admin/scaling/compute/route');
    const r = await POST(makeReq('POST', { kind: 'adx', action: 'scale', sku: 'x' }));
    expect(r.status).toBe(401);
  });
});

describe('GET /api/admin/scaling/compute', () => {
  it('lists the configured Azure-native scalable compute (best-effort probes)', async () => {
    vi.doMock('@/lib/auth/session', validSession);
    vi.doMock('@/lib/azure/kusto-arm-client', () => ({
      getKustoClusterArm: vi.fn(async () => ({ name: 'adx', sku: { name: 'Standard_E4ads_v5', capacity: 2 }, state: 'Running' })),
    }));
    vi.doMock('@/lib/azure/synapse-pool-arm', () => ({
      getPoolState: vi.fn(async () => ({ state: 'Online', sku: 'DW100c', status: 'Online' })),
    }));
    vi.doMock('@/lib/azure/vmss-client', () => ({
      shirVmssConfig: () => null,
      purviewShirVmssConfig: () => null,
      getVmssStatus: vi.fn(),
    }));
    const { GET } = await import('@/app/api/admin/scaling/compute/route');
    const r = await GET();
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(Array.isArray(j.resources)).toBe(true);
    const adx = j.resources.find((x: any) => x.kind === 'adx');
    expect(adx).toBeTruthy();
    expect(adx.skuOptions.length).toBeGreaterThan(0);
  });

  it('returns 401 when unauthenticated', async () => {
    vi.doMock('@/lib/auth/session', () => ({ getSession: vi.fn(() => null) }));
    const { GET } = await import('@/app/api/admin/scaling/compute/route');
    const r = await GET();
    expect(r.status).toBe(401);
  });
});
