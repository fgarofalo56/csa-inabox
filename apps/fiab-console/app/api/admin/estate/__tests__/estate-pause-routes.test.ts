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
// #4243 — the DISCOVERY tag reader is a second network edge (it goes through
// arm-client's 429-retrying armGetWithRetry, which these tests must not reach).
// The default shim in beforeEach delegates to the current fake actuator's
// readTags, so every existing per-id tag fixture keeps steering discovery AND
// the act-time re-verify through one mock, in the same call order as live.
const createManifestTagReader = vi.fn();
vi.mock('@/lib/estate/pause-orchestrator', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/estate/pause-orchestrator')>();
  return {
    ...real,
    createArmActuator: (...a: unknown[]) => createArmActuator(...a),
    loadPauseSnapshot: (...a: unknown[]) => loadPauseSnapshot(...(a as [])),
    savePauseSnapshot: (...a: unknown[]) => savePauseSnapshot(...(a as [])),
    resolveDeployManifest: (...a: unknown[]) => resolveDeployManifest(...a),
    createManifestTagReader: (...a: unknown[]) => createManifestTagReader(...a),
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

/**
 * #4243 — a v2 preview token for THIS suite's fixtures. Defaults describe the
 * standard two-resource estate with every read succeeding: manifest = what the
 * deploy names, established = what positively resolved, f = read failures at
 * preview time. Override per case to mint drifted / degraded tokens.
 */
const tok = (over: {
  manifestIds?: string[];
  establishedIds?: string[];
  readFailures?: number;
} = {}) =>
  previewToken({
    manifestIds: over.manifestIds ?? [POOL_ID, ADX_ID],
    establishedIds: over.establishedIds ?? over.manifestIds ?? [POOL_ID, ADX_ID],
    readFailures: over.readFailures ?? 0,
  });

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
  // Discovery reads delegate to the CURRENT fake actuator's readTags (set per
  // test via createArmActuator.mockResolvedValue), preserving the single-mock
  // call ordering the scope cases below count on.
  createManifestTagReader.mockImplementation(() => async (id: string) => {
    const actuator = (await createArmActuator()) as { readTags: (id: string) => Promise<Readonly<Record<string, string>> | null> };
    return actuator.readTags(id);
  });
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
    expect(j.confirmToken).toBe(tok());
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

  /**
   * #3989 — THE GATE USED TO BE OPT-IN FROM THE CALLER'S SIDE.
   *
   * `if (body.confirmToken && body.confirmToken !== token)` short-circuits on an
   * ABSENT token, so omitting the field skipped the drift check entirely — while
   * the sibling refusal below still told the operator "Loom will not pause
   * resources you have not seen", a guarantee the code was not providing for
   * exactly those callers (deploy-integrity R7).
   *
   * No test covered the omission, which is why the shape survived. This is it.
   * The mutation control is the fix itself: restore the `body.confirmToken &&`
   * short-circuit and this case goes from 409 to 202 with both resources ACTUATED.
   */
  it('409s when NO preview token is sent at all — the drift gate is not opt-in', async () => {
    const fake = fakeActuator();
    createArmActuator.mockResolvedValue(fake.actuator);
    const { POST } = await import('../pause/route');
    const res = await POST(post({ confirm: ESTATE }), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(409);
    const j = await res.json();
    // Distinct from the drift message: "re-open the preview and confirm the
    // current set" reads wrong for a caller that never previewed.
    expect(j.error).toMatch(/carried no preview token/);
    expect(j.error).toMatch(/REQUIRED, not optional/);
    expect(j.error).not.toMatch(/changed between the preview you confirmed and now/);
    // The thing that actually matters: nothing was touched, nothing was recorded.
    expect(fake.touched).toEqual([]);
    expect(savePauseSnapshot).not.toHaveBeenCalled();
    // #4243 — this refusal used to leave ZERO trace, which is why the live
    // incident took an elimination proof to identify. It now writes the same
    // Cosmos audit row every other refusal branch does.
    expect(auditCreate.mock.calls.map((c) => (c[0] as { kind: string }).kind))
      .toContain('estate-pause.refused-no-token');
  });

  it('409s when the resolved set DRIFTED from the preview the operator confirmed', async () => {
    const fake = fakeActuator();
    createArmActuator.mockResolvedValue(fake.actuator);
    const { POST } = await import('../pause/route');
    const res = await POST(
      post({ confirm: ESTATE, confirmToken: tok({ establishedIds: [POOL_ID] }) }),
      { params: Promise.resolve({}) } as never,
    );
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.error).toMatch(/changed between the preview you confirmed and now/);
    expect(fake.touched).toEqual([]);
    // #4243 — the drift refusal is audited too (it never was, and that
    // zero-trace property is what made the live 409 undiagnosable from logs).
    expect(auditCreate.mock.calls.map((c) => (c[0] as { kind: string }).kind))
      .toContain('estate-pause.refused-set-changed');
  });

  /**
   * ── #4243 — THE MANUFACTURED-DRIFT FAMILY ─────────────────────────────────
   * The live 2026-08-31 Pause failure: the console's own read-warmer saturated
   * the UAMI's ARM read budget, one 429'd tag read silently shrank the preview
   * population, the count-embedding token changed, and the drift gate 409'd
   * over an estate that had NOT changed — asserting "the set changed", which
   * the code never established (deploy-integrity R7). These cases pin the
   * three-way split: read-failed refuses with RETRY, real drift still refuses
   * as drift, unchanged proceeds.
   */
  describe('#4243 — throttled reads must not manufacture drift', () => {
    it('THE LIVE SHAPE: a 429-throwing tag read between GET and POST over an UNCHANGED estate '
      + 'refuses with the throttle message, NEVER the drift message', async () => {
      // The preview was clean (both resources established, zero failures)…
      const cleanPreviewToken = tok();
      // …and at POST time the ADX tag read throws 429-shaped, exactly what
      // arm-client's ArmThrottledError surfaces after bounded retry exhaustion.
      const fake = fakeActuator();
      fake.actuator.readTags = vi.fn(async (id: string) => {
        if (id === ADX_ID) {
          throw new Error(
            `ARM GET ${ADX_ID}?api-version=2023-08-15 was throttled (429) and stayed throttled after 3 attempt(s).`,
          );
        }
        return { 'loom-estate-id': ESTATE };
      }) as never;
      createArmActuator.mockResolvedValue(fake.actuator);
      const { POST } = await import('../pause/route');
      const res = await POST(
        post({ confirm: ESTATE, confirmToken: cleanPreviewToken }),
        { params: Promise.resolve({}) } as never,
      );
      expect(res.status).toBe(409);
      const j = await res.json();
      // The honest message — and NOT the R7 lie the live estate produced.
      expect(j.error).toMatch(/1 tag read\(s\) failed \(throttled\/unreachable\)/);
      expect(j.error).toMatch(/nothing established the estate changed; retry/i);
      expect(j.error).not.toMatch(/changed between the preview you confirmed and now/);
      // The row says THROTTLED, not generic indeterminate.
      expect(j.readFailures).toEqual([
        expect.objectContaining({ resourceId: ADX_ID, throttled: true }),
      ]);
      expect(fake.touched).toEqual([]);
      expect(savePauseSnapshot).not.toHaveBeenCalled();
      expect(auditCreate.mock.calls.map((c) => (c[0] as { kind: string }).kind))
        .toContain('estate-pause.refused-reads-failed');
    });

    it('a DEGRADED preview (minted while reads were failing) is refused honestly, not as drift', async () => {
      // The GET side of the same incident: the preview itself was computed
      // while a read was failing, so its token carries f=1. Confirming it
      // against a now-clean estate must NOT pause (the operator saw a short
      // set) and must NOT claim the set changed (nothing established that).
      const degraded = tok({ establishedIds: [POOL_ID], readFailures: 1 });
      const fake = fakeActuator();
      createArmActuator.mockResolvedValue(fake.actuator);
      const { POST } = await import('../pause/route');
      const res = await POST(
        post({ confirm: ESTATE, confirmToken: degraded }),
        { params: Promise.resolve({}) } as never,
      );
      expect(res.status).toBe(409);
      const j = await res.json();
      expect(j.error).toMatch(/while 1 tag read\(s\) were failing/);
      expect(j.error).toMatch(/Nothing established that the estate changed/i);
      expect(j.error).not.toMatch(/changed between the preview you confirmed and now/);
      expect(fake.touched).toEqual([]);
      expect(auditCreate.mock.calls.map((c) => (c[0] as { kind: string }).kind))
        .toContain('estate-pause.refused-preview-degraded');
    });

    it('REAL drift — the mock set actually changes between preview and POST — still refuses as drift', async () => {
      // Preview taken while ADX belonged to estate-b (established = pool only,
      // all reads clean)…
      const previewWhenAdxWasForeign = tok({ establishedIds: [POOL_ID] });
      // …then ADX is re-tagged to THIS estate before the POST. Both reads
      // succeed, both sides fully established, and the sets genuinely differ:
      // that IS drift, and the drift message is now true when it fires.
      const fake = fakeActuator();
      createArmActuator.mockResolvedValue(fake.actuator);
      const { POST } = await import('../pause/route');
      const res = await POST(
        post({ confirm: ESTATE, confirmToken: previewWhenAdxWasForeign }),
        { params: Promise.resolve({}) } as never,
      );
      expect(res.status).toBe(409);
      const j = await res.json();
      expect(j.error).toMatch(/changed between the preview you confirmed and now/);
      expect(j.error).toMatch(/every tag read succeeding/);
      expect(fake.touched).toEqual([]);
      expect(savePauseSnapshot).not.toHaveBeenCalled();
    });

    it('a MANIFEST population change (env rewired by a deploy) refuses as drift — positively observed', async () => {
      // The preview covered a deploy that named only the pool; the deploy now
      // names pool + ADX. That comparison is env-derived on both sides — valid
      // even under total read failure — and it is a REAL change.
      const oldDeployToken = tok({ manifestIds: [POOL_ID] });
      const fake = fakeActuator();
      createArmActuator.mockResolvedValue(fake.actuator);
      const { POST } = await import('../pause/route');
      const res = await POST(
        post({ confirm: ESTATE, confirmToken: oldDeployToken }),
        { params: Promise.resolve({}) } as never,
      );
      expect(res.status).toBe(409);
      const j = await res.json();
      expect(j.error).toMatch(/deploy-named population changed between the preview you confirmed and now/i);
      expect(fake.touched).toEqual([]);
      expect(auditCreate.mock.calls.map((c) => (c[0] as { kind: string }).kind))
        .toContain('estate-pause.refused-manifest-changed');
    });

    it('a STALE (pre-v2) token is refused as stale — never as drift', async () => {
      const fake = fakeActuator();
      createArmActuator.mockResolvedValue(fake.actuator);
      const { POST } = await import('../pause/route');
      const res = await POST(
        // The legacy `count:hash` shape every pre-#4243 preview handed out.
        post({ confirm: ESTATE, confirmToken: '2:abcd1234' }),
        { params: Promise.resolve({}) } as never,
      );
      expect(res.status).toBe(409);
      const j = await res.json();
      expect(j.error).toMatch(/not one this console can read/);
      expect(j.error).not.toMatch(/changed between the preview you confirmed and now/);
      expect(fake.touched).toEqual([]);
      expect(auditCreate.mock.calls.map((c) => (c[0] as { kind: string }).kind))
        .toContain('estate-pause.refused-stale-token');
    });

    it('dryRun during a throttle reports the failure per row AND keeps indeterminate distinct', async () => {
      const fake = fakeActuator();
      fake.actuator.readTags = vi.fn(async (id: string) => {
        if (id === ADX_ID) throw new Error('ARM GET x was throttled (429) and stayed throttled after 3 attempt(s).');
        return { 'loom-estate-id': ESTATE };
      }) as never;
      createArmActuator.mockResolvedValue(fake.actuator);
      const { POST } = await import('../pause/route');
      const j = await (await POST(post({ dryRun: true }), { params: Promise.resolve({}) } as never)).json();
      expect(j.dryRun).toBe(true);
      expect(j.readFailures).toEqual([
        expect.objectContaining({ resourceId: ADX_ID, throttled: true }),
      ]);
      // Indeterminate stays its OWN population class, not folded into
      // "no Loom tag": one is an error worth surfacing, the other is the
      // ordinary correct answer for unrelated resources.
      expect(j.population.indeterminate).toBe(1);
      expect(j.population.notLoomOwned).toBe(0);
      // And the token it mints CARRIES the degradation, so confirming it later
      // hits the preview-degraded refusal rather than pausing a short set.
      expect(j.confirmToken).toMatch(/\.f1$/);
      expect(fake.touched).toEqual([]);
    });
  });

  /**
   * ── #4243 REVIEW ROUND 1 — POSITIVE ABSENCE IS NOT A FAILED READ ──────────
   * The live estate composes the SHIR id from mismatched env coordinates, so
   * ARM answers 404 on it DETERMINISTICALLY. Under the first cut of the strict
   * gate that 404 counted as a read failure and refused EVERY live pause with
   * a "retry" a permanent 404 can never satisfy. A 404 is a POSITIVE
   * observation — there is no resource at that id — so the entry is EXCLUDED
   * (symmetrically with GET, keeping the token coherent), surfaced with the
   * env remediation, audited, and the pause PROCEEDS. Throttled stays strict.
   */
  describe('#4243 review — a deploy-named resource ARM positively reports ABSENT', () => {
    const notFound = (id: string) =>
      new Error(
        `ARM GET ${id}?api-version=2023-08-15 failed 404: {"error":{"code":"ResourceNotFound",`
          + `"message":"The Resource was not found."}}`,
      );

    it('404 on a manifest-named id: the pause PROCEEDS with that entry EXCLUDED, warned, and audited', async () => {
      const fake = fakeActuator();
      fake.actuator.readTags = vi.fn(async (id: string) => {
        if (id === ADX_ID) throw notFound(ADX_ID);
        return { 'loom-estate-id': ESTATE };
      }) as never;
      createArmActuator.mockResolvedValue(fake.actuator);
      const { POST } = await import('../pause/route');
      // The preview saw the same absence (symmetric exclusion), so its token
      // covers the pool alone with ZERO read failures.
      const res = await POST(
        post({ confirm: ESTATE, confirmToken: tok({ manifestIds: [POOL_ID] }) }),
        { params: Promise.resolve({}) } as never,
      );
      expect(res.status).toBe(202);
      const j = await res.json();
      // NOT the retry refusal, NOT the drift refusal — the pause ran.
      expect(fake.touched).toEqual([POOL_ID]);
      expect(j.absent).toEqual([
        expect.objectContaining({ resourceId: ADX_ID }),
      ]);
      expect(j.absent[0].statement).toMatch(/EXCLUDED/);
      expect(j.absent[0].statement).toMatch(/no\s+resource exists at that id/i);
      expect(j.absent[0].statement).toMatch(/LOOM_SUBSCRIPTION_ID/); // the env values to fix
      expect(j.message).toMatch(/1 deploy-named resource\(s\) were EXCLUDED/);
      // The exclusion left a trace — the zero-trace property is the incident.
      expect(auditCreate.mock.calls.map((c) => (c[0] as { kind: string }).kind))
        .toContain('estate-pause.absent-excluded');
      // The snapshot holds only the resource that exists.
      const saved = savePauseSnapshot.mock.calls[0]?.[0] as unknown as EstatePauseSnapshot;
      expect(saved.resources.map((r) => r.resourceId)).toEqual([POOL_ID]);
    });

    it('dryRun under the same 404: `absent` is surfaced, the token carries f0, and nothing is indeterminate', async () => {
      const fake = fakeActuator();
      fake.actuator.readTags = vi.fn(async (id: string) => {
        if (id === ADX_ID) throw notFound(ADX_ID);
        return { 'loom-estate-id': ESTATE };
      }) as never;
      createArmActuator.mockResolvedValue(fake.actuator);
      const { POST } = await import('../pause/route');
      const j = await (await POST(post({ dryRun: true }), { params: Promise.resolve({}) } as never)).json();
      expect(j.dryRun).toBe(true);
      expect(j.absent).toHaveLength(1);
      // Positively absent ≠ unreadable: the population is CLEAN, not degraded.
      expect(j.readFailures).toEqual([]);
      expect(j.population.examined).toBe(1);
      expect(j.population.indeterminate).toBe(0);
      expect(j.confirmToken).toMatch(/\.f0$/);
      expect(j.confirmToken).toBe(tok({ manifestIds: [POOL_ID] }));
      expect(fake.touched).toEqual([]);
    });

    it('UNREADABLE (throttled) stays strict — absence never leaks into the throttle class', async () => {
      // The guard boundary: delete the 404-classifier arm (folding absent into
      // unreachable) and the two cases above go red; widen it (folding 429
      // into absent) and THIS case goes red by pausing through a throttle.
      const fake = fakeActuator();
      fake.actuator.readTags = vi.fn(async (id: string) => {
        if (id === ADX_ID) {
          throw new Error(`ARM GET ${ADX_ID}?api-version=2023-08-15 was throttled (429) and stayed throttled after 3 attempt(s).`);
        }
        return { 'loom-estate-id': ESTATE };
      }) as never;
      createArmActuator.mockResolvedValue(fake.actuator);
      const { POST } = await import('../pause/route');
      const res = await POST(
        post({ confirm: ESTATE, confirmToken: tok() }),
        { params: Promise.resolve({}) } as never,
      );
      expect(res.status).toBe(409);
      const j = await res.json();
      expect(j.error).toMatch(/tag read\(s\) failed \(throttled\/unreachable\)/);
      expect(fake.touched).toEqual([]);
    });

    it('a NON-STRING confirmToken lands in the audited stale-token refusal, never a 500', async () => {
      // Review round 1 measured: {"confirmToken": 5} crashed parsePreviewToken
      // (.trim on a number) into a generic 500 with ZERO audit rows.
      const fake = fakeActuator();
      createArmActuator.mockResolvedValue(fake.actuator);
      const { POST } = await import('../pause/route');
      const res = await POST(
        post({ confirm: ESTATE, confirmToken: 5 }),
        { params: Promise.resolve({}) } as never,
      );
      expect(res.status).toBe(409);
      const j = await res.json();
      expect(j.error).toMatch(/not one this console can read/);
      expect(fake.touched).toEqual([]);
      expect(auditCreate.mock.calls.map((c) => (c[0] as { kind: string }).kind))
        .toContain('estate-pause.refused-stale-token');
    });
  });

  it('dispatches the pause and returns 202 PAUSING — never PAUSED', async () => {
    const fake = fakeActuator();
    createArmActuator.mockResolvedValue(fake.actuator);
    const { POST } = await import('../pause/route');
    const res = await POST(
      post({ confirm: ESTATE, confirmToken: tok() }),
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

  it('#4243 ZERO-DISPATCH: when ARM rejects EVERY dispatch, no PAUSING snapshot is saved and the '
    + 'response is a failure, not a 202', async () => {
    // Pre-#4243 (`pause/route.ts:292-337`) this shape SAVED a PAUSING snapshot
    // with zero accepted dispatches and returned 202 "Pause dispatched to 0
    // resource(s)" — a stuck-PAUSING estate that polls to 0-of-N forever and
    // refuses a retry with "already PAUSING". The pinned honest behaviour:
    // nothing was set in motion, so nothing is recorded and the caller is told
    // the truth. Delete the guard and this case goes 202-with-snapshot again.
    const fake = fakeActuator({ pauseOk: false, pauseError: 'ARM 500 InternalServerError' });
    createArmActuator.mockResolvedValue(fake.actuator);
    const { POST } = await import('../pause/route');
    const res = await POST(
      post({ confirm: ESTATE, confirmToken: tok() }),
      { params: Promise.resolve({}) } as never,
    );
    expect(res.status).toBe(502);
    const j = await res.json();
    expect(j.ok).toBe(false);
    // Review round 1: the headline states COUNTS, and never claims a global
    // state ("still RUNNING") that an already-paused row would contradict.
    expect(j.error).toMatch(/Nothing was set in motion/);
    expect(j.error).toMatch(/ARM REJECTED 2/);
    expect(j.error).toMatch(/NONE was accepted/);
    expect(j.error).not.toMatch(/still RUNNING/);
    expect(j.error).not.toMatch(/Pause dispatched/);
    // BOTH mutations were attempted and rejected — visible per resource…
    expect(j.actions).toHaveLength(2);
    expect(j.actions.every((a: { status: string }) => a.status === 'failed')).toBe(true);
    // …and NO snapshot was persisted, so the estate cannot get stuck PAUSING.
    expect(savePauseSnapshot).not.toHaveBeenCalled();
    // The failure is audited in Cosmos AND on the SIEM stream.
    expect(auditCreate.mock.calls.map((c) => (c[0] as { kind: string }).kind))
      .toContain('estate-pause.all-dispatches-rejected');
    expect(emitAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'platform.estate-pause', outcome: 'failure' }),
    );
  });

  it('#4243 ZERO-DISPATCH boundary: an estate that is ALREADY fully paused still records its '
    + 'snapshot (that snapshot settles to PAUSED truthfully)', async () => {
    // dispatched=0 with zero FAILURES is not the stuck shape: every resource
    // was already stopped, the snapshot records that, and the first poll
    // promotes it to PAUSED from authoritative reads. The guard must key on
    // "rejected", not on "nothing dispatched".
    const fake = fakeActuator({ power: () => 'Paused' });
    createArmActuator.mockResolvedValue(fake.actuator);
    const { POST } = await import('../pause/route');
    const res = await POST(
      post({ confirm: ESTATE, confirmToken: tok() }),
      { params: Promise.resolve({}) } as never,
    );
    expect(res.status).toBe(202);
    const j = await res.json();
    expect(j.actions.every((a: { status: string }) => a.status === 'already-paused')).toBe(true);
    expect(savePauseSnapshot).toHaveBeenCalledTimes(1);
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
    // Both resources are ours at PLAN time (the tag flips only on the re-verify),
    // so the preview token covers both. #3989 made `confirmToken` REQUIRED.
    const res = await POST(
      post({ confirm: ESTATE, confirmToken: tok() }),
      { params: Promise.resolve({}) } as never,
    );
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
    // ADX is excluded at DISCOVERY, so the preview — and therefore the required
    // #3989 token — covers the pool alone.
    const j = await (
      await POST(
        post({ confirm: ESTATE, confirmToken: tok({ establishedIds: [POOL_ID] }) }),
        { params: Promise.resolve({}) } as never,
      )
    ).json();
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
    const j = await (
      await POST(
        post({ confirm: ESTATE, confirmToken: tok() }),
        { params: Promise.resolve({}) } as never,
      )
    ).json();
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
    const j = await (
      await POST(
        post({ confirm: ESTATE, confirmToken: tok({ establishedIds: [POOL_ID] }) }),
        { params: Promise.resolve({}) } as never,
      )
    ).json();
    expect(fake.touched).toEqual([POOL_ID]);
    expect(j.population.notLoomOwned).toBe(1);
    const saved = savePauseSnapshot.mock.calls[0]?.[0] as unknown as EstatePauseSnapshot;
    expect(saved.resources.map((r) => r.resourceId)).toEqual([POOL_ID]);
  });

  it('SCOPE: an UNREADABLE tag set REFUSES the pause — never act on uncertainty (#4243)', async () => {
    // Pre-#4243 this case paused the readable resource and left the unreadable
    // one running. #4243 strengthened it: a failed discovery read means the
    // membership of the CURRENT estate is only partially known, so the route
    // refuses the whole pause with a retry remediation instead of acting on
    // the half it could read — and instead of calling the difference "drift".
    const fake = fakeActuator();
    fake.actuator.readTags = vi.fn(async (id: string) => {
      if (id === ADX_ID) throw new Error('ARM 403 Forbidden on the tag read');
      return { 'loom-estate-id': ESTATE };
    }) as never;
    createArmActuator.mockResolvedValue(fake.actuator);
    const { POST } = await import('../pause/route');
    const res = await POST(
      post({ confirm: ESTATE, confirmToken: tok({ establishedIds: [POOL_ID] }) }),
      { params: Promise.resolve({}) } as never,
    );
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.error).toMatch(/tag read\(s\) failed \(throttled\/unreachable\)/);
    expect(j.error).toMatch(/nothing established the estate changed; retry/i);
    // A 403 is unreachable, not throttled — the classification is per row.
    expect(j.readFailures).toEqual([
      expect.objectContaining({ resourceId: ADX_ID, throttled: false }),
    ]);
    expect(fake.touched).toEqual([]);
    expect(savePauseSnapshot).not.toHaveBeenCalled();
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
      post({ confirm: ESTATE, confirmToken: tok() }),
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
        post({ confirm: ESTATE, confirmToken: tok({ manifestIds: ids }) }),
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
    // Nothing resolves, so the preview — and the required #3989 token — is over
    // the EMPTY set. Sending it proves this 409 is the population statement and
    // not the token gate one step earlier.
    const res = await POST(
      post({ confirm: ESTATE, confirmToken: tok({ manifestIds: [] }) }),
      { params: Promise.resolve({}) } as never,
    );
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
    // A matching token, so the 409 under test is the already-PAUSED refusal and
    // not #3989's token gate two steps earlier.
    const res = await POST(
      post({ confirm: ESTATE, confirmToken: tok() }),
      { params: Promise.resolve({}) } as never,
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already PAUSED/);
    expect(fake.touched).toEqual([]);
    expect(savePauseSnapshot).not.toHaveBeenCalled();
  });

  it('dual-audits: Cosmos row AND the SIEM stream', async () => {
    createArmActuator.mockResolvedValue(fakeActuator().actuator);
    const { POST } = await import('../pause/route');
    await POST(
      post({ confirm: ESTATE, confirmToken: tok() }),
      { params: Promise.resolve({}) } as never,
    );
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
