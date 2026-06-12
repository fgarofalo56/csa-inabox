/**
 * BFF contract tests for /api/adf/cdc — the Change Data Capture (preview)
 * navigator + editor backend. Per .claude/rules/no-vaporware.md these exercise
 * the real route handlers with a mocked adf-client (real ARM is replaced, the
 * mapping + dispatch logic is real). They pin:
 *   - 401 when unauthenticated
 *   - 503 honest gate when the factory env vars are unset
 *   - GET list → compact {name, status, mode, sourceCount, targetCount} rows
 *   - GET ?name=X → full detail (sources/targets mapping)
 *   - GET ?name=X&status=1 → live status poll string
 *   - POST {action} dispatch to start/stop/delete
 *   - POST {spec} upsert path
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'o', upn: 'a@b.com' }, exp: Date.now() / 1000 + 3600 }) as any);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

let gateValue: { missing: string } | null = null;
const listAdfCdcs = vi.fn((..._a: any[]) => Promise.resolve([] as any[]));
const getAdfCdc = vi.fn((..._a: any[]) => Promise.resolve({} as any));
const upsertAdfCdc = vi.fn((..._a: any[]) => Promise.resolve({} as any));
const startAdfCdc = vi.fn(async (..._a: any[]) => {});
const stopAdfCdc = vi.fn(async (..._a: any[]) => {});
const deleteAdfCdc = vi.fn(async (..._a: any[]) => {});
const statusAdfCdc = vi.fn((..._a: any[]) => Promise.resolve('' as string));
const previewAdfCdcTarget = vi.fn((..._a: any[]) => Promise.resolve({} as any));

vi.mock('@/lib/azure/adf-client', () => ({
  adfCdcConfigGate: () => gateValue,
  listAdfCdcs: (...a: any[]) => listAdfCdcs(...a),
  getAdfCdc: (...a: any[]) => getAdfCdc(...a),
  upsertAdfCdc: (...a: any[]) => upsertAdfCdc(...a),
  startAdfCdc: (...a: any[]) => startAdfCdc(...a),
  stopAdfCdc: (...a: any[]) => stopAdfCdc(...a),
  deleteAdfCdc: (...a: any[]) => deleteAdfCdc(...a),
  statusAdfCdc: (...a: any[]) => statusAdfCdc(...a),
  previewAdfCdcTarget: (...a: any[]) => previewAdfCdcTarget(...a),
}));

import { GET, POST } from '../route';

const cdcResource = (name: string, status: string) => ({
  name,
  properties: {
    status,
    description: 'mirror prod',
    policy: { mode: 'Continuous' },
    folder: { name: 'Mirrors' },
    sourceConnectionsInfo: [{
      connection: { linkedService: { referenceName: 'ls-src' }, linkedServiceType: 'AzureSqlDatabase', type: 'linkedservicetype' },
      sourceEntities: [{ name: 'dbo.orders' }, { name: 'sales.customers' }],
    }],
    targetConnectionsInfo: [{
      connection: { linkedService: { referenceName: 'ls-adls' }, linkedServiceType: 'AzureBlobFS', type: 'linkedservicetype' },
      targetEntities: [{ name: 'dbo.orders' }],
    }],
  },
});

function req(url: string, init?: RequestInit) {
  return new NextRequest(new Request(`http://localhost${url}`, init));
}

describe('/api/adf/cdc', () => {
  beforeEach(() => {
    gateValue = null;
    [listAdfCdcs, getAdfCdc, upsertAdfCdc, startAdfCdc, stopAdfCdc, deleteAdfCdc, statusAdfCdc, previewAdfCdcTarget].forEach((m) => m.mockReset?.());
    getSessionMock.mockReturnValue({ claims: { oid: 'o' }, exp: Date.now() / 1000 + 3600 });
  });
  afterEach(() => vi.clearAllMocks());

  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null as any);
    const res = await GET(req('/api/adf/cdc'));
    expect(res.status).toBe(401);
  });

  it('503 honest gate when factory env vars are unset', async () => {
    gateValue = { missing: 'LOOM_ADF_NAME' };
    const res = await GET(req('/api/adf/cdc'));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe('not_configured');
    expect(body.missing).toBe('LOOM_ADF_NAME');
  });

  it('GET list returns compact rows with source/target counts', async () => {
    listAdfCdcs.mockResolvedValue([cdcResource('cdc1', 'Running'), cdcResource('cdc2', 'Stopped')]);
    const res = await GET(req('/api/adf/cdc'));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.cdcs).toHaveLength(2);
    expect(body.cdcs[0]).toMatchObject({ name: 'cdc1', status: 'Running', mode: 'Continuous', sourceCount: 2, targetCount: 1 });
  });

  it('GET ?name=X returns full detail mapping', async () => {
    getAdfCdc.mockResolvedValue(cdcResource('cdc1', 'Running'));
    const res = await GET(req('/api/adf/cdc?name=cdc1'));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.cdc.name).toBe('cdc1');
    expect(body.cdc.sources[0]).toMatchObject({ linkedService: 'ls-src', connectorType: 'AzureSqlDatabase' });
    expect(body.cdc.sources[0].entities).toEqual(['dbo.orders', 'sales.customers']);
    expect(body.cdc.targets[0]).toMatchObject({ linkedService: 'ls-adls', connectorType: 'AzureBlobFS' });
    expect(getAdfCdc).toHaveBeenCalledWith('cdc1');
  });

  it('GET ?name=X&status=1 polls live status only', async () => {
    statusAdfCdc.mockResolvedValue('Stopping');
    const res = await GET(req('/api/adf/cdc?name=cdc1&status=1'));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe('Stopping');
    expect(statusAdfCdc).toHaveBeenCalledWith('cdc1');
    expect(getAdfCdc).not.toHaveBeenCalled();
  });

  it('GET ?name=X&preview=1 returns landed change-data rows only', async () => {
    previewAdfCdcTarget.mockResolvedValue({
      entity: { name: 'dbo.orders', container: 'bronze', folderPath: 'mirrors/w/m/dbo.orders' },
      entities: [{ name: 'dbo.orders', container: 'bronze', folderPath: 'mirrors/w/m/dbo.orders' }],
      columns: ['id', 'amount'],
      rows: [[1, 9.5], [2, 3.0]],
      rowCount: 2,
      truncated: false,
      deltaUrl: 'https://acct.dfs.core.windows.net/bronze/mirrors/w/m/dbo.orders',
    });
    const res = await GET(req('/api/adf/cdc?name=cdc1&preview=1&rows=100'));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.preview.columns).toEqual(['id', 'amount']);
    expect(body.preview.rows).toHaveLength(2);
    expect(body.preview.entity.name).toBe('dbo.orders');
    expect(previewAdfCdcTarget).toHaveBeenCalledWith('cdc1', undefined, 100);
    // Preview must NOT fall through to the detail / status paths.
    expect(getAdfCdc).not.toHaveBeenCalled();
    expect(statusAdfCdc).not.toHaveBeenCalled();
  });

  it('GET preview passes through the entity selector and clamps rows', async () => {
    previewAdfCdcTarget.mockResolvedValue({
      entity: { name: 'sales.customers', container: 'bronze', folderPath: 'p' },
      entities: [], columns: [], rows: [], rowCount: 0, truncated: false, deltaUrl: 'u',
    });
    await GET(req('/api/adf/cdc?name=cdc1&preview=1&entity=sales.customers'));
    // entity forwarded; rows defaults to 100 when omitted.
    expect(previewAdfCdcTarget).toHaveBeenCalledWith('cdc1', 'sales.customers', 100);
  });

  it('GET preview surfaces a 502 when the Delta target read fails', async () => {
    previewAdfCdcTarget.mockRejectedValue(new Error('Missing env var: LOOM_SYNAPSE_WORKSPACE'));
    const res = await GET(req('/api/adf/cdc?name=cdc1&preview=1'));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('LOOM_SYNAPSE_WORKSPACE');
  });

  it('POST action:start dispatches startAdfCdc', async () => {
    const res = await POST(req('/api/adf/cdc', { method: 'POST', body: JSON.stringify({ name: 'cdc1', action: 'start' }) }));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(startAdfCdc).toHaveBeenCalledWith('cdc1');
  });

  it('POST action:stop dispatches stopAdfCdc', async () => {
    const res = await POST(req('/api/adf/cdc', { method: 'POST', body: JSON.stringify({ name: 'cdc1', action: 'stop' }) }));
    await res.json();
    expect(stopAdfCdc).toHaveBeenCalledWith('cdc1');
  });

  it('POST action:delete dispatches deleteAdfCdc', async () => {
    const res = await POST(req('/api/adf/cdc', { method: 'POST', body: JSON.stringify({ name: 'cdc1', action: 'delete' }) }));
    await res.json();
    expect(deleteAdfCdc).toHaveBeenCalledWith('cdc1');
  });

  it('POST spec upserts the CDC resource', async () => {
    upsertAdfCdc.mockResolvedValue(cdcResource('cdc-new', 'Stopped'));
    const spec = { policy: { mode: 'Continuous' }, sourceConnectionsInfo: [], targetConnectionsInfo: [] };
    const res = await POST(req('/api/adf/cdc', { method: 'POST', body: JSON.stringify({ name: 'cdc-new', spec }) }));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(upsertAdfCdc).toHaveBeenCalledWith('cdc-new', spec);
    expect(body.cdc.name).toBe('cdc-new');
  });

  it('POST without action or spec is a 400', async () => {
    const res = await POST(req('/api/adf/cdc', { method: 'POST', body: JSON.stringify({ name: 'cdc1' }) }));
    expect(res.status).toBe(400);
  });
});
