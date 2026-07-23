/**
 * I7 — grant-check preflight contract tests (preflightWorkspaceEnforce).
 *
 * Invariants (PRP ws-identity-cloudmatrix §I7):
 *  - ready ⇔ UAMI provisioned + zero would-be-denied grants + zero shadow
 *    divergences + config gate clear + shadow rollup readable.
 *  - missingGrants lists ONLY backends the workspace UAMI would be DENIED
 *    (wouldAllow === false); not-applicable / unresolvable (null) never counts.
 *  - divergences + observedCalls come from the REAL identity.shadow rollup.
 *  - observedCalls === 0 is a WARNING, not a blocker.
 *  - NEVER throws — an unreachable ARM / Cosmos degrades to a blocking reason.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { getWorkspaceUami, workspaceIdentityConfigGate, evaluateWorkspaceGrant, query } = vi.hoisted(
  () => ({
    getWorkspaceUami: vi.fn(),
    workspaceIdentityConfigGate: vi.fn(),
    evaluateWorkspaceGrant: vi.fn(),
    query: vi.fn(),
  }),
);

vi.mock('@/lib/azure/cosmos-client', () => ({
  auditLogContainer: async () => ({ items: { query } }),
}));
vi.mock('@/lib/azure/workspace-identity-client', () => ({
  getWorkspaceUami,
  workspaceIdentityConfigGate,
  workspaceUamiName: (id: string) => `uami-ws-${id}`,
}));
vi.mock('@/lib/azure/workspace-grants', () => ({
  // Two backends so a single would-be-denied case is unambiguous.
  WORKSPACE_GRANTS: [{ backend: 'adls-lake' }, { backend: 'cosmos-data' }],
  evaluateWorkspaceGrant,
}));

import { preflightWorkspaceEnforce } from '../workspace-identity-preflight';

/** Wire the audit-log COUNT queries: total observations, then divergences. */
function mockShadowRollup({ observed, divergent }: { observed: number; divergent: number }) {
  query.mockImplementation((spec: { query: string }) => ({
    fetchAll: async () => ({
      resources: [/divergence = true/.test(spec.query) ? divergent : observed],
    }),
  }));
}

const UAMI = { id: '/x/uami-ws-ws1', name: 'uami-ws-ws1', clientId: 'CID', principalId: 'PID' };
const allow = (backend: string) => ({ backend, wouldAllow: true, reason: 'granted', source: 'arm', checkedAt: 'T' });
const deny = (backend: string) => ({ backend, wouldAllow: false, reason: 'no assignment', source: 'arm', checkedAt: 'T' });

beforeEach(() => {
  getWorkspaceUami.mockReset();
  workspaceIdentityConfigGate.mockReset().mockReturnValue(null);
  evaluateWorkspaceGrant.mockReset();
  query.mockReset();
  mockShadowRollup({ observed: 42, divergent: 0 });
});

describe('preflightWorkspaceEnforce', () => {
  it('READY: UAMI provisioned, every grant allows, zero divergences', async () => {
    getWorkspaceUami.mockResolvedValue(UAMI);
    evaluateWorkspaceGrant.mockImplementation(async (_ws, _u, backend: string) => allow(backend));

    const r = await preflightWorkspaceEnforce({ id: 'ws1' });

    expect(r.ready).toBe(true);
    expect(r.uamiProvisioned).toBe(true);
    expect(r.missingGrants).toEqual([]);
    expect(r.divergences).toBe(0);
    expect(r.observedCalls).toBe(42);
    expect(r.reasons).toEqual([]);
    expect(r.grantEvaluations).toHaveLength(2);
  });

  it('NOT READY: a would-be-denied grant lands in missingGrants and blocks', async () => {
    getWorkspaceUami.mockResolvedValue(UAMI);
    evaluateWorkspaceGrant.mockImplementation(async (_ws, _u, backend: string) =>
      backend === 'cosmos-data' ? deny(backend) : allow(backend),
    );

    const r = await preflightWorkspaceEnforce({ id: 'ws1' });

    expect(r.ready).toBe(false);
    expect(r.missingGrants).toEqual(['cosmos-data']);
    expect(r.reasons.some((x) => x.includes('cosmos-data'))).toBe(true);
  });

  it('NOT READY: UAMI not provisioned (grants never evaluated)', async () => {
    getWorkspaceUami.mockResolvedValue(null);

    const r = await preflightWorkspaceEnforce({ id: 'ws-new' });

    expect(r.ready).toBe(false);
    expect(r.uamiProvisioned).toBe(false);
    expect(evaluateWorkspaceGrant).not.toHaveBeenCalled();
    expect(r.reasons.some((x) => x.includes('not provisioned'))).toBe(true);
  });

  it('NOT READY: shadow divergences block even when grants currently allow', async () => {
    getWorkspaceUami.mockResolvedValue(UAMI);
    evaluateWorkspaceGrant.mockImplementation(async (_ws, _u, backend: string) => allow(backend));
    mockShadowRollup({ observed: 100, divergent: 3 });

    const r = await preflightWorkspaceEnforce({ id: 'ws1' });

    expect(r.ready).toBe(false);
    expect(r.divergences).toBe(3);
    expect(r.reasons.some((x) => /divergence/i.test(x))).toBe(true);
  });

  it('null (not-applicable / unresolvable) grants are NOT counted as missing', async () => {
    getWorkspaceUami.mockResolvedValue(UAMI);
    evaluateWorkspaceGrant.mockImplementation(async (_ws, _u, backend: string) =>
      backend === 'cosmos-data'
        ? { backend, wouldAllow: null, reason: 'not configured', source: 'not-applicable', checkedAt: 'T' }
        : allow(backend),
    );

    const r = await preflightWorkspaceEnforce({ id: 'ws1' });

    expect(r.missingGrants).toEqual([]);
    expect(r.ready).toBe(true);
  });

  it('observedCalls === 0 warns but does NOT block', async () => {
    getWorkspaceUami.mockResolvedValue(UAMI);
    evaluateWorkspaceGrant.mockImplementation(async (_ws, _u, backend: string) => allow(backend));
    mockShadowRollup({ observed: 0, divergent: 0 });

    const r = await preflightWorkspaceEnforce({ id: 'ws1' });

    expect(r.ready).toBe(true);
    expect(r.observedCalls).toBe(0);
    expect(r.warnings.some((x) => /no identity\.shadow/i.test(x))).toBe(true);
  });

  it('NOT READY: config gate open — no ARM probe, honest reason', async () => {
    workspaceIdentityConfigGate.mockReturnValue({ missing: 'LOOM_WS_IDENTITY_SUB' });

    const r = await preflightWorkspaceEnforce({ id: 'ws1' });

    expect(r.ready).toBe(false);
    expect(getWorkspaceUami).not.toHaveBeenCalled();
    expect(r.reasons.some((x) => x.includes('LOOM_WS_IDENTITY_SUB'))).toBe(true);
  });

  it('NEVER throws: an unreadable shadow rollup degrades to a blocking reason', async () => {
    getWorkspaceUami.mockResolvedValue(UAMI);
    evaluateWorkspaceGrant.mockImplementation(async (_ws, _u, backend: string) => allow(backend));
    query.mockImplementation(() => ({ fetchAll: async () => { throw new Error('cosmos down'); } }));

    const r = await preflightWorkspaceEnforce({ id: 'ws1' });

    expect(r.ready).toBe(false);
    expect(r.reasons.some((x) => /shadow/i.test(x))).toBe(true);
  });

  it('NEVER throws: a blown grant evaluation is caught and recorded, not thrown', async () => {
    getWorkspaceUami.mockResolvedValue(UAMI);
    evaluateWorkspaceGrant.mockRejectedValue(new Error('ARM 500'));

    const r = await preflightWorkspaceEnforce({ id: 'ws1' });

    // Errored evaluations resolve wouldAllow:null → not missing, not ready-blocking
    // by themselves; ready stays true here (UAMI up, no divergences).
    expect(r.grantEvaluations.every((g) => g.wouldAllow === null)).toBe(true);
    expect(r.missingGrants).toEqual([]);
  });
});
