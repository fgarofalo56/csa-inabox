/**
 * BFF contract tests for GET/PUT /api/items/paginated-report/[id]/definition.
 *
 * Pins the structured-model fix: the designer, the /export route, and the
 * client library all speak `RdlReportDefinition` (dataSources / datasets /
 * tablixes / parameters). This route previously spoke a stale raw-RDL-XML shape
 * (`{ rdl }`), which made the designer's GET return `undefined` for
 * `j.definition` (a null-crash on `.tablixes`) and rejected every Save with
 * "rdl is required". These tests lock the route onto the structured contract:
 *   - GET returns `{ ok, definition }`, seeding a blank valid definition when
 *     none is saved yet (so a fresh item opens on an authorable canvas).
 *   - PUT accepts the structured document, normalizes identity to the item's
 *     workspace, and returns the persisted `{ definition }`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const getSessionMock = vi.fn(
  () => ({ claims: { oid: 'o' }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

const loadKustoItemMock = vi.fn();
vi.mock('@/lib/azure/kusto-client', () => ({
  loadKustoItem: (...a: unknown[]) => loadKustoItemMock(...a),
  KustoError: class KustoError extends Error { status = 500; },
}));

const getRdlDefinitionMock = vi.fn();
const upsertRdlDefinitionMock = vi.fn();
vi.mock('@/lib/azure/paginated-report-client', () => ({
  getRdlDefinition: (...a: unknown[]) => getRdlDefinitionMock(...a),
  upsertRdlDefinition: (...a: unknown[]) => upsertRdlDefinitionMock(...a),
  emptyRdlDefinition: (workspaceId: string, id: string, name: string) => ({
    id, workspaceId, name: name || 'Untitled paginated report',
    pageOrientation: 'Portrait', pageSize: 'Letter',
    dataSources: [], datasets: [], tablixes: [], parameters: [],
    createdAt: 't', updatedAt: 't',
  }),
}));

import { GET, PUT } from '../route';

function getReq(qs = 'workspaceId=ws1') {
  return { nextUrl: { searchParams: new URLSearchParams(qs) } } as any;
}
function putReq(body: any) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return { text: async () => raw } as any;
}
function ctx(id = 'rpt1') {
  return { params: Promise.resolve({ id }) };
}
const item = () => ({ id: 'rpt1', workspaceId: 'ws1', itemType: 'paginated-report', displayName: 'Q3 Sales' });
const structuredDef = () => ({
  id: 'rpt1', workspaceId: 'ws1', name: 'Q3 Sales',
  pageOrientation: 'Landscape', pageSize: 'A4',
  dataSources: [{ id: 'ds_1', name: 'Sales', type: 'AzureSQL', server: 's', database: 'd' }],
  datasets: [{ id: 'dset_1', name: 'q', dataSourceId: 'ds_1', query: 'SELECT 1', fields: [{ name: 'a', type: 'Int' }] }],
  tablixes: [{ id: 'tbx_1', name: 'T', datasetId: 'dset_1', columns: ['a'], rowGroups: [], headerRow: ['A'], cells: [[{ expression: 'Fields!a.Value' }]], showColumnHeaders: true, pageBreak: false }],
  parameters: [{ name: 'Year', type: 'Int', prompt: 'Year', defaultValue: '2026' }],
  createdAt: 'orig', updatedAt: 'orig',
});

beforeEach(() => {
  getSessionMock.mockReturnValue({ claims: { oid: 'o' }, exp: Date.now() / 1000 + 3600 } as any);
  loadKustoItemMock.mockReset().mockResolvedValue(item());
  getRdlDefinitionMock.mockReset();
  upsertRdlDefinitionMock.mockReset().mockImplementation(async (d: any) => d);
});

describe('GET /api/items/paginated-report/[id]/definition', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValueOnce(null as any);
    const res = await GET(getReq(), ctx());
    expect(res.status).toBe(401);
  });

  it('404 when the item is missing / not owned', async () => {
    loadKustoItemMock.mockResolvedValueOnce(null);
    const res = await GET(getReq(), ctx());
    expect(res.status).toBe(404);
  });

  it('returns the saved structured definition (not a raw-RDL shape)', async () => {
    getRdlDefinitionMock.mockResolvedValueOnce(structuredDef());
    const res = await GET(getReq(), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // The designer reads j.definition.tablixes — it must be a real array.
    expect(Array.isArray(body.definition.tablixes)).toBe(true);
    expect(body.definition.tablixes[0].id).toBe('tbx_1');
    expect(body.rdl).toBeUndefined(); // no stale XML shape
    expect(getRdlDefinitionMock).toHaveBeenCalledWith('ws1', 'rpt1');
  });

  it('seeds a blank valid definition when none is saved yet (fresh item)', async () => {
    getRdlDefinitionMock.mockResolvedValueOnce(null);
    const res = await GET(getReq(), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.definition.id).toBe('rpt1');
    expect(body.definition.workspaceId).toBe('ws1');
    expect(body.definition.name).toBe('Q3 Sales');
    expect(body.definition.tablixes).toEqual([]); // authorable empty canvas, not a crash
  });
});

describe('PUT /api/items/paginated-report/[id]/definition', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValueOnce(null as any);
    const res = await PUT(putReq(structuredDef()), ctx());
    expect(res.status).toBe(401);
  });

  it('400 on a non-object / invalid json body', async () => {
    const res = await PUT(putReq('not json'), ctx());
    expect(res.status).toBe(400);
    expect(upsertRdlDefinitionMock).not.toHaveBeenCalled();
  });

  it('404 when the item is missing / not owned', async () => {
    loadKustoItemMock.mockResolvedValueOnce(null);
    const res = await PUT(putReq(structuredDef()), ctx());
    expect(res.status).toBe(404);
    expect(upsertRdlDefinitionMock).not.toHaveBeenCalled();
  });

  it('persists the structured definition and returns it', async () => {
    const res = await PUT(putReq(structuredDef()), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.definition.tablixes[0].id).toBe('tbx_1');
    expect(body.definition.parameters[0].name).toBe('Year');
    // Page setup round-trips.
    expect(body.definition.pageOrientation).toBe('Landscape');
    expect(body.definition.pageSize).toBe('A4');
    expect(upsertRdlDefinitionMock).toHaveBeenCalledTimes(1);
  });

  it('normalizes identity to the item workspace (client cannot re-point id/workspace)', async () => {
    const spoof = { ...structuredDef(), id: 'evil', workspaceId: 'other-ws' };
    const res = await PUT(putReq(spoof), ctx());
    expect(res.status).toBe(200);
    const saved = upsertRdlDefinitionMock.mock.calls[0][0];
    expect(saved.id).toBe('rpt1');       // path id wins
    expect(saved.workspaceId).toBe('ws1'); // item workspace wins
    expect(typeof saved.updatedAt).toBe('string');
  });

  it('coerces missing collection fields to arrays (never persists undefined)', async () => {
    const partial: any = { id: 'rpt1', workspaceId: 'ws1', name: 'x' };
    const res = await PUT(putReq(partial), ctx());
    expect(res.status).toBe(200);
    const saved = upsertRdlDefinitionMock.mock.calls[0][0];
    expect(saved.dataSources).toEqual([]);
    expect(saved.datasets).toEqual([]);
    expect(saved.tablixes).toEqual([]);
    expect(saved.parameters).toEqual([]);
    expect(saved.pageSize).toBe('Letter');       // defaulted
    expect(saved.pageOrientation).toBe('Portrait'); // defaulted
  });
});
