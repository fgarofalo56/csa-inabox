/**
 * GHSA-hf73-rp4q-66pf — item-level authorization contract for the three
 * `report/[id]/**` routes that had none.
 *
 * THE DEFECT THESE PIN. `embed-token`, `export` and `paginated-embed-token` each
 * consumed `[id]` and ran no item-level check:
 *   - embed-token minted a Power BI embed token up to and including **Edit**
 *     scope for a caller-named report;
 *   - paginated-embed-token minted one AND granted `xmlaPermissions:'ReadOnly'`
 *     over every semantic model the caller listed;
 *   - export returned the report's real rendered bytes, and on the loom-native
 *     branch resolved another item's SENSITIVITY LABEL for an unauthorized
 *     caller.
 * All three were excused by check-route-guards' SHARED_BACKEND_ITEM_ROUTES on
 * "no per-tenant Cosmos ownership to scope" — while NINETEEN sibling routes under
 * `report/[id]/**` resolve that same `[id]` as an owned Loom item.
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

const generateReportEmbedToken = vi.fn(async () => ({ token: 'REAL-TOKEN', tokenId: 't', expiration: 'e' }));
const generatePaginatedReportEmbedToken = vi.fn(async () => ({ token: 'REAL-PAGINATED-TOKEN', tokenId: 't', expiration: 'e' }));
const getReport = vi.fn(async () => ({ id: 'rpt-1', embedUrl: 'https://x' }));
const startReportExport = vi.fn(async () => ({ id: 'exp-1', status: 'Succeeded' }));
const getReportExportStatus = vi.fn(async () => ({ id: 'exp-1', status: 'Succeeded' }));
const getReportExportFile = vi.fn(async () => ({ bytes: Buffer.from('%PDF-1.7') }));
const startPaginatedReportExport = vi.fn(async () => ({ id: 'exp-1', status: 'Succeeded' }));
vi.mock('@/lib/azure/powerbi-client', () => ({
  generateReportEmbedToken: (...a: any[]) => generateReportEmbedToken(...a),
  generatePaginatedReportEmbedToken: (...a: any[]) => generatePaginatedReportEmbedToken(...a),
  getReport: (...a: any[]) => getReport(...a),
  getPbiEmbedHostname: () => 'app.powerbi.com',
  startReportExport: (...a: any[]) => startReportExport(...a),
  startPaginatedReportExport: (...a: any[]) => startPaginatedReportExport(...a),
  getReportExportStatus: (...a: any[]) => getReportExportStatus(...a),
  getReportExportFile: (...a: any[]) => getReportExportFile(...a),
  PowerBiError: class PowerBiError extends Error { status = 502; },
}));

const applySensitivityStamp = vi.fn(async (_s: any, _id: any, bytes: Buffer) => ({ bytes, blocked: null }));
vi.mock('@/lib/azure/report-export-label', () => ({
  applySensitivityStamp: (...a: any[]) => applySensitivityStamp(...a),
}));
vi.mock('@/lib/azure/rate-limiter', () => ({ enforceRateLimit: async () => null }));
const fetchWithTimeout = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }));
vi.mock('@/lib/azure/fetch-with-timeout', () => ({
  fetchWithTimeout: (...a: any[]) => fetchWithTimeout(...a),
  FetchTimeoutError: class FetchTimeoutError extends Error {},
}));
vi.mock('@/lib/azure/cloud-endpoints', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  assertFabricFamilyAvailable: () => undefined,
}));

import { POST as embedToken } from '../embed-token/route';
import { POST as paginatedEmbedToken } from '../paginated-embed-token/route';
import { POST as exportReport } from '../export/route';

const ID = 'rpt-1';
const ctx = () => ({ params: Promise.resolve({ id: ID }) }) as any;
const req = (body: any = {}) =>
  ({ nextUrl: new URL(`http://x/api/items/report/${ID}/x`), json: async () => body }) as any;

const SESSION = { claims: { oid: 'oid-1', tid: 'tid-1' } };
const OWNER = { workspace: { id: 'ws-1' }, role: 'Owner' as AccessRole, via: 'owner', canWrite: true };
const VIEWER = { workspace: { id: 'ws-1' }, role: 'Viewer' as AccessRole, via: 'acl', canWrite: false };

const ALL_BACKENDS = [
  generateReportEmbedToken, generatePaginatedReportEmbedToken, getReport,
  startReportExport, startPaginatedReportExport, getReportExportFile,
  applySensitivityStamp, fetchWithTimeout,
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('LOOM_REPORT_RENDERER', 'https://renderer.example');
  itemRows = [{ workspaceId: 'ws-1' }];
  getSession.mockReturnValue(SESSION);
  resolveWorkspaceAccessByOid.mockResolvedValue(OWNER);
  generateReportEmbedToken.mockResolvedValue({ token: 'REAL-TOKEN', tokenId: 't', expiration: 'e' });
  generatePaginatedReportEmbedToken.mockResolvedValue({ token: 'REAL-PAGINATED-TOKEN', tokenId: 't', expiration: 'e' });
  getReport.mockResolvedValue({ id: 'rpt-1', embedUrl: 'https://x' });
  startReportExport.mockResolvedValue({ id: 'exp-1', status: 'Succeeded' });
  getReportExportFile.mockResolvedValue({ bytes: Buffer.from('%PDF-1.7') });
  applySensitivityStamp.mockImplementation(async (_s: any, _id: any, bytes: Buffer) => ({ bytes, blocked: null }));
  fetchWithTimeout.mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) } as any);
});

const ROUTES: Array<{ name: string; call: () => Promise<any> }> = [
  { name: 'embed-token POST (View)', call: () => embedToken(req({ workspaceId: 'pbi-ws' }), ctx()) },
  { name: 'embed-token POST (Edit)', call: () => embedToken(req({ workspaceId: 'pbi-ws', accessLevel: 'Edit' }), ctx()) },
  { name: 'paginated-embed-token POST', call: () => paginatedEmbedToken(req({ workspaceId: 'pbi-ws' }), ctx()) },
  { name: 'export POST (Power BI ExportTo)', call: () => exportReport(req({ workspaceId: 'pbi-ws', format: 'PDF' }), ctx()) },
  { name: 'export POST (loom-native renderer)', call: () => exportReport(req({ mode: 'loom-native', format: 'PDF' }), ctx()) },
];

describe('GHSA-hf73-rp4q-66pf — a NON-OWNER is refused and no backend is reached', () => {
  for (const r of ROUTES) {
    it(`${r.name} 404s a caller with no role on the owning workspace`, async () => {
      resolveWorkspaceAccessByOid.mockResolvedValue(null);
      const res = await r.call();
      expect(res.status).toBe(404);
      for (const backend of ALL_BACKENDS) expect(backend).not.toHaveBeenCalled();
    });
  }

  it('export refuses BOTH branches, so the loom-native path cannot be used as the way around', async () => {
    // The dispatch is body-driven (`mode:'loom-native'` OR no workspaceId), so a
    // guard placed after the dispatch would have left one branch open.
    resolveWorkspaceAccessByOid.mockResolvedValue(null);
    for (const body of [{ workspaceId: 'pbi-ws', format: 'PDF' }, { mode: 'loom-native', format: 'PDF' }]) {
      const res = await exportReport(req(body), ctx());
      expect(res.status).toBe(404);
    }
    expect(applySensitivityStamp).not.toHaveBeenCalled();
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });
});

describe('GHSA-hf73-rp4q-66pf — a legitimate VIEWER is not locked out of the reads', () => {
  it('embed-token View still serves a read-only Viewer', async () => {
    resolveWorkspaceAccessByOid.mockResolvedValue(VIEWER);
    const res = await embedToken(req({ workspaceId: 'pbi-ws' }), ctx());
    expect(res.status).toBe(200);
    expect(generateReportEmbedToken).toHaveBeenCalledWith('pbi-ws', ID, 'View');
  });

  it('paginated-embed-token still serves a read-only Viewer (allowEdit:false)', async () => {
    resolveWorkspaceAccessByOid.mockResolvedValue(VIEWER);
    const res = await paginatedEmbedToken(req({ workspaceId: 'pbi-ws' }), ctx());
    expect(res.status).toBe(200);
  });

  it('export still serves a read-only Viewer', async () => {
    resolveWorkspaceAccessByOid.mockResolvedValue(VIEWER);
    const res = await exportReport(req({ workspaceId: 'pbi-ws', format: 'PDF' }), ctx());
    expect(res.status).toBe(200);
  });
});

describe('GHSA-hf73-rp4q-66pf — an EDIT token is write-scoped, a VIEW token is not', () => {
  it('a Viewer cannot obtain an Edit-scope embed token', async () => {
    // Granting read roles unconditionally here would have handed a read-only
    // Viewer an EDITING credential for the report — a fix that creates a
    // privilege escalation is not a fix.
    resolveWorkspaceAccessByOid.mockResolvedValue(VIEWER);
    const res = await embedToken(req({ workspaceId: 'pbi-ws', accessLevel: 'Edit' }), ctx());
    expect(res.status).toBe(404);
    expect(generateReportEmbedToken).not.toHaveBeenCalled();
  });

  it('an Owner still can', async () => {
    resolveWorkspaceAccessByOid.mockResolvedValue(OWNER);
    const res = await embedToken(req({ workspaceId: 'pbi-ws', accessLevel: 'Edit' }), ctx());
    expect(res.status).toBe(200);
    expect(generateReportEmbedToken).toHaveBeenCalledWith('pbi-ws', ID, 'Edit');
  });
});

describe('GHSA-hf73-rp4q-66pf — the guard is unskippable and runs first', () => {
  it('authorization is scoped to the REPORT item, not to the caller-supplied Power BI workspace', async () => {
    await embedToken(req({ workspaceId: 'pbi-ws' }), ctx());
    expect(resolveWorkspaceAccessByOid).toHaveBeenCalledWith(
      'oid-1',
      'ws-1',
      expect.objectContaining({ callerTid: 'tid-1' }),
    );
  });

  it('401s with no session, before the item lookup or the backend', async () => {
    getSession.mockReturnValue(null);
    const res = await embedToken(req({ workspaceId: 'pbi-ws' }), ctx());
    expect(res.status).toBe(401);
    expect(resolveWorkspaceAccessByOid).not.toHaveBeenCalled();
    expect(generateReportEmbedToken).not.toHaveBeenCalled();
  });

  it('an id naming NO report item anywhere still reaches the opt-in Power BI path', async () => {
    itemRows = [];
    resolveWorkspaceAccessByOid.mockResolvedValue(null);
    const res = await embedToken(req({ workspaceId: 'pbi-ws' }), ctx());
    expect(res.status).toBe(200);
    expect(generateReportEmbedToken).toHaveBeenCalled();
  });
});
