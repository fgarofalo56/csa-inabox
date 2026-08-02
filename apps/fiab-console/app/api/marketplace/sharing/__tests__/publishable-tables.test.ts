/**
 * GET /api/marketplace/sharing/publishable-tables — the enumeration that
 * replaced the hand-typed `abfss://` field in the "Add a table to <share>"
 * dialog (issue #2618 / LU-9).
 *
 * The load-bearing property is that the location this route emits is one the
 * share record will actually accept AND that the scanner actually probed: the
 * old free-text field let an operator publish a share entry pointing at a path
 * that had never been verified to hold a `_delta_log`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isValidShareLocation } from '@/lib/sharing/model';

const ADMIN_SESSION = {
  claims: { oid: 'admin-oid', upn: 'admin@contoso.gov', tid: 'tenant-1' },
};

// Toolkit is mocked so these tests exercise the handler, not the auth plumbing
// (the auth CHOICE is asserted separately, below, by reading the source).
vi.mock('@/lib/api/route-toolkit', () => ({
  withTenantAdmin: (h: any) => (req: any) => h(req, { session: ADMIN_SESSION, params: {} }),
}));

const resolveLakehouseAbfssMock = vi.fn();
const scanLakehouseTablesMock = vi.fn();

vi.mock('@/lib/azure/lakehouse-abfss', () => ({
  resolveLakehouseAbfss: (...a: unknown[]) => resolveLakehouseAbfssMock(...a),
}));
vi.mock('@/lib/azure/synapse-catalog-client', () => ({
  scanLakehouseTables: (...a: unknown[]) => scanLakehouseTablesMock(...a),
}));

const LAKEHOUSE_ABFSS = 'abfss://gold@stloomdemo.dfs.core.usgovcloudapi.net/lakehouses/sales';

function table(over: Record<string, unknown> = {}) {
  return {
    schema: 'gold',
    name: 'revenue',
    adlsPath: 'gold/lakehouses/sales/Tables/revenue',
    bulkUrl: 'https://x',
    format: 'delta',
    status: 'ok',
    latestVersion: 7,
    rowCount: null,
    sizeBytes: 4096,
    lastModified: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

function req(qs: string) {
  return { nextUrl: new URL(`https://loom.test/api/marketplace/sharing/publishable-tables${qs}`) } as any;
}

beforeEach(() => {
  resolveLakehouseAbfssMock.mockReset();
  scanLakehouseTablesMock.mockReset();
  resolveLakehouseAbfssMock.mockResolvedValue({
    abfss: LAKEHOUSE_ABFSS, container: 'gold', root: 'lakehouses/sales',
  });
  scanLakehouseTablesMock.mockResolvedValue([table()]);
});
afterEach(() => { vi.clearAllMocks(); });

describe('tableLocationFrom', () => {
  it('splices the scanner path onto the lakehouse abfss authority', async () => {
    const { tableLocationFrom } = await import('../publishable-tables/route');
    expect(tableLocationFrom(LAKEHOUSE_ABFSS, 'gold/lakehouses/sales/Tables/revenue'))
      .toBe('abfss://gold@stloomdemo.dfs.core.usgovcloudapi.net/lakehouses/sales/Tables/revenue');
  });

  it('emits a location the share record accepts (isValidShareLocation)', async () => {
    const { tableLocationFrom } = await import('../publishable-tables/route');
    const loc = tableLocationFrom(LAKEHOUSE_ABFSS, 'gold/lakehouses/sales/Tables/revenue');
    // The whole point of picking rather than typing: the emitted value must
    // pass the SAME server-side validator the PATCH runs, every time.
    expect(loc).not.toBeNull();
    expect(isValidShareLocation(loc!)).toBe(true);
  });

  it('preserves the sovereign-cloud DFS host rather than assuming core.windows.net', async () => {
    const { tableLocationFrom } = await import('../publishable-tables/route');
    expect(tableLocationFrom(LAKEHOUSE_ABFSS, 'gold/lakehouses/sales/Tables/revenue'))
      .toContain('.dfs.core.usgovcloudapi.net');
  });

  it('refuses a scanner path from a different container instead of mis-rooting it', async () => {
    const { tableLocationFrom } = await import('../publishable-tables/route');
    // 'bronze/...' under a gold-rooted lakehouse would silently publish the
    // WRONG container if the prefix were merely stripped by index.
    expect(tableLocationFrom(LAKEHOUSE_ABFSS, 'bronze/lakehouses/sales/Tables/revenue')).toBeNull();
  });

  it('refuses a malformed lakehouse root and an empty relative path', async () => {
    const { tableLocationFrom } = await import('../publishable-tables/route');
    expect(tableLocationFrom('https://not-abfss/x', 'gold/Tables/t')).toBeNull();
    expect(tableLocationFrom(LAKEHOUSE_ABFSS, 'gold/')).toBeNull();
  });
});

describe('GET /api/marketplace/sharing/publishable-tables', () => {
  it('returns real Delta tables with a full abfss location', async () => {
    const { GET } = await import('../publishable-tables/route');
    const res: Response = await GET(req('?lakehouseId=lh-1&workspaceId=ws-1'), undefined as any);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.tables).toEqual([{
      name: 'revenue',
      location: 'abfss://gold@stloomdemo.dfs.core.usgovcloudapi.net/lakehouses/sales/Tables/revenue',
      latestVersion: 7,
      sizeBytes: 4096,
      lastModified: '2026-08-01T00:00:00.000Z',
    }]);
  });

  it('scans only the lakehouse own root, not the whole container', async () => {
    const { GET } = await import('../publishable-tables/route');
    await GET(req('?lakehouseId=lh-1&workspaceId=ws-1'), undefined as any);
    expect(scanLakehouseTablesMock).toHaveBeenCalledWith({ containers: ['gold'], rootPrefix: 'lakehouses/sales' });
  });

  it('drops non-Delta directories — only Delta roots are publishable', async () => {
    scanLakehouseTablesMock.mockResolvedValue([
      table(),
      table({ name: 'raw_csv', adlsPath: 'gold/lakehouses/sales/Tables/raw_csv', format: 'parquet' }),
    ]);
    const { GET } = await import('../publishable-tables/route');
    const body = await (await GET(req('?lakehouseId=lh-1&workspaceId=ws-1'), undefined as any)).json();
    expect(body.tables.map((t: { name: string }) => t.name)).toEqual(['revenue']);
  });

  it('returns an honest gate naming the env vars when no storage resolves', async () => {
    resolveLakehouseAbfssMock.mockResolvedValue(null);
    const { GET } = await import('../publishable-tables/route');
    const body = await (await GET(req('?lakehouseId=lh-1&workspaceId=ws-1'), undefined as any)).json();
    expect(body.ok).toBe(false);
    // no-vaporware: a gate names the exact remediation and never fakes a list.
    expect(body.error).toContain('LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL');
    expect(body.tables).toBeUndefined();
  });

  it('400s without both ids rather than scanning something arbitrary', async () => {
    const { GET } = await import('../publishable-tables/route');
    expect((await GET(req('?lakehouseId=lh-1'), undefined as any)).status).toBe(400);
    expect((await GET(req('?workspaceId=ws-1'), undefined as any)).status).toBe(400);
  });
});

describe('authorization', () => {
  it('is tenant-admin gated — it returns abfss roots the read path hides from non-admins', async () => {
    // Asserted against the SOURCE because the toolkit is mocked above: the
    // choice of wrapper is the control under test, and `_loom-backend.ts`
    // elides `location` for non-admin readers. A withSession picker here would
    // hand back through enumeration exactly what the list route withholds.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'publishable-tables', 'route.ts'), 'utf8',
    );
    expect(src).toMatch(/export const GET = withTenantAdmin\(/);
    expect(src).not.toMatch(/export const GET = withSession\(/);
  });
});
