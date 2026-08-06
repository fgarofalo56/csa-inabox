/**
 * #3016 — the adopt bag must reach EVERY deploy tier, not only the copy-paste
 * fallback.
 *
 * These are the guard-that-callers-exist tests: each one goes RED if a tier
 * stops consuming the unified bag (`lib/setup/adopt-bag`). The measured defect
 * they pin: the wizard's "use my existing X" decisions were serialized ONLY
 * into the HTTP-503 copy-paste command, so every tier that actually deployed
 * provisioned duplicates (a second Purview then fails the whole run with
 * EnterpriseTenantAlreadyExists).
 *
 *   tier 0  user-ARM PUT       → parameters.adopt on the deployment body
 *   tier 1  Setup Orchestrator → explicit `adopt` field on the POST payload
 *   tier 2  GitHub dispatch    → SKIPPED for a meaningful bag (no declared
 *                                input can carry it; dispatch-and-discard is
 *                                the defect) — greenfield still dispatches
 *   tier 3  copy-paste `az`    → `-p adopt='…'` in the emitted command
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

// Switchable per test: tier 0 needs a REAL-looking user ARM token; the
// orchestrator test needs token acquisition to fail so the route falls through.
let armTokenImpl: () => Promise<{ token: string; identity: 'user' | 'uami' } | null> = async () => null;
vi.mock('@/lib/auth/obo', () => ({
  getArmTokenPreferUser: () => {
    const p = armTokenImpl();
    return p.then((v) => {
      if (v === null) throw new Error('no ARM token in this test');
      return v;
    });
  },
}));

const SUB = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/** A submit body whose plan adopts one resource (the meaningful-bag case). */
function adoptSubmit() {
  return {
    subscriptionId: SUB,
    boundary: 'Commercial',
    mode: 'single-sub',
    domainName: 'finance',
    capacitySku: 'F8',
    location: 'eastus2',
    plan: {
      planId: 'plan_t',
      schemaVersion: 1,
      services: {
        purview: {
          mode: 'adopt',
          target: { name: 'pv-existing', rg: 'rg-data', sub: SUB },
          decidedBy: 'op',
          decidedAt: 'now',
        },
        aisearch: { mode: 'create', decidedBy: 'op', decidedAt: 'now' },
      },
    },
  };
}

/** Same shape, every decision `create` — the greenfield case. */
function greenfieldSubmit() {
  const b = adoptSubmit();
  (b.plan.services as any) = {
    purview: { mode: 'create', decidedBy: 'op', decidedAt: 'now' },
    aisearch: { mode: 'create', decidedBy: 'op', decidedAt: 'now' },
  };
  return b;
}

function bodyReq(body: any) {
  return { url: 'http://x/api/setup/deploy', json: async () => body } as any;
}

interface CapturedCall {
  url: string;
  body: any;
}

function stubFetch(impl: (url: string, init?: any) => { status?: number; body?: unknown }) {
  const calls: CapturedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: any) => {
      let parsed: any = undefined;
      try {
        parsed = init?.body ? JSON.parse(String(init.body)) : undefined;
      } catch {
        parsed = String(init?.body ?? '');
      }
      calls.push({ url: String(url), body: parsed });
      const r = impl(String(url), init);
      return new Response(JSON.stringify(r.body ?? {}), {
        status: r.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}

/** ARM stub: pre-flight says "can deploy" and captures the deployment PUT. */
function armStub(url: string): { status?: number; body?: unknown } {
  if (url.includes('/providers/Microsoft.Authorization/permissions')) {
    return { body: { value: [{ actions: ['*'], notActions: [] }] } };
  }
  if (url.includes('/providers?api-version=')) {
    return {
      body: {
        value: ['Microsoft.Storage', 'Microsoft.Network'].map((ns) => ({
          namespace: ns,
          registrationState: 'Registered',
        })),
      },
    };
  }
  if (url.includes('/providers/Microsoft.Resources/deployments/')) {
    return { status: 201, body: { properties: { provisioningState: 'Accepted' } } };
  }
  return { body: {} };
}

beforeEach(() => {
  process.env.LOOM_TENANT_ADMIN_OID = 'oid-test';
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 } as any);
  armTokenImpl = async () => null;
});

afterEach(() => {
  delete process.env.LOOM_TENANT_ADMIN_OID;
  delete process.env.LOOM_GITHUB_ACTIONS_TOKEN;
  delete process.env.LOOM_SETUP_ORCHESTRATOR_URL;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('POST /api/setup/deploy — adopt-bag transport (#3016)', () => {
  it('tier 3 (copy-paste): the 503 gate command carries the plan-derived adopt bag', async () => {
    const { POST } = await import('@/app/api/setup/deploy/route');
    const r = await POST(bodyReq(adoptSubmit()));
    const j = await r.json();
    expect(r.status).toBe(503);
    const cmds = j.remediation.commands.join('\n');
    expect(cmds).toContain("-p adopt='");
    expect(cmds).toContain('pv-existing');
    // The explicit create entry rides along (belt against stale env merges).
    expect(cmds).toContain('"aisearch":{"mode":"create"}');
  });

  it('tier 0 (user-ARM PUT): the deployment parameters carry the adopt bag', async () => {
    armTokenImpl = async () => ({ token: 'user-tk', identity: 'user' });
    const calls = stubFetch(armStub);
    const { POST } = await import('@/app/api/setup/deploy/route');
    const r = await POST(bodyReq(adoptSubmit()));
    const j = await r.json();
    expect(r.status).toBe(202);
    expect(j.deploymentMode).toBe('user-arm');
    const put = calls.find((c) => c.url.includes('/providers/Microsoft.Resources/deployments/'));
    expect(put).toBeDefined();
    const adopt = put!.body?.properties?.parameters?.adopt?.value;
    expect(adopt?.purview).toEqual({
      mode: 'adopt',
      target: { name: 'pv-existing', rg: 'rg-data', sub: SUB },
    });
  });

  it('tier 0 greenfield: an all-create plan emits NO adopt parameter (unchanged params)', async () => {
    armTokenImpl = async () => ({ token: 'user-tk', identity: 'user' });
    const calls = stubFetch(armStub);
    const { POST } = await import('@/app/api/setup/deploy/route');
    const r = await POST(bodyReq(greenfieldSubmit()));
    expect(r.status).toBe(202);
    const put = calls.find((c) => c.url.includes('/providers/Microsoft.Resources/deployments/'));
    expect(put!.body?.properties?.parameters?.adopt).toBeUndefined();
  });

  it('tier 1 (orchestrator): the POST payload carries an explicit adopt field', async () => {
    process.env.LOOM_SETUP_ORCHESTRATOR_URL = 'http://orch.internal';
    const calls = stubFetch((url) => {
      if (url.startsWith('http://orch.internal')) {
        return { body: { deployment_id: 'dep-1', stream_url: '/s' } };
      }
      return armStub(url);
    });
    const { POST } = await import('@/app/api/setup/deploy/route');
    const r = await POST(bodyReq(adoptSubmit()));
    const j = await r.json();
    expect(r.status).toBe(202);
    expect(j.deploymentMode).toBe('orchestrator');
    const orch = calls.find((c) => c.url.startsWith('http://orch.internal'));
    expect(orch).toBeDefined();
    // The EXPLICIT field — pydantic extra="ignore" drops anything undeclared,
    // so relying on the raw body spread is exactly how the bag got lost before.
    expect(orch!.body?.adopt?.purview?.mode).toBe('adopt');
    expect(orch!.body?.adopt?.purview?.target?.name).toBe('pv-existing');
  });

  it('tier 2 (GitHub dispatch): SKIPPED for a meaningful bag — never dispatch-and-discard', async () => {
    process.env.LOOM_GITHUB_ACTIONS_TOKEN = 'gh-token';
    const calls = stubFetch((url) => {
      if (url.includes('/actions/workflows/')) return { status: 200, body: {} };
      return armStub(url);
    });
    const { POST } = await import('@/app/api/setup/deploy/route');
    const r = await POST(bodyReq(adoptSubmit()));
    const j = await r.json();
    // Falls through to the copy-paste gate WITH the bag, instead of a 202
    // dispatch that silently drops the operator's decisions.
    expect(r.status).toBe(503);
    expect(j.remediation.commands.join('\n')).toContain("-p adopt='");
    expect(calls.some((c) => c.url.includes('/actions/workflows/'))).toBe(false);
  });

  it('tier 2 greenfield: an all-create plan still dispatches (greenfield keeps every tier)', async () => {
    process.env.LOOM_GITHUB_ACTIONS_TOKEN = 'gh-token';
    const calls = stubFetch((url) => {
      if (url.includes('/actions/workflows/')) return { status: 200, body: {} };
      return armStub(url);
    });
    const { POST } = await import('@/app/api/setup/deploy/route');
    const r = await POST(bodyReq(greenfieldSubmit()));
    const j = await r.json();
    expect(r.status).toBe(202);
    expect(j.deploymentMode).toBe('github-workflow-dispatch');
    expect(calls.some((c) => c.url.includes('/actions/workflows/'))).toBe(true);
  });

  it('400 FAIL-CLOSED on a malformed adopt pick — never a silent drop', async () => {
    const b = adoptSubmit();
    (b.plan.services as any).purview.target.sub = 'not-a-guid';
    const { POST } = await import('@/app/api/setup/deploy/route');
    const r = await POST(bodyReq(b));
    const j = await r.json();
    expect(r.status).toBe(400);
    expect(j.problems.join(' ')).toMatch(/not a subscription GUID/);
  });

  it('legacy fields (no plan) still reach the copy-paste gate unchanged', async () => {
    const { POST } = await import('@/app/api/setup/deploy/route');
    const r = await POST(
      bodyReq({
        subscriptionId: SUB,
        boundary: 'Commercial',
        mode: 'single-sub',
        domainName: 'finance',
        capacitySku: 'F8',
        location: 'eastus2',
        existingAdxClusterName: 'adx-legacy',
      }),
    );
    const j = await r.json();
    expect(r.status).toBe(503);
    expect(j.remediation.commands.join('\n')).toContain('adx-legacy');
  });
});
