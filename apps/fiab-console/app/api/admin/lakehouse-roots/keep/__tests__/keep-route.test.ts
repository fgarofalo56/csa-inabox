/**
 * POST /api/admin/lakehouse-roots/keep — the "Keep root for <lakehouse>" action
 * on the readiness check "Lakehouses sharing a storage root".
 *
 * The REAL route handler runs. Mocked: the session, the capability gate, the
 * item store (an in-memory map whose `replace` records every write), the
 * lakehouse listing, and the three storage calls (create, read, mark). The
 * grouping (`findSharedLakehouseRoots`), the root derivation, the container
 * order and `mayAdoptRoot` are the real ones.
 *
 * Fixture: two lakehouses named "Sales", created before item roots, neither
 * recording a root, so both derive `lakehouses/Sales`. The directory exists in
 * `bronze`. Configured containers are `bronze` and `landing`, so a new root is
 * created in `landing` (first in the lakehouse container order).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => ({
    claims: { oid: 'admin-1', upn: 'admin@contoso.com', tid: 'tenant-1' },
    exp: Date.now() / 1000 + 3600,
  })),
}));

const enforceCapability = vi.fn(async (..._a: any[]): Promise<any> => null);
vi.mock('@/lib/auth/feature-gate', () => ({
  enforceCapability: (...a: any[]) => enforceCapability(...a),
}));

vi.mock('@/lib/azure/cloud-endpoints', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/azure/cloud-endpoints')>()),
  detectLoomCloud: () => 'AzureCloud',
}));

vi.mock('@/lib/azure/adls-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/azure/adls-client')>()),
  configuredContainerNames: () => ['bronze', 'landing'],
}));

/** Stored items keyed `<workspaceId>::<id>`, and every replace with its options. */
const DOCS = new Map<string, any>();
const REPLACES: Array<{ doc: any; opts: any }> = [];
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(async () => ({
    item: (id: string, pk: string) => ({
      read: async () => ({ resource: structuredClone(DOCS.get(`${pk}::${id}`)) }),
      replace: async (doc: any, opts: any) => {
        REPLACES.push({ doc: structuredClone(doc), opts });
        DOCS.set(`${pk}::${id}`, structuredClone(doc));
        return { resource: doc };
      },
    }),
  })),
}));

let ROWS: any[] = [];
/** Directories that exist: `<container>/<root>` → owner marker (null = unmarked). */
const DIRS = new Map<string, string | null>();
const CREATES: string[] = [];
const STAMPS: string[] = [];
vi.mock('@/lib/azure/lakehouse-abfss', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/azure/lakehouse-abfss')>()),
  // As the real query: recycled rows are returned only when asked for.
  listLakehouseRootFacts: async (_items: unknown, opts?: { includeRecycled?: boolean }) =>
    (opts?.includeRecycled ? ROWS : ROWS.filter((r) => !r.recycled)),
  readLakehouseRootOwner: async (c: string, r: string) => {
    const k = `${c}/${r}`;
    return DIRS.has(k)
      ? { exists: true, owner: DIRS.get(k) ?? null, etag: '"e"', metadata: {} }
      : { exists: false, owner: null };
  },
  createOwnedLakehouseRoot: async (c: string, r: string, id: string) => {
    const k = `${c}/${r}`;
    if (DIRS.has(k)) throw Object.assign(new Error('exists'), { statusCode: 409 });
    DIRS.set(k, id);
    CREATES.push(`${k} ${id}`);
  },
  stampLakehouseRootOwner: async (c: string, r: string, id: string) => {
    DIRS.set(`${c}/${r}`, id);
    STAMPS.push(`${c}/${r} ${id}`);
    return true;
  },
}));

const audit = vi.fn();
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: (...a: any[]) => audit(...a) }));

import { POST } from '../route';

const BEFORE = '2026-09-01T00:00:00.000Z';
const PROV = { status: 'created', secondaryIds: { container: 'bronze', rootPath: 'lakehouses/Sales', adlsRoot: 'x', other: 'kept' } };

function seed(extra: { bRecycled?: boolean; bProvisioning?: boolean } = {}) {
  const a = { id: 'lh-a', workspaceId: 'ws-1', itemType: 'lakehouse', displayName: 'Sales', createdAt: BEFORE, state: { notes: 'a' }, _etag: '"a1"' };
  const b = {
    id: 'lh-b', workspaceId: 'ws-2', itemType: 'lakehouse', displayName: 'Sales', createdAt: BEFORE,
    state: { notes: 'b', ...(extra.bProvisioning ? { provisioning: PROV } : {}), ...(extra.bRecycled ? { _recycled: { at: BEFORE } } : {}) },
    _etag: '"b1"',
  };
  DOCS.set('ws-1::lh-a', a);
  DOCS.set('ws-2::lh-b', b);
  ROWS = [
    { id: 'lh-a', workspaceId: 'ws-1', displayName: 'Sales', createdAt: BEFORE },
    { id: 'lh-b', workspaceId: 'ws-2', displayName: 'Sales', createdAt: BEFORE, ...(extra.bRecycled ? { recycled: { at: BEFORE } } : {}) },
  ];
  DIRS.set('bronze/lakehouses/Sales', null);
}

const post = (body: unknown) => POST(new NextRequest('http://localhost/api/admin/lakehouse-roots/keep', {
  method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json' },
}) as any, {} as any);

beforeEach(() => {
  DOCS.clear();
  REPLACES.length = 0;
  DIRS.clear();
  CREATES.length = 0;
  STAMPS.length = 0;
  ROWS = [];
  audit.mockClear();
  enforceCapability.mockClear();
});

describe('POST /api/admin/lakehouse-roots/keep', () => {
  // FAILS IF the route is not capability-gated: the gate's 403 would be
  // replaced by the handler's own answer, and a write would happen.
  it('answers the capability gate\'s refusal and writes nothing', async () => {
    const { NextResponse } = await import('next/server');
    enforceCapability.mockResolvedValueOnce(NextResponse.json({ ok: false }, { status: 403 }));
    seed();
    const res = await post({ itemId: 'lh-a' });
    expect(res.status).toBe(403);
    expect(REPLACES).toEqual([]);
    expect(CREATES).toEqual([]);
  });

  // FAILS IF a missing itemId reaches the store (anything but 400).
  it('refuses a body without an itemId', async () => {
    seed();
    expect((await post({})).status).toBe(400);
    expect((await post('not json')).status).toBe(400);
    expect(REPLACES).toEqual([]);
  });

  // The main path. FAILS IF:
  //  - the other member is not given its own root (no create, or created in
  //    `bronze` instead of the first container in the order, `landing`);
  //  - the keeper is moved (its recorded root would not be `lakehouses/Sales`);
  //  - the other member keeps the installer receipt's location fields (the
  //    resolver reads them first, so it would stay on the shared root) or loses
  //    the receipt's other fields;
  //  - a write is not conditional on the item's ETag;
  //  - the keeper's directory is not marked for it.
  it('gives the other member its own root, records and marks the keeper, and moves nothing', async () => {
    seed({ bProvisioning: true });
    const res = await post({ itemId: 'lh-a' });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(CREATES).toEqual(['landing/lakehouses/Sales--lh-b lh-b']);
    const b = DOCS.get('ws-2::lh-b');
    expect(b.state).toMatchObject({ notes: 'b', adlsContainer: 'landing', lakehouseRoot: 'lakehouses/Sales--lh-b' });
    expect(b.state.provisioning.secondaryIds).toEqual({ other: 'kept' });
    const a = DOCS.get('ws-1::lh-a');
    expect(a.state).toMatchObject({ notes: 'a', adlsContainer: 'bronze', lakehouseRoot: 'lakehouses/Sales' });
    expect(REPLACES.map((r) => r.opts?.accessCondition)).toEqual([
      { type: 'IfMatch', condition: '"b1"' },
      { type: 'IfMatch', condition: '"a1"' },
    ]);
    expect(STAMPS).toEqual(['bronze/lakehouses/Sales lh-a']);
    // The common root is still there, now marked for the keeper.
    expect(DIRS.get('bronze/lakehouses/Sales')).toBe('lh-a');
    expect(body.reassigned).toEqual([{ id: 'lh-b', name: 'Sales', container: 'landing', root: 'lakehouses/Sales--lh-b' }]);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][0]).toMatchObject({ action: 'lakehouse-root.keep', targetId: 'lh-a', outcome: 'success' });
  });

  // FAILS IF the recycled member is skipped: its files stay under the shared
  // root and a restore would put it back on it. Also FAILS IF the route lists
  // lakehouses without the recycled ones: lh-a is then in no group, and the
  // answer is 409 with no create.
  it('gives a recycled member its own root too', async () => {
    seed({ bRecycled: true });
    const res = await post({ itemId: 'lh-a' });
    expect(res.status).toBe(200);
    expect(CREATES).toEqual(['landing/lakehouses/Sales--lh-b lh-b']);
  });

  // FAILS IF a recycled item can be made the keeper (200 and writes).
  it('refuses to keep the root for a recycled member', async () => {
    seed({ bRecycled: true });
    const res = await post({ itemId: 'lh-b' });
    expect(res.status).toBe(409);
    expect(REPLACES).toEqual([]);
    expect(CREATES).toEqual([]);
  });

  // FAILS IF the route acts on an item in no group (200 and writes).
  it('answers 409 and changes nothing for a lakehouse in no group', async () => {
    seed();
    const res = await post({ itemId: 'lh-zzz' });
    expect(res.status).toBe(409);
    expect(REPLACES).toEqual([]);
    expect(CREATES).toEqual([]);
  });

  // FAILS IF a directory marked for another item is taken over when the create
  // conflicts (the member would be recorded on it and the response 200). The
  // keeper is still applied: FAILS IF one member's failure stops the rest.
  it('reports a member whose new root is marked for another item, and still applies the keeper', async () => {
    seed();
    DIRS.set('landing/lakehouses/Sales--lh-b', 'lh-other');
    const res = await post({ itemId: 'lh-a' });
    const body = await res.json();
    expect(res.status).toBe(502);
    expect(body.failed.map((f: any) => f.id)).toEqual(['lh-b']);
    expect(DOCS.get('ws-2::lh-b').state.lakehouseRoot).toBeUndefined();
    expect(DOCS.get('ws-1::lh-a').state.lakehouseRoot).toBe('lakehouses/Sales');
    expect(STAMPS).toEqual(['bronze/lakehouses/Sales lh-a']);
  });

  // Paired positive: an existing UNMARKED directory at the member's own item
  // root is its own and is used. FAILS IF `mayAdoptRoot` is not consulted and
  // every conflict is treated as a failure (502).
  it('uses the member\'s own existing unmarked item root', async () => {
    seed();
    DIRS.set('landing/lakehouses/Sales--lh-b', null);
    const res = await post({ itemId: 'lh-a' });
    expect(res.status).toBe(200);
    expect(DOCS.get('ws-2::lh-b').state.lakehouseRoot).toBe('lakehouses/Sales--lh-b');
  });

  // FAILS IF the keeper's directory is not looked for: with no directory in any
  // configured container there is nothing to keep, and the route must not
  // record a root that does not exist.
  it('answers 409 when the keeper has no directory to keep', async () => {
    seed();
    DIRS.clear();
    const res = await post({ itemId: 'lh-a' });
    expect(res.status).toBe(409);
    expect(REPLACES).toEqual([]);
  });
});
