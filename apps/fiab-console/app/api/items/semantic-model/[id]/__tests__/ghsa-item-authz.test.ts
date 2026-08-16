/**
 * GHSA-hf73-rp4q-66pf — item-level authorization contract for the seven
 * `semantic-model/[id]/**` routes that had none.
 *
 * THE DEFECT THESE PIN. Each of `direct-lake`, `embed-token`, `measures`,
 * `refresh`, `refresh-schedule`, `refreshes` and `take-over` took `[id]` from the
 * URL, used it to address a Power BI dataset / AAS database, and ran no
 * item-level check. They passed CI because they sat in check-route-guards'
 * SHARED_BACKEND_ITEM_ROUTES under "specific-per-item-TYPE route over a SHARED
 * Azure backend … no per-tenant Cosmos ownership to scope" — a premise EIGHT
 * sibling routes under this same `[id]` disprove by resolving it as an owned Loom
 * item.
 *
 * WHAT IS DELIBERATELY *NOT* MOCKED. `authorizeItemWorkspace` and
 * `authorizeWorkspace` both RUN FOR REAL, as does `isTenantAdmin`; only the data
 * layer beneath them is stubbed (the Cosmos item→workspace lookup and the ACL
 * resolver). Mocking the guard itself would leave a suite that still passes with
 * the guard deleted — which is the exact failure these routes already had, and
 * the reason `check-route-guards` being green proves nothing here.
 *
 * THE TWO CASES THAT MATTER, per route and per handler:
 *   - a NON-OWNER gets 404 and the backend is never called (the hole);
 *   - a legitimate read-only VIEWER still gets through on read surfaces (a fix
 *     that 404s real users is not a fix — item-crud.ts:289 makes read roles an
 *     explicit opt-in, and forgetting it was live on copy-job/[id]/watermark).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AccessRole } from '@/lib/auth/workspace-access';

const getSession = vi.fn();
vi.mock('@/lib/auth/session', async () => {
  const actual = await vi.importActual<any>('@/lib/auth/session');
  return { ...actual, getSession: () => getSession() };
});

/** Rows the guard's `workspaceIdOfItem` query returns — i.e. "does an item with
 *  this id exist, and in which workspace". */
let itemRows: Array<{ workspaceId?: string }> = [{ workspaceId: 'ws-1' }];
const queryStub = () => ({
  items: { query: () => ({ fetchAll: async () => ({ resources: itemRows }) }) },
});
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => queryStub(),
  workspacesContainer: async () => queryStub(),
}));

/** The ACL resolver: null = the caller has no role on the workspace. */
const resolveWorkspaceAccessByOid = vi.fn();
vi.mock('@/lib/auth/workspace-access', () => ({
  resolveWorkspaceAccessByOid: (...a: any[]) => resolveWorkspaceAccessByOid(...a),
}));

// ── Backends. Every one is asserted NEVER-CALLED on the non-owner path. ───────
const generateDatasetEmbedToken = vi.fn(async () => ({ token: 'REAL-TOKEN', tokenId: 't', expiration: 'e' }));
const getDataset = vi.fn(async () => ({ id: 'ds-1' }));
const executeDatasetQueries = vi.fn(async () => ({ results: [{ tables: [{ rows: [] }] }] }));
const refreshDataset = vi.fn(async () => undefined);
const listRefreshHistory = vi.fn(async () => []);
const enhancedRefreshDataset = vi.fn(async () => ({ requestId: 'r-1' }));
const takeOverDataset = vi.fn(async () => undefined);
const pbiGetRefreshSchedule = vi.fn(async () => ({ enabled: true }));
const patchRefreshSchedule = vi.fn(async () => undefined);
vi.mock('@/lib/azure/powerbi-client', () => ({
  generateDatasetEmbedToken: (...a: any[]) => generateDatasetEmbedToken(...a),
  getDataset: (...a: any[]) => getDataset(...a),
  executeDatasetQueries: (...a: any[]) => executeDatasetQueries(...a),
  refreshDataset: (...a: any[]) => refreshDataset(...a),
  listRefreshHistory: (...a: any[]) => listRefreshHistory(...a),
  enhancedRefreshDataset: (...a: any[]) => enhancedRefreshDataset(...a),
  takeOverDataset: (...a: any[]) => takeOverDataset(...a),
  getRefreshSchedule: (...a: any[]) => pbiGetRefreshSchedule(...a),
  patchRefreshSchedule: (...a: any[]) => patchRefreshSchedule(...a),
  PowerBiError: class PowerBiError extends Error { status = 502; },
}));

const aasRefresh = vi.fn(async () => ({ refreshId: 'x', location: 'l' }));
const aasGetRefreshes = vi.fn(async () => []);
const aasGetRefreshSchedule = vi.fn(async () => ({ enabled: false }));
const aasSetRefreshSchedule = vi.fn(async () => ({ enabled: true }));
vi.mock('@/lib/azure/aas-server-client', () => ({
  refresh: (...a: any[]) => aasRefresh(...a),
  getRefreshes: (...a: any[]) => aasGetRefreshes(...a),
  getRefreshSchedule: (...a: any[]) => aasGetRefreshSchedule(...a),
  setRefreshSchedule: (...a: any[]) => aasSetRefreshSchedule(...a),
  aasServerConfigGate: () => null,
  AasError: class AasError extends Error { status = 502; },
}));

// direct-lake's wider surface.
const synapseExecuteQuery = vi.fn(async () => ({ columns: [], rows: [], rowCount: 0 }));
vi.mock('@/lib/azure/synapse-sql-client', () => ({
  executeQuery: (...a: any[]) => synapseExecuteQuery(...a),
  serverlessTarget: () => ({}),
  getSynapseSqlSuffix: () => 'sql.azuresynapse.net',
  buildDeltaOpenRowsetSql: () => 'SELECT 1',
  goldDeltaBulkUrl: () => 'https://x/gold',
}));
const getShimConfig = vi.fn(async () => null);
const upsertShimConfig = vi.fn(async (c: any) => c);
vi.mock('@/lib/azure/direct-lake-config-store', () => ({
  getShimConfig: (...a: any[]) => getShimConfig(...a),
  upsertShimConfig: (...a: any[]) => upsertShimConfig(...a),
  SHIM_REFRESH_POLICIES: ['Partition', 'Full'],
}));
vi.mock('@/lib/azure/aas-client', () => ({
  listShimRefreshHistory: vi.fn(async () => []),
  shimEnabled: () => true,
  SHIM_DISABLED_HINT: 'hint',
  AasError: class AasError extends Error { status = 502; },
}));
const ensureShimSubscription = vi.fn(async () => ({ ok: true }));
vi.mock('@/lib/azure/eventgrid-client', () => ({
  ensureShimSubscription: (...a: any[]) => ensureShimSubscription(...a),
  getShimSubscriptionStatus: vi.fn(async () => null),
  parseDeltaSource: () => ({ account: 'acct', container: 'c', path: 'p' }),
  toAbfss: () => 'abfss://c@acct.dfs.core.windows.net/p',
  EventGridError: class EventGridError extends Error {},
}));
vi.mock('@/lib/azure/columnar-cache-query', () => ({
  columnarCacheBackendSelected: () => false,
  columnarCacheQuery: vi.fn(),
  resolveFrame: vi.fn(),
}));
vi.mock('../../_lib/bi-backend', () => ({ usingAasAsync: async () => false }));

import { POST as embedToken } from '../embed-token/route';
import { POST as measures } from '../measures/route';
import { POST as takeOver } from '../take-over/route';
import { GET as refreshGet, POST as refreshPost } from '../refresh/route';
import { GET as refreshesGet, POST as refreshesPost } from '../refreshes/route';
import { GET as scheduleGet, PATCH as schedulePatch } from '../refresh-schedule/route';
import { GET as dlGet, POST as dlPost, PUT as dlPut } from '../direct-lake/route';

const ID = 'sm-1';
const ctx = () => ({ params: Promise.resolve({ id: ID }) }) as any;
const req = (qs = '', body: any = {}) =>
  ({
    nextUrl: new URL(`http://x/api/items/semantic-model/${ID}/x${qs}`),
    json: async () => body,
  }) as any;

const SESSION = { claims: { oid: 'oid-1', tid: 'tid-1' } };

/** What `resolveWorkspaceAccessByOid` returns for each caller shape. */
const OWNER = { workspace: { id: 'ws-1' }, role: 'Owner' as AccessRole, via: 'owner', canWrite: true };
const VIEWER = { workspace: { id: 'ws-1' }, role: 'Viewer' as AccessRole, via: 'acl', canWrite: false };

const ALL_BACKENDS = [
  generateDatasetEmbedToken, getDataset, executeDatasetQueries, refreshDataset,
  listRefreshHistory, enhancedRefreshDataset, takeOverDataset, pbiGetRefreshSchedule,
  patchRefreshSchedule, aasRefresh, aasGetRefreshes, aasGetRefreshSchedule,
  aasSetRefreshSchedule, synapseExecuteQuery, getShimConfig, upsertShimConfig,
  ensureShimSubscription,
];

beforeEach(() => {
  vi.clearAllMocks();
  // direct-lake POST honest-gates on this before it reaches Serverless. Set it
  // so the Viewer case below measures the GUARD's verdict and not the config
  // gate's — a 503 would have made that assertion pass for the wrong reason.
  vi.stubEnv('LOOM_SYNAPSE_WORKSPACE', 'syn-ws');
  itemRows = [{ workspaceId: 'ws-1' }];
  getSession.mockReturnValue(SESSION);
  resolveWorkspaceAccessByOid.mockResolvedValue(OWNER);
  generateDatasetEmbedToken.mockResolvedValue({ token: 'REAL-TOKEN', tokenId: 't', expiration: 'e' });
  getDataset.mockResolvedValue({ id: 'ds-1' });
  executeDatasetQueries.mockResolvedValue({ results: [{ tables: [{ rows: [] }] }] });
  listRefreshHistory.mockResolvedValue([]);
  enhancedRefreshDataset.mockResolvedValue({ requestId: 'r-1' });
  pbiGetRefreshSchedule.mockResolvedValue({ enabled: true });
  getShimConfig.mockResolvedValue(null);
  synapseExecuteQuery.mockResolvedValue({ columns: [], rows: [], rowCount: 0 });
});

/** Every route+handler under test, with the call shape each needs and whether it
 *  is a READ surface (so a Viewer must still get through). */
const ROUTES: Array<{ name: string; read: boolean; call: () => Promise<any> }> = [
  { name: 'embed-token POST', read: true, call: () => embedToken(req('', { workspaceId: 'pbi-ws' }), ctx()) },
  {
    name: 'measures POST',
    read: true,
    call: () => measures(req('?workspaceId=pbi-ws', { measureName: 'm', tableName: 't', daxExpression: '1' }), ctx()),
  },
  { name: 'take-over POST', read: false, call: () => takeOver(req('?workspaceId=pbi-ws'), ctx()) },
  { name: 'refresh GET', read: true, call: () => refreshGet(req('?workspaceId=pbi-ws'), ctx()) },
  { name: 'refresh POST', read: false, call: () => refreshPost(req('?workspaceId=pbi-ws'), ctx()) },
  { name: 'refreshes GET', read: true, call: () => refreshesGet(req('?workspaceId=pbi-ws'), ctx()) },
  { name: 'refreshes POST', read: false, call: () => refreshesPost(req('?workspaceId=pbi-ws', {}), ctx()) },
  { name: 'refresh-schedule GET', read: true, call: () => scheduleGet(req('?workspaceId=pbi-ws'), ctx()) },
  { name: 'refresh-schedule PATCH', read: false, call: () => schedulePatch(req('?workspaceId=pbi-ws', { enabled: false }), ctx()) },
  { name: 'direct-lake GET', read: true, call: () => dlGet(req(''), ctx()) },
  { name: 'direct-lake POST', read: true, call: () => dlPost(req('', { table: 'T' }), ctx()) },
  {
    name: 'direct-lake PUT',
    read: false,
    call: () => dlPut(req('', { deltaSourcePath: 'abfss://c@a.dfs.core.windows.net/p', workspaceId: 'ws-1' }), ctx()),
  },
];

describe('GHSA-hf73-rp4q-66pf — a NON-OWNER is refused and no backend is reached', () => {
  for (const r of ROUTES) {
    it(`${r.name} 404s a caller with no role on the owning workspace`, async () => {
      // Before the fix EVERY one of these returned 200 to any signed-in caller
      // who named the id — including a live Power BI embed token.
      resolveWorkspaceAccessByOid.mockResolvedValue(null);
      const res = await r.call();
      expect(res.status).toBe(404);
      for (const backend of ALL_BACKENDS) expect(backend).not.toHaveBeenCalled();
    });
  }
});

describe('GHSA-hf73-rp4q-66pf — a legitimate VIEWER is not locked out of the reads', () => {
  for (const r of ROUTES.filter((x) => x.read)) {
    it(`${r.name} still serves a read-only Viewer (allowReadRoles is not decorative)`, async () => {
      resolveWorkspaceAccessByOid.mockResolvedValue(VIEWER);
      const res = await r.call();
      expect(res.status).not.toBe(404);
      expect(res.status).toBeLessThan(400);
    });
  }
});

describe('GHSA-hf73-rp4q-66pf — the WRITE surfaces stay write-scoped', () => {
  for (const r of ROUTES.filter((x) => !x.read)) {
    it(`${r.name} refuses a read-only Viewer`, async () => {
      // The mirror image of the test above: making the reads work by loosening
      // the mutations would be a regression, not a fix.
      resolveWorkspaceAccessByOid.mockResolvedValue(VIEWER);
      const res = await r.call();
      expect(res.status).toBe(404);
    });
  }
});

describe('GHSA-hf73-rp4q-66pf — the guard is unskippable and runs before the backend', () => {
  it('authorization is scoped to the SEMANTIC-MODEL item, not to the caller-supplied Power BI workspace', async () => {
    // The `?workspaceId=`/body `workspaceId` on this family is a POWER BI group
    // id. Feeding it to the workspace ladder would authorize the wrong object,
    // so the workspace is resolved FROM THE ITEM — which also makes the check
    // unskippable by omitting the parameter.
    await embedToken(req('', { workspaceId: 'pbi-ws' }), ctx());
    expect(resolveWorkspaceAccessByOid).toHaveBeenCalledWith(
      'oid-1',
      'ws-1', // resolved from the item, NOT 'pbi-ws'
      expect.objectContaining({ callerTid: 'tid-1' }),
    );
  });

  it('401s with no session, before the item lookup or the backend', async () => {
    getSession.mockReturnValue(null);
    const res = await embedToken(req('', { workspaceId: 'pbi-ws' }), ctx());
    expect(res.status).toBe(401);
    expect(resolveWorkspaceAccessByOid).not.toHaveBeenCalled();
    expect(generateDatasetEmbedToken).not.toHaveBeenCalled();
  });

  it('an id naming NO semantic-model item anywhere still reaches the opt-in Power BI path', async () => {
    // Deliberate, and the reason this family threads `authorizeItemWorkspace`
    // rather than `withWorkspaceOwner`: the ids `GET /api/items/semantic-model`
    // enumerates are raw Power BI dataset GUIDs with no Loom item behind them,
    // and `loadOwnedItem` renders "no item" as 404. Wrapping would have 404'd
    // every caller on that path.
    itemRows = [];
    resolveWorkspaceAccessByOid.mockResolvedValue(null);
    const res = await embedToken(req('', { workspaceId: 'pbi-ws' }), ctx());
    expect(res.status).toBe(200);
    expect(generateDatasetEmbedToken).toHaveBeenCalled();
  });
});
