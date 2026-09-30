/**
 * Contract tests for GET /api/lakehouse/access, which reports the caller's
 * write access to one lakehouse item from the same `authorizeLakehouse`
 * decision the routes apply.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/auth/item-access', () => ({ resolveItemAccessByOid: vi.fn() }));

import { GET } from '../access/route';
import { getSession } from '@/lib/auth/session';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';

const req = (qs: string) => ({ nextUrl: new URL(`http://x/api/lakehouse/access?${qs}`) } as any);
const access = (canWrite: boolean) => ({ item: { id: 'lh', workspaceId: 'ws', itemType: 'lakehouse' }, role: canWrite ? 'Member' : 'Viewer', via: 'workspace', canWrite });

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue({ claims: { oid: 'o1' } });
});

describe('GET /api/lakehouse/access', () => {
  it('reports canWrite true for an editor and false for a read-only role', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(access(true));
    expect((await (await GET(req('lakehouseId=lh'))).json()).canWrite).toBe(true);
    (resolveItemAccessByOid as any).mockResolvedValue(access(false));
    // Breaks if the route reports a constant instead of the resolver's answer.
    expect((await (await GET(req('lakehouseId=lh'))).json()).canWrite).toBe(false);
    expect((resolveItemAccessByOid as any).mock.calls.map((c: any[]) => c.slice(1))).toEqual([['lh', 'lakehouse'], ['lh', 'lakehouse']]);
  });

  it('404 when the caller cannot reach the item', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    expect((await GET(req('lakehouseId=lh'))).status).toBe(404);
  });

  it('400 without lakehouseId', async () => {
    expect((await GET(req(''))).status).toBe(400);
    expect(resolveItemAccessByOid).not.toHaveBeenCalled();
  });
});
