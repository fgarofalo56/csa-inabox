/**
 * Contract tests for GET /api/onelake/storage (OneLake item-size reporting).
 *
 *   1. unauthenticated                  → 401
 *   2. ADLS not configured              → 503 + adls_not_configured gate naming
 *                                         LOOM_BRONZE_URL (no fabricated numbers)
 *   3. happy path                       → per-item PrefixUsage from the ADLS walk,
 *                                         tenant-filtered, with rolled-up totals
 *                                         and largest-first ordering
 *   4. unresolved prefix                → item with no ADLS backing reports a
 *                                         null usage + honest reason (no crash)
 *   5. forbidden walk (403)             → per-item reason naming the RBAC role,
 *                                         the rest of the report still succeeds
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  workspacesContainer: vi.fn(),
  itemsContainer: vi.fn(),
}));
vi.mock('@/lib/azure/adls-client', () => ({
  getAccountName: vi.fn(),
  aggregatePrefixUsage: vi.fn(),
  KNOWN_CONTAINERS: ['bronze', 'silver', 'gold', 'landing', 'csv-imports'],
}));

import { GET } from '../storage/route';
import { getSession } from '@/lib/auth/session';
import { workspacesContainer, itemsContainer } from '@/lib/azure/cosmos-client';
import { getAccountName, aggregatePrefixUsage } from '@/lib/azure/adls-client';

const SESSION = { claims: { oid: 'tenant-1', upn: 'alice@contoso.com', name: 'Alice' } };

function queryReturning(resources: any[]) {
  return { query: () => ({ fetchAll: vi.fn().mockResolvedValue({ resources }) }) };
}

// A lakehouse (resolvable via secondaryIds), a warehouse (resolvable via
// resourceId), and a kql-database (no ADLS backing → null usage).
const ITEMS = [
  {
    id: 'lh-1',
    workspaceId: 'ws-1',
    itemType: 'lakehouse',
    displayName: 'Gold LH',
    state: { provisioning: { secondaryIds: { container: 'gold', rootPath: 'lakehouses/gold-lh' } } },
  },
  {
    id: 'wh-1',
    workspaceId: 'ws-1',
    itemType: 'warehouse',
    displayName: 'Sales WH',
    state: { provisioning: { resourceId: 'silver/warehouses/sales-wh' } },
  },
  {
    id: 'kql-1',
    workspaceId: 'ws-1',
    itemType: 'kql-database',
    displayName: 'Telemetry KQL',
    state: {}, // ADX-backed — no DLZ ADLS prefix
  },
  // a different tenant's item — must be filtered out
  {
    id: 'lh-other',
    workspaceId: 'ws-other',
    itemType: 'lakehouse',
    displayName: 'Foreign LH',
    state: { provisioning: { secondaryIds: { container: 'bronze', rootPath: 'lakehouses/foreign' } } },
  },
];

function usage(over: Partial<any> = {}) {
  return {
    liveBytes: 0, liveFiles: 0, systemBytes: 0,
    deletedBytes: 0, deletedFiles: 0, totalBytes: 0, capped: false,
    ...over,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue(SESSION);
  (getAccountName as any).mockReturnValue('dlzacct');
  (itemsContainer as any).mockResolvedValue({ items: queryReturning(ITEMS) });
  // Workspace ownership: ws-1 belongs to tenant-1; ws-other does not.
  (workspacesContainer as any).mockResolvedValue({
    item: (id: string) => ({
      read: vi.fn().mockResolvedValue({
        resource: id === 'ws-1' ? { id: 'ws-1', tenantId: 'tenant-1' } : { id, tenantId: 'tenant-2' },
      }),
    }),
  });
});

function makeReq(qs = '') {
  return { nextUrl: { searchParams: new URLSearchParams(qs) } } as any;
}

describe('GET /api/onelake/storage', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
  });

  it('503 + honest gate when the DLZ storage account is not configured', async () => {
    (getAccountName as any).mockImplementation(() => { throw new Error('no url'); });
    const res = await GET(makeReq());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe('adls_not_configured');
    expect(body.hint.missingEnvVar).toBe('LOOM_BRONZE_URL');
  });

  it('walks each owned item, rolls up totals, orders largest-first', async () => {
    (aggregatePrefixUsage as any).mockImplementation(async (container: string) => {
      if (container === 'gold') return usage({ liveBytes: 1000, systemBytes: 200, liveFiles: 5, deletedBytes: 50, deletedFiles: 1, totalBytes: 1050 });
      if (container === 'silver') return usage({ liveBytes: 300, systemBytes: 100, liveFiles: 2, totalBytes: 300 });
      throw new Error('unexpected container ' + container);
    });

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.account).toBe('dlzacct');

    // Only tenant-1 items (lh-1, wh-1, kql-1) — foreign LH filtered out.
    const ids = body.items.map((i: any) => i.id);
    expect(ids).toContain('lh-1');
    expect(ids).toContain('wh-1');
    expect(ids).toContain('kql-1');
    expect(ids).not.toContain('lh-other');

    // Largest-first: lh-1 (1050) before wh-1 (300); kql-1 (null usage) last.
    expect(ids[0]).toBe('lh-1');
    expect(ids[1]).toBe('wh-1');
    expect(ids[ids.length - 1]).toBe('kql-1');

    // wh-1 resolved via resourceId "silver/warehouses/sales-wh".
    const wh = body.items.find((i: any) => i.id === 'wh-1');
    expect(wh.location).toBe('silver/warehouses/sales-wh');

    // Totals roll up the two reporting items.
    expect(body.totals.reportedItems).toBe(2);
    expect(body.totals.liveBytes).toBe(1300);
    expect(body.totals.systemBytes).toBe(300);
    expect(body.totals.deletedBytes).toBe(50);
    expect(body.totals.totalBytes).toBe(1350);
  });

  it('reports a null usage + honest reason for an item with no ADLS backing', async () => {
    (aggregatePrefixUsage as any).mockResolvedValue(usage());
    const res = await GET(makeReq());
    const body = await res.json();
    const kql = body.items.find((i: any) => i.id === 'kql-1');
    expect(kql.location).toBeNull();
    expect(kql.usage).toBeNull();
    expect(kql.reason).toMatch(/No Azure-native ADLS/i);
  });

  it('surfaces a per-item RBAC reason on a 403 walk without failing the report', async () => {
    (aggregatePrefixUsage as any).mockImplementation(async (container: string) => {
      if (container === 'gold') { const e: any = new Error('forbidden'); e.statusCode = 403; throw e; }
      return usage({ liveBytes: 300, totalBytes: 300 });
    });
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    const lh = body.items.find((i: any) => i.id === 'lh-1');
    expect(lh.usage).toBeNull();
    expect(lh.reason).toMatch(/Storage Blob Data Reader/i);
    // The warehouse still reported successfully.
    const wh = body.items.find((i: any) => i.id === 'wh-1');
    expect(wh.usage.totalBytes).toBe(300);
  });

  it('honours the workspaceId filter', async () => {
    (aggregatePrefixUsage as any).mockResolvedValue(usage({ totalBytes: 10 }));
    const res = await GET(makeReq('workspaceId=ws-1'));
    const body = await res.json();
    // All in-scope items are ws-1; ws-other already excluded — sanity check it stays 200.
    expect(res.status).toBe(200);
    expect(body.items.every((i: any) => i.workspaceId === 'ws-1')).toBe(true);
  });
});
