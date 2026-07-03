/**
 * BFF tests for POST /api/items/semantic-model/[id]/model — the XMLA
 * aggregation-write route behind the Semantic Model "Automatic aggregations"
 * surface.
 *
 * Asserts auth (401), validation (400), the honest XMLA infra-gate (200 +
 * xmlaUnavailable), and the happy path: resolves the model name as the XMLA
 * catalog, builds + applies the TMSL via executeTmsl, and runs the optional
 * probe query. The client modules are stubbed (the TMSL shaping + XMLA SOAP
 * contract is covered in aas-client.test.ts).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Fully mock the client modules (no importActual) so the real
// @azure/identity runtime is never loaded — it isn't needed to exercise the
// route's orchestration + validation, and pulling it in is unnecessary here.
vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
// #1602 gates the model route with assertOwner(workspaceId, oid), which hits
// Cosmos (workspacesContainer). These are aggregation validation / XMLA logic
// tests, not ownership tests — treat the caller as the owner so the guard is a
// no-op (the 401 spec still short-circuits on a null session before this runs).
vi.mock('@/lib/auth/workspace-guard', () => ({ assertOwner: vi.fn(async () => true) }));
vi.mock('@/lib/azure/powerbi-client', () => ({
  getDataset: vi.fn(),
  executeDatasetQueries: vi.fn(),
  PowerBiError: class PowerBiError extends Error { status = 502; },
}));
vi.mock('@/lib/azure/aas-client', () => ({
  xmlaConfigGate: vi.fn(),
  // Minimal real-ish TMSL builder so the route still emits a string carrying
  // the agg table name (the SOAP shaping itself is covered in aas-client.test.ts).
  buildAggTableTmsl: (p: any) => JSON.stringify({ createOrReplace: { table: { name: p.aggTableName } } }),
  executeTmsl: vi.fn(),
  // The aggregation write goes through executeAggTmsl(catalog, tmsl) — the
  // XMLA-endpoint-targeted variant — not the (server, db, tmsl) executeTmsl.
  executeAggTmsl: vi.fn(),
  AasError: class AasError extends Error { status = 502; },
}));

import { POST as modelPOST } from '../semantic-model/[id]/model/route';
import { getSession } from '@/lib/auth/session';
import { assertOwner } from '@/lib/auth/workspace-guard';
import { getDataset, executeDatasetQueries } from '@/lib/azure/powerbi-client';
import { xmlaConfigGate, executeTmsl, executeAggTmsl } from '@/lib/azure/aas-client';

function bodyReq(url: string, body: any) {
  const u = new URL(url);
  return { nextUrl: u, url, json: async () => body } as any;
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const validBody = {
  aggTableName: 'SalesAgg',
  partitionExpression: 'let Source = Sql.Database("s","db") in Source',
  altMaps: [
    { aggColumn: 'CustomerKey', dataType: 'int64', summarization: 'GroupBy', detailTable: 'FactSales', detailColumn: 'CustomerKey' },
    { aggColumn: 'SalesAmount', dataType: 'double', summarization: 'Sum', detailTable: 'FactSales', detailColumn: 'SalesAmount' },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  // resetAllMocks wipes the vi.fn impls (incl. assertOwner), so re-arm the
  // ownership guard to authorize — these are aggregation logic tests.
  (assertOwner as any).mockResolvedValue(true);
  (xmlaConfigGate as any).mockReturnValue(null);
});

describe('POST semantic-model/[id]/model (aggregations)', () => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await modelPOST(bodyReq('http://x/?workspaceId=w', validBody), ctx('d1'));
    expect(res.status).toBe(401);
  });

  it('400 without workspaceId', async () => {
    (getSession as any).mockReturnValue({ claims: {} });
    const res = await modelPOST(bodyReq('http://x/', validBody), ctx('d1'));
    expect(res.status).toBe(400);
  });

  it('400 when altMaps empty', async () => {
    (getSession as any).mockReturnValue({ claims: {} });
    const res = await modelPOST(bodyReq('http://x/?workspaceId=w', { ...validBody, altMaps: [] }), ctx('d1'));
    expect(res.status).toBe(400);
  });

  it('400 when a non-Count mapping omits its detail column', async () => {
    (getSession as any).mockReturnValue({ claims: {} });
    const bad = { ...validBody, altMaps: [{ aggColumn: 'x', dataType: 'double', summarization: 'Sum', detailTable: 'FactSales' }] };
    const res = await modelPOST(bodyReq('http://x/?workspaceId=w', bad), ctx('d1'));
    expect(res.status).toBe(400);
  });

  it('200 + xmlaUnavailable when no XMLA endpoint is configured (honest gate)', async () => {
    (getSession as any).mockReturnValue({ claims: {} });
    (xmlaConfigGate as any).mockReturnValue({ missing: 'LOOM_POWERBI_XMLA_ENDPOINT', detail: 'set it' });
    const res = await modelPOST(bodyReq('http://x/?workspaceId=w', validBody), ctx('d1'));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.xmlaUnavailable).toBe(true);
    expect(j.missing).toBe('LOOM_POWERBI_XMLA_ENDPOINT');
    expect(executeAggTmsl).not.toHaveBeenCalled();
  });

  it('resolves the catalog, applies TMSL, and runs the probe on the happy path', async () => {
    (getSession as any).mockReturnValue({ claims: {} });
    (getDataset as any).mockResolvedValue({ id: 'd1', name: 'SalesModel' });
    (executeAggTmsl as any).mockResolvedValue({ ok: true });
    (executeDatasetQueries as any).mockResolvedValue({ results: [{ tables: [{ rows: [{ Total: 42 }] }] }] });

    const res = await modelPOST(
      bodyReq('http://x/?workspaceId=w', { ...validBody, probeQuery: 'EVALUATE ROW("Total",[TotalSales])' }),
      ctx('d1'),
    );
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.catalog).toBe('SalesModel');
    expect(j.columns).toBe(2);
    expect(j.probeResult.rows[0].Total).toBe(42);
    // executeAggTmsl called with the catalog + a TMSL string carrying the table.
    expect((executeAggTmsl as any).mock.calls[0][0]).toBe('SalesModel');
    expect(String((executeAggTmsl as any).mock.calls[0][1])).toContain('SalesAgg');
  });
});
