/**
 * Unit tests for paginated-report-client:
 *   - getRdlDefinition: null on 404, partition-scoped read
 *   - upsertRdlDefinition: round-trips the full nested shape + bumps updatedAt
 *   - deleteRdlDefinition: swallows 404
 *   - paginatedRenderGate / renderReport: honest gate when env unset
 *   - emptyRdlDefinition / exportMimeType
 *
 * Mocks the Cosmos container so no real Cosmos call is made (same pattern as
 * copilot-config.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const read = vi.fn();
const upsert = vi.fn();
const del = vi.fn();
const itemFn = vi.fn(() => ({ read, delete: del }));
const containerMock = { item: itemFn, items: { upsert } };

vi.mock('@/lib/azure/cosmos-client', () => ({
  paginatedReportDefinitionsContainer: vi.fn(async () => containerMock),
}));

import {
  getRdlDefinition, upsertRdlDefinition, deleteRdlDefinition,
  paginatedRenderGate, renderReport, emptyRdlDefinition, exportMimeType,
  type RdlReportDefinition,
} from '@/lib/azure/paginated-report-client';

function sampleDef(): RdlReportDefinition {
  return {
    id: 'rpt1',
    workspaceId: 'ws1',
    name: 'Sales',
    pageOrientation: 'Landscape',
    pageSize: 'A4',
    dataSources: [{ id: 'ds1', name: 'OLTP', type: 'AzureSQL', server: 's.database.windows.net', database: 'db' }],
    datasets: [{ id: 'dset1', name: 'q', dataSourceId: 'ds1', query: 'SELECT 1 AS n', fields: [{ name: 'n', type: 'Int' }], sampleRows: [{ n: 1 }] }],
    tablixes: [{ id: 'tbx1', name: 'T', datasetId: 'dset1', columns: ['n'], rowGroups: [], headerRow: ['N'], cells: [[{ expression: 'Fields!n.Value' }]], showColumnHeaders: true, pageBreak: false }],
    parameters: [{ name: 'Region', type: 'String', prompt: 'Region', defaultValue: 'East' }],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

beforeEach(() => {
  read.mockReset(); upsert.mockReset(); del.mockReset(); itemFn.mockClear();
  delete process.env.LOOM_PAGINATED_RENDER_URL;
  delete process.env.LOOM_PAGINATED_RENDER_KEY;
});

describe('getRdlDefinition', () => {
  it('returns null when Cosmos read 404s', async () => {
    read.mockRejectedValue({ code: 404 });
    expect(await getRdlDefinition('ws1', 'rpt1')).toBeNull();
  });
  it('returns the doc when partition matches', async () => {
    read.mockResolvedValue({ resource: sampleDef() });
    const d = await getRdlDefinition('ws1', 'rpt1');
    expect(d?.name).toBe('Sales');
    expect(itemFn).toHaveBeenCalledWith('rpt1', 'ws1');
  });
  it('returns null when the stored doc is in a different partition', async () => {
    read.mockResolvedValue({ resource: { ...sampleDef(), workspaceId: 'other' } });
    expect(await getRdlDefinition('ws1', 'rpt1')).toBeNull();
  });
});

describe('upsertRdlDefinition', () => {
  it('round-trips the full nested shape and bumps updatedAt', async () => {
    upsert.mockImplementation(async (doc: RdlReportDefinition) => ({ resource: doc }));
    const out = await upsertRdlDefinition(sampleDef());
    const written = upsert.mock.calls[0][0] as RdlReportDefinition;
    expect(written.dataSources[0].type).toBe('AzureSQL');
    expect(written.datasets[0].sampleRows).toEqual([{ n: 1 }]);
    expect(written.tablixes[0].cells[0][0].expression).toBe('Fields!n.Value');
    expect(written.parameters[0].name).toBe('Region');
    expect(out.updatedAt).not.toBe('2026-01-01T00:00:00.000Z');
  });
  it('rejects when id or workspaceId is missing', async () => {
    await expect(upsertRdlDefinition({ ...sampleDef(), id: '' })).rejects.toThrow(/report id/);
    await expect(upsertRdlDefinition({ ...sampleDef(), workspaceId: '' })).rejects.toThrow(/workspaceId/);
  });
});

describe('deleteRdlDefinition', () => {
  it('swallows a 404', async () => {
    del.mockRejectedValue({ code: 404 });
    await expect(deleteRdlDefinition('ws1', 'rpt1')).resolves.toBeUndefined();
  });
  it('deletes by (id, workspaceId)', async () => {
    del.mockResolvedValue({});
    await deleteRdlDefinition('ws1', 'rpt1');
    expect(itemFn).toHaveBeenCalledWith('rpt1', 'ws1');
  });
});

describe('render gate', () => {
  it('paginatedRenderGate returns a gate when LOOM_PAGINATED_RENDER_URL is unset', () => {
    const g = paginatedRenderGate();
    expect(g?.missingEnvVar).toBe('LOOM_PAGINATED_RENDER_URL');
  });
  it('paginatedRenderGate returns null when configured', () => {
    process.env.LOOM_PAGINATED_RENDER_URL = 'https://fn.example.net';
    expect(paginatedRenderGate()).toBeNull();
  });
  it('renderReport throws 503 when the renderer is not configured', async () => {
    await expect(renderReport(sampleDef(), 'pdf')).rejects.toMatchObject({ status: 503 });
  });
  it('renderReport posts to /api/render with ?code and returns the binary', async () => {
    process.env.LOOM_PAGINATED_RENDER_URL = 'https://fn.example.net';
    process.env.LOOM_PAGINATED_RENDER_KEY = 'secret-key';
    const fetchMock = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }));
    vi.stubGlobal('fetch', fetchMock as any);
    const out = await renderReport(sampleDef(), 'xlsx');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/render');
    expect(url).toContain('code=secret-key');
    expect(out.fileName).toBe('Sales.xlsx');
    expect(out.mimeType).toBe(exportMimeType('xlsx'));
    expect(out.bytes.length).toBe(3);
    vi.unstubAllGlobals();
  });
});

describe('emptyRdlDefinition', () => {
  it('seeds a valid blank document', () => {
    const d = emptyRdlDefinition('ws9', 'rptX', 'My report');
    expect(d).toMatchObject({ id: 'rptX', workspaceId: 'ws9', name: 'My report', pageSize: 'Letter', pageOrientation: 'Portrait' });
    expect(d.dataSources).toEqual([]);
    expect(d.tablixes).toEqual([]);
  });
});
