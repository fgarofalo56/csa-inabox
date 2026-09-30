/**
 * BFF route test for POST /api/thread/mirror-to-lakehouse — the Weave
 * "Mirror to Lakehouse" edge. Mocks the session, item loads, the shortcut
 * registry write and the thread-edge record.
 *
 * The folder every shortcut hangs under is `mirrors/<folder>`, derived from the
 * mirror's name. The derivation rows below assert the exact `parentPath` handed
 * to `createShortcut` AND that the lakehouse path validator (`pathSegments`,
 * imported from its source, not transcribed) reads it as exactly
 * ['mirrors', <folder>] — i.e. one segment after `mirrors/`.
 *
 * What breaks these (mutation arms run in a sandbox, see the PR body):
 *  - keeping "/" in the allowed set (the previous filter) → '../x', 'a/b',
 *    'orders/', '/abs' and the 'Finance/Prod' display-name fallback derive a
 *    nested or parent-relative path, so the exact parentPath fails;
 *  - dropping the "." / ".." mapping → '.' and '..' derive `mirrors/.` and
 *    `mirrors/..`, which pathSegments refuses (null ≠ ['mirrors', '_']);
 *  - a stricter filter that also rewrites "." or "-" → 'sales-2024.v2',
 *    '../x' and the 'mirror-1' id fallback no longer derive what they did;
 *  - trimming the name first → ' Sales DB ' no longer derives '_Sales_DB_',
 *    the folder the route has always used for it (a re-weave would then create
 *    duplicate rows instead of upserting the existing ones);
 *  - dropping the item-id fallback → an unnamed mirror derives `mirrors/`;
 *  - using the raw name with no derivation → every derivation row except the
 *    'sales-2024.v2' row fails;
 *  - dropping the `typeof from.name === 'string'` guard → a number / object /
 *    boolean name derives its own folder instead of the display name's;
 *  - widening the allowed set to keep "\" → 'a\\b' derives `mirrors/a\b`,
 *    which pathSegments splits into two segments.
 * The newline and NUL rows are killed only by the raw-name arm: the previous
 * filter already mapped those characters, so they pin that the mapping still
 * covers them rather than a difference from the old code.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { pathSegments } from '@/app/api/lakehouse/_lib/item-scope';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'oid-1', upn: 'u@x' } } as any));
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

const loadOwnedItemMock = vi.fn();
vi.mock('@/app/api/items/_lib/item-crud', () => ({ loadOwnedItem: (...a: any[]) => loadOwnedItemMock(...a) }));

const recordThreadEdgeMock = vi.fn(async () => {});
vi.mock('@/lib/thread/thread-edges', () => ({ recordThreadEdge: (...a: any[]) => recordThreadEdgeMock(...a) }));

vi.mock('@/lib/azure/mirror-engine', () => ({
  httpsToAbfss: (u: string) => u.replace(/^https:\/\/([^.]+)\.dfs\.core\.windows\.net\/([^/]+)\//, 'abfss://$2@$1.dfs.core.windows.net/'),
}));

const createShortcutMock = vi.fn(async (def: any) => def);
vi.mock('@/lib/azure/lakehouse-shortcuts', () => ({ createShortcut: (...a: any[]) => createShortcutMock(...a) }));

import { POST } from '../route';

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/thread/mirror-to-lakehouse', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

const TABLES = [
  { schema: 'dbo', table: 'orders', status: 'replicated', path: 'https://acct.dfs.core.windows.net/bronze/mirrors/m1/dbo.orders' },
  { schema: 'dbo', table: 'lines', status: 'replicated', path: 'https://acct.dfs.core.windows.net/bronze/mirrors/m1/dbo.lines' },
];
let srcDisplayName = 'Orders Mirror';

beforeEach(() => {
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-1', upn: 'u@x' } } as any);
  srcDisplayName = 'Orders Mirror';
  loadOwnedItemMock.mockReset();
  loadOwnedItemMock.mockImplementation(async (id: string, type: string) => {
    if (type === 'mirrored-database') return { id: 'mirror-1', displayName: srcDisplayName, state: { tablesStatus: TABLES } };
    if (type === 'lakehouse') return { id: 'lh-1', displayName: 'Sales LH' };
    return null;
  });
  createShortcutMock.mockClear();
  recordThreadEdgeMock.mockClear();
});

const body = (name?: unknown) => ({ from: { id: 'mirror-1', type: 'mirrored-database', name }, values: { lakehouseId: 'lh-1' } });

describe('mirror-to-lakehouse route', () => {
  it('401 when unauthenticated, before any item load', async () => {
    getSessionMock.mockReturnValueOnce(null as any);
    const res = await POST(post(body('Orders Mirror')));
    expect(res.status).toBe(401);
    expect(loadOwnedItemMock).not.toHaveBeenCalled();
  });

  it('400 for a non-mirror source', async () => {
    const res = await POST(post({ from: { id: 'x', type: 'lakehouse' }, values: { lakehouseId: 'lh-1' } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/mirrored databases/);
  });

  it('400 when the mirror has no replicated tables, with no shortcut written', async () => {
    loadOwnedItemMock.mockImplementation(async (_id: string, type: string) =>
      type === 'lakehouse' ? { id: 'lh-1', displayName: 'Sales LH' } : { id: 'mirror-1', displayName: 'M', state: { tablesStatus: [] } });
    const res = await POST(post(body('M')));
    expect(res.status).toBe(400);
    expect(createShortcutMock).not.toHaveBeenCalled();
  });

  it('creates one files shortcut per replicated table, records the edge and returns the folder', async () => {
    const res = await POST(post(body('Orders Mirror')));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.path).toBe('mirrors/Orders_Mirror');
    expect(j.message).toContain('under Files/mirrors/Orders_Mirror');
    expect(createShortcutMock).toHaveBeenCalledTimes(2);
    expect(createShortcutMock.mock.calls[0][0]).toMatchObject({
      lakehouseId: 'lh-1', name: 'dbo.orders', kind: 'files', parentPath: 'mirrors/Orders_Mirror',
      targetUri: TABLES[0].path, abfssUri: 'abfss://bronze@acct.dfs.core.windows.net/mirrors/m1/dbo.orders',
      statusDetail: 'Mirrored from Orders Mirror (dbo.orders)',
    });
    expect(recordThreadEdgeMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'mirror-to-lakehouse', fromName: 'Orders Mirror' }));
  });
});

describe('mirror-to-lakehouse folder derivation (one segment after mirrors/)', () => {
  const rows: Array<[label: string, name: string, folder: string]> = [
    ['parent reference', '../x', '.._x'],
    ['bare parent', '..', '__'],
    ['single dot', '.', '_'],
    ['forward slash', 'a/b', 'a_b'],
    ['backslash', 'a\\b', 'a_b'],
    ['trailing slash', 'orders/', 'orders_'],
    ['leading slash', '/abs', '_abs'],
    ['embedded newline', 'a\nb', 'a_b'],
    ['embedded NUL', 'a\u0000b', 'a_b'],
    // Compatibility: names with no "/" derive exactly what the route always derived.
    ['hyphen and dot kept', 'sales-2024.v2', 'sales-2024.v2'],
    ['surrounding spaces kept as underscores', ' Sales DB ', '_Sales_DB_'],
  ];

  it.each(rows)('%s: %j → mirrors/%s', async (_label, name, folder) => {
    const res = await POST(post(body(name)));
    expect(res.status, `name=${JSON.stringify(name)}`).toBe(200);
    const parentPath = createShortcutMock.mock.calls[0][0].parentPath as string;
    expect(parentPath).toBe(`mirrors/${folder}`);
    // One segment after mirrors/, as read by the lakehouse path validator itself.
    expect(pathSegments(parentPath)).toEqual(['mirrors', folder]);
    // The source name is recorded next to the derived folder.
    expect(createShortcutMock.mock.calls[0][0].statusDetail).toBe(`Mirrored from ${name} (dbo.orders)`);
  });

  it('falls back to the display name when from.name is absent, through the same mapping', async () => {
    srcDisplayName = 'Finance/Prod';
    await POST(post(body(undefined)));
    expect(createShortcutMock.mock.calls[0][0].parentPath).toBe('mirrors/Finance_Prod');
  });

  it('an unnamed mirror gets its item id as the folder, never a bare mirrors/', async () => {
    srcDisplayName = '';
    await POST(post(body('')));
    const parentPath = createShortcutMock.mock.calls[0][0].parentPath as string;
    expect(parentPath).toBe('mirrors/mirror-1');
    expect(pathSegments(parentPath)).toEqual(['mirrors', 'mirror-1']);
  });

  // A non-string `from.name` is not a name: the display name is used. Breaks
  // if the `typeof from.name === 'string'` guard is dropped — 42 would then
  // derive `mirrors/42` and be recorded as "Mirrored from 42".
  it.each([
    ['a number', 42],
    ['an object', { x: 1 }],
    ['true', true],
  ])('a non-string from.name (%s) falls back to the display name', async (_label, name) => {
    await POST(post(body(name)));
    const def = createShortcutMock.mock.calls[0][0];
    expect(def.parentPath).toBe('mirrors/Orders_Mirror');
    expect(def.statusDetail).toBe('Mirrored from Orders Mirror (dbo.orders)');
  });
});
