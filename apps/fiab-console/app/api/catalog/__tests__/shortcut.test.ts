/**
 * Unit tests for /api/catalog/shortcut BFF route.
 *
 *   1. unauthenticated → 401
 *   2. missing body → 400
 *   3. happy-path create shortcut without Purview registration
 *   4. happy-path create + register in Purview
 *   5. Purview register failure is surfaced as a soft warning but the
 *      shortcut create still succeeds.
 *   6. GET returns the existing shortcut list.
 *   7. DELETE removes a named shortcut.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/fabric-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/fabric-client');
  return {
    ...actual,
    createOneLakeShortcut: vi.fn(),
    listOneLakeShortcuts: vi.fn(),
    deleteOneLakeShortcut: vi.fn(),
  };
});
vi.mock('@/lib/azure/purview-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/purview-client');
  return { ...actual, registerAtlasEntity: vi.fn() };
});

import { POST, GET, DELETE } from '../shortcut/route';
import { getSession } from '@/lib/auth/session';
import { createOneLakeShortcut, listOneLakeShortcuts, deleteOneLakeShortcut } from '@/lib/azure/fabric-client';
import { registerAtlasEntity } from '@/lib/azure/purview-client';

function postReq(body: any) { return { json: async () => body } as any; }
function getReq(qs: string) { return { nextUrl: new URL(`http://x/api/catalog/shortcut?${qs}`) } as any; }

beforeEach(() => {
  vi.resetAllMocks();
  process.env.LOOM_PURVIEW_ACCOUNT = 'purview-test';
});

describe('POST /api/catalog/shortcut', () => {
  it('returns 401 when no session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await POST(postReq({}));
    expect(res.status).toBe(401);
  });

  it('returns 400 when required fields missing', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    const res = await POST(postReq({ workspaceId: 'w' }));
    expect(res.status).toBe(400);
  });

  it('creates shortcut without Purview registration when not requested', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (createOneLakeShortcut as any).mockResolvedValue({ name: 'bronze-cust', path: 'Files' });
    const res = await POST(postReq({
      workspaceId: 'ws', itemId: 'lh', name: 'bronze-cust',
      target: { adlsGen2: { location: 'https://x.dfs.core.windows.net', subpath: '/y' } },
    }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.shortcut.name).toBe('bronze-cust');
    expect(j.purview).toBeUndefined();
    expect(registerAtlasEntity).not.toHaveBeenCalled();
  });

  it('also registers in Purview when registerInPurview=true', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (createOneLakeShortcut as any).mockResolvedValue({ name: 'bronze-cust', path: 'Files' });
    (registerAtlasEntity as any).mockResolvedValue({ primaryGuid: 'guid-1' });
    const res = await POST(postReq({
      workspaceId: 'ws', itemId: 'lh', name: 'bronze-cust', registerInPurview: true,
      target: { adlsGen2: { location: 'https://x.dfs.core.windows.net', subpath: '/y' } },
    }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.purview.guid).toBe('guid-1');
    expect(j.purview.deepLink).toContain('purview-test.purview.azure.com');
  });

  it('soft-warns when Purview registration fails but still ok on shortcut', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (createOneLakeShortcut as any).mockResolvedValue({ name: 'sc', path: 'Files' });
    (registerAtlasEntity as any).mockRejectedValue(new Error('boom'));
    const res = await POST(postReq({
      workspaceId: 'ws', itemId: 'lh', name: 'sc', registerInPurview: true,
      target: { adlsGen2: { location: 'https://x.dfs.core.windows.net', subpath: '/y' } },
    }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.purview.error).toContain('boom');
    expect(j.purview.guid).toBeUndefined();
  });
});

describe('GET /api/catalog/shortcut', () => {
  it('lists shortcuts for a Lakehouse', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (listOneLakeShortcuts as any).mockResolvedValue([{ name: 's1', path: 'Files' }]);
    const res = await GET(getReq('workspaceId=ws&itemId=lh') as any);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.count).toBe(1);
    expect(j.shortcuts[0].name).toBe('s1');
  });
});

describe('DELETE /api/catalog/shortcut', () => {
  it('removes a named shortcut', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (deleteOneLakeShortcut as any).mockResolvedValue(undefined);
    const res = await DELETE(getReq('workspaceId=ws&itemId=lh&path=Files&name=s1') as any);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(deleteOneLakeShortcut).toHaveBeenCalledWith('ws', 'lh', 'Files', 's1');
  });
});
