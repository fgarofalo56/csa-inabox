/**
 * Backend contract tests for /api/lakehouse/history — Delta time travel (F20).
 *
 * GET (version list, ADLS _delta_log):
 *   1. unauthenticated → 401
 *   2. missing params → 400
 *   3. unknown container → 404
 *   4. path traversal rejected → 400
 *   5. happy path parses commitInfo from _delta_log/*.json → sorted versions
 *
 * POST (restore / preview, Databricks):
 *   6. unauthenticated → 401
 *   7. bad action → 400
 *   8. negative/non-int version → 400
 *   9. honest gate (LOOM_DATABRICKS_HOSTNAME unset) → 503 + named env var
 *  10. no warehouse → 503 gated
 *  11. preview happy path runs SELECT … VERSION AS OF and returns rows
 *  12. restore happy path runs RESTORE TABLE … TO VERSION AS OF
 *  13. backend throw → 502 structured error
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/adls-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/adls-client');
  return {
    ...actual,
    listPaths: vi.fn(),
    downloadFile: vi.fn(),
    getAccountName: vi.fn(() => 'loomdlz'),
  };
});
vi.mock('@/lib/azure/databricks-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/databricks-client');
  return {
    ...actual,
    databricksConfigGate: vi.fn(),
    listWarehouses: vi.fn(),
    executeStatement: vi.fn(),
  };
});

// `resolveLakehouseStorage` is a plain function (not a vi.fn, so a
// resetAllMocks cannot clear it) that DELEGATES to the `resolveLakehouseAbfss`
// mock: a bound value is `{ ok: true, bound }`, null is `no-storage`, and
// `{ withheld: <reason> }` is that withheld reason. The message function is
// the REAL one, so asserted text is the resolver module's own wording.
vi.mock('@/lib/azure/lakehouse-abfss', async () => {
  const actual: any = await vi.importActual('@/lib/azure/lakehouse-abfss');
  const resolveLakehouseAbfss = vi.fn();
  return {
    lakehouseStorageWithheldMessage: actual.lakehouseStorageWithheldMessage,
    lakehouseStorageWithheldFields: actual.lakehouseStorageWithheldFields,
    resolveLakehouseAbfss,
    resolveLakehouseStorage: async (...a: any[]) => {
      const b: any = await resolveLakehouseAbfss(...a);
      if (b && typeof b === 'object' && 'withheld' in b) return { ok: false, reason: b.withheld };
      return b ? { ok: true, bound: b } : { ok: false, reason: 'no-storage' };
    },
  };
});
vi.mock('@/lib/auth/item-access', () => ({ resolveItemAccessByOid: vi.fn() }));

import { GET, POST } from '../route';
import { getSession } from '@/lib/auth/session';
import { listPaths, downloadFile, getAccountName } from '@/lib/azure/adls-client';
import { databricksConfigGate, listWarehouses, executeStatement } from '@/lib/azure/databricks-client';
import { resolveLakehouseAbfss } from '@/lib/azure/lakehouse-abfss';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';

// The arms below that name a container + tablePath directly (no lakehouseId)
// are the tenant-admin storage form; ADMIN is a tenant admin via
// LOOM_TENANT_ADMIN_OID. MEMBER is not, and uses the item form.
const ADMIN_OID = 'oid-tenant-admin';
const ADMIN = { claims: { oid: ADMIN_OID, upn: 'admin@x' } };
const MEMBER = { claims: { oid: 'oid-member', upn: 'member@x' } };
const LH = 'lh-hist';
const CONTAINER = 'landing';
const ROOT = 'lakehouses/Sales--lh-hist';
const TABLE = `${ROOT}/Tables/orders`;
let savedAdminOid: string | undefined;
let savedLoomCloud: string | undefined;

function getReq(params: Record<string, string>) {
  const sp = new URLSearchParams(params);
  return { nextUrl: { searchParams: sp } } as any;
}
function postReq(body: any) {
  return { json: async () => body } as any;
}

beforeEach(() => {
  vi.resetAllMocks();
  // vi.resetAllMocks() clears the factory's getAccountName implementation
  // (() => 'loomdlz'), leaving it returning undefined — which would make the
  // route build an `abfss://…@undefined.dfs…` path. Re-assert it each test so
  // the ADLS account resolves to the expected DLZ account name.
  (getAccountName as any).mockReturnValue('loomdlz');
  savedAdminOid = process.env.LOOM_TENANT_ADMIN_OID;
  process.env.LOOM_TENANT_ADMIN_OID = ADMIN_OID;
  // The abfss host suffix follows the boundary (`dfsSuffix`). Pin Commercial
  // here so the `dfs.core.windows.net` expectations below do not depend on the
  // shell this suite runs in; the Gov arm sets its own boundary.
  savedLoomCloud = process.env.LOOM_CLOUD;
  process.env.LOOM_CLOUD = 'commercial';
  (resolveItemAccessByOid as any).mockResolvedValue({
    item: { id: LH, workspaceId: 'ws-1', itemType: 'lakehouse' },
    role: 'Viewer',
    via: 'workspace',
    canWrite: false,
  });
  (resolveLakehouseAbfss as any).mockResolvedValue({
    abfss: `abfss://${CONTAINER}@loomdlz.dfs.core.windows.net/${ROOT}`,
    container: CONTAINER,
    root: ROOT,
  });
});
afterEach(() => {
  delete process.env.LOOM_DATABRICKS_HOSTNAME;
  if (savedAdminOid === undefined) delete process.env.LOOM_TENANT_ADMIN_OID;
  else process.env.LOOM_TENANT_ADMIN_OID = savedAdminOid;
  if (savedLoomCloud === undefined) delete process.env.LOOM_CLOUD;
  else process.env.LOOM_CLOUD = savedLoomCloud;
});

describe('GET /api/lakehouse/history', () => {
  it('401 when no session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await GET(getReq({ container: 'bronze', tablePath: 'Tables/x' }));
    expect(res.status).toBe(401);
  });

  it('400 when params missing', async () => {
    (getSession as any).mockReturnValue(ADMIN);
    const res = await GET(getReq({ container: 'bronze' }));
    expect(res.status).toBe(400);
  });

  it('404 on unknown container', async () => {
    (getSession as any).mockReturnValue(ADMIN);
    const res = await GET(getReq({ container: 'nope', tablePath: 'Tables/x' }));
    expect(res.status).toBe(404);
  });

  it('400 on path traversal', async () => {
    (getSession as any).mockReturnValue(ADMIN);
    const res = await GET(getReq({ container: 'bronze', tablePath: '../etc' }));
    expect(res.status).toBe(400);
  });

  it('parses commitInfo and returns versions sorted desc', async () => {
    (getSession as any).mockReturnValue(ADMIN);
    (listPaths as any).mockResolvedValue([
      { name: 'Tables/x/_delta_log/00000000000000000000.json', isDirectory: false, size: 10 },
      { name: 'Tables/x/_delta_log/00000000000000000001.json', isDirectory: false, size: 10 },
      { name: 'Tables/x/_delta_log/00000000000000000000.checkpoint.parquet', isDirectory: false, size: 99 },
      { name: 'Tables/x/_delta_log/_commits', isDirectory: true, size: 0 },
    ]);
    (downloadFile as any).mockImplementation(async (_c: string, path: string) => {
      const ver = path.includes('0001') ? 1 : 0;
      const op = ver === 1 ? 'MERGE' : 'WRITE';
      const commit = JSON.stringify({
        commitInfo: {
          timestamp: 1714000000000 + ver,
          operation: op,
          userName: 'alice@contoso.com',
          operationMetrics: { numOutputRows: String(100 * (ver + 1)), numFiles: '2' },
        },
      });
      const meta = JSON.stringify({ metaData: { id: 'abc' } });
      return { body: Buffer.from(`${meta}\n${commit}\n`, 'utf8') };
    });
    const res = await GET(getReq({ container: 'bronze', tablePath: 'Tables/x' }));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.versions.map((v: any) => v.version)).toEqual([1, 0]);
    expect(j.versions[0].operation).toBe('MERGE');
    expect(j.versions[0].metrics.numOutputRows).toBe(200);
    expect(j.versions[1].userName).toBe('alice@contoso.com');
    // checkpoint.parquet and directory entries excluded
    expect(j.versions.length).toBe(2);
  });
});

describe('POST /api/lakehouse/history', () => {
  it('401 when no session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await POST(postReq({ container: 'bronze', tablePath: 'Tables/x', version: 0, action: 'preview' }));
    expect(res.status).toBe(401);
  });

  it('400 on bad action', async () => {
    (getSession as any).mockReturnValue(ADMIN);
    const res = await POST(postReq({ container: 'bronze', tablePath: 'Tables/x', version: 0, action: 'frobnicate' }));
    expect(res.status).toBe(400);
  });

  it('400 on negative version', async () => {
    (getSession as any).mockReturnValue(ADMIN);
    const res = await POST(postReq({ container: 'bronze', tablePath: 'Tables/x', version: -1, action: 'preview' }));
    expect(res.status).toBe(400);
  });

  it('503 honest gate when LOOM_DATABRICKS_HOSTNAME unset', async () => {
    (getSession as any).mockReturnValue(ADMIN);
    (databricksConfigGate as any).mockReturnValue({ missing: 'LOOM_DATABRICKS_HOSTNAME' });
    const res = await POST(postReq({ container: 'bronze', tablePath: 'Tables/x', version: 0, action: 'preview' }));
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.gated).toBe(true);
    expect(j.code).toBe('no_databricks');
    expect(j.hint).toContain('LOOM_DATABRICKS_HOSTNAME');
  });

  it('503 gated when no warehouse', async () => {
    (getSession as any).mockReturnValue(ADMIN);
    (databricksConfigGate as any).mockReturnValue(null);
    (listWarehouses as any).mockResolvedValue([]);
    const res = await POST(postReq({ container: 'bronze', tablePath: 'Tables/x', version: 0, action: 'preview' }));
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.code).toBe('no_warehouse');
  });

  it('preview runs SELECT … VERSION AS OF and returns rows', async () => {
    (getSession as any).mockReturnValue(ADMIN);
    (databricksConfigGate as any).mockReturnValue(null);
    (listWarehouses as any).mockResolvedValue([{ id: 'wh1', name: 'w', state: 'RUNNING' }]);
    (executeStatement as any).mockResolvedValue({ columns: ['id'], rows: [[1]], rowCount: 1, executionMs: 7, truncated: false });
    const res = await POST(postReq({ container: 'bronze', tablePath: 'Tables/x', version: 3, action: 'preview' }));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.action).toBe('preview');
    expect(j.columns).toEqual(['id']);
    const sql = (executeStatement as any).mock.calls[0][1] as string;
    expect(sql).toContain('VERSION AS OF 3');
    expect(sql).toContain('abfss://bronze@loomdlz.dfs.core.windows.net/Tables/x');
  });

  it('restore runs RESTORE TABLE … TO VERSION AS OF', async () => {
    (getSession as any).mockReturnValue(ADMIN);
    (databricksConfigGate as any).mockReturnValue(null);
    (listWarehouses as any).mockResolvedValue([{ id: 'wh1', name: 'w', state: 'STOPPED' }]);
    (executeStatement as any).mockResolvedValue({ columns: ['num_restored_files'], rows: [[5]], rowCount: 1, executionMs: 20, truncated: false });
    const res = await POST(postReq({ container: 'bronze', tablePath: 'Tables/x', version: 2, action: 'restore' }));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.action).toBe('restore');
    const sql = (executeStatement as any).mock.calls[0][1] as string;
    expect(sql).toContain('RESTORE TABLE delta.');
    expect(sql).toContain('TO VERSION AS OF 2');
  });

  it('502 structured error when backend throws', async () => {
    (getSession as any).mockReturnValue(ADMIN);
    (databricksConfigGate as any).mockReturnValue(null);
    (listWarehouses as any).mockResolvedValue([{ id: 'wh1', name: 'w', state: 'RUNNING' }]);
    (executeStatement as any).mockRejectedValue(Object.assign(new Error('VACUUM removed files'), { code: 'DELTA_VERSION' }));
    const res = await POST(postReq({ container: 'bronze', tablePath: 'Tables/x', version: 0, action: 'restore' }));
    expect(res.status).toBe(502);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.error).toContain('VACUUM removed files');
    expect(j.code).toBe('DELTA_VERSION');
  });
});

describe('/api/lakehouse/history — item form and storage-form access', () => {
  // POSITIVE, paired with the refusals below: a read-only member lists the
  // version log of a table inside the item's own root. FAILS IF GET asks for
  // write access (403) or the containment test refuses a genuine member (the
  // listPaths row set becomes []).
  it('GET lists a table inside the lakehouse root for a caller who can see the item', async () => {
    (getSession as any).mockReturnValue(MEMBER);
    (listPaths as any).mockResolvedValue([]);
    const res = await GET(getReq({ lakehouseId: LH, container: CONTAINER, tablePath: TABLE }));
    expect(res.status).toBe(200);
    expect((listPaths as any).mock.calls.map((c: any[]) => [c[0], c[1]]))
      .toEqual([[CONTAINER, `${TABLE}/_delta_log`]]);
  });

  // FAILS IF the item authorization is dropped (status 200, row set 1) or
  // answered 403.
  it('GET answers 404 for a lakehouse the caller cannot reach, with no storage call', async () => {
    (getSession as any).mockReturnValue(MEMBER);
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    const res = await GET(getReq({ lakehouseId: LH, container: CONTAINER, tablePath: TABLE }));
    expect(res.status).toBe(404);
    expect((listPaths as any).mock.calls).toEqual([]);
  });

  // FAILS IF containment is a string-prefix test: `<root>-archive/...` starts
  // with the root string, so the listPaths row set would become 1.
  it('GET refuses a table in a sibling folder that shares a string prefix with the root', async () => {
    (getSession as any).mockReturnValue(MEMBER);
    const trap = `${ROOT}-archive/Tables/orders`;
    expect(trap.startsWith(ROOT)).toBe(true);
    const res = await GET(getReq({ lakehouseId: LH, container: CONTAINER, tablePath: trap }));
    expect(res.status).toBe(403);
    expect((listPaths as any).mock.calls).toEqual([]);
  });

  // FAILS IF the storage form stops requiring a tenant admin: the same request
  // the ADMIN arms above make would answer 200 with a listPaths call.
  it('GET refuses the storage form for a caller who is not a tenant admin', async () => {
    (getSession as any).mockReturnValue(MEMBER);
    const res = await GET(getReq({ container: 'bronze', tablePath: 'Tables/x' }));
    expect(res.status).toBe(403);
    expect((listPaths as any).mock.calls).toEqual([]);
  });

  // FAILS IF restore stops asking for write access: a read-only caller's
  // restore would run (the executeStatement row set becomes 1).
  it('POST refuses a restore from a read-only caller, with no statement run', async () => {
    (getSession as any).mockReturnValue(MEMBER);
    (databricksConfigGate as any).mockReturnValue(null);
    (listWarehouses as any).mockResolvedValue([{ id: 'wh1', name: 'w', state: 'RUNNING' }]);
    const res = await POST(postReq({ lakehouseId: LH, container: CONTAINER, tablePath: TABLE, version: 1, action: 'restore' }));
    expect(res.status).toBe(403);
    expect((executeStatement as any).mock.calls).toEqual([]);
  });

  // POSITIVE twin of the arm above: the same read-only caller may PREVIEW, and
  // the statement targets the item's own table. FAILS IF preview also demands
  // write access (403), or the resolved path is not what reaches the SQL.
  it('POST previews a version for a read-only caller, against the item table', async () => {
    (getSession as any).mockReturnValue(MEMBER);
    (databricksConfigGate as any).mockReturnValue(null);
    (listWarehouses as any).mockResolvedValue([{ id: 'wh1', name: 'w', state: 'RUNNING' }]);
    (executeStatement as any).mockResolvedValue({ columns: ['id'], rows: [[1]], rowCount: 1, executionMs: 1, truncated: false });
    const res = await POST(postReq({ lakehouseId: LH, container: CONTAINER, tablePath: TABLE, version: 1, action: 'preview' }));
    expect(res.status).toBe(200);
    const sql = (executeStatement as any).mock.calls[0][1] as string;
    expect(sql).toContain(`abfss://${CONTAINER}@loomdlz.dfs.core.windows.net/${TABLE}`);
  });

  // FAILS IF the host suffix is hard-coded to Commercial: in GCC-High the
  // statement would name `loomdlz.dfs.core.windows.net`, a host that does not
  // serve a Gov account.
  it('POST builds the table path with the Gov DFS suffix in a Gov boundary', async () => {
    process.env.LOOM_CLOUD = 'gcc-high';
    (getSession as any).mockReturnValue(MEMBER);
    (databricksConfigGate as any).mockReturnValue(null);
    (listWarehouses as any).mockResolvedValue([{ id: 'wh1', name: 'w', state: 'RUNNING' }]);
    (executeStatement as any).mockResolvedValue({ columns: ['id'], rows: [[1]], rowCount: 1, executionMs: 1, truncated: false });
    const res = await POST(postReq({ lakehouseId: LH, container: CONTAINER, tablePath: TABLE, version: 1, action: 'preview' }));
    expect(res.status).toBe(200);
    const sql = (executeStatement as any).mock.calls[0][1] as string;
    expect(sql).toContain(`abfss://${CONTAINER}@loomdlz.dfs.core.usgovcloudapi.net/${TABLE}`);
    expect(sql).not.toContain('dfs.core.windows.net');
  });

  // FAILS IF a withheld location is treated as bound (listPaths row set 1) or
  // as unconfigured storage (a different status or message). The message is
  // lifted from the resolver module.
  it('GET answers 409 with the resolver wording when the location is withheld', async () => {
    const actual: any = await vi.importActual('@/lib/azure/lakehouse-abfss');
    const expected = actual.lakehouseStorageWithheldMessage('root-unverified');
    expect(expected, 'the resolver must word root-unverified').toBeTruthy();
    (getSession as any).mockReturnValue(MEMBER);
    (resolveLakehouseAbfss as any).mockResolvedValue({ withheld: 'root-unverified' });
    const res = await GET(getReq({ lakehouseId: LH, container: CONTAINER, tablePath: TABLE }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(expected);
    expect((listPaths as any).mock.calls).toEqual([]);
  });

  // FAILS IF the POST storage form stops requiring a tenant admin: the row set
  // becomes 1 and the status 200.
  it('POST refuses the storage form for a caller who is not a tenant admin', async () => {
    (getSession as any).mockReturnValue(MEMBER);
    (databricksConfigGate as any).mockReturnValue(null);
    (listWarehouses as any).mockResolvedValue([{ id: 'wh1', name: 'w', state: 'RUNNING' }]);
    const res = await POST(postReq({ container: 'bronze', tablePath: 'Tables/x', version: 0, action: 'preview' }));
    expect(res.status).toBe(403);
    expect((executeStatement as any).mock.calls).toEqual([]);
  });
});

describe('/api/lakehouse/history POST — the statement names exactly the checked path', () => {
  function ready() {
    (getSession as any).mockReturnValue(MEMBER);
    (databricksConfigGate as any).mockReturnValue(null);
    (listWarehouses as any).mockResolvedValue([{ id: 'wh1', name: 'w', state: 'RUNNING' }]);
    (executeStatement as any).mockResolvedValue({ columns: ['id'], rows: [[1]], rowCount: 1, executionMs: 1, truncated: false });
  }

  // The path is INSIDE the item root (so containment alone accepts it) and one
  // segment carries a backtick. FAILS IF the backtick is stripped after the
  // scope check instead of refused before it: the previous code answered 200
  // and ran a statement naming `${ROOT}/Tables/orders`, not the checked path.
  it('refuses a tablePath with a backtick before scoping, and runs nothing', async () => {
    ready();
    const tick = `${ROOT}/Tables/ord\`ers`;
    expect(tick.startsWith(`${ROOT}/`), 'the fixture must sit inside the root').toBe(true);
    const res = await POST(postReq({ lakehouseId: LH, container: CONTAINER, tablePath: tick, version: 1, action: 'preview' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/backtick/);
    expect((executeStatement as any).mock.calls).toEqual([]);
    expect((resolveItemAccessByOid as any).mock.calls, 'refused before the item is even looked up').toEqual([]);
  });

  // FAILS IF the container is not checked for a backtick BEFORE scoping: the
  // later check on the resolved location would still answer 400, but only
  // after the item was looked up (resolveItemAccessByOid calls 1, not 0).
  it('refuses a container with a backtick, and runs nothing', async () => {
    ready();
    const res = await POST(postReq({ lakehouseId: LH, container: 'land`ing', tablePath: TABLE, version: 1, action: 'restore' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/backtick/);
    expect((executeStatement as any).mock.calls).toEqual([]);
    expect((resolveItemAccessByOid as any).mock.calls, 'refused before the item is even looked up').toEqual([]);
  });

  // The request is clean; the RESOLVED container (from the item binding) holds
  // a backtick. FAILS IF the route edits the location after scoping: the
  // previous code stripped it and ran against `landing`, a container the scope
  // check never named.
  it('refuses a resolved location with a backtick instead of rewriting it', async () => {
    ready();
    (resolveLakehouseAbfss as any).mockResolvedValue({ abfss: 'abfss://x', container: 'land`ing', root: ROOT });
    const res = await POST(postReq({ lakehouseId: LH, tablePath: TABLE, version: 1, action: 'preview' }));
    expect(res.status).toBe(400);
    expect((executeStatement as any).mock.calls).toEqual([]);
  });

  // POSITIVE pair: a clean path inside the root still runs, and the statement
  // names it byte-for-byte. FAILS IF the new refusal also catches clean input.
  it('runs a clean path and names it unchanged in the statement', async () => {
    ready();
    const res = await POST(postReq({ lakehouseId: LH, container: CONTAINER, tablePath: TABLE, version: 4, action: 'preview' }));
    expect(res.status).toBe(200);
    expect((executeStatement as any).mock.calls[0][1])
      .toBe(`SELECT * FROM delta.\`abfss://${CONTAINER}@loomdlz.dfs.core.windows.net/${TABLE}\` VERSION AS OF 4 LIMIT 100`);
  });

  // A `%` inside the root (so containment alone accepts it). FAILS IF the path
  // is carried with it: POST would answer 200 and run a statement, GET would
  // answer 200 and list. Both refuse before the item is looked up.
  it('refuses a tablePath with a percent sign, on POST and GET, before scoping', async () => {
    ready();
    const pct = `${ROOT}/Tables/ord%2e%2eers`;
    expect(pct.startsWith(`${ROOT}/`), 'the fixture must sit inside the root').toBe(true);
    const post = await POST(postReq({ lakehouseId: LH, container: CONTAINER, tablePath: pct, version: 1, action: 'preview' }));
    expect(post.status).toBe(400);
    const get = await GET(getReq({ lakehouseId: LH, container: CONTAINER, tablePath: pct }));
    expect(get.status).toBe(400);
    expect((executeStatement as any).mock.calls).toEqual([]);
    expect((listPaths as any).mock.calls).toEqual([]);
    expect((resolveItemAccessByOid as any).mock.calls, 'refused before the item is even looked up').toEqual([]);
  });
});

describe('/api/lakehouse/history — the request is confined to the bound container', () => {
  // The lakehouse is bound in `landing`; the request names `bronze` with a
  // table path inside the root. FAILS IF the container check is dropped from
  // the scoping (the route would list `bronze/<root>/...`, listPaths row set
  // 1, status 200).
  it('GET answers 403 for another container and makes no storage call', async () => {
    (getSession as any).mockReturnValue(MEMBER);
    (listPaths as any).mockResolvedValue([]);
    const res = await GET(getReq({ lakehouseId: LH, container: 'bronze', tablePath: TABLE }));
    expect(res.status).toBe(403);
    expect((listPaths as any).mock.calls).toEqual([]);
  });

  // Same for a preview. FAILS IF the container check is dropped: the statement
  // would run against `bronze` (executeStatement row set 1, status 200).
  it('POST preview answers 403 for another container and runs nothing', async () => {
    (getSession as any).mockReturnValue(MEMBER);
    (databricksConfigGate as any).mockReturnValue(null);
    (listWarehouses as any).mockResolvedValue([{ id: 'wh1', name: 'w', state: 'RUNNING' }]);
    (executeStatement as any).mockResolvedValue({ columns: ['id'], rows: [[1]], rowCount: 1, executionMs: 1, truncated: false });
    const res = await POST(postReq({ lakehouseId: LH, container: 'bronze', tablePath: TABLE, version: 1, action: 'preview' }));
    expect(res.status).toBe(403);
    expect((executeStatement as any).mock.calls).toEqual([]);
  });

  // FAILS IF a root-shared 409 stops naming the page that resolves it
  // (`fixHref` absent), or names it for root-unverified, which is retried.
  it('a root-shared 409 carries the readiness link; root-unverified does not', async () => {
    (getSession as any).mockReturnValue(MEMBER);
    (resolveLakehouseAbfss as any).mockResolvedValue({ withheld: 'root-shared' });
    const shared = await (await GET(getReq({ lakehouseId: LH, container: CONTAINER, tablePath: TABLE }))).json();
    expect(shared).toMatchObject({ ok: false, reason: 'root-shared', fixHref: '/admin/readiness' });
    (resolveLakehouseAbfss as any).mockResolvedValue({ withheld: 'root-unverified' });
    const unverified = await (await GET(getReq({ lakehouseId: LH, container: CONTAINER, tablePath: TABLE }))).json();
    expect(unverified.reason).toBe('root-unverified');
    expect(unverified.fixHref).toBeUndefined();
  });
});
