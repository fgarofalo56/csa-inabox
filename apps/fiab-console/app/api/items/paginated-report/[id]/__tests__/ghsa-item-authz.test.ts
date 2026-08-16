/**
 * GHSA-hf73-rp4q-66pf — item-level authorization contract for the two
 * `paginated-report/[id]` routes that had none.
 *
 * THE DEFECT THESE PIN. The type-root `GET` returned a caller-named paginated
 * report's metadata, and `POST [id]/export` rendered it to a real PDF / XLSX /
 * DOCX — and when the body omitted `definition` it first LOADED the saved RDL via
 * `getRdlDefinition(workspaceId, id)`, so the report's full definition (its data
 * sources, connection details and queries) rendered into a downloadable file for
 * an unauthorized caller. Both were excused by check-route-guards'
 * SHARED_BACKEND_ITEM_ROUTES on "no per-tenant Cosmos ownership to scope", which
 * their own sibling `paginated-report/[id]/rdl` disproves — it resolves the SAME
 * `[id]` through `loadOwnedItem` / `updateOwnedItem`.
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

const getReport = vi.fn(async () => ({ id: 'pr-1', name: 'R' }));
vi.mock('@/lib/azure/powerbi-client', () => ({
  getReport: (...a: any[]) => getReport(...a),
  PowerBiError: class PowerBiError extends Error { status = 502; },
}));

const renderReport = vi.fn(async () => ({
  bytes: Buffer.from('%PDF-1.7 real-bytes'), mimeType: 'application/pdf', fileName: 'R.pdf',
}));
const getRdlDefinition = vi.fn(async () => null);
vi.mock('@/lib/azure/paginated-report-client', () => ({
  paginatedRenderGate: () => null,
  renderReport: (...a: any[]) => renderReport(...a),
  getRdlDefinition: (...a: any[]) => getRdlDefinition(...a),
}));
vi.mock('@/lib/azure/rate-limiter', () => ({ enforceRateLimit: async () => null }));

import { GET as metadata } from '../route';
import { POST as exportReport } from '../export/route';

const ID = 'pr-1';
const ctx = () => ({ params: Promise.resolve({ id: ID }) }) as any;
const req = (qs = '', body: any = {}) =>
  ({ nextUrl: new URL(`http://x/api/items/paginated-report/${ID}${qs}`), json: async () => body }) as any;

const SESSION = { claims: { oid: 'oid-1', tid: 'tid-1' } };
const OWNER = { workspace: { id: 'ws-1' }, role: 'Owner' as AccessRole, via: 'owner', canWrite: true };
const VIEWER = { workspace: { id: 'ws-1' }, role: 'Viewer' as AccessRole, via: 'acl', canWrite: false };

const DEF = {
  id: ID, workspaceId: 'ws-1', name: 'My Report', pageOrientation: 'Portrait',
  pageSize: 'Letter', dataSources: [], datasets: [], tablixes: [], parameters: [],
  createdAt: '', updatedAt: '',
};

beforeEach(() => {
  vi.clearAllMocks();
  itemRows = [{ workspaceId: 'ws-1' }];
  getSession.mockReturnValue(SESSION);
  resolveWorkspaceAccessByOid.mockResolvedValue(OWNER);
  getReport.mockResolvedValue({ id: ID, name: 'R' });
  renderReport.mockResolvedValue({
    bytes: Buffer.from('%PDF-1.7 real-bytes'), mimeType: 'application/pdf', fileName: 'R.pdf',
  });
  getRdlDefinition.mockResolvedValue(null);
});

describe('GHSA-hf73-rp4q-66pf — a NON-OWNER is refused and no backend is reached', () => {
  it('GET 404s a caller with no role on the owning workspace', async () => {
    resolveWorkspaceAccessByOid.mockResolvedValue(null);
    const res = await metadata(req('?workspaceId=pbi-ws'), ctx());
    expect(res.status).toBe(404);
    expect(getReport).not.toHaveBeenCalled();
  });

  it('export 404s a non-owner and never renders bytes', async () => {
    resolveWorkspaceAccessByOid.mockResolvedValue(null);
    const res = await exportReport(req('', { format: 'pdf', definition: DEF }), ctx());
    expect(res.status).toBe(404);
    expect(renderReport).not.toHaveBeenCalled();
  });

  it('export never LOADS the saved RDL definition for a non-owner', async () => {
    // The definition-fallback branch was the worse half: it read the stored RDL
    // — data sources, connection details, queries — before rendering.
    resolveWorkspaceAccessByOid.mockResolvedValue(null);
    const res = await exportReport(req('', { format: 'pdf', workspaceId: 'ws-1' }), ctx());
    expect(res.status).toBe(404);
    expect(getRdlDefinition).not.toHaveBeenCalled();
  });

  it('the guard runs BEFORE the format check, so an unauthorized caller cannot probe the route', async () => {
    resolveWorkspaceAccessByOid.mockResolvedValue(null);
    const res = await exportReport(req('', { format: 'not-a-format', definition: DEF }), ctx());
    expect(res.status).toBe(404);
  });
});

describe('GHSA-hf73-rp4q-66pf — a legitimate VIEWER is not locked out', () => {
  it('GET still serves a read-only Viewer', async () => {
    resolveWorkspaceAccessByOid.mockResolvedValue(VIEWER);
    const res = await metadata(req('?workspaceId=pbi-ws'), ctx());
    expect(res.status).toBe(200);
    expect(getReport).toHaveBeenCalledWith('pbi-ws', ID);
  });

  it('export still serves a read-only Viewer and streams real bytes', async () => {
    resolveWorkspaceAccessByOid.mockResolvedValue(VIEWER);
    const res = await exportReport(req('', { format: 'pdf', definition: DEF }), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toContain('%PDF');
  });
});

describe('GHSA-hf73-rp4q-66pf — the guard is unskippable and runs first', () => {
  it('authorization is scoped to the PAGINATED-REPORT item, not the caller-supplied Power BI workspace', async () => {
    await metadata(req('?workspaceId=pbi-ws'), ctx());
    expect(resolveWorkspaceAccessByOid).toHaveBeenCalledWith(
      'oid-1',
      'ws-1',
      expect.objectContaining({ callerTid: 'tid-1' }),
    );
  });

  it('GET authorizes even when ?workspaceId= is ABSENT (unskippable)', async () => {
    resolveWorkspaceAccessByOid.mockResolvedValue(null);
    const res = await metadata(req(''), ctx());
    expect(res.status).toBe(404);
    expect(resolveWorkspaceAccessByOid).toHaveBeenCalledTimes(1);
  });

  it('401s with no session, before the item lookup or the backend', async () => {
    getSession.mockReturnValue(null);
    const res = await metadata(req('?workspaceId=pbi-ws'), ctx());
    expect(res.status).toBe(401);
    expect(resolveWorkspaceAccessByOid).not.toHaveBeenCalled();
  });

  it('an id naming NO paginated-report item anywhere still reaches the opt-in Power BI path', async () => {
    itemRows = [];
    resolveWorkspaceAccessByOid.mockResolvedValue(null);
    const res = await metadata(req('?workspaceId=pbi-ws'), ctx());
    expect(res.status).toBe(200);
    expect(getReport).toHaveBeenCalled();
  });
});
