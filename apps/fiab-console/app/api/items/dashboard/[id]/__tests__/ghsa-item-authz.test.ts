/**
 * GHSA-hf73-rp4q-66pf — item-level authorization contract for the four
 * `dashboard/[id]/**` routes that had none.
 *
 * THE DEFECT THESE PIN. `embed-token`, `pin`, `tile-embed-token` and
 * `tile-query` each consumed `[id]` and ran no item-level check.
 * `tile-embed-token` was the worst shape in the whole advisory: it took
 * `workspaceId` from the request BODY and minted a live Power BI embed token, so
 * it did not even require guessing a Loom item id. `tile-query` was worse in a
 * different way — it never reached the allowlist at all, because the file matched
 * the guard checker on `session.claims.oid` / `tenantScopeId(session)` inside
 * `recordQueryRun`, which are FinOps ATTRIBUTION fields and never a check.
 *
 * WHAT IS DELIBERATELY *NOT* MOCKED. `authorizeItemWorkspace`,
 * `authorizeWorkspace` and `isTenantAdmin` all RUN FOR REAL; only the data layer
 * beneath them is stubbed. Mocking the guard would leave a suite that passes with
 * the guard deleted — the exact failure these routes already had.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AccessRole } from '@/lib/auth/workspace-access';

const getSession = vi.fn();
vi.mock('@/lib/auth/session', async () => {
  const actual = await vi.importActual<any>('@/lib/auth/session');
  return { ...actual, getSession: () => getSession(), tenantScopeId: () => 'tid-1' };
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

const generateDashboardEmbedToken = vi.fn(async () => ({ token: 'REAL-TOKEN', tokenId: 't', expiration: 'e' }));
const generateTileEmbedToken = vi.fn(async () => ({ token: 'REAL-TILE-TOKEN', tokenId: 't', expiration: 'e' }));
const getDashboard = vi.fn(async () => ({ id: 'db-1', embedUrl: 'https://x' }));
const cloneDashboardTile = vi.fn(async () => ({ id: 'tile-2' }));
const executeDatasetQueries = vi.fn(async () => ({ results: [{ tables: [{ rows: [] }] }] }));
vi.mock('@/lib/azure/powerbi-client', () => ({
  generateDashboardEmbedToken: (...a: any[]) => generateDashboardEmbedToken(...a),
  generateTileEmbedToken: (...a: any[]) => generateTileEmbedToken(...a),
  getDashboard: (...a: any[]) => getDashboard(...a),
  cloneDashboardTile: (...a: any[]) => cloneDashboardTile(...a),
  executeDatasetQueries: (...a: any[]) => executeDatasetQueries(...a),
  powerbiConfigGate: () => null,
  PowerBiError: class PowerBiError extends Error { status = 502; },
}));

const kustoExecuteQuery = vi.fn(async () => ({ columns: [], rows: [], rowCount: 0, truncated: false, executionMs: 1 }));
vi.mock('@/lib/azure/kusto-client', () => ({
  executeQuery: (...a: any[]) => kustoExecuteQuery(...a),
  kustoConfigGate: () => null,
  defaultDatabase: () => 'db',
  KustoError: class KustoError extends Error { status = 502; },
}));
vi.mock('@/lib/azure/aas-client', () => ({
  executeDax: vi.fn(),
  aasConfigGate: () => null,
  resolveAasTarget: () => ({ server: 's', model: 'm' }),
  AasError: class AasError extends Error { status = 502; },
}));
vi.mock('@/lib/azure/rate-limiter', () => ({ enforceRateLimit: async () => null }));
const recordQueryRun = vi.fn();
vi.mock('@/lib/finops/query-run', () => ({ recordQueryRun: (...a: any[]) => recordQueryRun(...a) }));
vi.mock('@/lib/azure/copilot-orchestrator', () => ({ NoAoaiDeploymentError: class extends Error {} }));
vi.mock('@/lib/azure/aoai-chat-client', () => ({ aoaiChat: vi.fn() }));
vi.mock('@/lib/azure/cloud-endpoints', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  isGovCloud: () => false,
}));

import { POST as embedToken } from '../embed-token/route';
import { POST as tileEmbedToken } from '../tile-embed-token/route';
import { POST as pin } from '../pin/route';
import { POST as tileQuery } from '../tile-query/route';

const ID = 'db-1';
const ctx = () => ({ params: Promise.resolve({ id: ID }) }) as any;
const req = (body: any = {}) =>
  ({ nextUrl: new URL(`http://x/api/items/dashboard/${ID}/x`), json: async () => body }) as any;

const SESSION = { claims: { oid: 'oid-1', tid: 'tid-1', upn: 'u@x' } };
const OWNER = { workspace: { id: 'ws-1' }, role: 'Owner' as AccessRole, via: 'owner', canWrite: true };
const VIEWER = { workspace: { id: 'ws-1' }, role: 'Viewer' as AccessRole, via: 'acl', canWrite: false };

const ALL_BACKENDS = [
  generateDashboardEmbedToken, generateTileEmbedToken, getDashboard,
  cloneDashboardTile, executeDatasetQueries, kustoExecuteQuery, recordQueryRun,
];

beforeEach(() => {
  vi.clearAllMocks();
  itemRows = [{ workspaceId: 'ws-1' }];
  getSession.mockReturnValue(SESSION);
  resolveWorkspaceAccessByOid.mockResolvedValue(OWNER);
  generateDashboardEmbedToken.mockResolvedValue({ token: 'REAL-TOKEN', tokenId: 't', expiration: 'e' });
  generateTileEmbedToken.mockResolvedValue({ token: 'REAL-TILE-TOKEN', tokenId: 't', expiration: 'e' });
  getDashboard.mockResolvedValue({ id: 'db-1', embedUrl: 'https://x' });
  cloneDashboardTile.mockResolvedValue({ id: 'tile-2' });
  kustoExecuteQuery.mockResolvedValue({ columns: [], rows: [], rowCount: 0, truncated: false, executionMs: 1 });
});

const ROUTES: Array<{ name: string; read: boolean; call: () => Promise<any> }> = [
  { name: 'embed-token POST', read: true, call: () => embedToken(req({ workspaceId: 'pbi-ws' }), ctx()) },
  { name: 'tile-embed-token POST', read: true, call: () => tileEmbedToken(req({ workspaceId: 'pbi-ws', tileId: 'tile-1' }), ctx()) },
  { name: 'tile-query POST', read: true, call: () => tileQuery(req({ kind: 'kusto', query: 'T | take 1' }), ctx()) },
  {
    name: 'pin POST',
    read: false,
    call: () => pin(req({ workspaceId: 'pbi-ws', sourceDashboardId: 'src', tileId: 'tile-1' }), ctx()),
  },
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

  it('NO POWER BI EMBED TOKEN is minted for a non-owner — the highest-severity case', async () => {
    // Before the fix this returned 200 with a live tile token to any signed-in
    // caller, with `workspaceId` supplied in the BODY — no id guessing needed.
    resolveWorkspaceAccessByOid.mockResolvedValue(null);
    const res = await tileEmbedToken(req({ workspaceId: 'pbi-ws', tileId: 'tile-1' }), ctx());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'dashboard not found' });
    expect(generateTileEmbedToken).not.toHaveBeenCalled();
  });

  it('tile-query does not let a non-owner bill a run against the dashboard', async () => {
    // `[id]` is the FinOps attribution key (itemId + dashboardId on every
    // recorded run), which is exactly what made the bare `claims.oid` in
    // recordQueryRun look like a guard to the checker.
    resolveWorkspaceAccessByOid.mockResolvedValue(null);
    const res = await tileQuery(req({ kind: 'kusto', query: 'T | take 1' }), ctx());
    expect(res.status).toBe(404);
    expect(kustoExecuteQuery).not.toHaveBeenCalled();
    expect(recordQueryRun).not.toHaveBeenCalled();
  });
});

describe('GHSA-hf73-rp4q-66pf — a legitimate VIEWER is not locked out of the reads', () => {
  for (const r of ROUTES.filter((x) => x.read)) {
    it(`${r.name} still serves a read-only Viewer (allowReadRoles is not decorative)`, async () => {
      resolveWorkspaceAccessByOid.mockResolvedValue(VIEWER);
      const res = await r.call();
      expect(res.status).toBe(200);
    });
  }
});

describe('GHSA-hf73-rp4q-66pf — the WRITE surface stays write-scoped', () => {
  it('pin refuses a read-only Viewer — a Viewer must not clone a tile onto the dashboard', async () => {
    resolveWorkspaceAccessByOid.mockResolvedValue(VIEWER);
    const res = await pin(req({ workspaceId: 'pbi-ws', sourceDashboardId: 'src', tileId: 'tile-1' }), ctx());
    expect(res.status).toBe(404);
    expect(cloneDashboardTile).not.toHaveBeenCalled();
  });
});

describe('GHSA-hf73-rp4q-66pf — the guard is unskippable and runs first', () => {
  it('authorization is scoped to the DASHBOARD item, not to the caller-supplied Power BI workspace', async () => {
    await tileEmbedToken(req({ workspaceId: 'pbi-ws', tileId: 'tile-1' }), ctx());
    expect(resolveWorkspaceAccessByOid).toHaveBeenCalledWith(
      'oid-1',
      'ws-1', // resolved from the item, NOT the body's 'pbi-ws'
      expect.objectContaining({ callerTid: 'tid-1' }),
      // #3825 — the guard now threads the WorkspaceAccessDiagnostics out-channel
      // so a refused tenant-admin grant is rendered as an honest 409 rather than
      // a bare 404. toHaveBeenCalledWith is exact on arity, hence this argument.
      expect.any(Object),
    );
  });

  it('pin authorizes BEFORE the Power BI config gate, so an unreachable id learns no env var', async () => {
    resolveWorkspaceAccessByOid.mockResolvedValue(null);
    const res = await pin(req({}), ctx());
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toMatch(/LOOM_|pbi_gate/);
  });

  it('401s with no session, before the item lookup or the backend', async () => {
    getSession.mockReturnValue(null);
    const res = await tileEmbedToken(req({ workspaceId: 'pbi-ws', tileId: 'tile-1' }), ctx());
    expect(res.status).toBe(401);
    expect(resolveWorkspaceAccessByOid).not.toHaveBeenCalled();
    expect(generateTileEmbedToken).not.toHaveBeenCalled();
  });

  it('an id naming NO dashboard item anywhere still reaches the opt-in Power BI path', async () => {
    // The reason this family threads `authorizeItemWorkspace` and not
    // `withWorkspaceOwner`: the ids `GET /api/items/dashboard?workspaceId=`
    // enumerates are raw Power BI dashboard GUIDs with no Loom item, and
    // `loadOwnedItem` renders "no item" as 404. `dashboard/[id]` made the same
    // call and documented it.
    itemRows = [];
    resolveWorkspaceAccessByOid.mockResolvedValue(null);
    const res = await embedToken(req({ workspaceId: 'pbi-ws' }), ctx());
    expect(res.status).toBe(200);
    expect(generateDashboardEmbedToken).toHaveBeenCalled();
  });
});
