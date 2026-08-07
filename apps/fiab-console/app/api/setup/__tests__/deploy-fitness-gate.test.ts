/**
 * #3014 — `assertPlanIsDeployable` must be CALLED at the deploy choke point.
 *
 * The measured defect: the five-criteria day-0 fitness suite was a well-tested
 * library with ZERO production callers — its own header claimed "runs before a
 * single resource is created" and nothing called it, so an unusable adoption
 * failed mid-deploy as an ARM error and left a half-built estate.
 *
 * These are the guard-that-callers-exist tests: remove the
 * `assertPlanIsDeployable(...)` call (or the `validatePlan` structural gate)
 * from POST /api/setup/deploy and the named tests go RED. `tsc` and the
 * fitness unit suite stay green under that mutation — which is exactly why
 * this file exists.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getSessionMock = vi.fn(
  () => ({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({
  getSession: () => getSessionMock(),
  tenantScopeId: (s: any) => s?.claims?.tid ?? s?.claims?.oid,
}));

vi.mock('@azure/identity', () => {
  class Cred {
    async getToken() {
      return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 };
    }
  }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

vi.mock('@/lib/azure/cosmos-client', () => ({
  featurePermissionsContainer: async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
  }),
}));

const SUB = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function bodyReq(body: any) {
  return { url: 'http://x/api/setup/deploy', json: async () => body } as any;
}

function submitWithPlan(services: Record<string, unknown>) {
  return {
    subscriptionId: SUB,
    boundary: 'Commercial',
    mode: 'single-sub',
    domainName: 'finance',
    capacitySku: 'F8',
    location: 'eastus2',
    plan: { planId: 'plan_t', schemaVersion: 1, services },
  };
}

/** A fitness result in the shape `evaluateFitness` produces. */
function fitness(verdict: 'usable' | 'usable-with-changes' | 'unusable' | 'unknown', what: string) {
  return {
    verdict,
    checks: [
      {
        id: 'aisearch.sku',
        verdict: verdict === 'usable' ? 'pass' : verdict === 'usable-with-changes' ? 'warn' : verdict === 'unknown' ? 'unknown' : 'fail',
        what,
        why: 'test',
        established: 'test fixture',
      },
    ],
  };
}

beforeEach(() => {
  process.env.LOOM_TENANT_ADMIN_OID = 'oid-test';
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 } as any);
});

afterEach(() => {
  delete process.env.LOOM_TENANT_ADMIN_OID;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('POST /api/setup/deploy — the #3014 fitness gate at the choke point', () => {
  it('422 adoption-not-deployable when an adopted resource is UNUSABLE — before any tier fires', async () => {
    const { POST } = await import('@/app/api/setup/deploy/route');
    const r = await POST(
      bodyReq(
        submitWithPlan({
          aisearch: {
            mode: 'adopt',
            target: { name: 'search-free', rg: 'rg-s', sub: SUB },
            fitness: fitness('unusable', 'AI Search "search-free" is on the free tier, which Loom cannot use'),
            decidedBy: 'op',
            decidedAt: 'now',
          },
        }),
      ),
    );
    const j = await r.json();
    expect(r.status).toBe(422);
    expect(j.error).toBe('adoption-not-deployable');
    expect(j.blocking?.[0]?.serviceKey).toBe('aisearch');
    expect(j.message).toContain('free tier');
  });

  it('422 when the verdict is UNKNOWN — "could not verify" blocks, and stays distinct from "unusable"', async () => {
    const { POST } = await import('@/app/api/setup/deploy/route');
    const r = await POST(
      bodyReq(
        submitWithPlan({
          adx: {
            mode: 'adopt',
            target: { name: 'adx1', rg: 'rg-a', sub: SUB },
            fitness: fitness('unknown', 'Loom could not read the SKU of ADX "adx1"'),
            decidedBy: 'op',
            decidedAt: 'now',
          },
        }),
      ),
    );
    const j = await r.json();
    expect(r.status).toBe(422);
    expect(j.blocking?.[0]?.verdict).toBe('unknown');
    expect(j.message).toContain('could not read');
  });

  it('usable-with-changes PROCEEDS (the changes are ones the platform performs itself)', async () => {
    const { POST } = await import('@/app/api/setup/deploy/route');
    const r = await POST(
      bodyReq(
        submitWithPlan({
          aisearch: {
            mode: 'adopt',
            target: { name: 'search1', rg: 'rg-s', sub: SUB },
            fitness: fitness('usable-with-changes', 'network rule will be added by the deploy'),
            decidedBy: 'op',
            decidedAt: 'now',
          },
        }),
      ),
    );
    const j = await r.json();
    // Passes the gate → reaches the honest 503 copy-paste tier, bag intact.
    expect(r.status).toBe(503);
    expect(j.remediation.commands.join('\n')).toContain('search1');
  });

  it('400 structural: adopting a create-only service (Key Vault) is refused before any tier', async () => {
    const { POST } = await import('@/app/api/setup/deploy/route');
    const r = await POST(
      bodyReq(
        submitWithPlan({
          keyvault: {
            mode: 'adopt',
            target: { name: 'kv1', rg: 'rg-k', sub: SUB },
            decidedBy: 'op',
            decidedAt: 'now',
          },
        }),
      ),
    );
    const j = await r.json();
    expect(r.status).toBe(400);
    expect(j.issues?.some((i: any) => i.code === 'adopt-not-permitted')).toBe(true);
  });

  it('400 structural: an adopt without a full coordinate (missing rg) is refused', async () => {
    const { POST } = await import('@/app/api/setup/deploy/route');
    const r = await POST(
      bodyReq(
        submitWithPlan({
          purview: {
            mode: 'adopt',
            target: { name: 'pv1', rg: '', sub: SUB },
            decidedBy: 'op',
            decidedAt: 'now',
          },
        }),
      ),
    );
    const j = await r.json();
    expect(r.status).toBe(400);
    expect(j.issues?.some((i: any) => i.code === 'missing-target')).toBe(true);
  });

  it('an UN-EVALUATED adoption still deploys (honestly documented: no producer for evaluateFitness yet)', async () => {
    // This pins the deliberate scope of the gate: enforcing
    // 'fitness-not-evaluated' before an evaluator exists would dead-end
    // brownfield entirely. When the evaluator lands, this test is the one to
    // flip. Refs #3014 follow-up.
    const { POST } = await import('@/app/api/setup/deploy/route');
    const r = await POST(
      bodyReq(
        submitWithPlan({
          purview: {
            mode: 'adopt',
            target: { name: 'pv1', rg: 'rg-p', sub: SUB },
            decidedBy: 'op',
            decidedAt: 'now',
          },
        }),
      ),
    );
    const j = await r.json();
    expect(r.status).toBe(503); // the copy-paste gate, bag intact — not a 4xx
    expect(j.remediation.commands.join('\n')).toContain('pv1');
  });
});
