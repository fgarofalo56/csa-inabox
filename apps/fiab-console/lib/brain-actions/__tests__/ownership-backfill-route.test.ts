/**
 * GET / POST /api/admin/brain/ownership-backfill — end to end (#4255 W2).
 *
 * Runs the REAL `withTenantAdmin` (only the `getSession` / `requireTenantAdmin`
 * leaves are mocked — mocking the wrapper itself would prove nothing, per
 * `lib/brain/__tests__/ui/authz-mutation.test.ts`), the REAL manifest
 * resolution (`resolveDeployManifest` is a pure function of env, so it runs
 * for real), and the REAL orchestrator. Mocked at the edges only: the two ARM
 * calls (tag read, tag merge) and the audit stream.
 *
 * ── MUTATION-GRADE ─────────────────────────────────────────────────────────
 * Every refusal spec asserts BOTH the response AND that the ARM tag-merge mock
 * was never called. Delete the server-side re-derivation from
 * `../ownership-backfill.ts` and the "client-supplied id" spec goes red: the
 * foreign id reaches the write arm and `mergeTag` records a call the spec
 * forbids. Delete the audit emit from the route and the audit specs go red.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

// ── the two authz leaves, and ONLY these ───────────────────────────────────
vi.mock('@/lib/auth/session', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/session')>('@/lib/auth/session');
  return { ...actual, getSession: vi.fn() };
});
vi.mock('@/lib/auth/feature-gate', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/auth/feature-gate')>('@/lib/auth/feature-gate');
  return { ...actual, requireTenantAdmin: vi.fn(() => null) };
});

// ── the audit stream ───────────────────────────────────────────────────────
const audit = vi.hoisted(() => ({ emitAuditEvent: vi.fn() }));
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: audit.emitAuditEvent }));

// ── the ONLY two Azure edges this capability has ───────────────────────────
const arm = vi.hoisted(() => ({
  readTags: vi.fn(),
  mergeTag: vi.fn(),
}));
vi.mock('@/lib/brain-actions/arm-tags', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/brain-actions/arm-tags')>(
      '@/lib/brain-actions/arm-tags',
    );
  return { ...actual, armMergeTag: arm.mergeTag };
});
vi.mock('@/lib/estate/pause-orchestrator', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/estate/pause-orchestrator')>(
      '@/lib/estate/pause-orchestrator',
    );
  // `resolveDeployManifest` and `resolveEstateId` stay REAL — they are pure
  // functions of env, and mocking them would let this suite pass against a
  // manifest resolution that does not exist. Only the ARM tag READ is faked.
  return { ...actual, createManifestTagReader: () => arm.readTags };
});

import { GET, POST } from '@/app/api/admin/brain/ownership-backfill/route';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { LOOM_ESTATE_TAG_KEY } from '@/lib/brain-actions/ownership-backfill';

const SUB = '00000000-0000-4000-8000-000000000001';
const RG = 'rg-loom-dlz';
const ESTATE = 'estate-under-test';
const POOL_ID =
  `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Synapse` +
  `/workspaces/syn-loom/sqlPools/pool01`;
const ADX_ID = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Kusto/clusters/adxloom`;

const ADMIN = {
  claims: { oid: 'oid-1', upn: 'admin@example.test', tid: 'tid-1', name: 'Admin' },
  exp: 9_999_999_999,
};

function adminOnly403() {
  return NextResponse.json({ ok: false, error: 'admin_only' }, { status: 403 });
}

function getReq() {
  return {
    method: 'GET',
    nextUrl: new URL('http://x/api/admin/brain/ownership-backfill'),
  } as never;
}
function postReq(body: unknown) {
  return {
    method: 'POST',
    nextUrl: new URL('http://x/api/admin/brain/ownership-backfill'),
    json: async () => body,
  } as never;
}

const ENV_KEYS = [
  'LOOM_ESTATE_ID',
  'LOOM_SUBSCRIPTION_ID',
  'LOOM_DLZ_RG',
  'LOOM_SYNAPSE_WORKSPACE',
  'LOOM_SYNAPSE_DEDICATED_POOL',
  'LOOM_KUSTO_CLUSTER_NAME',
  'LOOM_AAS_SERVER_NAME',
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.LOOM_ESTATE_ID = ESTATE;
  process.env.LOOM_SUBSCRIPTION_ID = SUB;
  process.env.LOOM_DLZ_RG = RG;
  process.env.LOOM_SYNAPSE_WORKSPACE = 'syn-loom';
  process.env.LOOM_SYNAPSE_DEDICATED_POOL = 'pool01';
  process.env.LOOM_KUSTO_CLUSTER_NAME = 'adxloom';
  process.env.LOOM_AAS_SERVER_NAME = 'aasloom';
  (getSession as unknown as ReturnType<typeof vi.fn>).mockReturnValue(ADMIN);
  (requireTenantAdmin as unknown as ReturnType<typeof vi.fn>).mockReturnValue(null);
  arm.readTags.mockResolvedValue({});
  arm.mergeTag.mockImplementation(async (_id: string, k: string, v: string) => ({ [k]: v }));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

describe('authorization — the REAL withTenantAdmin', () => {
  it('401s with no session; ARM is never read, never written, nothing audited', async () => {
    (getSession as unknown as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const res = await POST(postReq({ resourceIds: [POOL_ID] }), {
      params: Promise.resolve({}),
    } as never);
    expect(res.status).toBe(401);
    expect(arm.readTags).not.toHaveBeenCalled();
    expect(arm.mergeTag).not.toHaveBeenCalled();
    expect(audit.emitAuditEvent).not.toHaveBeenCalled();
  });

  it('403s for a signed-in NON-admin — the mutation target', async () => {
    (requireTenantAdmin as unknown as ReturnType<typeof vi.fn>).mockReturnValue(adminOnly403());
    const res = await POST(postReq({ resourceIds: [POOL_ID] }), {
      params: Promise.resolve({}),
    } as never);
    expect(res.status).toBe(403);
    expect(arm.mergeTag).not.toHaveBeenCalled();
  });

  it('the PREVIEW is admin-only too — a read of the estate is not public', async () => {
    (requireTenantAdmin as unknown as ReturnType<typeof vi.fn>).mockReturnValue(adminOnly403());
    const res = await GET(getReq(), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(403);
    expect(arm.readTags).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET — the preview writes NOTHING
// ---------------------------------------------------------------------------

describe('GET — preview', () => {
  it('returns the manifest-derived list and writes nothing to Azure', async () => {
    const res = await GET(getReq(), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      preview: {
        estateId: string;
        tagKey: string;
        candidates: Array<{ resourceId: string; state: string; reason: { source: string } }>;
        actionableResourceIds: string[];
        populationNote: string;
      };
    };
    expect(json.ok).toBe(true);
    expect(json.preview.estateId).toBe(ESTATE);
    expect(json.preview.tagKey).toBe(LOOM_ESTATE_TAG_KEY);
    expect(json.preview.candidates.length).toBeGreaterThanOrEqual(3);
    for (const c of json.preview.candidates) expect(c.reason.source).toBe('deploy-manifest');
    expect(json.preview.actionableResourceIds).toContain(POOL_ID);
    // THE POINT OF THE PREVIEW.
    expect(arm.mergeTag).not.toHaveBeenCalled();
  });

  it('audits the preview as a READ — mutatedAzure false, stated not omitted', async () => {
    await GET(getReq(), { params: Promise.resolve({}) } as never);
    const ev = audit.emitAuditEvent.mock.calls[0]![0] as {
      action: string;
      outcome: string;
      detail: { mutatedAzure: unknown };
    };
    expect(ev.action).toBe('brain-ownership-backfill.preview');
    expect(ev.outcome).toBe('success');
    expect(ev.detail.mutatedAzure).toBe(false);
  });

  it('shows the non-actionable rows too, with their reason', async () => {
    // An operator confirming a list must see what was considered AND rejected;
    // a screen showing only the actionable rows hides why the others are gone.
    arm.readTags.mockImplementation(async (id: string) => {
      if (id === ADX_ID) throw new Error('ARM 403: no Reader on this cluster');
      return {};
    });
    const res = await GET(getReq(), { params: Promise.resolve({}) } as never);
    const json = (await res.json()) as {
      preview: {
        candidates: Array<{ resourceId: string; state: string; readError?: string }>;
        actionableResourceIds: string[];
      };
    };
    const adx = json.preview.candidates.find((c) => c.resourceId === ADX_ID)!;
    expect(adx.state).toBe('indeterminate');
    expect(adx.readError).toContain('could NOT be read');
    expect(json.preview.actionableResourceIds).not.toContain(ADX_ID);
  });
});

// ---------------------------------------------------------------------------
// POST — the apply
// ---------------------------------------------------------------------------

describe('POST — apply', () => {
  it('400s on a malformed body without touching ARM', async () => {
    for (const body of [null, {}, { resourceIds: 'x' }, { resourceIds: [] }, { resourceIds: [''] }]) {
      const res = await POST(postReq(body), { params: Promise.resolve({}) } as never);
      expect(res.status).toBe(400);
    }
    expect(arm.mergeTag).not.toHaveBeenCalled();
  });

  it('tags a confirmed manifest resource and returns a real per-resource receipt', async () => {
    arm.readTags.mockResolvedValue({ env: 'dev' });
    arm.mergeTag.mockResolvedValue({ env: 'dev', [LOOM_ESTATE_TAG_KEY]: ESTATE });
    const res = await POST(postReq({ resourceIds: [POOL_ID] }), {
      params: Promise.resolve({}),
    } as never);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      backfill: {
        tagged: number;
        results: Array<{
          outcome: string;
          priorEstateTag: string | null;
          priorTags: Record<string, string>;
          afterTags: Record<string, string>;
          mutatedAzure: unknown;
        }>;
      };
    };
    expect(json.backfill.tagged).toBe(1);
    const r = json.backfill.results[0]!;
    expect(r.outcome).toBe('tagged');
    expect(r.mutatedAzure).toBe(true);
    expect(r.priorEstateTag).toBeNull();
    expect(r.priorTags).toEqual({ env: 'dev' });
    expect(r.afterTags).toEqual({ env: 'dev', [LOOM_ESTATE_TAG_KEY]: ESTATE });
    expect(arm.mergeTag).toHaveBeenCalledWith(POOL_ID, LOOM_ESTATE_TAG_KEY, ESTATE);
  });

  it('REFUSES a client-supplied id the server does not derive, and writes NOTHING', async () => {
    const notOurs =
      `/subscriptions/${SUB}/resourceGroups/rg-forzelite/providers/Microsoft.DBforPostgreSQL` +
      '/flexibleServers/forzelite-dev-pgdb';
    const res = await POST(postReq({ resourceIds: [notOurs] }), {
      params: Promise.resolve({}),
    } as never);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      backfill: { tagged: number; refused: number; results: Array<{ reason: string }> };
    };
    expect(json.backfill.tagged).toBe(0);
    expect(json.backfill.refused).toBe(1);
    expect(json.backfill.results[0]!.reason).toContain('not produced by a fresh resolution');
    expect(arm.mergeTag).not.toHaveBeenCalled();
  });

  it('audits the apply with a TRUTHFUL mutatedAzure on a confirmed write', async () => {
    await POST(postReq({ resourceIds: [POOL_ID] }), { params: Promise.resolve({}) } as never);
    const ev = audit.emitAuditEvent.mock.calls[0]![0] as {
      action: string;
      outcome: string;
      detail: { mutatedAzure: unknown; tagged: number; results: unknown[] };
    };
    expect(ev.action).toBe('brain-ownership-backfill.apply');
    expect(ev.outcome).toBe('success');
    expect(ev.detail.mutatedAzure).toBe(true);
    expect(ev.detail.tagged).toBe(1);
    expect(Array.isArray(ev.detail.results)).toBe(true);
  });

  it('audits mutatedAzure FALSE when every id was refused — ARM was never written', async () => {
    const notOurs = `/subscriptions/${SUB}/resourceGroups/rg-sentinel/providers/Microsoft.App/containerApps/sentinel-api`;
    await POST(postReq({ resourceIds: [notOurs] }), { params: Promise.resolve({}) } as never);
    const ev = audit.emitAuditEvent.mock.calls[0]![0] as { detail: { mutatedAzure: unknown } };
    expect(ev.detail.mutatedAzure).toBe(false);
  });

  it("audits mutatedAzure 'unconfirmed' when the write was attempted and did not confirm", async () => {
    arm.mergeTag.mockRejectedValue(new Error('ARM refused to merge: status 403'));
    const res = await POST(postReq({ resourceIds: [POOL_ID] }), {
      params: Promise.resolve({}),
    } as never);
    expect(res.status).toBe(200);
    const ev = audit.emitAuditEvent.mock.calls[0]![0] as {
      outcome: string;
      detail: { mutatedAzure: unknown; failed: number };
    };
    // R7: a failed call establishes NEITHER outcome. Not `false`.
    expect(ev.detail.mutatedAzure).toBe('unconfirmed');
    expect(ev.detail.failed).toBe(1);
    expect(ev.outcome).toBe('failure');
  });

  it('RE-RUNNING is idempotent end to end: the second apply writes nothing', async () => {
    // First run tags it.
    await POST(postReq({ resourceIds: [POOL_ID] }), { params: Promise.resolve({}) } as never);
    expect(arm.mergeTag).toHaveBeenCalledTimes(1);
    // The estate now reports the tag — the same state a real re-run would meet.
    arm.readTags.mockResolvedValue({ [LOOM_ESTATE_TAG_KEY]: ESTATE });
    arm.mergeTag.mockClear();

    const res = await POST(postReq({ resourceIds: [POOL_ID] }), {
      params: Promise.resolve({}),
    } as never);
    const json = (await res.json()) as {
      backfill: { tagged: number; alreadyTagged: number; mutatedAzure: unknown };
    };
    expect(json.backfill.tagged).toBe(0);
    expect(json.backfill.alreadyTagged).toBe(1);
    expect(json.backfill.mutatedAzure).toBe(false);
    expect(arm.mergeTag).not.toHaveBeenCalled();
  });

  it('409s with an honest reason when the estate id cannot be established', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const res = await POST(postReq({ resourceIds: [POOL_ID] }), {
      params: Promise.resolve({}),
    } as never);
    expect(res.status).toBe(409);
    const json = (await res.json()) as { ok: boolean; guard: string; error: string };
    expect(json.ok).toBe(false);
    expect(json.guard).toBe('estate-scoped');
    expect(json.error).toContain('NOTHING was ');
    expect(arm.mergeTag).not.toHaveBeenCalled();
  });
});
