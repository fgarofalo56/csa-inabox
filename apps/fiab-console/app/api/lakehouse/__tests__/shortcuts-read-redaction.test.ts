/**
 * Both shortcut list endpoints return `statusDetail` redacted, including for a
 * row written before `statusDetail` was redacted on write.
 *
 * The REAL routes and the REAL registry module (lib/azure/lakehouse-shortcuts)
 * run over an in-memory Cosmos stand-in that holds a row exactly as the
 * previous code stored it: a probe error naming a SAS URL with its signature.
 *
 * WHAT BREAKS IT: `listShortcuts` returning rows as stored — the sentinel in
 * the `sig=` query parameter then reaches both response bodies. Each absence
 * check is paired with a check that the rest of the detail (host, path, reason)
 * and the row itself are still returned.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const SENTINEL = 'Vb3Nq7Xc1Zk5Rm9Tf2Hw8Jd4';
const DETAIL = `ADLS endpoint unreachable: https://partner.dfs.core.windows.net/exports?restype=container&sv=2024-01-01&sig=${SENTINEL} timed out`;

const rows: Record<string, any>[] = [];
const fakeContainer = {
  items: {
    query: (spec: { query: string; parameters: { name: string; value: string }[] }) => ({
      fetchAll: async () => {
        expect(spec.query).toContain('WHERE c.lakehouseId = @lh');
        const lh = spec.parameters.find((p) => p.name === '@lh')!.value;
        return { resources: rows.filter((r) => r.lakehouseId === lh).map((r) => structuredClone(r)) };
      },
    }),
  },
};

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({ lakehouseShortcutsContainer: async () => fakeContainer }));
vi.mock('@/app/api/items/_lib/item-crud', () => ({ loadOwnedItem: vi.fn() }));
// This branch's routes authorize the lakehouse item before any registry read.
vi.mock('@/lib/auth/item-access', () => ({ resolveItemAccessByOid: vi.fn() }));
vi.mock('../_lib/legacy-container-key', () => ({ legacyContainerKeyFor: vi.fn() }));

import { getSession } from '@/lib/auth/session';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import { legacyContainerKeyFor } from '../_lib/legacy-container-key';
import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';
import { GET as LAKEHOUSE_GET } from '../shortcuts/route';
import { GET as ITEM_GET } from '@/app/api/items/[type]/[id]/shortcuts/route';

beforeEach(() => {
  vi.clearAllMocks();
  rows.length = 0;
  rows.push({
    id: 'lh1:files::partner', lakehouseId: 'lh1', name: 'partner', kind: 'files', parentPath: '',
    fullPath: 'Files/partner', targetType: 'adls', targetUri: 'abfss://exports@partner.dfs.core.windows.net/',
    status: 'error', statusDetail: DETAIL, createdBy: 'a@contoso.com',
    createdAt: '2025-12-01T00:00:00.000Z', updatedAt: '2025-12-01T00:00:00.000Z',
  });
  (getSession as any).mockReturnValue({ claims: { oid: 'oid-a', upn: 'a@contoso.com', tid: 't1' } });
  (loadOwnedItem as any).mockResolvedValue({ id: 'lh1', itemType: 'lakehouse' });
  (resolveItemAccessByOid as any).mockImplementation(async (_s: unknown, id: string) => ({
    item: { id, workspaceId: 'ws-1', itemType: 'lakehouse' }, role: 'Member', via: 'workspace', canWrite: true,
  }));
  (legacyContainerKeyFor as any).mockResolvedValue(null);
});

function expectRedacted(body: any) {
  expect(body.ok).toBe(true);
  expect(body.data).toHaveLength(1);
  const [r] = body.data;
  expect(r.name).toBe('partner');
  expect(r.statusDetail).not.toContain(SENTINEL);
  expect(r.statusDetail).toContain('https://partner.dfs.core.windows.net/exports');
  expect(r.statusDetail).toContain('timed out');
  expect(JSON.stringify(body)).not.toContain(SENTINEL);
}

describe('shortcut list endpoints redact a stored statusDetail', () => {
  it('GET /api/lakehouse/shortcuts', async () => {
    const req = { nextUrl: new URL('http://x/api/lakehouse/shortcuts?lakehouseId=lh1') } as any;
    const res = await LAKEHOUSE_GET(req, { params: Promise.resolve({}) } as any);
    expect(res.status).toBe(200);
    expectRedacted(await res.json());
  });

  it('GET /api/items/[type]/[id]/shortcuts', async () => {
    const res = await ITEM_GET({} as any, { params: Promise.resolve({ type: 'lakehouse', id: 'lh1' }) });
    expect(res.status).toBe(200);
    expectRedacted(await res.json());
  });
});
