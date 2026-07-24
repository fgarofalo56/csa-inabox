import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSessionMock = vi.hoisted(() => vi.fn(() => ({ claims: { oid: 'tenant-1', upn: 'a@b.com' }, exp: Date.now() / 1000 + 3600 }) as any));
const getUnifiedLineageMock = vi.hoisted(() => vi.fn());
const emitAuditEventMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));
vi.mock('@/lib/azure/unified-lineage', () => ({ getUnifiedLineage: getUnifiedLineageMock }));
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: emitAuditEventMock }));

function req(qs: string) {
  return { nextUrl: { searchParams: new URLSearchParams(qs) } } as any;
}

beforeEach(() => {
  getSessionMock.mockReturnValue({ claims: { oid: 'tenant-1', upn: 'a@b.com' }, exp: Date.now() / 1000 + 3600 } as any);
  getUnifiedLineageMock.mockReset();
  emitAuditEventMock.mockClear();
});

describe('GET /api/lineage/openlineage/export', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null);
    const { GET } = await import('@/app/api/lineage/openlineage/export/route');
    const res = await GET(req('itemId=x'), undefined as any);
    expect(res.status).toBe(401);
  });

  it('400 when no focus is provided', async () => {
    const { GET } = await import('@/app/api/lineage/openlineage/export/route');
    const res = await GET(req(''), undefined as any);
    expect(res.status).toBe(400);
  });

  it('exports a schema-valid OpenLineage event stream + audits the egress', async () => {
    getUnifiedLineageMock.mockResolvedValue({
      ok: true,
      focusId: 'a',
      sources: [{ source: 'weave', ok: true, nodeCount: 2 }],
      nodes: [
        { id: 'a', label: 'A', identity: 'uc:c.s.a', type: 'table' },
        { id: 'b', label: 'B', identity: 'uc:c.s.b', type: 'table' },
      ],
      edges: [{ from: 'a', to: 'b' }],
    });
    const { GET } = await import('@/app/api/lineage/openlineage/export/route');
    const res = await GET(req('itemId=a&itemType=lakehouse'), undefined as any);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.eventCount).toBe(1);
    const ev = j.events[0];
    expect(ev.eventType).toBe('COMPLETE');
    expect(ev.producer).toContain('csa-loom');
    expect(ev.schemaURL).toContain('openlineage.io');
    expect(ev.inputs[0].name).toBe('uc:c.s.a');
    expect(ev.outputs[0].name).toBe('uc:c.s.b');
    // Audited data egress (emit-first).
    expect(emitAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'lineage.openlineage.export' }));
  });
});
