/**
 * BFF contract tests for POST /api/migrate/assess — the M1 estate-assessment
 * on-ramp. Per no-vaporware these exercise the REAL route handler with the
 * reader (migrate-client), Cosmos audit trail, and audit stream mocked.
 *
 * Pins: 401 unauthenticated; 403 non-admin; feature-flag-off 503; the honest
 * svc-loom-migrate gate when LOOM_MIGRATE_URL is unset; the connector-gate
 * pass-through; and the real readiness-report shape (with the reader mocked).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── session ───────────────────────────────────────────────────────────────
const getSessionMock = vi.fn(
  () => ({ claims: { oid: 'admin-oid', upn: 'admin@contoso.com', tid: 'tenant-1' }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

// ── runtime flag (default-ON; a test flips it off) ──────────────────────────
const runtimeFlagMock = vi.fn(async () => true);
vi.mock('@/lib/admin/runtime-flags', () => ({ runtimeFlag: (id: string) => runtimeFlagMock(id) }));

// ── audit doubles ───────────────────────────────────────────────────────────
const auditCreate = vi.fn(async () => ({}));
vi.mock('@/lib/azure/cosmos-client', () => ({
  auditLogContainer: async () => ({ items: { create: auditCreate } }),
}));
const emitAuditEventMock = vi.fn();
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: (e: any) => emitAuditEventMock(e) }));

// ── the estate reader (migrate-client) — real REST is out of scope here ─────
class FakeReaderError extends Error {
  constructor(message: string, readonly status = 502) { super(message); this.name = 'MigrateReaderError'; }
}
const enumerateEstateMock = vi.fn();
vi.mock('@/lib/migrate/migrate-client', () => ({
  isMigrateConfigured: () => (process.env.LOOM_MIGRATE_URL || '').trim().length > 0,
  enumerateEstate: (s: any, c: any) => enumerateEstateMock(s, c),
  MigrateReaderError: FakeReaderError,
}));

function makeReq(body: unknown) {
  return new Request('http://local/api/migrate/assess', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as any;
}

beforeEach(() => {
  getSessionMock.mockReturnValue({ claims: { oid: 'admin-oid', upn: 'admin@contoso.com', tid: 'tenant-1' }, exp: Date.now() / 1000 + 3600 } as any);
  runtimeFlagMock.mockResolvedValue(true);
  process.env.LOOM_TENANT_ADMIN_OID = 'admin-oid';
  process.env.LOOM_MIGRATE_URL = 'https://loom-migrate.internal';
  enumerateEstateMock.mockReset();
  auditCreate.mockClear();
  emitAuditEventMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.LOOM_TENANT_ADMIN_OID;
  delete process.env.LOOM_MIGRATE_URL;
});

describe('POST /api/migrate/assess', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null);
    const { POST } = await import('@/app/api/migrate/assess/route');
    const res = await POST(makeReq({ sourceType: 'snowflake' }), { params: Promise.resolve({}) } as any);
    expect(res.status).toBe(401);
  });

  it('403 when the caller is not a tenant admin', async () => {
    delete process.env.LOOM_TENANT_ADMIN_OID;
    const { POST } = await import('@/app/api/migrate/assess/route');
    const res = await POST(makeReq({ sourceType: 'snowflake' }), { params: Promise.resolve({}) } as any);
    expect(res.status).toBe(403);
  });

  it('503 when the n-m1-estate-assess flag is OFF', async () => {
    runtimeFlagMock.mockResolvedValue(false);
    const { POST } = await import('@/app/api/migrate/assess/route');
    const res = await POST(makeReq({ sourceType: 'snowflake' }), { params: Promise.resolve({}) } as any);
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.code).toBe('feature_disabled');
    expect(enumerateEstateMock).not.toHaveBeenCalled();
  });

  it('returns the honest svc-loom-migrate gate when LOOM_MIGRATE_URL is unset', async () => {
    delete process.env.LOOM_MIGRATE_URL;
    const { POST } = await import('@/app/api/migrate/assess/route');
    const res = await POST(makeReq({ sourceType: 'snowflake' }), { params: Promise.resolve({}) } as any);
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.gated).toBe(true);
    expect(j.gate.id).toBe('svc-loom-migrate');
    expect(j.gate.missing).toContain('LOOM_MIGRATE_URL');
    expect(enumerateEstateMock).not.toHaveBeenCalled();
  });

  it('400 on an unknown sourceType', async () => {
    const { POST } = await import('@/app/api/migrate/assess/route');
    const res = await POST(makeReq({ sourceType: 'oracle' }), { params: Promise.resolve({}) } as any);
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.code).toBe('invalid_source_type');
  });

  it('passes a connector gate through as an honest gated response (no fake counts)', async () => {
    enumerateEstateMock.mockResolvedValue({
      ok: false,
      gate: { gated: true, sourceType: 'snowflake', prerequisite: ['host', 'token', 'catalog'], message: 'Provide the Snowflake account URL, a token, and a database.' },
    });
    const { POST } = await import('@/app/api/migrate/assess/route');
    const res = await POST(makeReq({ sourceType: 'snowflake', connection: {} }), { params: Promise.resolve({}) } as any);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.gated).toBe(true);
    expect(j.gate.missing).toEqual(['host', 'token', 'catalog']);
    // Audited (emit-first + durable row) even for the denied path.
    expect(emitAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'migrate.assess', outcome: 'denied' }));
    expect(auditCreate).toHaveBeenCalled();
  });

  it('returns the real readiness report from an enumerated inventory (reader mocked)', async () => {
    enumerateEstateMock.mockResolvedValue({
      ok: true,
      inventory: {
        sourceType: 'databricks-uc',
        sourceLabel: 'https://adb-1.azuredatabricks.net',
        objects: [
          { kind: 'relational-table', name: 'orders', schema: 'sales', database: 'main', rawType: 'MANAGED' },
          { kind: 'notebook', name: 'etl' },
          { kind: 'stored-routine', name: 'udf' },
        ],
      },
    });
    const { POST } = await import('@/app/api/migrate/assess/route');
    const res = await POST(makeReq({ sourceType: 'databricks-uc', connection: { host: 'x', token: 'y' } }), { params: Promise.resolve({}) } as any);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.report.sourceType).toBe('databricks-uc');
    expect(j.report.totals).toEqual({ objects: 3, oneToOne: 1, needsReview: 2 });
    expect(j.report.objects[0]).toMatchObject({ name: 'orders', loomItemType: 'lakehouse', effort: 'needs-review' });
    expect(emitAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'migrate.assess', outcome: 'success' }));
  });

  it('surfaces a reader transport error as a structured 502', async () => {
    enumerateEstateMock.mockRejectedValue(new FakeReaderError('Estate reader unreachable', 502));
    const { POST } = await import('@/app/api/migrate/assess/route');
    const res = await POST(makeReq({ sourceType: 'fabric', connection: { workspaceId: 'w', token: 't' } }), { params: Promise.resolve({}) } as any);
    expect(res.status).toBe(502);
    const j = await res.json();
    expect(j.code).toBe('reader_error');
    expect(emitAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure' }));
  });
});
