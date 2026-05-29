/**
 * BFF gate tests for the three-editor uplift:
 *   - POST /api/items/semantic-model/build        (real push-dataset authoring)
 *   - GET  /api/items/eventstream/[id]/definition (pull live Fabric topology)
 *
 * Asserts auth (401), validation (400/409), and that the happy path delegates
 * to the real client helper with the right args + maps the response shape.
 * The client modules are stubbed; the network contract is covered separately
 * (powerbi-client-parity.test.ts / fabric-client-eventstream.test.ts).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/powerbi-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/powerbi-client');
  return { ...actual, createPushDataset: vi.fn(), postPushRows: vi.fn() };
});
vi.mock('@/lib/azure/kusto-client', () => ({
  loadKustoItem: vi.fn(),
  KustoError: class KustoError extends Error { status = 500; },
}));
vi.mock('@/lib/azure/fabric-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/fabric-client');
  return { ...actual, getEventstreamDefinition: vi.fn() };
});

import { POST as buildPOST } from '../semantic-model/build/route';
import { GET as defGET } from '../eventstream/[id]/definition/route';
import { getSession } from '@/lib/auth/session';
import { createPushDataset, postPushRows } from '@/lib/azure/powerbi-client';
import { loadKustoItem } from '@/lib/azure/kusto-client';
import { getEventstreamDefinition } from '@/lib/azure/fabric-client';

function bodyReq(url: string, body: any) {
  const u = new URL(url);
  return { nextUrl: u, url, json: async () => body } as any;
}
function getReq(url: string) {
  const u = new URL(url);
  return { nextUrl: u, url } as any;
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => { vi.resetAllMocks(); });

describe('POST semantic-model/build', () => {
  const validBody = {
    name: 'My model',
    tables: [{ name: 'Sales', columns: [{ name: 'Amount', dataType: 'Double' }], measures: [{ name: 'Total', expression: 'SUM(Sales[Amount])' }] }],
    relationships: [{ name: 'r1', fromTable: 'Sales', fromColumn: 'CustId', toTable: 'Customer', toColumn: 'Id' }],
  };

  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await buildPOST(bodyReq('http://x/?workspaceId=w', validBody));
    expect(res.status).toBe(401);
  });

  it('400 without workspaceId', async () => {
    (getSession as any).mockReturnValue({ claims: {} });
    const res = await buildPOST(bodyReq('http://x/', validBody));
    expect(res.status).toBe(400);
  });

  it('400 when name missing', async () => {
    (getSession as any).mockReturnValue({ claims: {} });
    const res = await buildPOST(bodyReq('http://x/?workspaceId=w', { tables: validBody.tables }));
    expect(res.status).toBe(400);
  });

  it('400 when no tables', async () => {
    (getSession as any).mockReturnValue({ claims: {} });
    const res = await buildPOST(bodyReq('http://x/?workspaceId=w', { name: 'n', tables: [] }));
    expect(res.status).toBe(400);
  });

  it('400 on invalid column dataType', async () => {
    (getSession as any).mockReturnValue({ claims: {} });
    const res = await buildPOST(bodyReq('http://x/?workspaceId=w', { name: 'n', tables: [{ name: 'T', columns: [{ name: 'c', dataType: 'NotAType' }] }] }));
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toMatch(/invalid dataType/i);
  });

  it('happy path delegates to createPushDataset with normalized shape', async () => {
    (getSession as any).mockReturnValue({ claims: {} });
    (createPushDataset as any).mockResolvedValue({ id: 'ds-new', name: 'My model' });
    const res = await buildPOST(bodyReq('http://x/?workspaceId=w', validBody));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.datasetId).toBe('ds-new');
    const [ws, payload] = (createPushDataset as any).mock.calls[0];
    expect(ws).toBe('w');
    expect(payload.name).toBe('My model');
    expect(payload.tables[0].columns[0].dataType).toBe('Double');
    expect(payload.relationships[0].crossFilteringBehavior).toBe('OneDirection');
  });

  it('pushes sample rows when provided', async () => {
    (getSession as any).mockReturnValue({ claims: {} });
    (createPushDataset as any).mockResolvedValue({ id: 'ds-new', name: 'n' });
    (postPushRows as any).mockResolvedValue({ ok: true });
    const res = await buildPOST(bodyReq('http://x/?workspaceId=w', { ...validBody, sampleRows: { Sales: [{ Amount: 1 }, { Amount: 2 }] } }));
    const j = await res.json();
    expect(j.pushedRows).toBe(2);
    expect(postPushRows).toHaveBeenCalledWith('w', 'ds-new', 'Sales', [{ Amount: 1 }, { Amount: 2 }]);
  });

  it('surfaces a Power BI 403 verbatim', async () => {
    (getSession as any).mockReturnValue({ claims: {} });
    const { PowerBiError } = await vi.importActual<any>('@/lib/azure/powerbi-client');
    (createPushDataset as any).mockRejectedValue(new PowerBiError('Forbidden', 403));
    const res = await buildPOST(bodyReq('http://x/?workspaceId=w', validBody));
    expect(res.status).toBe(403);
  });
});

describe('GET eventstream/[id]/definition', () => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await defGET(getReq('http://x/'), ctx('es-1'));
    expect(res.status).toBe(401);
  });

  it('404 when the item does not exist', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 't1' } });
    (loadKustoItem as any).mockResolvedValue(null);
    const res = await defGET(getReq('http://x/'), ctx('es-1'));
    expect(res.status).toBe(404);
  });

  it('409 when not yet published to Fabric', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 't1' } });
    (loadKustoItem as any).mockResolvedValue({ id: 'es-1', state: {} });
    const res = await defGET(getReq('http://x/'), ctx('es-1'));
    expect(res.status).toBe(409);
  });

  it('decodes the Base64 eventstream.json and projects it to Loom config', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 't1' } });
    (loadKustoItem as any).mockResolvedValue({ id: 'es-1', state: { fabricWorkspaceId: 'fw', fabricEventstreamId: 'fes' } });
    const topology = {
      sources: [{ name: 'src1', type: 'AzureEventHub', properties: { namespace: 'ns1' } }],
      destinations: [{ name: 'dst1', type: 'Eventhouse', properties: { database: 'db1', table: 't1' } }],
      operators: [{ name: 'op1', type: 'Filter', properties: { expression: 'x == 1' } }],
      streams: [],
    };
    const payload = Buffer.from(JSON.stringify(topology), 'utf-8').toString('base64');
    (getEventstreamDefinition as any).mockResolvedValue({ parts: [{ path: 'eventstream.json', payload, payloadType: 'InlineBase64' }] });

    const res = await defGET(getReq('http://x/'), ctx('es-1'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.config.source.kind).toBe('eventhub');
    expect(j.config.source.namespace).toBe('ns1');
    expect(j.config.sink.kind).toBe('kusto');
    expect(j.config.sink.table).toBe('t1');
    expect(j.config.transforms[0].kind).toBe('filter');
    expect(getEventstreamDefinition).toHaveBeenCalledWith('fw', 'fes');
  });
});
