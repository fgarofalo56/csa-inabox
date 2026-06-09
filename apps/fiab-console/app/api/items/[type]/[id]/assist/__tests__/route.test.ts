/**
 * BFF route tests for /api/items/[type]/[id]/assist (Warehouse Copilot).
 *
 * Asserts the engine/mode validation gates and the happy NL→SQL path with a
 * mocked AOAI chat-completions call (real fetch shape, no network) and mocked
 * Synapse schema grounding. No Azure calls leave the test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getSessionMock = vi.fn(
  () => ({ claims: { oid: 'oid-1', upn: 'u@t.com', name: 'U' }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

class FakeNoAoai extends Error {}
let resolveShouldThrow = false;
vi.mock('@/lib/azure/copilot-orchestrator', () => ({
  resolveAoaiTarget: async () => {
    // Throw a generic Error (not NoAoaiDeploymentError) so the route emits its
    // env-var fallback hint — the branch the editor surfaces most often.
    if (resolveShouldThrow) throw new Error('aoai endpoint unset');
    return { endpoint: 'https://aoai.example.com', deployment: 'chat', apiVersion: '2024-10-21' };
  },
  NoAoaiDeploymentError: FakeNoAoai,
}));

vi.mock('@/lib/azure/cloud-endpoints', () => ({
  cogScope: () => 'https://cognitiveservices.azure.com/.default',
}));

const executeQueryMock = vi.fn(async () => ({
  columns: ['table_name', 'column_name', 'type_name', 'max_length', 'is_nullable'],
  rows: [
    ['dbo.Orders', 'CustomerId', 'int', 4, false],
    ['dbo.Orders', 'Amount', 'decimal', 9, false],
    ['dbo.Orders', 'OrderDate', 'datetime', 8, false],
  ],
  rowCount: 3,
  executionMs: 5,
  truncated: false,
  messages: [],
  recordsAffected: 0,
}));
vi.mock('@/lib/azure/synapse-sql-client', () => ({
  dedicatedTarget: () => ({ server: 's', database: 'dw', cacheKey: 'k' }),
  serverlessTarget: () => ({ server: 's', database: 'master', cacheKey: 'k2' }),
  executeQuery: (...a: any[]) => executeQueryMock(...a),
}));

vi.mock('@/lib/azure/databricks-client', () => ({
  executeStatement: vi.fn(async () => ({ columns: [], rows: [], rowCount: 0, executionMs: 1, truncated: false })),
}));

vi.mock('@azure/identity', () => {
  class Cred {
    async getToken() {
      return { token: 'fake-bearer', expiresOnTimestamp: Date.now() + 3_600_000 };
    }
  }
  return {
    ChainedTokenCredential: Cred,
    DefaultAzureCredential: Cred,
    ManagedIdentityCredential: Cred,
  };
});

const ctx = (type: string, id: string) => ({ params: Promise.resolve({ type, id }) });
const req = (b: any) => ({ json: async () => b }) as any;

const fetchMock = vi.fn();

beforeEach(() => {
  resolveShouldThrow = false;
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-1', upn: 'u@t.com', name: 'U' }, exp: Date.now() / 1000 + 3600 } as any);
  fetchMock.mockReset();
  // Default: AOAI returns a runnable SELECT for generate; prose for explain.
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: '```sql\nSELECT TOP 10 CustomerId, SUM(Amount) AS revenue FROM dbo.Orders GROUP BY CustomerId ORDER BY revenue DESC;\n```' } }],
    }),
    text: async () => '',
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('POST /api/items/[type]/[id]/assist', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { POST } = await import('../route');
    const r = await POST(req({ mode: 'generate', prompt: 'x' }), ctx('warehouse', 'i1'));
    expect(r.status).toBe(401);
  });

  it('400 for an unsupported engine', async () => {
    const { POST } = await import('../route');
    const r = await POST(req({ mode: 'generate', prompt: 'x' }), ctx('lakehouse', 'i1'));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/not available/i);
  });

  it('400 for an invalid mode', async () => {
    const { POST } = await import('../route');
    const r = await POST(req({ mode: 'delete', prompt: 'x' }), ctx('warehouse', 'i1'));
    expect(r.status).toBe(400);
  });

  it('400 when generate has no prompt', async () => {
    const { POST } = await import('../route');
    const r = await POST(req({ mode: 'generate' }), ctx('warehouse', 'i1'));
    expect(r.status).toBe(400);
  });

  it('400 when explain has no sql', async () => {
    const { POST } = await import('../route');
    const r = await POST(req({ mode: 'explain' }), ctx('warehouse', 'i1'));
    expect(r.status).toBe(400);
  });

  it('503 no_aoai honest gate when AOAI is unresolved', async () => {
    resolveShouldThrow = true;
    const { POST } = await import('../route');
    const r = await POST(req({ mode: 'generate', prompt: 'top customers' }), ctx('warehouse', 'i1'));
    expect(r.status).toBe(503);
    const j = await r.json();
    expect(j.code).toBe('no_aoai');
    expect(j.hint).toMatch(/LOOM_AOAI_ENDPOINT/);
  });

  it('generate → strips fences, grounds in live schema, returns runnable SQL', async () => {
    const { POST } = await import('../route');
    const r = await POST(
      req({ mode: 'generate', prompt: 'top 10 customers by revenue last quarter' }),
      ctx('warehouse', 'i1'),
    );
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.engine).toBe('warehouse');
    // Fences stripped, real SQL returned.
    expect(j.result.startsWith('SELECT TOP 10')).toBe(true);
    expect(j.result).not.toContain('```');
    // Schema grounding hit the live DMV.
    expect(executeQueryMock).toHaveBeenCalled();
    // The prompt sent to AOAI included the grounded table/column names.
    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    const sysMsg = sentBody.messages.find((m: any) => m.role === 'system').content;
    expect(sysMsg).toContain('dbo.Orders');
    expect(sentBody.temperature).toBe(0.2);
  });

  it('explain → returns prose unchanged and does not require a prompt', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'This query returns the top 10 customers by revenue.' } }] }),
      text: async () => '',
    });
    const { POST } = await import('../route');
    const r = await POST(
      req({ mode: 'explain', sql: 'SELECT TOP 10 CustomerId FROM dbo.Orders;' }),
      ctx('synapse-dedicated-sql-pool', 'i1'),
    );
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.result).toContain('top 10 customers');
  });

  it('retries without temperature on a reasoning-model 400', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'unsupported_value: temperature does not support 0.2; only the default (1) value is supported',
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'SELECT 1;' } }] }),
        text: async () => '',
      });
    const { POST } = await import('../route');
    const r = await POST(req({ mode: 'generate', prompt: 'smoke' }), ctx('warehouse', 'i1'));
    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Second (retry) call omits temperature.
    const retryBody = JSON.parse((fetchMock.mock.calls[1][1] as any).body);
    expect(retryBody.temperature).toBeUndefined();
  });
});

describe('POST /api/items/[type]/[id]/assist — comments mode', () => {
  it('400 when comments has no sql', async () => {
    const { POST } = await import('../route');
    const r = await POST(req({ mode: 'comments' }), ctx('warehouse', 'i1'));
    expect(r.status).toBe(400);
  });

  it('returns the commented SQL (fences stripped) for a real query', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content:
                '```sql\n-- Top customers by spend\nSELECT CustomerId, SUM(Amount) FROM dbo.Orders GROUP BY CustomerId;\n```',
            },
          },
        ],
      }),
      text: async () => '',
    });
    const { POST } = await import('../route');
    const r = await POST(
      req({ mode: 'comments', sql: 'SELECT CustomerId, SUM(Amount) FROM dbo.Orders GROUP BY CustomerId;' }),
      ctx('warehouse', 'i1'),
    );
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.result).toContain('-- Top customers by spend');
    expect(j.result).not.toContain('```');
  });

  it('503 no_aoai honest gate when AOAI is unresolved', async () => {
    resolveShouldThrow = true;
    const { POST } = await import('../route');
    const r = await POST(req({ mode: 'comments', sql: 'SELECT 1' }), ctx('warehouse', 'i1'));
    expect(r.status).toBe(503);
    expect((await r.json()).code).toBe('no_aoai');
  });
});

describe('POST /api/items/[type]/[id]/assist — optimize mode', () => {
  it('returns rewritten SQL and tolerates an EXPLAIN-plan soft-fail', async () => {
    // First fetch is the AOAI rewrite (synapse SHOWPLAN goes through the mocked
    // executeQuery, which here throws to simulate a paused pool — soft-fail).
    executeQueryMock.mockRejectedValueOnce(new Error('pool paused'));
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'SELECT CustomerId, SUM(Amount) AS total FROM dbo.Orders GROUP BY CustomerId OPTION (LABEL = \'opt\');' } }],
      }),
      text: async () => '',
    });
    const { POST } = await import('../route');
    const r = await POST(
      req({ mode: 'optimize', sql: 'SELECT CustomerId, SUM(Amount) FROM dbo.Orders GROUP BY CustomerId;' }),
      ctx('synapse-dedicated-sql-pool', 'i1'),
    );
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.result).toContain('OPTION (LABEL');
    expect(j.result).not.toContain('```');
  });

  it('folds a real EXPLAIN plan into the prompt when SHOWPLAN returns rows', async () => {
    // executeQuery is called twice: once for schema, once for SHOWPLAN. The
    // default mock returns schema-shaped rows for both — good enough to assert
    // the plan text reaches the system prompt.
    executeQueryMock.mockResolvedValueOnce({
      columns: ['table_name', 'column_name', 'type_name', 'max_length', 'is_nullable'],
      rows: [['dbo.Orders', 'CustomerId', 'int', 4, false]],
      rowCount: 1, executionMs: 1, truncated: false, messages: [], recordsAffected: 0,
    });
    executeQueryMock.mockResolvedValueOnce({
      columns: ['StmtText'],
      rows: [['  |--Table Scan(OBJECT:([dbo].[Orders]))']],
      rowCount: 1, executionMs: 1, truncated: false, messages: [], recordsAffected: 0,
    });
    fetchMock.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: 'SELECT 1;' } }] }),
      text: async () => '',
    });
    const { POST } = await import('../route');
    const r = await POST(
      req({ mode: 'optimize', sql: 'SELECT * FROM dbo.Orders;' }),
      ctx('synapse-dedicated-sql-pool', 'i1'),
    );
    expect(r.status).toBe(200);
    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    const sysMsg = sentBody.messages.find((m: any) => m.role === 'system').content;
    expect(sysMsg).toContain('Table Scan');
  });
});
