/**
 * BFF contract tests for POST /api/connections/[id]/preview — the "Analyze data"
 * row-preview route for a saved Loom Connection. Auth + connection load +
 * buildConnectionExecutor are mocked; these pin status codes + honest gates
 * (no-vaporware.md): unauth 401, not-found 404, non-tabular 412, missing
 * objectRef 400, unbound executor 412, and a real 200 rows body.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let sessionVal: any = { claims: { oid: 'oid-1' }, exp: Date.now() / 1000 + 3600 };
let conn: any = null;
let executorResult: any = null;

vi.mock('@/lib/auth/session', () => ({ getSession: () => sessionVal }));
vi.mock('@/lib/azure/connections-store', () => ({
  loadConnection: async () => conn,
}));
vi.mock('@/lib/azure/report-model-resolver', () => ({
  buildConnectionExecutor: vi.fn(async () => executorResult),
}));

function req(body?: any) {
  return { json: async () => body ?? {} } as any;
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe('POST /api/connections/[id]/preview', () => {
  beforeEach(() => {
    sessionVal = { claims: { oid: 'oid-1' }, exp: Date.now() / 1000 + 3600 };
    conn = null;
    executorResult = null;
    vi.resetModules();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('401 when unauthenticated', async () => {
    sessionVal = null;
    const { POST } = await import('../route');
    const res = await POST(req({ objectRef: { mode: 'table', table: 'T' } }), ctx('c1'));
    expect(res.status).toBe(401);
  });

  it('404 when the connection is not found', async () => {
    conn = null;
    const { POST } = await import('../route');
    const res = await POST(req({ objectRef: { mode: 'table', table: 'T' } }), ctx('missing'));
    expect(res.status).toBe(404);
  });

  it('412 gate for a non-tabular connection (event-hub)', async () => {
    conn = { id: 'c1', type: 'event-hub', name: 'eh' };
    const { POST } = await import('../route');
    const res = await POST(req({ objectRef: { mode: 'table', table: 'T' } }), ctx('c1'));
    expect(res.status).toBe(412);
    const j = await res.json();
    expect(j.missing).toBe('connType');
  });

  it('400 when the objectRef is missing / incomplete', async () => {
    conn = { id: 'c1', type: 'azure-sql', name: 'sql' };
    const { POST } = await import('../route');
    const res = await POST(req({ objectRef: { mode: 'table' } }), ctx('c1'));
    expect(res.status).toBe(400);
  });

  it('412 gate when the executor resolves to unbound (honest remediation)', async () => {
    conn = { id: 'c1', type: 'azure-sql', name: 'sql' };
    executorResult = { backend: 'unbound', gate: { code: 'unbound', error: 'Set LOOM_SYNAPSE_WORKSPACE', missing: 'LOOM_SYNAPSE_WORKSPACE' } };
    const { POST } = await import('../route');
    const res = await POST(req({ objectRef: { mode: 'table', table: 'T' } }), ctx('c1'));
    expect(res.status).toBe(412);
    const j = await res.json();
    expect(j.missing).toBe('LOOM_SYNAPSE_WORKSPACE');
  });

  it('200 rows for a bound table preview', async () => {
    conn = { id: 'c1', type: 'azure-sql', name: 'sql' };
    executorResult = {
      backend: 'connection',
      connType: 'azure-sql',
      executor: { preview: vi.fn(async () => ({ columns: ['id', 'name'], rows: [{ id: 1, name: 'a' }], truncated: false })) },
    };
    const { POST } = await import('../route');
    const res = await POST(req({ objectRef: { mode: 'table', table: 'Customer', schema: 'dbo' }, limit: 100 }), ctx('c1'));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.columns).toEqual(['id', 'name']);
    expect(j.rows).toHaveLength(1);
    expect(j.truncated).toBe(false);
  });
});
