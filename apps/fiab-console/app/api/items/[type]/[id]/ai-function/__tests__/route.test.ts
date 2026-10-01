/**
 * Route-level test for POST /api/items/[type]/[id]/ai-function on the
 * Databricks path: labels, extract fields and the target language reach the
 * warehouse as Spark SQL string literals, escaped by the Spark rule
 * (`\'` for a quote, `\\` for a backslash) through buildAiSqlExpr.
 *
 * What breaks these tests:
 *   - the route building the expression with T-SQL quote doubling
 *     (escapeSqlLiteral) again: the statement carries `don''t`, not `don\'t`,
 *     and every exact-text assertion below fails;
 *   - the route interpolating the option raw: the statement carries `don't`
 *     inside `'...'` and the exact-text assertion fails;
 *   - an option dropped on the way to buildAiSqlExpr (e.g. `fields` not
 *     forwarded): the default `'entity'` appears instead of the sent value.
 * The plain-label case is the positive control: a value with nothing to
 * escape is carried unchanged, so a rule that mangles every value cannot pass.
 *
 * No network: the session, the Databricks client and the cloud resolver are
 * mocked; executeStatement records the statement it was handed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

const getSessionMock = vi.fn(() => ({ claims: { oid: 'oid-1', upn: 'u@t.com', name: 'U' }, exp: Date.now() / 1000 + 3600 }) as any);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

vi.mock('@/lib/azure/cloud-endpoints', async (importOriginal) => ({
  ...(await importOriginal() as any),
  isGovCloud: () => false,
}));

const executeStatement = vi.fn(async (..._a: unknown[]) => ({ columns: [], rows: [], rowCount: 0, executionMs: 1, truncated: false }));
vi.mock('@/lib/azure/databricks-client', () => ({
  databricksConfigGate: () => null,
  getWarehouse: async () => ({ state: 'RUNNING' }),
  executeStatement: (...a: unknown[]) => executeStatement(...a),
}));

vi.mock('@/lib/azure/copilot-config-store', () => ({ loadTenantCopilotConfig: async () => null }));

/**
 * Item scoping. The REAL guardSynapseItemRequest runs (and its Cosmos lookup
 * against ITEMS); only the workspace ladder is mocked, so a test can make it
 * deny. `n1` is a notebook in ws-1.
 */
const authorizeItemWorkspace = vi.fn(async (..._a: unknown[]): Promise<Response | null> => null);
vi.mock('@/lib/auth/workspace-guard', () => ({ authorizeItemWorkspace: (...a: unknown[]) => authorizeItemWorkspace(...a) }));
const ITEMS = [{ id: 'n1', itemType: 'notebook', workspaceId: 'ws-1', state: {} }];
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: {
      query: (spec: any) => ({
        fetchAll: async () => {
          const id = spec?.parameters?.find((p: any) => p.name === '@id')?.value;
          const t = spec?.parameters?.find((p: any) => p.name === '@t')?.value;
          return { resources: ITEMS.filter((i) => i.id === id && i.itemType === t) };
        },
      }),
    },
  }),
}));

import { POST } from '../route';

/** POST the body and return the one statement sent to the warehouse. */
async function sentSql(body: Record<string, unknown>): Promise<string> {
  const req = new NextRequest('https://x/api/items/notebook/n1/ai-function', {
    method: 'POST',
    body: JSON.stringify({ column: 'txt', table: 'main.s.t', warehouseId: 'wh1', ...body }),
  });
  const res = await POST(req, { params: Promise.resolve({ type: 'notebook', id: 'n1' }) });
  const j = await res.json();
  expect(res.status, JSON.stringify(j)).toBe(200);
  expect(j.engine).toBe('databricks');
  expect(executeStatement).toHaveBeenCalledTimes(1);
  expect(executeStatement.mock.calls[0][0]).toBe('wh1');
  const sql = String(executeStatement.mock.calls[0][1]);
  expect(j.sql).toBe(sql);
  return sql;
}

beforeEach(() => {
  executeStatement.mockClear();
  authorizeItemWorkspace.mockReset();
  authorizeItemWorkspace.mockResolvedValue(null);
});

/** POST to an arbitrary [type]/[id]; returns status, body and whether the warehouse was reached. */
async function postAs(type: string, id: string) {
  const req = new NextRequest(`https://x/api/items/${type}/${id}/ai-function`, {
    method: 'POST',
    body: JSON.stringify({ fn: 'classify', column: 'txt', table: 'main.s.t', warehouseId: 'wh1', options: { labels: ['good'] } }),
  });
  const res = await POST(req, { params: Promise.resolve({ type, id }) });
  return { status: res.status, body: await res.json(), sent: executeStatement.mock.calls.length };
}

describe('ai-function route: POST is item-scoped', () => {
  it('positive control: an authorized caller on an existing item reaches the warehouse (200)', async () => {
    const r = await postAs('notebook', 'n1');
    expect(r.status).toBe(200);
    expect(r.sent).toBe(1);
    // The ladder is asked about THIS item, read-scoped. Breaks if the route
    // authorizes a fixed type, drops allowReadRoles, or skips the ladder.
    expect(authorizeItemWorkspace).toHaveBeenCalledTimes(1);
    expect(authorizeItemWorkspace.mock.calls[0][1]).toMatchObject({ itemId: 'n1', itemType: 'notebook', allowReadRoles: true });
    // The refusal text the ladder will use. Breaks if the route passes a
    // different `notFound` (e.g. "workspace not found", which tells a caller
    // with no role nothing about what to do next).
    expect((authorizeItemWorkspace.mock.calls[0][1] as { notFound: string }).notFound).toMatch(/Ask a workspace owner to share it with you\.$/);
  });

  it('a caller with no role on the item gets 404 and no statement is sent', async () => {
    // Breaks if the route goes back to session-only authorization (the denial
    // is ignored and the statement is sent, status 200).
    authorizeItemWorkspace.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: 'workspace not found' }), { status: 404 }),
    );
    const r = await postAs('notebook', 'n1');
    expect(r.status).toBe(404);
    expect(r.sent).toBe(0);
  });

  it('an id that names no item of [type] gets 404 and no statement is sent', async () => {
    // The ladder ALLOWS here (null) — it does for an id naming no item — so this
    // pins the guard's fail-closed lookup. `n1` exists, but as a notebook, so the
    // second call breaks if the route stops passing [type] to the lookup.
    const missing = await postAs('notebook', 'missing');
    expect(missing.status).toBe(404);
    // The guard's own refusal carries the route's text. Breaks if the route's
    // `notFound` changes. (The ladder's denial body is pinned through the real
    // ladder in route-real-ladder.test.ts; here the ladder is a mock.)
    expect(missing.body.error).toMatch(/Ask a workspace owner to share it with you\.$/);
    expect((await postAs('databricks-sql-warehouse', 'n1')).status).toBe(404);
    expect(executeStatement).not.toHaveBeenCalled();
  });

  it("an unsaved item ('new') gets the coded gate, not a statement", async () => {
    // Breaks if the gate is removed: the guard then answers `new` with a 404,
    // which the helper renders as a failed run. With the gate, the helper shows
    // a "Save this item first" warning instead (pinned in
    // lib/editors/components/__tests__/ai-functions-helper-unsaved.test.tsx).
    // The `authorizeItemWorkspace` assertion breaks if the gate is widened so
    // that it no longer short-circuits ahead of the guard.
    const r = await postAs('databricks-sql-warehouse', 'new');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: false, code: 'unsaved_item' });
    expect(r.sent).toBe(0);
    expect(authorizeItemWorkspace).not.toHaveBeenCalled();
  });

  it('no session: 401 on a real id and on new, before the unsaved gate', async () => {
    getSessionMock.mockReturnValueOnce(null as any).mockReturnValueOnce(null as any);
    // Breaks if the unsaved-item gate moves above authentication.
    expect((await postAs('notebook', 'n1')).status).toBe(401);
    const n = await postAs('databricks-sql-warehouse', 'new');
    expect(n.status).toBe(401);
    expect(n.body.code).not.toBe('unsaved_item');
    expect(executeStatement).not.toHaveBeenCalled();
  });
});

describe('ai-function route (Databricks path): option literals follow the Spark SQL rule', () => {
  it('positive control: plain labels are carried unchanged', async () => {
    expect(await sentSql({ fn: 'classify', options: { labels: ['good', 'bad'] } })).toBe(
      "SELECT `txt`, ai_classify(`txt`, ARRAY('good', 'bad')) AS ai_result FROM main.s.t LIMIT 50",
    );
  });

  it("a label holding a quote: don't is sent as 'don\\'t'", async () => {
    const sql = await sentSql({ fn: 'classify', options: { labels: ["don't", 'C:\\'] } });
    expect(sql).toBe(
      "SELECT `txt`, ai_classify(`txt`, ARRAY('don\\'t', 'C:\\\\')) AS ai_result FROM main.s.t LIMIT 50",
    );
    expect(sql).not.toContain("don''t");
  });

  it("an extract field holding a quote: don't is sent as 'don\\'t'", async () => {
    const sql = await sentSql({ fn: 'extract', options: { fields: ["don't", 'name'] } });
    expect(sql).toContain("ai_extract(`txt`, ARRAY('don\\'t', 'name'))");
    expect(sql).not.toContain("don''t");
  });

  it("a target language holding a quote: don't is sent as 'don\\'t'", async () => {
    const sql = await sentSql({ fn: 'translate', options: { targetLang: "don't" } });
    expect(sql).toContain("ai_translate(`txt`, 'don\\'t')");
    expect(sql).not.toContain("don''t");
  });
});
