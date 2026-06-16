/**
 * BFF contract tests for POST /api/items/paginated-report/[id]/export.
 *
 * Pins the C1 audit fix: Export must call the binary renderer (`renderReport`)
 * and stream REAL bytes with the correct Content-Type + Content-Disposition —
 * NOT proxy the /render route, which returns the on-screen JSON page-model and
 * produced a JSON blob renamed `.pdf`/`.xlsx`/`.docx`. The honest-gate must key
 * on `LOOM_PAGINATED_RENDER_URL` (export's real dependency).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const getSessionMock = vi.fn(
  () => ({ claims: { oid: 'o' }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

const paginatedRenderGateMock = vi.fn();
const renderReportMock = vi.fn();
const getRdlDefinitionMock = vi.fn();
vi.mock('@/lib/azure/paginated-report-client', () => ({
  paginatedRenderGate: () => paginatedRenderGateMock(),
  renderReport: (...a: unknown[]) => renderReportMock(...a),
  getRdlDefinition: (...a: unknown[]) => getRdlDefinitionMock(...a),
}));

import { POST } from '../route';

function req(body: any) {
  return { json: async () => body } as any;
}
function ctx(id = 'rpt1') {
  return { params: Promise.resolve({ id }) };
}
const sampleDef = () => ({
  id: 'rpt1', workspaceId: 'ws1', name: 'My Report',
  pageOrientation: 'Portrait', pageSize: 'Letter',
  dataSources: [], datasets: [], tablixes: [], parameters: [],
  createdAt: '', updatedAt: '',
});

beforeEach(() => {
  getSessionMock.mockReturnValue({ claims: { oid: 'o' }, exp: Date.now() / 1000 + 3600 } as any);
  paginatedRenderGateMock.mockReset().mockReturnValue(null);
  renderReportMock.mockReset();
  getRdlDefinitionMock.mockReset();
});

describe('POST /api/items/paginated-report/[id]/export', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValueOnce(null as any);
    const res = await POST(req({ format: 'pdf' }), ctx());
    expect(res.status).toBe(401);
  });

  it('400 on an unsupported export format', async () => {
    const res = await POST(req({ format: 'csv', definition: sampleDef() }), ctx());
    expect(res.status).toBe(400);
    expect(renderReportMock).not.toHaveBeenCalled();
  });

  it('honest-gates 503 with the LOOM_PAGINATED_RENDER_URL hint when the renderer is not deployed', async () => {
    paginatedRenderGateMock.mockReturnValue({ missingEnvVar: 'LOOM_PAGINATED_RENDER_URL', detail: 'renderer not deployed' });
    const res = await POST(req({ format: 'pdf', definition: sampleDef() }), ctx());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.hint.missingEnvVar).toBe('LOOM_PAGINATED_RENDER_URL');
    expect(body.hint.bicepModule).toMatch(/paginated-report-renderer/);
    expect(renderReportMock).not.toHaveBeenCalled();
  });

  it('streams real binary bytes with the correct Content-Type + Content-Disposition', async () => {
    renderReportMock.mockResolvedValue({
      bytes: Buffer.from('%PDF-1.7 real-bytes'),
      mimeType: 'application/pdf',
      fileName: 'My_Report.pdf',
    });
    const res = await POST(req({ format: 'pdf', definition: sampleDef(), parameterValues: [] }), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toContain('My_Report.pdf');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.toString()).toContain('%PDF'); // real document, not a JSON page-model
    expect(renderReportMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'rpt1' }), 'pdf', []);
  });

  it('falls back to the saved definition by workspaceId, and 404s when absent', async () => {
    getRdlDefinitionMock.mockResolvedValue(null);
    const res = await POST(req({ format: 'xlsx', workspaceId: 'ws1' }), ctx());
    expect(res.status).toBe(404);
    expect(getRdlDefinitionMock).toHaveBeenCalledWith('ws1', 'rpt1');
  });

  it('400 when neither a definition nor a workspaceId is supplied', async () => {
    const res = await POST(req({ format: 'pdf' }), ctx());
    expect(res.status).toBe(400);
  });
});
