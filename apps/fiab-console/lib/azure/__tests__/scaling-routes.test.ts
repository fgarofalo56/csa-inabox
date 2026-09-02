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

  it('REFUSES a declared CONSUMER (loom-trino) — the kind that carries 16 of the 19 apps', async () => {
    // WHY THIS ARM EXISTS. `pinned-singleton` above is a DURABILITY refusal and
    // it had a fixture; `declared-consumer` is the AVAILABILITY refusal and it
    // had none. MEASURED against the real committed template, the split is:
    //
    //   loom-risingwave  -> pinned-singleton     loom-trino -> declared-consumer
    //   iceberg-catalog  -> pinned-singleton     loom-unity -> declared-consumer
    //
    // `declared-consumer` accounts for 16 of the 19 newly-refused apps, and it
    // is the ONLY thing protecting loom-trino and loom-unity — the two this PR
    // names as the mitigation for defect 4293. Deleting that branch
    // (`if (refusal && refusal.kind !== 'declared-consumer')`) left the suite
    // 41/41 GREEN, so the mitigation the PR claims had no control at all.
    const seen = forbidArm();
    const { POST } = await import('@/app/api/admin/scaling/container-apps/route');
    const r = await POST(makeReq('POST', { name: 'loom-trino', minReplicas: 0 }));
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.ok).toBe(false);
    expect(j.refusal).toBe('declared-consumer');
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
    // …and it names WHICH of the four unavailable reasons this is. Without this
    // line the arm passed for an ACCIDENTAL reason and it was MEASURED: mutate
    // the route to `refuseScaleToZero(body.name, deployDeclaredScalability())`
    // — dropping the SOURCE for a bare Map, which discards `unnamed` and
    // disarms the `name-unresolved` refusal entirely — and the failed read
    // arrives as an EMPTY map instead, producing `why:'empty'`. Both branches
    // share `head` and `tail`, so both matched every assertion above and the
    // mutation left 41/41 green. `EXISTS and could not be read` appears only in
    // the `unreadable` branch, so it is what makes this a control.
    expect(j.error).toMatch(/EXISTS and could not be read or parsed/);
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

  it('REFUSES a subject SHADOWED by an app name the reader could not resolve', async () => {
    // The fourth `declaration-unavailable` reason, and the only one reachable on
    // a HEALTHY template: the dlz-attach gateway declares its name as
    // `[take(format('loom-s3-gateway-{0}', …), 32)]`, so it has no key in the
    // derived map and `loom-s3-gateway-*` not being there establishes nothing.
    //
    // This arm is what makes the SOURCE argument load-bearing rather than
    // stylistic. `refuseScaleToZero` accepts either a ScalabilitySource or a
    // bare Map, and the bare-Map path hard-codes `unnamed: []` — so passing
    // `deployDeclaredScalability()` instead of the source silently deletes this
    // refusal while leaving every other arm green.
    const seen = forbidArm();
    const { POST } = await import('@/app/api/admin/scaling/container-apps/route');
    const r = await POST(makeReq('POST', { name: 'loom-s3-gateway-abc123', minReplicas: 0 }));
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.refusal).toBe('declaration-unavailable');
    // R7 again, and this branch's own words — NOT the `unreadable` ones.
    expect(j.error).toMatch(/app NAME is computed at deploy time/);
    expect(j.error).toMatch(/is a claim that the question could not be answered/);
    // …and it names the module that shadows this subject, so the operator can
    // see WHY the answer was unavailable rather than being told it just was.
    expect(j.error).toMatch(/loom-s3-gateway-\{0\}/);
    expect(seen).toEqual([]);
  });

  // ── REVIEW FINDING 1 — THE GUARD JUDGED A NAME THE TRANSPORT REWROTE ───────
  //
  // `refuseScaleToZero` decides on `name.trim().toLowerCase()`; the same string
  // is then interpolated into an ARM URL and handed to `fetch`, whose WHATWG URL
  // parser resolves `.`/`..` segments before the request leaves. MEASURED on the
  // pre-fix code with fetch stubbed:
  //
  //   { name: 'loom-x/../loom-risingwave', minReplicas: 0 } -> 200,
  //     PATCH …/containerApps/loom-risingwave {"scale":{"minReplicas":0,…}}
  //   { name: 'loom-risingwave',           minReplicas: 0 } -> 409, 0 ARM calls
  //
  // Same resource, opposite outcome. Every arm above asserts something about a
  // name-keyed decision, so without these two the whole file was pinning a guard
  // that could be addressed around.

  it('a PATH-TRAVERSAL name cannot reach the app it canonicalizes to', async () => {
    const seen = forbidArm();
    const { POST } = await import('@/app/api/admin/scaling/container-apps/route');
    const r = await POST(makeReq('POST', { name: 'loom-x/../loom-risingwave', minReplicas: 0, maxReplicas: 1 }));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/letters, digits or hyphens/);
    expect(seen).toEqual([]);
  });

  it('a PERCENT-ESCAPED name is refused here rather than decoded downstream', async () => {
    // Deliberately NOT asserting what ARM does with `%2D`. Whether the service
    // percent-decodes the segment was never verified, and the guard does not
    // need it to be: a name that is not byte-identical to what the refusal table
    // was keyed on is refused because the equivalence is UNESTABLISHED, which is
    // the same fail-closed posture as `declaration-unavailable` above.
    //
    // This arm is keyed to the OUTCOME, not to a layer, and that is deliberate —
    // it is the one arm here that survives removing EITHER the route gate or the
    // `appUrl` guard alone, because the other layer still catches it. It dies
    // only when both are gone (MEASURED: mutation M5). A layer-keyed assertion
    // would have gone red on a refactor that moved the check without weakening
    // it, and would have gone green on one that moved it somewhere unreachable.
    const seen = forbidArm();
    const { POST } = await import('@/app/api/admin/scaling/container-apps/route');
    const r = await POST(makeReq('POST', { name: 'loom%2Drisingwave', minReplicas: 0 }));
    expect(r.status).toBe(400);
    expect(seen).toEqual([]);
  });

  it('a TRUTHY NON-STRING name is a 400, not an unhandled 500', async () => {
    // `if (!body?.name)` only caught a FALSY name. `123` passed it, reached
    // `.trim()` inside `refuseScaleToZero` — which runs OUTSIDE this handler's
    // try/catch — and threw unhandled. A malformed request answered with a 500
    // tells the operator the platform broke; it did not.
    const seen = forbidArm();
    const { POST } = await import('@/app/api/admin/scaling/container-apps/route');
    for (const name of [123, {}, ['loom-risingwave'], true]) {
      const r = await POST(makeReq('POST', { name, minReplicas: 0 }));
      expect(r.status, `name: ${JSON.stringify(name)}`).toBe(400);
    }
    expect(seen).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE SAME INVARIANT AT THE CHOKE POINT (#4279 review, finding 1 + finding 5)
//
// The route gate above stops this ONE door. `appUrl` in
// container-apps-arm-client.ts is where the URL is actually built, and EIGHT
// functions reach it with a caller-supplied name — including
// `deployMcpContainerApp` and `createMcpContainerApp`, which issue full-resource
// PUTs, strictly worse than the scale PATCH this PR is about. Only
// `getMcpContainerAppStatus` and `deleteMcpContainerApp` were guarded.
//
// This block is what distinguishes "the route was fixed" from "the class was
// closed": delete the guard inside `appUrl` and the route arms above stay green.
// ---------------------------------------------------------------------------
describe('container-apps ARM client — the app name cannot be canonicalized away', () => {
  const TRAVERSAL = 'loom-x/../loom-risingwave';

  /** Stub `fetch` so ANY ARM call is recorded and fails the assertion below. */
  function forbidArmCalls(): string[] {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: any) => {
      seen.push(String(u));
      throw new Error('no ARM call may be made for a name that cannot be trusted');
    }));
    return seen;
  }

  it('updateContainerAppScale refuses a traversal name before any ARM call', async () => {
    const seen = forbidArmCalls();
    const { updateContainerAppScale, AcaArmError } = await import('@/lib/azure/container-apps-arm-client');
    await expect(updateContainerAppScale(TRAVERSAL, { minReplicas: 0, maxReplicas: 1 }))
      .rejects.toMatchObject({ constructor: AcaArmError, status: 400 });
    expect(seen).toEqual([]);
  });

  it('the PUT paths inherit it — createMcpContainerApp refuses the same name', async () => {
    // The two full-resource PUTs are why the guard belongs in `appUrl` rather
    // than in `updateContainerAppScale`: a per-caller fix would have left them.
    //
    // The opts here are COMPLETE on purpose. An earlier draft of this arm called
    // `createMcpContainerApp(TRAVERSAL, {...})` — the wrong arity, since it takes
    // a single opts object — so `opts.secrets.map` threw a TypeError and the arm
    // passed on `.rejects.toThrow()` without ever reaching `appUrl`. It survived
    // the mutation it claims to kill, which is the whole failure mode this file
    // exists to prevent. Asserting the STATUS is what closed it.
    const seen = forbidArmCalls();
    const { createMcpContainerApp, AcaArmError } = await import('@/lib/azure/container-apps-arm-client');
    await expect(createMcpContainerApp({
      name: TRAVERSAL,
      image: 'acr.azurecr.io/mcp-x:1',
      location: 'centralus',
      environmentId: ACA_ENV_ID,
      uamiId: '/subscriptions/sub-1/resourceGroups/rg-admin/providers/Microsoft.ManagedIdentity/userAssignedIdentities/uami',
      targetPort: 8080,
      env: [],
      secrets: [],
    } as any)).rejects.toMatchObject({ constructor: AcaArmError, status: 400 });
    expect(seen).toEqual([]);
  });

  it('THE CONTROL: an ordinary name is NOT refused — the guard is a charset, not a denylist', async () => {
    // Over-refusal control. `appUrl` deliberately does not re-implement Azure's
    // 2-32/lowercase/ends-alphanumeric naming rule: ARM owns that, and forking it
    // here would create the second source of truth `cloud-parity.md` warns about.
    // The guard's only job is that raw and canonical are the same string.
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: any) => {
      seen.push(String(u));
      return new Response(JSON.stringify({ name: 'x' }), { status: 500 });
    }));
    const { updateContainerAppScale } = await import('@/lib/azure/container-apps-arm-client');
    // It fails — the stub answers 500 — but it fails HAVING CALLED ARM, which is
    // what proves the name was admitted rather than rejected by the guard.
    await expect(updateContainerAppScale('loom-presidio-analyzer', { minReplicas: 1, maxReplicas: 2 })).rejects.toThrow();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toContain('/containerApps/loom-presidio-analyzer');
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
