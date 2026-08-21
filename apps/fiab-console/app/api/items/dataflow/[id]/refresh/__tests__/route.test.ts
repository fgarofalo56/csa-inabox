/**
 * GHSA-hf73-rp4q-66pf — item-level authorization contract for
 * `POST /api/items/dataflow/[id]/refresh`.
 *
 * THE DEFECT THIS PINS. The handler RAN A DATAFLOW for a caller-supplied
 * `(id, workspaceId)` pair with no item-level check: any signed-in caller could
 * execute another tenant's dataflow, which reads that tenant's sources and WRITES
 * to that tenant's configured sink. It was excused by check-route-guards'
 * SHARED_BACKEND_ITEM_ROUTES on "no per-tenant Cosmos ownership to scope", which
 * its own sibling `dataflow/[id]` disproves — GET and PUT there both authorize
 * the same `(id, workspaceId)` through `authorizeItemWorkspace`.
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

const runDataflowAdf = vi.fn(async () => ({ ok: true, runId: 'adf-run-1' }));
vi.mock('@/lib/azure/dataflow-run', () => ({ runDataflowAdf: (...a: any[]) => runDataflowAdf(...a) }));

import { POST as refresh } from '../route';

const ID = 'df-1';
const ctx = () => ({ params: Promise.resolve({ id: ID }) }) as any;
const req = (qs = '?workspaceId=ws-1') =>
  ({ nextUrl: new URL(`http://x/api/items/dataflow/${ID}/refresh${qs}`), json: async () => ({}) }) as any;

const SESSION = { claims: { oid: 'oid-1', tid: 'tid-1' } };
const OWNER = { workspace: { id: 'ws-1' }, role: 'Owner' as AccessRole, via: 'owner', canWrite: true };
const VIEWER = { workspace: { id: 'ws-1' }, role: 'Viewer' as AccessRole, via: 'acl', canWrite: false };

beforeEach(() => {
  vi.clearAllMocks();
  itemRows = [{ workspaceId: 'ws-1' }];
  getSession.mockReturnValue(SESSION);
  resolveWorkspaceAccessByOid.mockResolvedValue(OWNER);
  runDataflowAdf.mockResolvedValue({ ok: true, runId: 'adf-run-1' } as any);
});

describe('GHSA-hf73-rp4q-66pf — a NON-OWNER is refused (the defect)', () => {
  it('404s a caller with no role on the owning workspace and never runs the dataflow', async () => {
    // Before the fix this returned 200 and EXECUTED the named tenant's dataflow,
    // writing to their configured sink.
    resolveWorkspaceAccessByOid.mockResolvedValue(null);
    const res = await refresh(req(), ctx());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'dataflow not found' });
    expect(runDataflowAdf).not.toHaveBeenCalled();
  });

  it('refuses a read-only Viewer — running a dataflow is a mutation', async () => {
    resolveWorkspaceAccessByOid.mockResolvedValue(VIEWER);
    const res = await refresh(req(), ctx());
    expect(res.status).toBe(404);
    expect(runDataflowAdf).not.toHaveBeenCalled();
  });
});

describe('GHSA-hf73-rp4q-66pf — a legitimate owner still runs it', () => {
  it('an Owner reaches ADF with the RAW route id and the caller workspace', async () => {
    const res = await refresh(req(), ctx());
    expect(res.status).toBe(200);
    expect(runDataflowAdf).toHaveBeenCalledWith(ID, 'ws-1');
  });

  it('a bundle-installed dataflow keeps its raw `loom:` id on the ADF call', async () => {
    // `authorizeItemWorkspace` resolves the `loom:` prefix internally for the
    // OWNERSHIP lookup only; the backend call must keep the raw route param or it
    // diverges for every bundle-installed item.
    await refresh(req(), { params: Promise.resolve({ id: `loom:${ID}` }) } as any);
    expect(runDataflowAdf).toHaveBeenCalledWith(`loom:${ID}`, 'ws-1');
  });
});

describe('GHSA-hf73-rp4q-66pf — the guard runs first', () => {
  it('matches the sibling by authorizing the CALLER-SUPPLIED workspace (a Loom Cosmos partition here)', async () => {
    // Unlike the Power BI families in this advisory, a `dataflow` workspaceId IS
    // a Loom Cosmos partition key — `dataflow/[id]` point-reads
    // `items.item(id, workspaceId)` with it — so it is the right scope.
    await refresh(req('?workspaceId=ws-1'), ctx());
    expect(resolveWorkspaceAccessByOid).toHaveBeenCalledWith(
      'oid-1', 'ws-1', expect.objectContaining({ callerTid: 'tid-1' }),
      // #3825 — the guard now threads the WorkspaceAccessDiagnostics out-channel
      // so a refused tenant-admin grant is rendered as an honest 409 rather than
      // a bare 404. toHaveBeenCalledWith is exact on arity, hence this argument.
      expect.any(Object),
    );
  });

  it('401s with no session, before the item lookup or ADF', async () => {
    getSession.mockReturnValue(null);
    const res = await refresh(req(), ctx());
    expect(res.status).toBe(401);
    expect(resolveWorkspaceAccessByOid).not.toHaveBeenCalled();
    expect(runDataflowAdf).not.toHaveBeenCalled();
  });
});
