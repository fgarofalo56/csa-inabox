/**
 * Contract tests for /api/governance/scans — the Data Map sources/scans BFF.
 *
 *   - 401 unauthenticated on every verb
 *   - GET (no params)          → listDataSources
 *   - GET ?source=x            → listScansForSource
 *   - GET ?source=x&scan=y&runs=1 → listScanRuns
 *   - POST { run, source, scan }   → triggerScanRun (202)
 *   - POST { name, kind, properties } → registerDataSource (201)
 *   - DELETE ?name=x           → deleteDataSource
 *   - PurviewNotConfigured     → 503 honest-gate shape { ok:false, code, hint }
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/purview-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/purview-client');
  return {
    ...actual,
    listDataSources: vi.fn(),
    registerDataSource: vi.fn(),
    deleteDataSource: vi.fn(),
    listScansForSource: vi.fn(),
    listScanRuns: vi.fn(),
    triggerScanRun: vi.fn(),
    upsertScan: vi.fn(),
  };
});

import { GET, POST, DELETE } from '../scans/route';
import { getSession } from '@/lib/auth/session';
import {
  listDataSources, registerDataSource, deleteDataSource,
  listScansForSource, listScanRuns, triggerScanRun, upsertScan,
  PurviewNotConfiguredError,
} from '@/lib/azure/purview-client';

function getReq(qs = '') {
  return { nextUrl: { searchParams: new URLSearchParams(qs) } } as any;
}
function bodyReq(body: any) {
  return { json: async () => body } as any;
}

beforeEach(() => { vi.resetAllMocks(); });

describe('GET /api/governance/scans', () => {
  it('401 unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await GET(getReq())).status).toBe(401);
  });

  it('lists data sources with no params', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (listDataSources as any).mockResolvedValue([{ id: 's1', name: 'lakehouse', kind: 'AdlsGen2' }]);
    const res = await GET(getReq());
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.sources[0].name).toBe('lakehouse');
    expect(listDataSources).toHaveBeenCalled();
  });

  it('lists scans for a source', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (listScansForSource as any).mockResolvedValue([{ id: 'sc1', name: 'weekly' }]);
    const res = await GET(getReq('source=lakehouse'));
    const j = await res.json();
    expect(j.scans[0].name).toBe('weekly');
    expect(listScansForSource).toHaveBeenCalledWith('lakehouse');
  });

  it('lists runs for a scan', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (listScanRuns as any).mockResolvedValue([{ runId: 'r1', status: 'Succeeded' }]);
    const res = await GET(getReq('source=lakehouse&scan=weekly&runs=1'));
    const j = await res.json();
    expect(j.runs[0].status).toBe('Succeeded');
    expect(listScanRuns).toHaveBeenCalledWith('lakehouse', 'weekly');
  });

  it('503 honest-gate shape when Purview not configured', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (listDataSources as any).mockRejectedValue(new PurviewNotConfiguredError({
      missingEnvVar: 'LOOM_PURVIEW_ACCOUNT', bicepModule: 'm', bicepStatus: 's', rolesRequired: [], followUp: 'f',
    }));
    const res = await GET(getReq());
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.code).toBe('purview_not_configured');
    expect(j.hint.missingEnvVar).toBe('LOOM_PURVIEW_ACCOUNT');
  });
});

describe('POST /api/governance/scans', () => {
  it('401 unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await POST(bodyReq({}))).status).toBe(401);
  });

  it('triggers a scan run (202)', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (triggerScanRun as any).mockResolvedValue({ runId: 'run-123' });
    const res = await POST(bodyReq({ run: true, source: 'lakehouse', scan: 'weekly' }));
    expect(res.status).toBe(202);
    const j = await res.json();
    expect(j.runId).toBe('run-123');
    expect(triggerScanRun).toHaveBeenCalledWith('lakehouse', 'weekly');
  });

  it('registers a data source (201)', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (registerDataSource as any).mockResolvedValue({ id: 's1', name: 'lakehouse', kind: 'AdlsGen2' });
    const res = await POST(bodyReq({ name: 'lakehouse', kind: 'AdlsGen2', properties: { endpoint: 'https://x' } }));
    expect(res.status).toBe(201);
    expect(registerDataSource).toHaveBeenCalledWith(expect.objectContaining({ name: 'lakehouse', kind: 'AdlsGen2' }));
  });

  it('400 when neither a run nor a complete source payload is given', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    const res = await POST(bodyReq({ name: 'x' }));
    expect(res.status).toBe(400);
  });

  it('defines a scan (201) via upsertScan', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (upsertScan as any).mockResolvedValue({ id: 'sc1', name: 'nightly', kind: 'AdlsGen2Msi' });
    const res = await POST(bodyReq({
      define: true, source: 'lake', scan: 'nightly', kind: 'AdlsGen2Msi',
      scanRulesetName: 'Loom_AAAA_AdlsGen2', scanRulesetType: 'Custom', collection: 'finance',
    }));
    expect(res.status).toBe(201);
    expect(upsertScan).toHaveBeenCalledWith(expect.objectContaining({
      sourceName: 'lake', scanName: 'nightly', kind: 'AdlsGen2Msi',
      scanRulesetName: 'Loom_AAAA_AdlsGen2', scanRulesetType: 'Custom', collectionRef: 'finance',
    }));
    expect(triggerScanRun).not.toHaveBeenCalled();
  });

  it('defines AND runs a scan (202) when define+run are both set', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (upsertScan as any).mockResolvedValue({ id: 'sc1', name: 'nightly' });
    (triggerScanRun as any).mockResolvedValue({ runId: 'run-9' });
    const res = await POST(bodyReq({
      define: true, run: true, source: 'lake', scan: 'nightly', kind: 'AdlsGen2Msi', scanRulesetName: 'AdlsGen2',
    }));
    expect(res.status).toBe(202);
    const j = await res.json();
    expect(j.runId).toBe('run-9');
    expect(upsertScan).toHaveBeenCalled();
    expect(triggerScanRun).toHaveBeenCalledWith('lake', 'nightly');
  });

  it('400 when define is missing kind/scanRulesetName', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    const res = await POST(bodyReq({ define: true, source: 'lake', scan: 'nightly' }));
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/governance/scans', () => {
  it('400 when name missing', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    expect((await DELETE(getReq())).status).toBe(400);
  });
  it('de-registers a source', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (deleteDataSource as any).mockResolvedValue(true);
    const res = await DELETE(getReq('name=lakehouse'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(deleteDataSource).toHaveBeenCalledWith('lakehouse');
  });
});
