/**
 * POST /api/admin/brain/perform — the guard chain, end to end (#4242).
 *
 * Runs the REAL `withTenantAdmin` (only the `getSession` / `requireTenantAdmin`
 * leaves are mocked — see `lib/brain/__tests__/ui/authz-mutation.test.ts` for
 * why mocking the wrapper itself proves nothing) and the REAL orchestrator +
 * guards. Mocked at the edges only: the snapshot loader (the fixture is the
 * fresh rebuild), the ARM client module, the audit stream, and the state store
 * (whose own semantics are proven in `state-store.test.ts`).
 *
 * ── MUTATION-GRADE, BY CONSTRUCTION ────────────────────────────────────────
 * Every refusal spec asserts BOTH the 409 and that the ARM write mock was
 * never called. Delete any guard call from `../perform.ts` and its spec goes
 * red: the request sails past the missing guard, reaches the staging arm, and
 * returns 200-staged where the spec demands 409 — while the happy-path spec
 * keeps the suite honest in the other direction (a chain that refuses
 * everything fails THAT one).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import {
  APP_NAME,
  brainSnapshot,
  collectionReport,
  detectorRun,
  ESTATE_ID,
  FINDING_ID,
  NODE_ID,
  RG,
  SUB,
  wireFinding,
  wireNode,
} from './fixtures';

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

// ── the fresh snapshot rebuild ─────────────────────────────────────────────
const snap = vi.hoisted(() => ({ loadSnapshot: vi.fn() }));
vi.mock('@/app/api/admin/brain/_lib/snapshot', () => ({
  loadSnapshot: snap.loadSnapshot,
  ESTATE_QUERY_TEXT: 'Resources',
}));

// ── the ARM client: the ONLY Azure write surface the executor may reach ────
const arm = vi.hoisted(() => ({
  getContainerApp: vi.fn(),
  updateContainerAppScale: vi.fn(),
  readAcaConfig: vi.fn(),
}));
vi.mock('@/lib/azure/container-apps-arm-client', () => {
  class AcaArmError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, body: unknown, message?: string) {
      super(message || `Container Apps ARM call failed (${status})`);
      this.name = 'AcaArmError';
      this.status = status;
      this.body = body;
    }
  }
  class AcaNotConfiguredError extends Error {
    missing: string[];
    constructor(missing: string[]) {
      super(`Container Apps not configured. Missing env: ${missing.join(', ')}`);
      this.name = 'AcaNotConfiguredError';
      this.missing = missing;
    }
  }
  return {
    AcaArmError,
    AcaNotConfiguredError,
    getContainerApp: arm.getContainerApp,
    updateContainerAppScale: arm.updateContainerAppScale,
    readAcaConfig: arm.readAcaConfig,
  };
});

// ── the audit stream ───────────────────────────────────────────────────────
const audit = vi.hoisted(() => ({ emitAuditEvent: vi.fn() }));
vi.mock('@/lib/admin/audit-stream', () => ({
  emitAuditEvent: audit.emitAuditEvent,
}));

// ── an in-memory state store with REAL staging semantics ───────────────────
const mem = vi.hoisted(() => {
  const staged = new Map<
    string,
    { token: string; detector: string; subjectNodeId: string }
  >();
  const calls = {
    stage: [] as unknown[],
    performed: [] as { findingId: string; receipt: unknown }[],
    failed: [] as { findingId: string; error: string }[],
    decisions: [] as unknown[],
  };
  let mintCount = 0;
  // Failure injection for the post-write honesty arms (#4246 blocker): a
  // store outage AFTER a confirmed ARM write must not un-claim the mutation.
  const failures = { performed: false, failed: false };
  const store = {
    read: async () => [],
    recordDecision: async (...a: unknown[]) => {
      calls.decisions.push(a);
      return {} as never;
    },
    stage: async (findingId: string, detector: string, subjectNodeId: string) => {
      mintCount += 1;
      const token = `confirm-token-${mintCount}`;
      staged.set(findingId, { token, detector, subjectNodeId });
      calls.stage.push({ findingId, detector, subjectNodeId });
      return { confirmToken: token, expiresAt: new Date(Date.now() + 600_000).toISOString() };
    },
    consumeStagedToken: async (
      findingId: string,
      detector: string,
      subjectNodeId: string,
      confirmToken: string,
    ) => {
      const s = staged.get(findingId);
      if (
        !s ||
        s.token !== confirmToken ||
        s.detector !== detector ||
        s.subjectNodeId !== subjectNodeId
      ) {
        return {
          guard: 'staged-confirm',
          reason:
            'REFUSED: no live staging matches this confirm. Nothing was changed in Azure.',
        };
      }
      staged.delete(findingId); // single use
      return null;
    },
    recordPerformed: async (findingId: string, receipt: unknown) => {
      if (failures.performed) throw new Error('cosmos unavailable: recordPerformed');
      calls.performed.push({ findingId, receipt });
      return {} as never;
    },
    recordFailed: async (findingId: string, error: string) => {
      if (failures.failed) throw new Error('cosmos unavailable: recordFailed');
      calls.failed.push({ findingId, error });
      return {} as never;
    },
  };
  return {
    staged,
    calls,
    store,
    failures,
    reset() {
      staged.clear();
      calls.stage.length = 0;
      calls.performed.length = 0;
      calls.failed.length = 0;
      calls.decisions.length = 0;
      mintCount = 0;
      failures.performed = false;
      failures.failed = false;
    },
  };
});
vi.mock('@/lib/brain-actions/state-store', () => {
  class BrainActionsNotConfiguredError extends Error {
    constructor() {
      super('LOOM_COSMOS_ENDPOINT is not set');
      this.name = 'BrainActionsNotConfiguredError';
    }
  }
  return {
    BrainActionsNotConfiguredError,
    recommendationStateStore: () => mem.store,
  };
});

import { GET, POST } from '@/app/api/admin/brain/perform/route';
import { ResourceGraphCollectionError } from '@/app/api/admin/brain/_lib/arg-collect';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';

const ADMIN = {
  claims: { oid: 'oid-1', upn: 'admin@example.test', tid: 'tid-1', name: 'Admin' },
  exp: 9_999_999_999,
};

function adminOnly403() {
  return NextResponse.json({ ok: false, error: 'admin_only' }, { status: 403 });
}

const BODY = { findingId: FINDING_ID, detector: 'unreachable-always-on', subjectNodeId: NODE_ID };

function postReq(body: unknown) {
  return {
    method: 'POST',
    nextUrl: new URL('http://x/api/admin/brain/perform'),
    json: async () => body,
  } as never;
}
function getReq(query = '') {
  return {
    method: 'GET',
    nextUrl: new URL(`http://x/api/admin/brain/perform${query}`),
  } as never;
}

const APP_INFO = {
  id: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/${APP_NAME}`,
  name: APP_NAME,
  location: 'centralus',
  minReplicas: 2,
  maxReplicas: 5,
  provisioningState: 'Succeeded',
};

/**
 * #4258 item 4 — the perform path now RESOLVES the estate id from env before
 * it reads the estate, and `guardOwnership` compares the subject's own
 * `loom-estate-id` value against it. So the suite has to name an estate, and
 * it must be the one the fixture's tag carries.
 */
let savedEstateId: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  mem.reset();
  savedEstateId = process.env.LOOM_ESTATE_ID;
  process.env.LOOM_ESTATE_ID = ESTATE_ID;
  (getSession as unknown as ReturnType<typeof vi.fn>).mockReturnValue(ADMIN);
  (requireTenantAdmin as unknown as ReturnType<typeof vi.fn>).mockReturnValue(null);
  snap.loadSnapshot.mockResolvedValue(brainSnapshot());
  arm.readAcaConfig.mockReturnValue({ subscriptionId: SUB, resourceGroup: RG });
  arm.getContainerApp.mockResolvedValue({ ...APP_INFO });
  arm.updateContainerAppScale.mockResolvedValue({ ...APP_INFO, minReplicas: 0 });
});

afterEach(() => {
  if (savedEstateId === undefined) delete process.env.LOOM_ESTATE_ID;
  else process.env.LOOM_ESTATE_ID = savedEstateId;
});

async function stageThenConfirm(): Promise<Response> {
  const stagedRes = await POST(postReq(BODY), { params: Promise.resolve({}) } as never);
  expect(stagedRes.status).toBe(200);
  const { confirmToken } = (await stagedRes.json()) as { confirmToken: string };
  return POST(postReq({ ...BODY, confirmToken }), { params: Promise.resolve({}) } as never);
}

describe('authorization — the REAL withTenantAdmin', () => {
  it('401s with no session; nothing is read, nothing is written, nothing is audited', async () => {
    (getSession as unknown as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const res = await POST(postReq(BODY), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(401);
    expect(snap.loadSnapshot).not.toHaveBeenCalled();
    expect(arm.updateContainerAppScale).not.toHaveBeenCalled();
    expect(audit.emitAuditEvent).not.toHaveBeenCalled();
  });

  it('403s for a signed-in NON-admin — the mutation target', async () => {
    (requireTenantAdmin as unknown as ReturnType<typeof vi.fn>).mockReturnValue(adminOnly403());
    const res = await POST(postReq(BODY), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(403);
    expect(snap.loadSnapshot).not.toHaveBeenCalled();
    expect(arm.updateContainerAppScale).not.toHaveBeenCalled();
  });
});

describe('guard refusals — server-side, re-derived, ARM never touched', () => {
  it('a SECURITY detector is never performable — refused before the estate is even read', async () => {
    const res = await POST(
      postReq({ ...BODY, detector: 'security.c1.unauthorized-inbound-edge' }),
      { params: Promise.resolve({}) } as never,
    );
    expect(res.status).toBe(409);
    const json = (await res.json()) as { ok: boolean; performable: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.performable).toBe(false);
    expect(json.error).toContain('NEVER performable');
    expect(snap.loadSnapshot).not.toHaveBeenCalled();
    expect(arm.updateContainerAppScale).not.toHaveBeenCalled();
    // The refusal is still audited, truthfully.
    const ev = audit.emitAuditEvent.mock.calls[0]![0] as {
      outcome: string;
      detail: { mutatedAzure: unknown };
    };
    expect(ev.outcome).toBe('denied');
    expect(ev.detail.mutatedAzure).toBe(false);
  });

  it('a repo-edit class refuses with the honest reason — never a stub that pretends', async () => {
    const res = await POST(
      postReq({ ...BODY, detector: 'dangling-empty-wire' }),
      { params: Promise.resolve({}) } as never,
    );
    expect(res.status).toBe(409);
    const json = (await res.json()) as { performable: boolean; error: string };
    expect(json.performable).toBe(false);
    expect(json.error).toContain('REPOSITORY EDIT');
    expect(arm.updateContainerAppScale).not.toHaveBeenCalled();
  });

  it('an INCOMPLETE snapshot refuses (#4015/#4016) — the partial-pull rule', async () => {
    snap.loadSnapshot.mockResolvedValue(
      brainSnapshot({ collection: collectionReport({ complete: false, totalRecords: 90 }) }),
    );
    const res = await POST(postReq(BODY), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(409);
    const json = (await res.json()) as { guard: string; error: string };
    expect(json.guard).toBe('snapshot-complete');
    expect(json.error).toContain('INCOMPLETE');
    expect(arm.getContainerApp).not.toHaveBeenCalled();
    expect(arm.updateContainerAppScale).not.toHaveBeenCalled();
  });

  it('a finding the fresh rebuild no longer produces refuses as STALE', async () => {
    snap.loadSnapshot.mockResolvedValue(brainSnapshot({ findings: [] }));
    const res = await POST(postReq(BODY), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { guard: string }).guard).toBe('finding-present');
    expect(arm.updateContainerAppScale).not.toHaveBeenCalled();
  });

  it('UNCONFIRMED ownership on the fresh tag read refuses', async () => {
    snap.loadSnapshot.mockResolvedValue(
      brainSnapshot({ findings: [wireFinding({ ownershipConfirmed: false })] }),
    );
    const res = await POST(postReq(BODY), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(409);
    const json = (await res.json()) as { guard: string; error: string };
    expect(json.guard).toBe('ownership-confirmed');
    expect(json.error).toContain('NOT established');
    expect(arm.updateContainerAppScale).not.toHaveBeenCalled();
  });

  it('a VACUOUS detector refuses', async () => {
    snap.loadSnapshot.mockResolvedValue(
      brainSnapshot({
        detectors: [detectorRun({ vacuous: true, vacuousReason: 'provenance not collected' })],
      }),
    );
    const res = await POST(postReq(BODY), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { guard: string }).guard).toBe('detector-not-vacuous');
    expect(arm.updateContainerAppScale).not.toHaveBeenCalled();
  });

  it('STALE evidence refuses: the fresh ARM GET disagrees with the snapshot claim', async () => {
    arm.getContainerApp.mockResolvedValue({ ...APP_INFO, minReplicas: 1 });
    const res = await POST(postReq(BODY), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(409);
    const json = (await res.json()) as { guard: string; error: string };
    expect(json.guard).toBe('evidence-fresh');
    expect(json.error).toContain('minReplicas=2');
    expect(json.error).toContain('minReplicas=1');
    expect(arm.updateContainerAppScale).not.toHaveBeenCalled();
  });

  it('an UNREADABLE current state refuses with "could not read", never "does not match"', async () => {
    arm.getContainerApp.mockRejectedValue(new Error('socket hang up'));
    const res = await POST(postReq(BODY), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(409);
    const json = (await res.json()) as { guard: string; error: string };
    expect(json.guard).toBe('evidence-fresh');
    expect(json.error).toContain('could NOT be read');
    expect(arm.updateContainerAppScale).not.toHaveBeenCalled();
  });

  // ── #4258 item 4 — THE PERMISSIVE-OWNERSHIP DEFECT, at the route ────────
  //
  // MUTATION CONTROL for the threading: remove `{ estateId: scope.estateId }`
  // from `../perform.ts`'s `loadSnapshot(...)` call and the first spec goes
  // red. Remove the `resolveMutationEstateId` guard and the second goes red
  // (the request reaches the staging arm and answers 200).
  it('loads the fresh snapshot ESTATE-SCOPED — never with the permissive default', async () => {
    await POST(postReq(BODY), { params: Promise.resolve({}) } as never);
    expect(snap.loadSnapshot).toHaveBeenCalledTimes(1);
    expect(snap.loadSnapshot).toHaveBeenCalledWith({ estateId: ESTATE_ID });
  });

  it('refuses BEFORE reading the estate when the console cannot say which estate it is', async () => {
    delete process.env.LOOM_ESTATE_ID;
    delete process.env.LOOM_SUBSCRIPTION_ID;
    const res = await POST(postReq(BODY), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(409);
    const json = (await res.json()) as { guard: string; error: string };
    expect(json.guard).toBe('estate-scoped');
    expect(json.error).toContain('loom:unbound');
    expect(snap.loadSnapshot).not.toHaveBeenCalled();
    expect(arm.updateContainerAppScale).not.toHaveBeenCalled();
  });

  it("a subject tagged for ANOTHER estate refuses even when the snapshot says confirmed", async () => {
    // What a permissively-built snapshot hands the guard chain once the
    // backfill in this same PR makes tags real.
    snap.loadSnapshot.mockResolvedValue(
      brainSnapshot({
        nodes: [
          wireNode({
            tags: { 'loom-estate-id': 'someone-elses-loom' },
            ownership: 'observed',
            ownershipConfirmed: true,
          }),
        ],
      }),
    );
    const res = await POST(postReq(BODY), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(409);
    const json = (await res.json()) as { guard: string; error: string };
    expect(json.guard).toBe('ownership-confirmed');
    expect(json.error).toContain('someone-elses-loom');
    expect(arm.updateContainerAppScale).not.toHaveBeenCalled();
  });

  it('every configured edge DANGLING refuses — the vacuity bypass (#4258 item 3)', async () => {
    snap.loadSnapshot.mockResolvedValue(brainSnapshot({ edges: [] }));
    const res = await POST(postReq(BODY), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { guard: string }).guard).toBe('population-not-blind');
    expect(arm.updateContainerAppScale).not.toHaveBeenCalled();
  });

  it('a subject outside the write scope refuses with both scopes named', async () => {
    arm.readAcaConfig.mockReturnValue({
      subscriptionId: '00000000-0000-4000-8000-000000000099',
      resourceGroup: RG,
    });
    const res = await POST(postReq(BODY), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { guard: string }).guard).toBe('write-scope');
    expect(arm.updateContainerAppScale).not.toHaveBeenCalled();
  });
});

describe('the destructive two-step', () => {
  it('WITHOUT a confirmToken the perform STAGES and does NOT execute', async () => {
    const res = await POST(postReq(BODY), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      staged: boolean;
      performed: boolean;
      confirmToken: string;
      note: string;
    };
    expect(json.ok).toBe(true);
    expect(json.staged).toBe(true);
    expect(json.performed).toBe(false);
    expect(json.confirmToken.length).toBeGreaterThan(0);
    expect(json.note).toContain('Nothing was changed in Azure');
    // THE ASSERTION WITH TEETH: staging never reaches ARM.
    expect(arm.updateContainerAppScale).not.toHaveBeenCalled();
    expect(mem.calls.stage).toHaveLength(1);
    const ev = audit.emitAuditEvent.mock.calls[0]![0] as {
      outcome: string;
      detail: { stage: string; mutatedAzure: unknown };
    };
    expect(ev.outcome).toBe('success');
    expect(ev.detail.stage).toBe('staged');
    expect(ev.detail.mutatedAzure).toBe(false);
  });

  it('a WRONG confirmToken refuses and never executes', async () => {
    await POST(postReq(BODY), { params: Promise.resolve({}) } as never); // stage
    const res = await POST(
      postReq({ ...BODY, confirmToken: 'forged' }),
      { params: Promise.resolve({}) } as never,
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { guard: string }).guard).toBe('staged-confirm');
    expect(arm.updateContainerAppScale).not.toHaveBeenCalled();
  });
});

describe('the happy path — scale-to-zero with a real before/after receipt', () => {
  it('stage → confirm → executes the minReplicas PATCH and audits mutatedAzure: true', async () => {
    const res = await stageThenConfirm();
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      performed: boolean;
      receipt: {
        executor: string;
        resourceId: string;
        before: { minReplicas: number };
        after: { minReplicas: number };
        mutatedAzure: boolean;
      };
    };
    expect(json.ok).toBe(true);
    expect(json.performed).toBe(true);
    expect(json.receipt.executor).toBe('scale-to-zero');
    expect(json.receipt.before.minReplicas).toBe(2);
    expect(json.receipt.after.minReplicas).toBe(0);
    expect(json.receipt.mutatedAzure).toBe(true);
    // The ARM id was DERIVED server-side from the snapshot's own fields.
    expect(json.receipt.resourceId).toBe(
      `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/${APP_NAME}`,
    );

    // The real client call, with the real arguments.
    expect(arm.updateContainerAppScale).toHaveBeenCalledTimes(1);
    expect(arm.updateContainerAppScale).toHaveBeenCalledWith(APP_NAME, { minReplicas: 0 });

    // Persisted + audited, truthfully.
    expect(mem.calls.performed).toHaveLength(1);
    const ev = audit.emitAuditEvent.mock.calls.at(-1)![0] as {
      action: string;
      outcome: string;
      detail: { stage: string; mutatedAzure: unknown };
    };
    expect(ev.action).toBe('brain-perform.unreachable-always-on');
    expect(ev.outcome).toBe('success');
    expect(ev.detail.stage).toBe('performed');
    expect(ev.detail.mutatedAzure).toBe(true);
  });

  it('a consumed token is SINGLE-USE — replaying the confirm refuses', async () => {
    const first = await stageThenConfirm();
    expect(first.status).toBe(200);
    const res = await POST(
      postReq({ ...BODY, confirmToken: 'confirm-token-1' }),
      { params: Promise.resolve({}) } as never,
    );
    expect(res.status).toBe(409);
    expect(arm.updateContainerAppScale).toHaveBeenCalledTimes(1); // still only once
  });
});

describe('the post-write failure window — a held receipt is NEVER un-claimed (#4246 blocker)', () => {
  it('executor succeeds + store write fails → performed:true, persisted:false, audit fires with mutatedAzure true', async () => {
    mem.failures.performed = true;
    const res = await stageThenConfirm();
    // The ARM write happened and the code holds its receipt: the answer is
    // PERFORMED, whatever Cosmos did afterwards. Answering 502 here would
    // state as fact ("not performed") the opposite of what was established.
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      performed: boolean;
      persisted: boolean;
      persistError?: string;
      receipt: { after: { minReplicas: number }; mutatedAzure: boolean };
    };
    expect(json.ok).toBe(true);
    expect(json.performed).toBe(true);
    expect(json.receipt.after.minReplicas).toBe(0);
    expect(json.receipt.mutatedAzure).toBe(true);
    // ...with the store outage DISCLOSED, not absorbed.
    expect(json.persisted).toBe(false);
    expect(json.persistError).toContain('cosmos unavailable');

    expect(arm.updateContainerAppScale).toHaveBeenCalledTimes(1);
    // The audit row still fires, truthful about the mutation AND the store.
    const ev = audit.emitAuditEvent.mock.calls.at(-1)![0] as {
      outcome: string;
      detail: { stage: string; mutatedAzure: unknown; persisted: boolean };
    };
    expect(ev.outcome).toBe('success');
    expect(ev.detail.stage).toBe('performed');
    expect(ev.detail.mutatedAzure).toBe(true);
    expect(ev.detail.persisted).toBe(false);
  });

  it('executor fails + the failure record also fails to persist → still the honest 502, still audited', async () => {
    arm.updateContainerAppScale.mockRejectedValue(new Error('ARM 500'));
    mem.failures.failed = true;
    const res = await stageThenConfirm();
    // Before the fix this DOUBLE failure escaped the orchestrator entirely:
    // the route's generic 500 answered and NO brain-perform audit row existed
    // for a write that had been attempted.
    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: string; persisted: boolean };
    expect(json.error).toContain('ARM 500');
    expect(json.persisted).toBe(false);
    const ev = audit.emitAuditEvent.mock.calls.at(-1)![0] as {
      outcome: string;
      detail: { stage: string; mutatedAzure: unknown };
    };
    expect(ev.outcome).toBe('failure');
    expect(ev.detail.stage).toBe('failed');
    expect(String(ev.detail.mutatedAzure)).toContain('unconfirmed');
  });
});

describe('executor failure — honest, recorded, unconfirmed', () => {
  it('a failed ARM write returns 502 with the real error and audits mutatedAzure as UNCONFIRMED', async () => {
    arm.updateContainerAppScale.mockRejectedValue(
      new Error(`updateContainerAppScale(${APP_NAME}) failed 403`),
    );
    const res = await stageThenConfirm();
    expect(res.status).toBe(502);
    const json = (await res.json()) as {
      ok: boolean;
      performed: boolean;
      error: string;
      mutationConfirmed: boolean;
    };
    expect(json.ok).toBe(false);
    expect(json.performed).toBe(false);
    expect(json.error).toContain('failed 403');
    expect(json.mutationConfirmed).toBe(false);

    expect(mem.calls.failed).toHaveLength(1);
    expect(mem.calls.failed[0]!.error).toContain('failed 403');

    const ev = audit.emitAuditEvent.mock.calls.at(-1)![0] as {
      outcome: string;
      detail: { mutatedAzure: unknown };
    };
    expect(ev.outcome).toBe('failure');
    // R7: a failed write established NEITHER outcome; the audit row must not
    // claim `false` any more than `true`.
    expect(String(ev.detail.mutatedAzure)).toContain('unconfirmed');
  });
});

describe('infra-gate 503s are audited, fail-soft (#4246 nit)', () => {
  it('a Resource Graph failure returns the honest 503 AND writes an audit row', async () => {
    snap.loadSnapshot.mockRejectedValue(
      new ResourceGraphCollectionError('ARG refused the query', 403, 'forbidden'),
    );
    const res = await POST(postReq(BODY), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(503);
    const ev = audit.emitAuditEvent.mock.calls.at(-1)![0] as {
      action: string;
      targetId: string;
      outcome: string;
      detail: { stage: string; gate: string; mutatedAzure: unknown };
    };
    expect(ev.action).toBe('brain-perform.unreachable-always-on');
    expect(ev.targetId).toBe(FINDING_ID);
    expect(ev.outcome).toBe('failure');
    expect(ev.detail.stage).toBe('infra-gate');
    expect(ev.detail.gate).toBe('ResourceGraphCollectionError');
    expect(ev.detail.mutatedAzure).toBe(false);
  });

  it('an audit-stream failure does not mask the 503', async () => {
    snap.loadSnapshot.mockRejectedValue(
      new ResourceGraphCollectionError('ARG refused the query', 403, 'forbidden'),
    );
    // Once, not permanently: vi.clearAllMocks() clears calls, not
    // implementations, and a leaked throwing impl would poison later specs.
    audit.emitAuditEvent.mockImplementationOnce(() => {
      throw new Error('log analytics down');
    });
    const res = await POST(postReq(BODY), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(503);
  });
});

describe('request validation — confirmToken bound (#4246 nit)', () => {
  it('rejects an oversized confirmToken before any work happens', async () => {
    const res = await POST(
      postReq({ ...BODY, confirmToken: 'x'.repeat(513) }),
      { params: Promise.resolve({}) } as never,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('confirmToken');
    expect(snap.loadSnapshot).not.toHaveBeenCalled();
  });
});

describe('GET — the state read-back', () => {
  it('returns recorded states plus the registry performability map', async () => {
    const res = await GET(getReq(), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      states: unknown[];
      performability: { detector: string; performable: boolean }[];
    };
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.states)).toBe(true);
    // The map must carry both a performable class and an honest refusal.
    const byDetector = new Map(json.performability.map((e) => [e.detector, e]));
    expect(byDetector.get('unreachable-always-on')?.performable).toBe(true);
    expect(byDetector.get('dangling-empty-wire')?.performable).toBe(false);
  });

  it('401s with no session', async () => {
    (getSession as unknown as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const res = await GET(getReq(), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(401);
  });
});

describe('request validation', () => {
  it('rejects a missing findingId / detector / subjectNodeId', async () => {
    for (const body of [
      {},
      { findingId: FINDING_ID },
      { findingId: FINDING_ID, detector: 'unreachable-always-on' },
    ]) {
      const res = await POST(postReq(body), { params: Promise.resolve({}) } as never);
      expect(res.status).toBe(400);
    }
    expect(snap.loadSnapshot).not.toHaveBeenCalled();
    expect(audit.emitAuditEvent).not.toHaveBeenCalled();
  });
});
