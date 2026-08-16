/**
 * GHSA-hf73-rp4q-66pf — item-level authorization contract for
 * `POST /api/items/prompt-flow/[id]/run`.
 *
 * THE DEFECT THIS PINS. The handler SUBMITTED A FLOW RUN for a caller-named
 * `(project, flowId)` pair with no item-level check: any signed-in caller could
 * execute another tenant's prompt flow, with caller-supplied `inputs`, on the
 * deployment's AI Foundry project. It was excused by check-route-guards'
 * SHARED_BACKEND_ITEM_ROUTES on "no per-tenant Cosmos ownership to scope", which
 * its own sibling `prompt-flow/[id]` disproves — it resolves that `[id]` as an
 * owned Loom item via `loadContentBackedItem`.
 *
 * WHAT IS DELIBERATELY *NOT* MOCKED. `authorizeItemWorkspace`,
 * `authorizeWorkspace` and `isTenantAdmin` all RUN FOR REAL; only the data layer
 * beneath them is stubbed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AccessRole } from '@/lib/auth/workspace-access';

const getSession = vi.fn();
vi.mock('@/lib/auth/session', async () => {
  const actual = await vi.importActual<any>('@/lib/auth/session');
  return { ...actual, getSession: () => getSession() };
});

let itemRows: Array<{ workspaceId?: string }> = [{ workspaceId: 'ws-1' }];
const queryStub = () => ({
  items: { query: () => ({ fetchAll: async () => ({ resources: itemRows }) }) },
});
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => queryStub(),
  workspacesContainer: async () => queryStub(),
}));

const resolveWorkspaceAccessByOid = vi.fn();
vi.mock('@/lib/auth/workspace-access', () => ({
  resolveWorkspaceAccessByOid: (...a: any[]) => resolveWorkspaceAccessByOid(...a),
}));

const submitFlowRun = vi.fn(async () => ({ runId: 'run-1' }));
vi.mock('@/lib/azure/foundry-client', () => ({
  submitFlowRun: (...a: any[]) => submitFlowRun(...a),
  FoundryError: class FoundryError extends Error { status = 502; },
  NotDeployedError: class NotDeployedError extends Error { hint = 'h'; },
}));

import { POST as run } from '../route';

const ID = 'flow-1';
const ctx = () => ({ params: Promise.resolve({ id: ID }) }) as any;
const req = (body: any = { project: 'proj-1', inputs: { q: 'x' } }) => ({ json: async () => body }) as any;

const SESSION = { claims: { oid: 'oid-1', tid: 'tid-1' } };
const OWNER = { workspace: { id: 'ws-1' }, role: 'Owner' as AccessRole, via: 'owner', canWrite: true };
const VIEWER = { workspace: { id: 'ws-1' }, role: 'Viewer' as AccessRole, via: 'acl', canWrite: false };

beforeEach(() => {
  vi.clearAllMocks();
  itemRows = [{ workspaceId: 'ws-1' }];
  getSession.mockReturnValue(SESSION);
  resolveWorkspaceAccessByOid.mockResolvedValue(OWNER);
  submitFlowRun.mockResolvedValue({ runId: 'run-1' } as any);
});

describe('GHSA-hf73-rp4q-66pf — a NON-OWNER is refused (the defect)', () => {
  it('404s a caller with no role on the owning workspace and never submits the run', async () => {
    resolveWorkspaceAccessByOid.mockResolvedValue(null);
    const res = await run(req(), ctx());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'prompt flow not found' });
    expect(submitFlowRun).not.toHaveBeenCalled();
  });

  it('refuses a read-only Viewer — a run executes the flow and bills AOAI capacity', async () => {
    resolveWorkspaceAccessByOid.mockResolvedValue(VIEWER);
    const res = await run(req(), ctx());
    expect(res.status).toBe(404);
    expect(submitFlowRun).not.toHaveBeenCalled();
  });

  it('the guard runs BEFORE the body is read, so an unauthorized caller cannot probe the route', async () => {
    resolveWorkspaceAccessByOid.mockResolvedValue(null);
    const res = await run(req({}), ctx());
    expect(res.status).toBe(404); // not the 400 "project required"
  });
});

describe('GHSA-hf73-rp4q-66pf — a legitimate owner still runs the flow', () => {
  it('an Owner reaches Foundry with the RAW route id', async () => {
    const res = await run(req(), ctx());
    expect(res.status).toBe(200);
    expect(submitFlowRun).toHaveBeenCalledWith('proj-1', ID, { q: 'x' });
  });

  it('a bundle-installed flow keeps its raw `loom:` id on the Foundry call', async () => {
    await run(req(), { params: Promise.resolve({ id: `loom:${ID}` }) } as any);
    expect(submitFlowRun).toHaveBeenCalledWith('proj-1', `loom:${ID}`, { q: 'x' });
  });
});

describe('GHSA-hf73-rp4q-66pf — the guard is unskippable and runs first', () => {
  it('the scope is resolved FROM THE ITEM (there is no Loom workspace param on this route)', async () => {
    await run(req(), ctx());
    expect(resolveWorkspaceAccessByOid).toHaveBeenCalledWith(
      'oid-1', 'ws-1', expect.objectContaining({ callerTid: 'tid-1' }),
    );
  });

  it('401s with no session, before the item lookup or Foundry', async () => {
    getSession.mockReturnValue(null);
    const res = await run(req(), ctx());
    expect(res.status).toBe(401);
    expect(resolveWorkspaceAccessByOid).not.toHaveBeenCalled();
    expect(submitFlowRun).not.toHaveBeenCalled();
  });

  it('an id naming NO prompt-flow item anywhere still reaches the Foundry data plane', async () => {
    // Deliberate, and the reason this route threads `authorizeItemWorkspace`
    // rather than `withWorkspaceOwner`: a flow authored in the Foundry project
    // has no Loom Cosmos item, and `loadOwnedItem` renders "no item" as 404.
    itemRows = [];
    resolveWorkspaceAccessByOid.mockResolvedValue(null);
    const res = await run(req(), ctx());
    expect(res.status).toBe(200);
    expect(submitFlowRun).toHaveBeenCalled();
  });
});
