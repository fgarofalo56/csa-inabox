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
