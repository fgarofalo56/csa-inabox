/**
 * `listOwnedItems` — BOTH branches must enforce the same authorization.
 *
 * CodeQL js/user-controlled-bypass #625 flags `if (opts.workspaceId)` on
 * item-crud.ts:273: "this condition guards a sensitive action, but a
 * user-provided value controls it." The caller chooses whether to pass
 * `workspaceId`, and that choice selects between two different query paths — so
 * the query is right to ask which one an attacker would pick.
 *
 * Reading the code, both paths ARE authorized:
 *
 *   workspaceId present -> authorize that ONE workspace, then a partition-keyed
 *                          query returns only its items
 *   workspaceId absent   -> query the type, then filter EVERY row through
 *                          resolveWorkspaceAccessByOid and keep only visible ones
 *
 * i.e. the branch is a PERFORMANCE optimization (partition-keyed vs.
 * fetch-then-filter), not a security boundary. But that equivalence had no test,
 * so it was a property of the current source rather than a guarantee — exactly
 * the state in which a later refactor quietly turns the fast path into the
 * unguarded one.
 *
 * These pin it: an item in a workspace the caller cannot see must NOT be
 * returned, whichever branch runs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ALLOWED_WS = 'ws-mine';
const FORBIDDEN_WS = 'ws-theirs';

const resolveWorkspaceAccessByOid = vi.fn();
const authorizeWorkspaceList = vi.fn();
const fetchAll = vi.fn();

vi.mock('@/lib/auth/workspace-access', () => ({
  resolveWorkspaceAccessByOid: (...a: any[]) => resolveWorkspaceAccessByOid(...a),
}));
vi.mock('@/lib/auth/workspace-list-access', () => ({
  authorizeWorkspaceList: (...a: any[]) => authorizeWorkspaceList(...a),
}));
vi.mock('@/lib/auth/workspace-guard', () => ({ authorizeWorkspace: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({ items: { query: () => ({ fetchAll }) } }),
  workspacesContainer: async () => ({ items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) } }),
  tenantSettingsContainer: async () => ({ items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) } }),
}));
vi.mock('@/lib/azure/loom-search', () => ({ upsertLoomDoc: vi.fn(), deleteLoomDoc: vi.fn(), docForItem: vi.fn() }));
vi.mock('@/lib/azure/loom-data-products-search', () => ({
  upsertDataProductDoc: vi.fn(), deleteDataProductDoc: vi.fn(), docForDataProduct: vi.fn(),
}));
vi.mock('@/lib/azure/governance-catalog-index', () => ({
  upsertGovernanceItem: vi.fn(), deleteGovernanceItem: vi.fn(),
  docForGovernanceItem: vi.fn(), isCatalogDataType: vi.fn(() => false),
}));
vi.mock('@/lib/azure/purview-autoonboard', () => ({
  autoOnboardToPurview: vi.fn(), offboardFromPurview: vi.fn(),
}));
vi.mock('@/lib/thread/thread-edges', () => ({
  reconcileThreadEdgesOnDelete: vi.fn(), restoreThreadEdgesForItem: vi.fn(),
}));

import { listOwnedItems, listAllOwnedItems } from '../item-crud';

const mine = { id: 'i-1', itemType: 't', workspaceId: ALLOWED_WS } as any;
const theirs = { id: 'i-2', itemType: 't', workspaceId: FORBIDDEN_WS } as any;

beforeEach(() => {
  vi.clearAllMocks();
  // Visible iff the workspace is the caller's.
  resolveWorkspaceAccessByOid.mockImplementation(async (_tid: string, ws: string) =>
    (ws === ALLOWED_WS ? { canWrite: true } : null));
  authorizeWorkspaceList.mockImplementation(async (_s: any, ws: string) =>
    (ws === ALLOWED_WS ? { canWrite: true } : null));
});

describe('listOwnedItems — the workspaceId branch is a perf choice, NOT an authz gate (CodeQL #625)', () => {
  it('workspaceId ABSENT: filters out an item in a workspace the caller cannot see', async () => {
    fetchAll.mockResolvedValue({ resources: [mine, theirs] });
    const out = await listOwnedItems('t', 'tenant-1');
    expect(out.map((i: any) => i.id)).toEqual(['i-1']);
  });

  it('workspaceId PRESENT and forbidden: returns nothing, and never runs the query', async () => {
    fetchAll.mockResolvedValue({ resources: [theirs] });
    const out = await listOwnedItems('t', 'tenant-1', { workspaceId: FORBIDDEN_WS });
    expect(out).toEqual([]);
    // Authorization happens BEFORE the fetch — the partition-keyed query is
    // never issued for a workspace the caller cannot see.
    expect(fetchAll).not.toHaveBeenCalled();
  });

  it('workspaceId PRESENT and allowed: returns that workspace’s items', async () => {
    fetchAll.mockResolvedValue({ resources: [mine] });
    const out = await listOwnedItems('t', 'tenant-1', { workspaceId: ALLOWED_WS });
    expect(out.map((i: any) => i.id)).toEqual(['i-1']);
  });

  it('BOTH branches agree: omitting workspaceId is not a way to reach a forbidden item', async () => {
    // The bypass the CodeQL alert is really asking about: can a caller drop the
    // parameter to escape the check? Same forbidden item, both branches.
    fetchAll.mockResolvedValue({ resources: [theirs] });
    const viaScoped = await listOwnedItems('t', 'tenant-1', { workspaceId: FORBIDDEN_WS });
    fetchAll.mockResolvedValue({ resources: [theirs] });
    const viaUnscoped = await listOwnedItems('t', 'tenant-1');
    expect(viaScoped).toEqual([]);
    expect(viaUnscoped).toEqual([]);
  });
});

/**
 * `listAllOwnedItems` — the SAME `if (workspaceId)` shape, one function down,
 * and the site CodeQL js/user-controlled-bypass #755 flags (item-crud.ts:384).
 *
 * #625 (the `listOwnedItems` twin above) was reviewed and dismissed as a false
 * positive on exactly this reasoning, and the tests above pinned it. Nothing
 * pinned THIS one — the alert is on a different function that two more routes
 * reach with a request-controlled `workspaceId`:
 *
 *   POST /api/catalog/register      body.workspaceId
 *   GET  /api/git-integration/status ?workspaceId=  (via _lib/ctx.ts)
 *
 * Reading the code, `listAllOwnedItems` is STRICTLY STRONGER than its twin:
 * where `listOwnedItems` returns the partition-keyed rows directly once the one
 * workspace is authorized, `listAllOwnedItems` has no such early return — the
 * per-row `resolveWorkspaceAccessByOid` filter runs on EVERY row on BOTH
 * branches. So dropping `workspaceId` widens the SCAN and cannot widen the
 * RESULT. The last test below is the one that says so: even on the scoped
 * branch, a row the query should not have returned is still dropped.
 */
describe('listAllOwnedItems — the workspaceId branch is a perf choice, NOT an authz gate (CodeQL #755)', () => {
  it('workspaceId ABSENT: filters out an item in a workspace the caller cannot see', async () => {
    fetchAll.mockResolvedValue({ resources: [mine, theirs] });
    const out = await listAllOwnedItems('tenant-1');
    expect(out.map((i: any) => i.id)).toEqual(['i-1']);
  });

  it('workspaceId PRESENT and forbidden: returns nothing, and never runs the query', async () => {
    fetchAll.mockResolvedValue({ resources: [theirs] });
    const out = await listAllOwnedItems('tenant-1', FORBIDDEN_WS);
    expect(out).toEqual([]);
    expect(fetchAll).not.toHaveBeenCalled();
  });

  it('workspaceId PRESENT and allowed: returns that workspace’s items', async () => {
    fetchAll.mockResolvedValue({ resources: [mine] });
    const out = await listAllOwnedItems('tenant-1', ALLOWED_WS);
    expect(out.map((i: any) => i.id)).toEqual(['i-1']);
  });

  it('BOTH branches agree: omitting workspaceId is not a way to reach a forbidden item', async () => {
    fetchAll.mockResolvedValue({ resources: [theirs] });
    const viaScoped = await listAllOwnedItems('tenant-1', FORBIDDEN_WS);
    fetchAll.mockResolvedValue({ resources: [theirs] });
    const viaUnscoped = await listAllOwnedItems('tenant-1');
    expect(viaScoped).toEqual([]);
    expect(viaUnscoped).toEqual([]);
  });

  it('the SCOPED branch still filters every row — an over-returning query cannot leak', async () => {
    // Authorize the one workspace, then hand the caller a result set that also
    // contains a foreign row (what a mis-scoped WHERE / partition-key drift
    // would produce). The per-row filter is unconditional here, so the foreign
    // row must not survive. This is the property that makes the branch a perf
    // choice rather than a gate.
    fetchAll.mockResolvedValue({ resources: [mine, theirs] });
    const out = await listAllOwnedItems('tenant-1', ALLOWED_WS);
    expect(out.map((i: any) => i.id)).toEqual(['i-1']);
  });

  it('a session-bearing caller goes through the authorizeWorkspaceList chokepoint', async () => {
    // The ternary at item-crud.ts:385 is a CODE-level choice (does this caller
    // hold a session?), not a security branch — but which resolver ran must
    // still be observable, or a later refactor could quietly drop the session
    // path without any test noticing.
    fetchAll.mockResolvedValue({ resources: [mine] });
    const session = { claims: { oid: 'tenant-1', tid: 'tid-1', groups: [] } } as any;
    await listAllOwnedItems('tenant-1', ALLOWED_WS, { session });
    expect(authorizeWorkspaceList).toHaveBeenCalledWith(session, ALLOWED_WS);

    vi.clearAllMocks();
    resolveWorkspaceAccessByOid.mockImplementation(async (_tid: string, ws: string) =>
      (ws === ALLOWED_WS ? { canWrite: true } : null));
    fetchAll.mockResolvedValue({ resources: [mine] });
    await listAllOwnedItems('tenant-1', ALLOWED_WS);
    expect(authorizeWorkspaceList).not.toHaveBeenCalled();
    expect(resolveWorkspaceAccessByOid).toHaveBeenCalled();
  });
});
