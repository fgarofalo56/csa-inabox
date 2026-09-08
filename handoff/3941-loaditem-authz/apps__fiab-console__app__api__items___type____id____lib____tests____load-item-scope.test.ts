/**
 * #3941 — the READ/WRITE contract of the shared loader, and its wiring.
 *
 * Two halves, because neither alone is enough.
 *
 * 1. THE LOADER'S OWN SHAPE. `loadAuthorizedItem` is asserted with
 *    `toHaveBeenCalledWith` — DEEP equality on the whole options object, not
 *    `objectContaining`. The security property under test is the ABSENCE of one
 *    key: `objectContaining` ignores extra keys, so adding `allowReadRoles: true`
 *    to a write call — which would let a read-only Viewer mutate or delete
 *    another user's item — would leave a loose assertion green. Do not loosen
 *    these. Same reasoning, verbatim, as
 *    `items/data-pipeline/[id]/__tests__/workspace-authz.test.ts`.
 *
 * 2. THE WIRING, per file. The loader being correct says nothing about a PUT
 *    handler that passes `write: false`. That is the NARROW form of this defect —
 *    one verb in one of ten files — and it is invisible to a spec that exercises
 *    a different route. The table below is the measured verb inventory of the
 *    whole family; a call site whose scope flips fails it, and so does a new
 *    handler added without a decision about its scope.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';

const SESSION = { claims: { oid: 'oid-caller', tid: 'tid-1', upn: 'u@loom.test', groups: [] } } as any;

const guard = vi.hoisted(() => ({ authorizeItemWorkspace: vi.fn(async () => null as any) }));
vi.mock('@/lib/auth/workspace-guard', () => guard);

const ITEM = { id: 'item-1', itemType: 'lakehouse', workspaceId: 'ws-1', displayName: 'L', state: {} };
const rows = vi.hoisted(() => ({ resources: [] as any[] }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: { query: () => ({ fetchAll: async () => rows }) },
  }),
}));

import { loadAuthorizedItem } from '../load-item';

const BASE = { workspaceId: 'ws-1', itemId: 'item-1', itemType: 'lakehouse', notFound: 'Item not found' };

beforeEach(() => {
  vi.clearAllMocks();
  guard.authorizeItemWorkspace.mockResolvedValue(null);
  rows.resources = [ITEM];
});

describe('#3941 loadAuthorizedItem — read/write scope', () => {
  it('write: false is READ-scoped — exactly { …, allowReadRoles: true } and nothing more', async () => {
    const r = await loadAuthorizedItem(SESSION, {
      itemId: 'item-1', itemType: 'lakehouse', write: false, notFound: 'Item not found',
    });
    expect(r.item).toBe(ITEM);
    expect(r.denied).toBeNull();
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, { ...BASE, allowReadRoles: true });
  });

  it('write: true is WRITE-scoped — the exact opts, WITHOUT allowReadRoles', async () => {
    await loadAuthorizedItem(SESSION, {
      itemId: 'item-1', itemType: 'lakehouse', write: true, notFound: 'Item not found',
    });
    // Deep equality: an added `allowReadRoles` key fails HERE. `false` would
    // also fail, and that is intended — the guard reads the key's presence.
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, BASE);
  });

  it('the workspace id comes from the ITEM DOCUMENT, never from the request', async () => {
    // The "skippable authorization" shape `authorizeItemWorkspace`'s header
    // warns about is a caller-supplied workspaceId that can be omitted. Here it
    // is read off the stored item, so there is no request-controlled path in.
    rows.resources = [{ ...ITEM, workspaceId: 'ws-from-the-document' }];
    await loadAuthorizedItem(SESSION, {
      itemId: 'item-1', itemType: 'lakehouse', write: false, notFound: 'Item not found',
    });
    expect(guard.authorizeItemWorkspace.mock.calls[0][1].workspaceId).toBe('ws-from-the-document');
  });

  it('a DENIAL is handed back and the item is withheld', async () => {
    guard.authorizeItemWorkspace.mockImplementation(
      async () => NextResponse.json({ ok: false, error: 'Item not found' }, { status: 404 }) as any,
    );
    const r = await loadAuthorizedItem(SESSION, {
      itemId: 'item-1', itemType: 'lakehouse', write: false, notFound: 'Item not found',
    });
    expect(r.item).toBeNull();
    expect(r.denied?.status).toBe(404);
  });

  it('an item with NO workspace FAILS CLOSED — no guard call, no item', async () => {
    // Authorizing against `undefined` must not become an allow. The point read
    // this replaces 404'd on it implicitly; here it is refused explicitly.
    rows.resources = [{ ...ITEM, workspaceId: '' }];
    const r = await loadAuthorizedItem(SESSION, {
      itemId: 'item-1', itemType: 'lakehouse', write: true, notFound: 'Item not found',
    });
    expect(r.item).toBeNull();
    expect(r.denied).toBeNull();
    expect(guard.authorizeItemWorkspace).not.toHaveBeenCalled();
  });

  it('no such item — no guard call, and the route renders its own 404', async () => {
    rows.resources = [];
    const r = await loadAuthorizedItem(SESSION, {
      itemId: 'nope', itemType: 'lakehouse', write: false, notFound: 'Item not found',
    });
    expect(r.item).toBeNull();
    expect(r.denied).toBeNull();
    expect(guard.authorizeItemWorkspace).not.toHaveBeenCalled();
  });
});

describe('#3941 the whole family is wired, and each verb carries the RIGHT scope', () => {
  // vitest roots at apps/fiab-console.
  const FAMILY = path.resolve(process.cwd(), 'app/api/items/[type]/[id]');

  /**
   * route -> the `write:` value of each call site, IN FILE ORDER, keyed to the
   * handler each one sits in. Measured against the tree, not assumed.
   */
  const EXPECTED: Array<[string, boolean[], string]> = [
    ['route.ts', [false, true, true], 'GET, PATCH, DELETE'],
    ['access-mode/route.ts', [true], 'PATCH'],
    ['business-metadata/route.ts', [false, true], 'GET, POST'],
    ['classifications/route.ts', [false, true], 'GET, PUT'],
    ['export-check/route.ts', [true], 'POST'],
    ['impact/route.ts', [false], 'GET'],
    ['lineage/route.ts', [false], 'GET'],
    ['pbids/route.ts', [false], 'GET'],
    ['sensitivity/route.ts', [false, true], 'GET, PUT'],
    ['sensitivity-label/route.ts', [false, true, true, true], 'GET, PUT, PATCH, DELETE'],
  ];

  it('all ten routes call the shared loader with the expected per-verb scope', () => {
    for (const [rel, writes, verbs] of EXPECTED) {
      const src = fs.readFileSync(path.join(FAMILY, rel), 'utf8');
      const found = [...src.matchAll(/write: (true|false),/g)].map((m) => m[1] === 'true');
      expect(found, `${rel} (${verbs})`).toEqual(writes);
    }
  });

  it('and NOT ONE of them still carries the owner-only point read', () => {
    // The two detector predicates `check-owner-only-workspace-guard` uses,
    // applied here so a re-inline fails the suite as well as the ratchet.
    const POINT_READ = /\.item\(\s*[A-Za-z0-9_.[\]]+\s*,\s*(?:[A-Za-z0-9_]*\.)*(?:claims\.oid|oid|tenantId|ownerOid)\s*\)/;
    const OWNER_CMP = /\.tenantId\s*[!=]==/;
    for (const [rel] of EXPECTED) {
      const src = fs.readFileSync(path.join(FAMILY, rel), 'utf8');
      const code = src.split(/\r?\n/).filter((l) => {
        const t = l.trim();
        return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
      }).join('\n');
      expect(POINT_READ.test(code), `${rel} owner-partition point read`).toBe(false);
      expect(OWNER_CMP.test(code), `${rel} ownership comparison`).toBe(false);
      expect(src).toContain('loadAuthorizedItem');
    }
    // A LIVE NEGATIVE: both predicates still fire on a file that DOES carry the
    // shape, so the ten zeros above are a measurement rather than a dead regex.
    const stillOwnerOnly = fs.readFileSync(path.join(FAMILY, 'audit/route.ts'), 'utf8');
    expect(POINT_READ.test(stillOwnerOnly)).toBe(true);
    expect(OWNER_CMP.test(stillOwnerOnly)).toBe(true);
  });
});
