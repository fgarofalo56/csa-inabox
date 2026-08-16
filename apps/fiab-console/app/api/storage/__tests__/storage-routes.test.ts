/**
 * /api/storage/[account]/containers  and  .../[container]/paths
 *
 * These two routes exist because ADLS browsing was HALF built: `listPaths` has
 * taken an optional `account` since the shortcut work, but nothing enumerated
 * an arbitrary account's containers, and /api/lakehouse/paths rejects any
 * container outside the four DLZ ones. A user picking a location outside the
 * DLZ therefore had to type an `abfss://` URI.
 *
 * What is pinned here: the inputs that reach the storage data plane are bounded
 * (both segments are URL path components and the prefix is appended to them),
 * and a DENIAL is reported as a denial with the exact role to grant — never as
 * an empty container list, which reads to the user as "this account is empty".
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
const listFileSystems = vi.fn();
const listPaths = vi.fn();
vi.mock('@/lib/azure/adls-client', () => ({
  getServiceClientFor: () => ({ listFileSystems: () => listFileSystems() }),
  listPaths: (...a: any[]) => listPaths(...a),
}));

import { GET as CONTAINERS } from '../[account]/containers/route';
import { GET as PATHS } from '../[account]/containers/[container]/paths/route';
import { isValidStorageAccount, isValidContainerName, isSafePrefix } from '../_lib/validate';
import { getSession } from '@/lib/auth/session';

const SESSION = { claims: { upn: 'u@contoso.com', oid: 'oid-1' }, exp: 9_999_999_999 };

function req(qs = '') {
  return { nextUrl: new URL(`http://x/api/storage/acct/containers?${qs}`) } as any;
}
function ctx(params: Record<string, string>) {
  return { params: Promise.resolve(params) } as any;
}
async function* gen(items: unknown[]) {
  for (const i of items) yield i;
}
function httpErr(status: number) {
  const e: any = new Error(`storage ${status}`);
  e.statusCode = status;
  return e;
}

beforeEach(() => {
  vi.clearAllMocks();
  (getSession as any).mockReturnValue(SESSION);
});

describe('input validation', () => {
  it('bounds the account name', () => {
    expect(isValidStorageAccount('loomlake01')).toBe(true);
    expect(isValidStorageAccount('ab')).toBe(false);
    expect(isValidStorageAccount('Loom-Lake')).toBe(false);
    expect(isValidStorageAccount('a'.repeat(25))).toBe(false);
  });

  it('bounds the container name', () => {
    expect(isValidContainerName('bronze')).toBe(true);
    expect(isValidContainerName('my-container')).toBe(true);
    expect(isValidContainerName('My-Container')).toBe(false);
    expect(isValidContainerName('a--b')).toBe(false);
  });

  it('keeps the prefix inside the container', () => {
    expect(isSafePrefix('')).toBe(true);
    expect(isSafePrefix('Tables/orders')).toBe(true);
    expect(isSafePrefix('../../etc')).toBe(false);
    expect(isSafePrefix('https://evil/x')).toBe(false);
    expect(isSafePrefix('a?comp=list')).toBe(false);
  });
});

describe('GET /api/storage/[account]/containers', () => {
  it('401 without a session', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await CONTAINERS(req(), ctx({ account: 'loomlake01' }))).status).toBe(401);
  });

  it('400 on an invalid account name (no data-plane call)', async () => {
    const res = await CONTAINERS(req(), ctx({ account: 'BAD NAME' }));
    expect(res.status).toBe(400);
    expect(listFileSystems).not.toHaveBeenCalled();
  });

  it('lists containers with their sovereign-correct data-plane URLs', async () => {
    listFileSystems.mockReturnValue(gen([{ name: 'raw' }, { name: 'bronze' }]));
    const j = await (await CONTAINERS(req(), ctx({ account: 'loomlake01' }))).json();
    expect(j.ok).toBe(true);
    expect(j.containers.map((c: any) => c.name)).toEqual(['bronze', 'raw']);
    expect(j.containers[0].url).toContain('loomlake01.dfs.');
    expect(j.host).toContain('loomlake01.dfs.');
  });

  it('a 403 names the exact role and the scope it must be at — it is NOT an empty list', async () => {
    listFileSystems.mockImplementation(() => { throw httpErr(403); });
    const res = await CONTAINERS(req(), ctx({ account: 'loomlake01' }));
    const j = await res.json();
    expect(res.status).toBe(403);
    expect(j.ok).toBe(false);
    expect(j.error).toContain('Storage Blob Data Reader');
    expect(j.error).toContain('account-scope');
    expect(j.containers).toBeUndefined();
  });

  it('an unclassified failure says it could not list, not that there is nothing', async () => {
    listFileSystems.mockImplementation(() => { throw new Error('DNS lookup failed'); });
    const res = await CONTAINERS(req(), ctx({ account: 'loomlake01' }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('Could not list containers');
  });
});

describe('GET /api/storage/[account]/containers/[container]/paths', () => {
  it('401 without a session', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await PATHS(req(), ctx({ account: 'a1b2c3', container: 'raw' }))).status).toBe(401);
  });

  it('walks an arbitrary account + container (what /api/lakehouse/paths cannot do)', async () => {
    listPaths.mockResolvedValue([{ name: 'Tables/orders', isDirectory: true, size: 0 }]);
    const j = await (await PATHS(req('prefix=Tables'), ctx({ account: 'loomlake01', container: 'raw' }))).json();
    expect(j.ok).toBe(true);
    expect(listPaths).toHaveBeenCalledWith('raw', 'Tables', 200, 'loomlake01');
    expect(j.paths[0].name).toBe('Tables/orders');
  });

  it('400 on a traversal prefix, before any data-plane call', async () => {
    const res = await PATHS(req('prefix=../../other'), ctx({ account: 'loomlake01', container: 'raw' }));
    expect(res.status).toBe(400);
    expect(listPaths).not.toHaveBeenCalled();
  });

  it('caps maxResults and reports the truncation instead of implying completeness', async () => {
    listPaths.mockResolvedValue(Array.from({ length: 1000 }, (_, i) => ({ name: `f${i}`, isDirectory: false, size: 1 })));
    const j = await (await PATHS(req('maxResults=99999'), ctx({ account: 'loomlake01', container: 'raw' }))).json();
    expect(listPaths).toHaveBeenCalledWith('raw', '', 1000, 'loomlake01');
    expect(j.truncated).toBe(true);
  });

  it('a 403 names the role rather than returning an empty folder', async () => {
    listPaths.mockRejectedValue(httpErr(403));
    const res = await PATHS(req(), ctx({ account: 'loomlake01', container: 'raw' }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('Storage Blob Data Reader');
  });
});
