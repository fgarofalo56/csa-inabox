/**
 * /api/onelake/tier — authorization + path validation (#4619).
 *
 *   PUT  401 / 403 non-admin (sink never called) / admin reaches the sink /
 *        every rejected path shape is a 400 with the sink never called
 *   GET  the same path shapes are a 400 before the tier read
 *
 * Each load-bearing assertion names the input that breaks it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/adls-client', () => ({
  KNOWN_CONTAINERS: ['bronze', 'silver', 'gold', 'landing', 'csv-imports'],
  getBlobTier: vi.fn(),
  setBlobTier: vi.fn(),
  copyBlobToTier: vi.fn(),
}));

import { GET, PUT } from '../tier/route';
import { getSession } from '@/lib/auth/session';
import { getBlobTier, setBlobTier, copyBlobToTier } from '@/lib/azure/adls-client';

const user = { claims: { upn: 'u@x', tid: 't1', oid: 'user-oid' } };
const admin = { claims: { upn: 'a@x', tid: 't1', oid: 'admin-oid' } };

function putReq(body: unknown) {
  return { json: async () => body, nextUrl: new URL('http://x/api/onelake/tier') } as any;
}
function getReq(container: string, path: string) {
  const u = new URL('http://x/api/onelake/tier');
  u.searchParams.set('container', container);
  u.searchParams.set('path', path);
  return { nextUrl: u } as any;
}

/** Every path shape #4619 requires the route to refuse. */
const BAD_PATHS: Array<[string, string]> = [
  ['a ".." segment', 'Files/../../other/blob.csv'],
  ['a backslash ".." segment', 'Files\\..\\blob.csv'],
  ['a trailing ".." segment', 'Files/..'],
  ['a leading slash', '/Files/blob.csv'],
  ['a leading backslash', '\\Files\\blob.csv'],
  ['a NUL', 'Files/blob\u0000.csv'],
  ['a control character', 'Files/blob\u001f.csv'],
  ['a DEL', 'Files/blob\u007f.csv'],
  ['an over-long path', 'a'.repeat(1025)],
];

function sinkCalls() {
  return (getBlobTier as any).mock.calls.length
    + (setBlobTier as any).mock.calls.length
    + (copyBlobToTier as any).mock.calls.length;
}

beforeEach(() => {
  vi.resetAllMocks();
  delete process.env.LOOM_TENANT_ADMIN_GROUP_ID;
  process.env.LOOM_TENANT_ADMIN_OID = 'admin-oid';
  (getBlobTier as any).mockResolvedValue({ tier: 'Hot' });
  (setBlobTier as any).mockResolvedValue({ tier: 'Cool' });
  (copyBlobToTier as any).mockResolvedValue({ tier: 'Hot' });
});

describe('PUT /api/onelake/tier — authorization', () => {
  it('401 without a session, and the sink is never called', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await PUT(putReq({ container: 'bronze', path: 'Files/a.csv', tier: 'Cool' }), {} as any);
    expect(res.status).toBe(401);
    expect(sinkCalls()).toBe(0);
  });

  it('403 admin_only for a signed-in non-admin, and the sink is never called', async () => {
    // Breaks if PUT is not tenant-admin gated: a valid body would reach
    // getBlobTier + setBlobTier and answer 200.
    (getSession as any).mockReturnValue(user);
    const res = await PUT(putReq({ container: 'bronze', path: 'Files/a.csv', tier: 'Cool' }), {} as any);
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.code).toBe('admin_only');
    expect(sinkCalls()).toBe(0);
  });

  it('a tenant admin reaches the sink (positive pair)', async () => {
    // Breaks if the gate refuses admins too, or the handler stops calling the sink.
    (getSession as any).mockReturnValue(admin);
    const res = await PUT(putReq({ container: 'bronze', path: 'Files/a.csv', tier: 'Cool' }), {} as any);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(getBlobTier).toHaveBeenCalledWith('bronze', 'Files/a.csv');
    expect(setBlobTier).toHaveBeenCalledWith('bronze', 'Files/a.csv', 'Cool');
  });
});

describe('PUT /api/onelake/tier — path validation (tenant admin)', () => {
  it.each(BAD_PATHS)('400 on a path with %s, and the sink is never called', async (_label, path) => {
    // Breaks if the PUT blobRelPathError check is removed: each path is
    // otherwise accepted and reaches getBlobTier/setBlobTier (mocked to succeed) → 200.
    (getSession as any).mockReturnValue(admin);
    const res = await PUT(putReq({ container: 'bronze', path, tier: 'Cool' }), {} as any);
    expect(res.status).toBe(400);
    expect((await res.json()).ok).toBe(false);
    expect(sinkCalls()).toBe(0);
  });

  it('a dotted-but-legal name like "a..b.csv" is still accepted', async () => {
    // Breaks if ".." were matched as a substring rather than as a whole segment.
    (getSession as any).mockReturnValue(admin);
    const res = await PUT(putReq({ container: 'bronze', path: 'Files/a..b.csv', tier: 'Cool' }), {} as any);
    expect(res.status).toBe(200);
    expect(setBlobTier).toHaveBeenCalledWith('bronze', 'Files/a..b.csv', 'Cool');
  });
});

describe('GET /api/onelake/tier — path validation', () => {
  it.each(BAD_PATHS)('400 on a path with %s, before the tier read', async (_label, path) => {
    // Breaks if the GET blobRelPathError check is removed: getBlobTier would be
    // called and the mocked tier returned with 200.
    (getSession as any).mockReturnValue(user);
    const res = await GET(getReq('bronze', path), {} as any);
    expect(res.status).toBe(400);
    expect(getBlobTier).not.toHaveBeenCalled();
  });

  it('a valid path reaches the tier read (positive pair)', async () => {
    (getSession as any).mockReturnValue(user);
    const res = await GET(getReq('bronze', 'Files/a.csv'), {} as any);
    expect(res.status).toBe(200);
    expect(getBlobTier).toHaveBeenCalledWith('bronze', 'Files/a.csv');
  });
});
