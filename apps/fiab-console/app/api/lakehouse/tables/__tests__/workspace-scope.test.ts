/**
 * Regression: /api/lakehouse/tables is scoped to ONE lakehouse's own ADLS root.
 *
 * The bug: the route scanned every medallion container's top-level `Tables/`,
 * ignoring which lakehouse the caller opened — so a lakehouse in one workspace
 * surfaced another lakehouse's (and another workspace's) tables. The fix
 * authorizes the caller against the specific lakehouse item and scans ONLY that
 * lakehouse's resolved `<root>/Tables/` (via a rootPrefix).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));

const resolveItemAccessByOid = vi.fn();
vi.mock('@/lib/auth/item-access', () => ({
  resolveItemAccessByOid: (...a: any[]) => resolveItemAccessByOid(...a),
}));

const resolveLakehouseAbfss = vi.fn();
vi.mock('@/lib/azure/lakehouse-abfss', () => ({
  resolveLakehouseAbfss: (...a: any[]) => resolveLakehouseAbfss(...a),
}));

const scanLakehouseTables = vi.fn();
vi.mock('@/lib/azure/synapse-catalog-client', () => ({
  scanLakehouseTables: (...a: any[]) => scanLakehouseTables(...a),
}));

import { GET } from '../route';
import { getSession } from '@/lib/auth/session';

const sess = { claims: { oid: 'user-1', tid: 'tenant-1', groups: [] } };
function req(qs: string) {
  return { nextUrl: new URL(`http://x/api/lakehouse/tables?${qs}`) } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  (getSession as any).mockReturnValue(sess);
});

describe('GET /api/lakehouse/tables — per-lakehouse scoping', () => {
  it('401 without a session', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await GET(req('lakehouseId=lh-x&workspaceId=ws-A'))).status).toBe(401);
  });

  it('400 without lakehouseId + workspaceId', async () => {
    expect((await GET(req('workspaceId=ws-A'))).status).toBe(400);
    expect((await GET(req('lakehouseId=lh-x'))).status).toBe(400);
  });

  it('404 when the caller cannot access the lakehouse', async () => {
    resolveItemAccessByOid.mockResolvedValue(null);
    expect((await GET(req('lakehouseId=lh-x&workspaceId=ws-A'))).status).toBe(404);
    expect(scanLakehouseTables).not.toHaveBeenCalled();
  });

  it('scans ONLY the lakehouse’s own resolved root (container + rootPrefix)', async () => {
    resolveItemAccessByOid.mockResolvedValue({ item: { id: 'lh-x', workspaceId: 'ws-A' } });
    resolveLakehouseAbfss.mockResolvedValue({ abfss: 'abfss://gold@acct.dfs.core.windows.net/lakehouses/lh-x', container: 'gold', root: 'lakehouses/lh-x' });
    scanLakehouseTables.mockResolvedValue([{ schema: 'gold', name: 'orders', adlsPath: 'gold/lakehouses/lh-x/Tables/orders' }]);

    const res = await GET(req('lakehouseId=lh-x&workspaceId=ws-A'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    // Root of the caller's OWN lakehouse resolved from its authoritative workspaceId.
    expect(resolveLakehouseAbfss).toHaveBeenCalledWith('lh-x', 'ws-A');
    // Scan is bounded to that single container + the lakehouse's rootPrefix.
    expect(scanLakehouseTables).toHaveBeenCalledWith({
      containers: ['gold'],
      rootPrefix: 'lakehouses/lh-x',
      rowCounts: false,
    });
    expect(j.tables).toHaveLength(1);
    expect(j.tables[0].name).toBe('orders');
  });

  it('a different lakehouse resolves to a DIFFERENT root — no cross-lakehouse bleed', async () => {
    resolveItemAccessByOid.mockResolvedValue({ item: { id: 'lh-y', workspaceId: 'ws-B' } });
    resolveLakehouseAbfss.mockResolvedValue({ abfss: 'abfss://silver@acct.dfs.core.windows.net/lakehouses/lh-y', container: 'silver', root: 'lakehouses/lh-y' });
    scanLakehouseTables.mockResolvedValue([]);
    await GET(req('lakehouseId=lh-y&workspaceId=ws-B'));
    expect(scanLakehouseTables).toHaveBeenCalledWith({
      containers: ['silver'],
      rootPrefix: 'lakehouses/lh-y',
      rowCounts: false,
    });
  });

  it('honest gate (no scan) when the lakehouse resolves to no configured storage', async () => {
    resolveItemAccessByOid.mockResolvedValue({ item: { id: 'lh-x', workspaceId: 'ws-A' } });
    resolveLakehouseAbfss.mockResolvedValue(null);
    const j = await (await GET(req('lakehouseId=lh-x&workspaceId=ws-A'))).json();
    expect(j.ok).toBe(true);
    expect(j.tables).toEqual([]);
    expect(j.gate).toContain('No lakehouse storage configured');
    expect(scanLakehouseTables).not.toHaveBeenCalled();
  });
});
