/**
 * BFF contract tests for /api/admin/estate/{state,pause,resume}.
 *
 * ── WHY THIS FILE USES THE **REAL** route-toolkit ──────────────────────────
 * Several route suites in this repo mock `@/lib/api/route-toolkit` and
 * re-implement `withTenantAdmin` inline. That is convenient and it makes the
 * authorization mutation-proof MEANINGLESS: deleting the real
 * `if (gate) return gate;` line in `lib/api/route-toolkit.ts:169` would not
 * move a single assertion, because the tests would still be exercising their
 * own copy.
 *
 * So this file mocks ONLY `@/lib/auth/session` (to mint a session) and
 * `@/lib/auth/feature-gate` (to control the admin verdict), and lets the REAL
 * `withTenantAdmin` run. The mutation receipt in the PR body is therefore
 * measured against the code that actually ships.
 *
 * ── AND WHY IT MOCKS THE ORCHESTRATOR'S AZURE SIDE, NOT ITS LOGIC ─────────
 * `createArmActuator`, `loadPauseSnapshot` and `savePauseSnapshot` are mocked
 * because they are the network. `planPause`, `startPause`, `pollResume`,
 * `previewToken` and the scope resolver underneath them are NOT mocked — the
 * routes are asserted against the real decisions, so a scope regression fails
 * here as well as in the unit suite.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Auth seams (the ONLY auth mocking) ------------------------------------
const getSession = vi.fn();
const requireTenantAdmin = vi.fn(() => null as unknown);
vi.mock('@/lib/auth/session', async () => ({
  ...(await vi.importActual<typeof import('@/lib/auth/session')>('@/lib/auth/session')),
  getSession: () => getSession(),
}));
vi.mock('@/lib/auth/feature-gate', () => ({
  requireTenantAdmin: (...a: unknown[]) => requireTenantAdmin(...(a as [])),
  enforceCapability: vi.fn(async () => null),
}));

// --- Audit sinks: inert, but asserted ---------------------------------------
const auditCreate = vi.fn(async (doc: unknown) => ({ resource: doc }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  auditLogContainer: vi.fn(async () => ({ items: { create: auditCreate } })),
  maintenanceJobsContainer: vi.fn(async () => ({
    items: { upsert: vi.fn(async (d: unknown) => ({ resource: d })) },
    item: () => ({ read: async () => ({ resource: undefined }) }),
  })),
}));
const emitAuditEvent = vi.fn();
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: (...a: unknown[]) => emitAuditEvent(...a) }));

// --- The orchestrator's NETWORK edge only -----------------------------------
const createArmActuator = vi.fn();
const loadPauseSnapshot = vi.fn(async () => null as unknown);
const savePauseSnapshot = vi.fn(async (_snap?: unknown) => {});
const resolveDeployManifest = vi.fn();
vi.mock('@/lib/estate/pause-orchestrator', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/estate/pause-orchestrator')>();
  return {
    ...real,
    createArmActuator: (...a: unknown[]) => createArmActuator(...a),
    loadPauseSnapshot: (...a: unknown[]) => loadPauseSnapshot(...(a as [])),
    savePauseSnapshot: (...a: unknown[]) => savePauseSnapshot(...(a as [])),
    resolveDeployManifest: (...a: unknown[]) => resolveDeployManifest(...a),
  };
});

import { armPowerReading, type EstatePauseSnapshot, type EstatePowerState } from '@/lib/estate/pause-state';
import { previewToken } from '@/lib/estate/pause-orchestrator';

const ADMIN = {
  claims: { oid: 'admin-oid', upn: 'admin@contoso.com', tid: 'tenant-1' },
  exp: 9_999_999_999,
};
const ESTATE = 'loom:estate-a';
const SUB = 'sub-a';
const POOL_ID = `/subscriptions/${SUB}/resourceGroups/rg-dlz-aiml-stack-dev/providers/Microsoft.Synapse/workspaces/syn-ws/sqlPools/pool1`;
const ADX_ID = `/subscriptions/${SUB}/resourceGroups/rg-shared-mixed-dev/providers/Microsoft.Kusto/clusters/adx-loom-shared`;
const AAS_ID = `/subscriptions/${SUB}/resourceGroups/rg-shared-mixed-dev/providers/Microsoft.AnalysisServices/servers/aas-loom`;
const VMSS_ID = `/subscriptions/${SUB}/resourceGroups/rg-shared-mixed-dev/providers/Microsoft.Compute/virtualMachineScaleSets/vmss-shir`;

/**
 * The four ids in the order the deploy resolves them. Indexed so a case can ask
 * for an estate of ANY cardinality — see the arming-gate cardinality case, which
 * exists because coverage pinned to a single fixture size cannot see a
 * weakening conditioned on a DIFFERENT size.
 */
const ALL_IDS = [POOL_ID, ADX_ID, AAS_ID, VMSS_ID];

function typeOf(resourceId: string): string {
  if (resourceId.includes('/sqlPools/')) return 'microsoft.synapse/workspaces/sqlpools';
  if (resourceId.includes('/clusters/')) return 'microsoft.kusto/clusters';
  if (resourceId.includes('/servers/')) return 'microsoft.analysisservices/servers';
  return 'microsoft.compute/virtualmachinescalesets';
}

/** The deploy manifest the console's env would produce on the live estate. */
function manifestFixture(ids: string[] = [POOL_ID, ADX_ID]) {
  const entries = ids.map((resourceId) => ({
    resourceId,
    resourceType: typeOf(resourceId),
    name: resourceId.split('/').pop()!,
    resourceGroup: resourceId.split('/resourceGroups/')[1].split('/')[0],
    subscriptionId: SUB,
    fromEnv: ['LOOM_SUBSCRIPTION_ID'],
  }));
  return {
    manifest: { estateId: ESTATE, resourceIds: ids },
    entries,
    unresolved: [{ label: 'Azure Analysis Services server', needs: ['LOOM_AAS_SERVER_NAME'] }],
    // ARMED. The default fixture exercises the working path; the not-armed
    // fixture below is used explicitly by the gate cases.
    manifestGated: false,
    namedByDeploy: ids.length,
  };
}

/**
 * The UNARMED shape — what `resolveDeployManifest` returns on a real console
 * today: the deploy NAMES the resources, and the manifest grants nothing.
 */
function unarmedManifestFixture(ids: string[] = [POOL_ID, ADX_ID]) {
  const armed = manifestFixture(ids);
  return {
    ...armed,
    manifest: { estateId: ESTATE, resourceIds: [] },
    manifestGated: true,
    namedByDeploy: ids.length,
    gateReason:
      `The deploy environment NAMES ${ids.length} resource(s) this Loom install is bound to, and `
      + 'manifest ownership alone would be enough to pause them. That path is held behind '
      + 'LOOM_ESTATE_PAUSE_ENABLED, which is not set, so nothing can be paused.',
  };
}

interface ActuatorOpts {
  tags?: Record<string, string> | null;
  power?: (id: string) => EstatePowerState;
  pauseOk?: boolean;
  pauseError?: string;
  resumeOk?: boolean;
  resumeError?: string;
  servable?: boolean;
}

function fakeActuator(o: ActuatorOpts = {}) {
  const touched: string[] = [];
  return {
    touched,
    actuator: {
      readTags: vi.fn(async () => (o.tags === undefined ? { 'loom-estate-id': ESTATE } : o.tags)),
      readPower: vi.fn(async (r: { resourceId: string }) => ({
        reading: armPowerReading({
          resourceId: r.resourceId,
          powerState: o.power ? o.power(r.resourceId) : 'Online',
          armApiVersion: '2021-06-01',
        }),
        sku: { name: 'DW100c', capacity: 100 },
      })),
      pause: vi.fn(async (c: { resource: { resourceId: string; name: string } }) => {
        touched.push(c.resource.resourceId);
        return o.pauseOk === false
          ? { ok: false, detail: 'rejected', error: o.pauseError ?? 'ARM 500' }
          : { ok: true, detail: `paused ${c.resource.name}` };
      }),
      resume: vi.fn(async (e: { resourceId: string; name: string }) => {
        touched.push(e.resourceId);
        return o.resumeOk === false
          ? { ok: false, detail: 'rejected', error: o.resumeError ?? 'ARM 500' }
          : { ok: true, detail: `resumed ${e.name}` };
      }),
      probeServable: vi.fn(async () => ({
        servable: o.servable !== false,
        probed: true,
        detail: o.servable === false ? 'the probe did not succeed' : 'answered',
      })),
    },
  };
}

const post = (body: unknown = {}) =>
  ({ json: async () => body, nextUrl: new URL('http://x/api/admin/estate/pause') }) as never;
const get = () => ({ nextUrl: new URL('http://x/api/admin/estate/state') }) as never;

function pausedSnapshotFixture(over?: Partial<EstatePauseSnapshot>): EstatePauseSnapshot {
  return {
    id: 'snap-1',
    tenantId: 'tenant-1',
    schemaVersion: 1,
    estateId: ESTATE,
    state: 'PAUSED',
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T00:05:00.000Z',
    pausedAt: '2026-08-23T00:05:00.000Z',
    resources: [POOL_ID, ADX_ID].map((resourceId) => ({
      resourceId,
      resourceType: resourceId.includes('/sqlPools/')
        ? 'microsoft.synapse/workspaces/sqlpools'
        : 'microsoft.kusto/clusters',
      name: resourceId.split('/').pop()!,
      resourceGroup: 'rg',
      subscriptionId: SUB,
      prePausePowerState: 'Online' as const,
      powerStateSource: 'arm' as const,
      powerStateReadAt: '2026-08-23T00:00:00.000Z',
      powerStateApiVersion: '2021-06-01',
      ownership: { verdict: 'loom-owned' as const, source: 'ownership-tag' as const, reason: 'tagged' },
    })),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockReturnValue(ADMIN);
  requireTenantAdmin.mockReturnValue(null);
  loadPauseSnapshot.mockResolvedValue(null);
  resolveDeployManifest.mockReturnValue(manifestFixture());
  createArmActuator.mockResolvedValue(fakeActuator().actuator);
});

// ===========================================================================
// AUTHORIZATION — the mutation target
// ===========================================================================

describe('authorization (the REAL withTenantAdmin from lib/api/route-toolkit)', () => {
  /**
   * THE AUTHZ MUTATION TARGET.
   *
   * Delete `if (gate) return gate;` from `withTenantAdmin`
   * (lib/api/route-toolkit.ts:169) and every case in this block goes RED,
   * because the handler runs for a caller `requireTenantAdmin` refused. That
   * line IS the authorization: `requireTenantAdmin` returns `NextResponse |
   * null`, so the check is the caller's use of the return value, and the call
   * itself stays in the file — which is why every text-matching route-guard
   * checker stayed green when it was deleted on 2026-08-07.
   */
  const routes: Array<[string, () => Promise<{ GET?: unknown; POST?: unknown }>, 'GET' | 'POST']> = [
    ['GET /state', () => import('../state/route'), 'GET'],
    ['POST /pause', () => import('../pause/route'), 'POST'],
    ['POST /resume', () => import('../resume/route'), 'POST'],
  ];

  for (const [label, load, verb] of routes) {
    it(`${label} — a NON-admin is refused with the gate's own 403, and NOTHING is actuated`, async () => {
      const forbidden = new Response(JSON.stringify({ ok: false, error: 'admin_only' }), { status: 403 });
      requireTenantAdmin.mockReturnValue(forbidden);
      const mod = (await load()) as Record<string, (r: unknown, c?: unknown) => Promise<Response>>;
      const res = await mod[verb](verb === 'GET' ? get() : post({ confirm: ESTATE }), { params: Promise.resolve({}) });
      expect(res.status).toBe(403);
      // The gate ran BEFORE any Azure work.
      expect(createArmActuator).not.toHaveBeenCalled();
      expect(savePauseSnapshot).not.toHaveBeenCalled();
    });

    it(`${label} — an UNAUTHENTICATED caller gets 401 before the admin check`, async () => {
      getSession.mockReturnValue(null);
      const mod = (await load()) as Record<string, (r: unknown, c?: unknown) => Promise<Response>>;
      const res = await mod[verb](verb === 'GET' ? get() : post({ confirm: ESTATE }), { params: Promise.resolve({}) });
      expect(res.status).toBe(401);
      expect(requireTenantAdmin).not.toHaveBeenCalled();
      expect(createArmActuator).not.toHaveBeenCalled();
    });
  }

  it('the admin gate is consulted with the SESSION, not with a constant', async () => {
    const { GET } = await import('../state/route');
    await GET(get(), { params: Promise.resolve({}) } as never);
    expect(requireTenantAdmin).toHaveBeenCalledWith(ADMIN);
  });
});

// ===========================================================================
// GET /state
// ===========================================================================

describe('GET /api/admin/estate/state', () => {
  it('returns the dry-run preview, the population report, and a confirm token', async () => {
    const { GET } = await import('../state/route');
    const res = await GET(get(), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.state).toBe('RUNNING');
    expect(j.preview.wouldPause).toHaveLength(2);
    expect(j.population.pausable).toBe(2);
    expect(j.confirmToken).toBe(previewToken([POOL_ID, ADX_ID]));
    // The envelope SPREADS its fields — it does not nest them under `data`.
    expect(j.data).toBeUndefined();
  });

  it('surfaces the resume RISK per resource before any pause is confirmed (R-CAP-3)', async () => {
    const { GET } = await import('../state/route');
    const j = await (await GET(get(), { params: Promise.resolve({}) } as never)).json();
    expect(j.highRisk).toBe(2);
    expect(j.risks.every((r: { statement: string }) => /Azure does not reserve it/.test(r.statement))).toBe(true);
  });

  it('reports the coverage gap: tier types no env var named', async () => {
    const { GET } = await import('../state/route');
    const j = await (await GET(get(), { params: Promise.resolve({}) } as never)).json();
    expect(j.unresolved[0].needs).toContain('LOOM_AAS_SERVER_NAME');
  });

  it('an untagged, unmanifested estate reports EMPTY and says WHY (#3922)', async () => {
    resolveDeployManifest.mockReturnValue({
      manifest: { estateId: ESTATE, resourceIds: [] },
      entries: [],
      unresolved: [],
      manifestGated: false,
      namedByDeploy: 0,
    });
    const { GET } = await import('../state/route');
    const j = await (await GET(get(), { params: Promise.resolve({}) } as never)).json();
    expect(j.population.empty).toBe(true);
    expect(j.population.statement).toMatch(/NOTHING would be paused/);
    expect(j.preview.wouldPause).toEqual([]);
  });

  it('NOT ARMED: reports armed:false and the named count, so the UI can disable Pause', async () => {
    resolveDeployManifest.mockReturnValue(unarmedManifestFixture());
    const { GET } = await import('../state/route');
    const j = await (await GET(get(), { params: Promise.resolve({}) } as never)).json();
    expect(j.manifestGated).toBe(true);
    expect(j.population.armed).toBe(false);
    expect(j.population.namedByDeploy).toBe(2);
    // The distinction that matters: this is NOT "nothing exists", it is
    // "2 resources exist and the switch is off".
    expect(j.population.examined).toBe(2);
  });

  it('NOT ARMED with the tag stamped: the preview is POPULATED but the estate is still not armed', async () => {
    // Post-#3922 shape. The tag establishes ownership independently of the
    // manifest, so the preview fills in — and the arming switch must STILL hold,
    // because the reasons it exists (no live receipt, R-CAP-2 missing) have not
    // changed. The UI keys Pause off `armed`, not off the preview length.
    resolveDeployManifest.mockReturnValue(unarmedManifestFixture());
    const { GET } = await import('../state/route');
    const j = await (await GET(get(), { params: Promise.resolve({}) } as never)).json();
    expect(j.preview.wouldPause.length).toBe(2);      // tag-owned
    expect(j.population.armed).toBe(false);           // …and still not armed
  });

  it('reports the CLOUD boundary so an untested one is nameable', async () => {
    const { GET } = await import('../state/route');
    const j = await (await GET(get(), { params: Promise.resolve({}) } as never)).json();
    expect(typeof j.cloud).toBe('string');
    expect(j.cloud.length).toBeGreaterThan(0);
  });

  it('reports the LIVE SKU with the resume risk (R-CAP-3), not an empty field', async () => {
    const { GET } = await import('../state/route');
    const j = await (await GET(get(), { params: Promise.resolve({}) } as never)).json();
    expect(j.risks).toHaveLength(2);
    // The field documented as "the SKU that must be RE-ACQUIRED on resume" is
    // actually populated, from an authoritative ARM read.
    expect(j.risks.every((r: { sku?: string }) => r.sku === 'DW100c')).toBe(true);
    expect(j.risks[0].statement).toContain('DW100c');
  });

  it('surfaces outOfTier so the Container Apps exclusion reaches the operator', async () => {
    const j = await (await (await import('../state/route')).GET(get(), { params: Promise.resolve({}) } as never)).json();
    expect(Array.isArray(j.outOfTier)).toBe(true);
  });

  it('an ARM gate is an HONEST 503, never a fabricated RUNNING', async () => {
    createArmActuator.mockRejectedValue(new Error('Failed to acquire ARM token'));
    const { GET } = await import('../state/route');
    const res = await GET(get(), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.error).toMatch(/NOT a statement that the estate is running or paused/);
  });

  it('polls a RESUMING snapshot and reports RESUME_FAILED when the probe fails', async () => {
    loadPauseSnapshot.mockResolvedValue(
      pausedSnapshotFixture({ state: 'RESUMING', resumeStartedAt: '2020-01-01T00:00:00.000Z' }),
    );
    createArmActuator.mockResolvedValue(fakeActuator({ servable: false }).actuator);
    const { GET } = await import('../state/route');
    const j = await (await GET(get(), { params: Promise.resolve({}) } as never)).json();
    expect(j.state).toBe('RESUME_FAILED');
    expect(j.summary.headline).toMatch(/not a display state/);
    expect(j.summary.details).toHaveLength(2);
  });

  it('polls a PAUSING snapshot and promotes it to PAUSED only on confirmed ARM reads', async () => {
    loadPauseSnapshot.mockResolvedValue(pausedSnapshotFixture({ state: 'PAUSING' }));
    createArmActuator.mockResolvedValue(fakeActuator({ power: () => 'Paused' }).actuator);
    const { GET } = await import('../state/route');
    const j = await (await GET(get(), { params: Promise.resolve({}) } as never)).json();
    expect(j.state).toBe('PAUSED');
    expect(j.confirmed).toBe(2);
    expect(savePauseSnapshot).toHaveBeenCalled();
  });
});

// ===========================================================================
// POST /pause
// ===========================================================================

describe('POST /api/admin/estate/pause', () => {
  it('refuses without the typed confirmation, and actuates NOTHING', async () => {
    const fake = fakeActuator();
    createArmActuator.mockResolvedValue(fake.actuator);
    const { POST } = await import('../pause/route');
    const res = await POST(post({}), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toMatch(/type the estate id/);
    expect(j.expected).toBe(ESTATE);
    expect(fake.touched).toEqual([]);
  });

  it('refuses a WRONG typed confirmation', async () => {
    const fake = fakeActuator();
    createArmActuator.mockResolvedValue(fake.actuator);
    const { POST } = await import('../pause/route');
    const res = await POST(post({ confirm: 'loom:some-other-estate' }), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(400);
    expect(fake.touched).toEqual([]);
  });

  it('409s when the resolved set DRIFTED from the preview the operator confirmed', async () => {
    const fake = fakeActuator();
    createArmActuator.mockResolvedValue(fake.actuator);
    const { POST } = await import('../pause/route');
    const res = await POST(
      post({ confirm: ESTATE, confirmToken: previewToken(['/some/other/resource']) }),
      { params: Promise.resolve({}) } as never,
    );
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.error).toMatch(/changed between the preview you confirmed and now/);
    expect(fake.touched).toEqual([]);
  });

  it('dispatches the pause and returns 202 PAUSING — never PAUSED', async () => {
    const fake = fakeActuator();
    createArmActuator.mockResolvedValue(fake.actuator);
    const { POST } = await import('../pause/route');
    const res = await POST(
      post({ confirm: ESTATE, confirmToken: previewToken([POOL_ID, ADX_ID]) }),
      { params: Promise.resolve({}) } as never,
    );
    expect(res.status).toBe(202);
    const j = await res.json();
    expect(j.state).toBe('PAUSING');
    expect(j.state).not.toBe('PAUSED');
    expect(fake.touched.sort()).toEqual([POOL_ID, ADX_ID].sort());
    expect(savePauseSnapshot).toHaveBeenCalledTimes(1);
    expect(j.monitorUrl).toBe('/api/admin/estate/state');
  });

  it('SCOPE: a resource re-tagged BETWEEN discovery and the mutation is NOT paused', async () => {
    // The tag says "ours" at discovery, so it enters the plan — and then says
    // "a DIFFERENT Loom estate" on the re-verify immediately before the ARM
    // call. R-SCOPE-3 leaves it running. This is the case a plan-time-only
    // check cannot catch, which is why the re-verify exists.
    const fake = fakeActuator();
    const reads = new Map<string, number>();
    fake.actuator.readTags = vi.fn(async (id: string) => {
      const n = (reads.get(id) ?? 0) + 1;
      reads.set(id, n);
      if (id === ADX_ID && n > 1) return { 'loom-estate-id': 'loom:estate-b' };
      return { 'loom-estate-id': ESTATE };
    }) as never;
    createArmActuator.mockResolvedValue(fake.actuator);
    const { POST } = await import('../pause/route');
    const res = await POST(post({ confirm: ESTATE }), { params: Promise.resolve({}) } as never);
    const j = await res.json();
    expect(res.status).toBe(202);
    expect(fake.touched).toEqual([POOL_ID]);
    const adx = j.actions.find((a: { resourceId: string }) => a.resourceId === ADX_ID);
    expect(adx.status).toBe('skipped');
    expect(adx.detail).toMatch(/Leaving it RUNNING/);
    // …and it is NOT in the snapshot, so a later resume cannot touch it either.
    const saved = savePauseSnapshot.mock.calls[0]?.[0] as unknown as EstatePauseSnapshot;
    expect(saved.resources.map((r) => r.resourceId)).toEqual([POOL_ID]);
  });

  it('SCOPE: a resource that is not ours at DISCOVERY never enters the plan at all', async () => {
    const fake = fakeActuator();
    fake.actuator.readTags = vi.fn(async (id: string) =>
      id === ADX_ID ? { 'loom-estate-id': 'loom:estate-b' } : { 'loom-estate-id': ESTATE },
    ) as never;
    createArmActuator.mockResolvedValue(fake.actuator);
    const { POST } = await import('../pause/route');
    const j = await (await POST(post({ confirm: ESTATE }), { params: Promise.resolve({}) } as never)).json();
    expect(fake.touched).toEqual([POOL_ID]);
    // Excluded before the plan, so there is no action row — but it is still
    // VISIBLE in the population, never silently dropped.
    expect(j.actions.map((a: { resourceId: string }) => a.resourceId)).toEqual([POOL_ID]);
    expect(j.population.notLoomOwned).toBe(1);
    expect(j.population.pausable).toBe(1);
  });

  it('SCOPE: the route NEVER ENUMERATES — it examines only what the deploy names', async () => {
    // This is the route-level scope property, and it is stronger than a filter:
    // there is no "list the resources in the subscription" call anywhere on this
    // path, so the twelve resources belonging to ten unrelated projects are not
    // spared by a rule — they are never asked about. `readTags` is the only
    // outward call, and it is issued for manifest ids and nothing else.
    const fake = fakeActuator();
    createArmActuator.mockResolvedValue(fake.actuator);
    const { POST } = await import('../pause/route');
    const j = await (await POST(post({ confirm: ESTATE }), { params: Promise.resolve({}) } as never)).json();
    const asked = (fake.actuator.readTags as unknown as { mock: { calls: string[][] } }).mock.calls.map((c) => c[0]);
    expect(new Set(asked)).toEqual(new Set([POOL_ID, ADX_ID]));
    expect(j.population.examined).toBe(2);
  });

  it('SCOPE: a manifest-named resource claimed by ANOTHER Loom estate is refused', async () => {
    // The manifest is a legitimate ownership source (PRP §3b R-SCOPE-3 admits a
    // deploy-emitted manifest alongside the tag), so it establishes ownership on
    // its own. What it must NOT do is override a POSITIVE statement that the
    // resource belongs to a different estate — that would let one Loom install
    // stop another's resources.
    const fake = fakeActuator();
    fake.actuator.readTags = vi.fn(async (id: string) =>
      id === ADX_ID ? { 'loom-estate-id': 'loom:estate-b' } : { 'loom-estate-id': ESTATE },
    ) as never;
    createArmActuator.mockResolvedValue(fake.actuator);
    const { POST } = await import('../pause/route');
    const j = await (await POST(post({ confirm: ESTATE }), { params: Promise.resolve({}) } as never)).json();
    expect(fake.touched).toEqual([POOL_ID]);
    expect(j.population.notLoomOwned).toBe(1);
    const saved = savePauseSnapshot.mock.calls[0]?.[0] as unknown as EstatePauseSnapshot;
    expect(saved.resources.map((r) => r.resourceId)).toEqual([POOL_ID]);
  });

  it('SCOPE: an UNREADABLE tag set leaves the resource RUNNING (never act on uncertainty)', async () => {
    const fake = fakeActuator();
    fake.actuator.readTags = vi.fn(async (id: string) => {
      if (id === ADX_ID) throw new Error('ARM 403 Forbidden on the tag read');
      return { 'loom-estate-id': ESTATE };
    }) as never;
    createArmActuator.mockResolvedValue(fake.actuator);
    const { POST } = await import('../pause/route');
    const j = await (await POST(post({ confirm: ESTATE }), { params: Promise.resolve({}) } as never)).json();
    expect(fake.touched).toEqual([POOL_ID]);
    expect(j.population.indeterminate).toBe(1);
    // Indeterminate is reported as its OWN class, not folded into "no Loom tag":
    // one is an error worth surfacing, the other is the ordinary correct answer.
    expect(j.population.notLoomOwned).toBe(0);
  });

  it('NOT ARMED: refuses with 409 and names the env var, before the typed confirmation', async () => {
    // The blocker. On a real console the deploy NAMES these resources, so
    // without the arming switch this route would pause ~$3,000/mo of compute.
    // The refusal must come BEFORE the confirm check, so an operator who has
    // not armed the feature is told THAT rather than "your confirmation was
    // wrong".
    resolveDeployManifest.mockReturnValue(unarmedManifestFixture());
    const fake = fakeActuator();
    createArmActuator.mockResolvedValue(fake.actuator);
    const { POST } = await import('../pause/route');
    const res = await POST(post({ confirm: ESTATE }), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.notArmed).toBe(true);
    expect(j.requiredEnv).toBe('LOOM_ESTATE_PAUSE_ENABLED');
    expect(j.namedByDeploy).toBe(2);
    expect(fake.touched).toEqual([]);
    expect(savePauseSnapshot).not.toHaveBeenCalled();
  });

  it('NOT ARMED: refuses even with a CORRECT confirmation and a matching token', async () => {
    resolveDeployManifest.mockReturnValue(unarmedManifestFixture());
    const fake = fakeActuator();
    createArmActuator.mockResolvedValue(fake.actuator);
    const { POST } = await import('../pause/route');
    const res = await POST(
      post({ confirm: ESTATE, confirmToken: previewToken([POOL_ID, ADX_ID]) }),
      { params: Promise.resolve({}) } as never,
    );
    expect(res.status).toBe(409);
    expect((await res.json()).notArmed).toBe(true);
    expect(fake.touched).toEqual([]);
  });

  it('NOT ARMED: holds even when the TAG establishes ownership (post-#3922 shape)', async () => {
    // The switch gates ACTUATION, not just the manifest path. Otherwise the
    // feature would arm itself the instant the first tag is stamped — exactly
    // when nobody expects it to become live.
    resolveDeployManifest.mockReturnValue(unarmedManifestFixture());
    const fake = fakeActuator(); // default readTags returns the loom-estate-id tag
    createArmActuator.mockResolvedValue(fake.actuator);
    const { POST } = await import('../pause/route');
    const res = await POST(post({ confirm: ESTATE }), { params: Promise.resolve({}) } as never);
    const j = await res.json();
    expect(res.status).toBe(409);
    expect(j.notArmed).toBe(true);
    // Ownership DID resolve — this is not an empty-scope refusal.
    expect(j.preview.wouldPause).toHaveLength(2);
    expect(fake.touched).toEqual([]);
    expect(savePauseSnapshot).not.toHaveBeenCalled();
  });

  it('NOT ARMED: the dry run still WORKS and still shows what would be in scope', async () => {
    // The gate withholds ownership; it must not blind the operator. They still
    // get to see what the deploy names and what arming would put in scope.
    resolveDeployManifest.mockReturnValue(unarmedManifestFixture());
    createArmActuator.mockResolvedValue(fakeActuator().actuator);
    const { POST } = await import('../pause/route');
    const j = await (await POST(post({ dryRun: true }), { params: Promise.resolve({}) } as never)).json();
    expect(j.dryRun).toBe(true);
    expect(j.manifestGated).toBe(true);
    expect(j.population.armed).toBe(false);
    expect(j.population.namedByDeploy).toBe(2);
    expect(j.population.examined).toBe(2);
  });

  /**
   * ── WHY THIS LOOPS (independent review, 2026-08-23) ────────────────────────
   * Every other arming-gate case above runs against ONE fixture, of ONE size:
   * two resources. A reviewer mutated the gate to
   *
   *     if (manifestGated && plan.inventory.pausable.length !== N)
   *
   * and found that N=2 was caught while **N=1 and N=3 both survived a full
   * green run**. N=3 is the cardinality of the LIVE estate — the deploy names
   * four resources but LOOM_PURVIEW_SHIR_VMSS_NAME is set EMPTY, so only the
   * Synapse pool, the ADX cluster and the AAS server resolve. So the suite
   * could not see a weakening that takes effect on precisely the estate this
   * feature would run against, and nowhere else.
   *
   * Pinning coverage to a fixture size is the defect, not the specific number.
   * This case therefore asserts the refusal at EVERY cardinality the manifest
   * can produce, so no `length !== N` can hide in an untested size.
   */
  it('NOT ARMED: the gate holds at EVERY estate cardinality, including the live estate\'s 3', async () => {
    for (let n = 1; n <= ALL_IDS.length; n++) {
      const ids = ALL_IDS.slice(0, n);
      resolveDeployManifest.mockReturnValue(unarmedManifestFixture(ids));
      const fake = fakeActuator();
      createArmActuator.mockResolvedValue(fake.actuator);
      const { POST } = await import('../pause/route');
      const res = await POST(
        post({ confirm: ESTATE, confirmToken: previewToken(ids) }),
        { params: Promise.resolve({}) } as never,
      );
      const j = await res.json();
      expect(res.status, `cardinality ${n}`).toBe(409);
      expect(j.notArmed, `cardinality ${n}`).toBe(true);
      expect(j.namedByDeploy, `cardinality ${n}`).toBe(n);
      // The refusal is not a side effect of an empty scope: ownership DID
      // resolve for all n, and still nothing was touched.
      expect(j.preview.wouldPause, `cardinality ${n}`).toHaveLength(n);
      expect(fake.touched, `cardinality ${n}`).toEqual([]);
      expect(savePauseSnapshot).not.toHaveBeenCalled();
    }
  });

  it('409s with the population statement when NOTHING is in scope', async () => {    resolveDeployManifest.mockReturnValue({ manifest: { estateId: ESTATE, resourceIds: [] }, entries: [], unresolved: [] });
    const fake = fakeActuator();
    createArmActuator.mockResolvedValue(fake.actuator);
    const { POST } = await import('../pause/route');
    const res = await POST(post({ confirm: ESTATE }), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.error).toMatch(/NOTHING would be paused/);
    expect(j.trackedBy).toBe(3922);
    expect(savePauseSnapshot).not.toHaveBeenCalled();
    expect(fake.touched).toEqual([]);
  });

  it('409s rather than re-pausing an estate that is already PAUSED', async () => {
    loadPauseSnapshot.mockResolvedValue(pausedSnapshotFixture());
    const fake = fakeActuator();
    createArmActuator.mockResolvedValue(fake.actuator);
    const { POST } = await import('../pause/route');
    const res = await POST(post({ confirm: ESTATE }), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(409);
    expect(fake.touched).toEqual([]);
    expect(savePauseSnapshot).not.toHaveBeenCalled();
  });

  it('dual-audits: Cosmos row AND the SIEM stream', async () => {
    createArmActuator.mockResolvedValue(fakeActuator().actuator);
    const { POST } = await import('../pause/route');
    await POST(post({ confirm: ESTATE }), { params: Promise.resolve({}) } as never);
    const kinds = auditCreate.mock.calls.map((c) => (c[0] as { kind: string }).kind);
    expect(kinds).toContain('estate-pause.start');
    expect(kinds).toContain('estate-pause.dispatched');
    expect(emitAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'platform.estate-pause', targetId: ESTATE, outcome: 'success' }),
    );
  });

  it('dryRun:true previews and actuates NOTHING', async () => {
    const fake = fakeActuator();
    createArmActuator.mockResolvedValue(fake.actuator);
    const { POST } = await import('../pause/route');
    const j = await (await POST(post({ dryRun: true }), { params: Promise.resolve({}) } as never)).json();
    expect(j.dryRun).toBe(true);
    expect(j.preview.wouldPause).toHaveLength(2);
    expect(fake.touched).toEqual([]);
    expect(savePauseSnapshot).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// POST /resume
// ===========================================================================

describe('POST /api/admin/estate/resume', () => {
  it('404s with no snapshot — Loom does not guess what the estate used to be', async () => {
    const { POST } = await import('../resume/route');
    const res = await POST(post({}), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(404);
    expect(createArmActuator).not.toHaveBeenCalled();
  });

  it('dispatches and returns 202 RESUMING — never RUNNING', async () => {
    loadPauseSnapshot.mockResolvedValue(pausedSnapshotFixture());
    const fake = fakeActuator();
    createArmActuator.mockResolvedValue(fake.actuator);
    const { POST } = await import('../resume/route');
    const res = await POST(post({}), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(202);
    const j = await res.json();
    expect(j.state).toBe('RESUMING');
    expect(j.state).not.toBe('RUNNING');
    expect(fake.touched.sort()).toEqual([POOL_ID, ADX_ID].sort());
    expect(j.monitorUrl).toBe('/api/admin/estate/state');
    expect(j.message).toMatch(/no guaranteed figure/);
  });

  it('CLASSIFIES a capacity rejection and names the declared fallback SKU', async () => {
    loadPauseSnapshot.mockResolvedValue(pausedSnapshotFixture());
    createArmActuator.mockResolvedValue(
      fakeActuator({
        resumeOk: false,
        resumeError:
          '(InsufficientResourcesForSubscription) [BadRequest] Currently there are no available '
          + 'resources to start the cluster with current SKU. Please choose different SKU',
      }).actuator,
    );
    const { POST } = await import('../resume/route');
    const j = await (await POST(post({}), { params: Promise.resolve({}) } as never)).json();
    expect(j.failures).toHaveLength(2);
    expect(j.failures.every((f: { kind: string }) => f.kind === 'capacity')).toBe(true);
    expect(j.failures[0].remediation).toMatch(/Azure does not reserve capacity while a resource is stopped/);
    expect(emitAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure' }));
  });

  it('refuses a snapshot with ZERO resources — an empty resume is not a success', async () => {
    loadPauseSnapshot.mockResolvedValue(pausedSnapshotFixture({ resources: [] }));
    const { POST } = await import('../resume/route');
    const res = await POST(post({}), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.error).toMatch(/ZERO resources/);
  });

  it('409s when a resume is already in flight', async () => {
    loadPauseSnapshot.mockResolvedValue(pausedSnapshotFixture({ state: 'RESUMING' }));
    const { POST } = await import('../resume/route');
    const res = await POST(post({}), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(409);
    expect(createArmActuator).not.toHaveBeenCalled();
  });

  it('is deliberately NOT gated by the arming switch — an estate must always be recoverable', async () => {
    // The pause route refuses when LOOM_ESTATE_PAUSE_ENABLED is unset. Resume
    // must NOT, or an estate paused while the flag was set becomes unrecoverable
    // through the product the moment someone unsets it — turning a safety
    // control into an outage. Resume is transitively gated anyway: it needs a
    // snapshot, and only a gated pause can create one.
    resolveDeployManifest.mockReturnValue(unarmedManifestFixture());
    loadPauseSnapshot.mockResolvedValue(pausedSnapshotFixture());
    const fake = fakeActuator();
    createArmActuator.mockResolvedValue(fake.actuator);
    const { POST } = await import('../resume/route');
    const res = await POST(post({}), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(202);
    expect((await res.json()).state).toBe('RESUMING');
    expect(fake.touched.sort()).toEqual([POOL_ID, ADX_ID].sort());
  });

  it('a RESUME_FAILED estate CAN be retried — that is its only legal exit', async () => {
    loadPauseSnapshot.mockResolvedValue(pausedSnapshotFixture({ state: 'RESUME_FAILED' }));
    createArmActuator.mockResolvedValue(fakeActuator().actuator);
    const { POST } = await import('../resume/route');
    const res = await POST(post({}), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(202);
    expect((await res.json()).state).toBe('RESUMING');
  });
});
