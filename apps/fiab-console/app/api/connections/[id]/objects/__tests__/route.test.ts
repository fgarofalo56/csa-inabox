/**
 * BFF contract tests for POST /api/connections/[id]/objects — the "Analyze data"
 * browse route for a saved Loom Connection. Auth + connection load + the SQL
 * introspection are mocked; these pin the status codes + the honest gates
 * (no-vaporware.md): unauth 401, not-found 404, non-tabular / ADLS 412 gate,
 * and a real 200 nodes body for a SQL connection.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let sessionVal: any = { claims: { oid: 'oid-1' }, exp: Date.now() / 1000 + 3600 };
let conn: any = null;

vi.mock('@/lib/auth/session', () => ({ getSession: () => sessionVal }));
vi.mock('@/lib/azure/connections-store', () => ({
  loadConnection: async () => conn,
}));

// Keep the real gate/bad/fail/providerForConnType/wire helpers; override only the
// per-provider introspection so a SQL browse returns a deterministic node set.
vi.mock('@/lib/report/navigator/introspect', async (importActual) => {
  const actual = await importActual<any>();
  return {
    ...actual,
    introspectSql: vi.fn(async () => [
      { name: 'Customer', kind: 'table', schema: 'dbo', hasChildren: false, selectable: true, objectRef: { mode: 'table', table: 'Customer', schema: 'dbo' } },
    ]),
  };
});

function req(body?: any) {
  return { json: async () => body ?? {} } as any;
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe('POST /api/connections/[id]/objects', () => {
  beforeEach(() => {
    sessionVal = { claims: { oid: 'oid-1' }, exp: Date.now() / 1000 + 3600 };
    conn = null;
    vi.resetModules();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('401 when unauthenticated', async () => {
    sessionVal = null;
    const { POST } = await import('../route');
    const res = await POST(req(), ctx('c1'));
    expect(res.status).toBe(401);
  });

  it('404 when the connection is not found in the tenant', async () => {
    conn = null;
    const { POST } = await import('../route');
    const res = await POST(req(), ctx('missing'));
    expect(res.status).toBe(404);
  });

  it('412 gate for an ADLS / Storage connection (no SQL-style tree)', async () => {
    conn = { id: 'c1', type: 'storage-adls', name: 'lake', authMethod: 'entra-mi' };
    const { POST } = await import('../route');
    const res = await POST(req(), ctx('c1'));
    expect(res.status).toBe(412);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.missing).toBe('connType');
  });

  it('412 gate for a non-tabular type (key-vault)', async () => {
    conn = { id: 'c1', type: 'key-vault', name: 'kv', authMethod: 'entra-mi' };
    const { POST } = await import('../route');
    const res = await POST(req(), ctx('c1'));
    expect(res.status).toBe(412);
  });

  it('200 nodes for a SQL connection', async () => {
    conn = { id: 'c1', type: 'azure-sql', name: 'sql', authMethod: 'entra-mi', host: 'srv.database.windows.net', database: 'db' };
    const { POST } = await import('../route');
    const res = await POST(req({ level: 'tables' }), ctx('c1'));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.provider).toBe('sql');
    expect(Array.isArray(j.nodes)).toBe(true);
    expect(j.nodes[0].name).toBe('Customer');
    expect(j.nodes[0].selectable).toBe(true);
  });
});
