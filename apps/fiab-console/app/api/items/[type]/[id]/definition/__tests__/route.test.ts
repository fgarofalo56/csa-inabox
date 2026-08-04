/**
 * BFF route tests for /api/items/[type]/[id]/definition (P1.5).
 *
 * Asserts the two properties the loom-vscode `loom:` filesystem depends on:
 *  - OWNER SCOPE — the route delegates to the owner-scoped `loadOwnedItem`
 *    primitive (read-roles on GET, write-scoped on PUT) and returns 404 (not a
 *    cross-item read) when it denies.
 *  - ETag / If-Match — GET emits a strong ETag; PUT requires If-Match (428
 *    without), rejects a stale tag (412), and on a match persists with the
 *    scrubbed secrets + provisioning re-attached (no round-trip data loss).
 *
 * The pure serializer (`@/lib/workspace/item-definition`) is left REAL so its
 * scrub / etag / re-attach logic is genuinely exercised; only the Cosmos +
 * session + version-store seams are mocked (like the sibling item route tests).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// --- session --------------------------------------------------------------
const getSessionMock = vi.fn(
  () => ({ claims: { oid: 'ten-1', upn: 'u@t.com', name: 'U', email: 'u@t.com' }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

// --- owner-scope loader (the primitive the route delegates to) ------------
const baseItem = () => ({
  id: 'item-1',
  workspaceId: 'ws-1',
  itemType: 'notebook',
  displayName: 'My Notebook',
  description: 'a nb',
  state: {
    lang: 'python',
    connectionString: 'SECRET-CONN',
    keyVaultSecretRef: 'kv-ref-name',
    provisioning: { backend: 'adls', account: 'stor1' },
    nested: { apiKey: 'K1', keep: 'v' },
  } as Record<string, unknown>,
  createdBy: 'u',
  createdAt: 't0',
  updatedAt: 't1',
});
let stored = baseItem();
/** loadOwnedItem returns the item only for the owned id — else null (404 path). */
const loadOwnedItemMock = vi.fn(async (id: string) => (id === 'item-1' ? stored : null));
vi.mock('@/app/api/items/_lib/item-crud', () => ({
  loadOwnedItem: (...a: any[]) => loadOwnedItemMock(...(a as [string])),
}));

// --- Cosmos replace + version store --------------------------------------
const replaceMock = vi.fn(async (doc: any) => ({ resource: doc }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({ item: () => ({ replace: replaceMock }) }),
}));
const recordVersionMock = vi.fn(async () => 1);
vi.mock('@/lib/versions/item-version-store', () => ({
  recordItemVersion: (...a: any[]) => recordVersionMock(...a),
}));

const ctx = (type: string, id: string) => ({ params: Promise.resolve({ type, id }) });
const getReq = () => ({ headers: new Headers() }) as any;
const putReq = (ifMatch: string | null, body: unknown) =>
  ({
    headers: new Headers(ifMatch ? { 'if-match': ifMatch } : {}),
    json: async () => body,
  }) as any;

beforeEach(() => {
  stored = baseItem();
  getSessionMock.mockReturnValue({ claims: { oid: 'ten-1', upn: 'u@t.com', name: 'U', email: 'u@t.com' }, exp: Date.now() / 1000 + 3600 } as any);
});
afterEach(() => vi.clearAllMocks());

describe('GET /api/items/[type]/[id]/definition', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { GET } = await import('../route');
    const r = await GET(getReq(), ctx('notebook', 'item-1'));
    expect(r.status).toBe(401);
  });

  it('404 (owner-scope) when the item is not reachable — no cross-item read', async () => {
    const { GET } = await import('../route');
    const r = await GET(getReq(), ctx('notebook', 'other-item'));
    expect(r.status).toBe(404);
    // GET admits shared read-only roles.
    expect(loadOwnedItemMock).toHaveBeenCalledWith(
      'other-item',
      'notebook',
      'ten-1',
      expect.objectContaining({ allowReadRoles: true }),
    );
  });

  it('200 returns a secret-scrubbed, provisioning-free definition + ETag header', async () => {
    const { GET } = await import('../route');
    const r = await GET(getReq(), ctx('notebook', 'item-1'));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.itemType).toBe('notebook');
    // secrets excluded; a …Ref reference name survives.
    expect(j.definition.state.connectionString).toBeUndefined();
    expect(j.definition.state.nested.apiKey).toBeUndefined();
    expect(j.definition.state.nested.keep).toBe('v');
    expect(j.definition.state.keyVaultSecretRef).toBe('kv-ref-name');
    // provisioning never travels.
    expect(j.definition.state.provisioning).toBeUndefined();
    expect(j.provisioningExcluded).toBe(true);
    expect(j.scrubbedPaths).toEqual(expect.arrayContaining(['state.connectionString', 'state.nested.apiKey']));
    // strong ETag on the header AND in the body.
    const etag = r.headers.get('ETag');
    expect(etag).toBeTruthy();
    expect(j.etag).toBe(etag);
  });
});

describe('PUT /api/items/[type]/[id]/definition', () => {
  it('428 when If-Match is absent', async () => {
    const { PUT } = await import('../route');
    const r = await PUT(putReq(null, { definition: {} }), ctx('notebook', 'item-1'));
    const j = await r.json();
    expect(r.status).toBe(428);
    expect(j.code).toBe('precondition_required');
  });

  it('412 when If-Match is stale', async () => {
    const { PUT } = await import('../route');
    const r = await PUT(putReq('"stale-etag"', { definition: { state: {} } }), ctx('notebook', 'item-1'));
    const j = await r.json();
    expect(r.status).toBe(412);
    expect(j.code).toBe('precondition_failed');
    expect(j.etag).toBeTruthy();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('404 (write-scope, no read-roles) when the item is not owned', async () => {
    const { PUT } = await import('../route');
    const r = await PUT(putReq('*', { definition: { state: {} } }), ctx('notebook', 'nope'));
    expect(r.status).toBe(404);
    const opts = loadOwnedItemMock.mock.calls.at(-1)?.[3] ?? {};
    expect((opts as any).allowReadRoles).toBeFalsy();
  });

  it('200 on a fresh ETag: persists edits + re-attaches secrets & provisioning', async () => {
    const { GET, PUT } = await import('../route');
    // Read to obtain the current strong ETag.
    const g = await GET(getReq(), ctx('notebook', 'item-1'));
    const etag = g.headers.get('ETag')!;
    const def = (await g.json()).definition;
    // Client edits the scrubbed definition it received.
    def.state.lang = 'scala';
    def.state.newField = 42;
    def.displayName = 'Renamed NB';

    const r = await PUT(putReq(etag, { definition: def }), ctx('notebook', 'item-1'));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(replaceMock).toHaveBeenCalledOnce();
    const saved = replaceMock.mock.calls.at(-1)![0];
    // edits landed
    expect(saved.state.lang).toBe('scala');
    expect(saved.state.newField).toBe(42);
    expect(saved.displayName).toBe('Renamed NB');
    // secrets the client never saw are restored — NO round-trip loss
    expect(saved.state.connectionString).toBe('SECRET-CONN');
    expect(saved.state.nested.apiKey).toBe('K1');
    // per-estate provisioning restored
    expect(saved.state.provisioning).toEqual({ backend: 'adls', account: 'stor1' });
    // version recorded + new ETag returned
    expect(recordVersionMock).toHaveBeenCalledOnce();
    expect(j.etag).toBeTruthy();
  });

  it('409 schema_too_new when the body declares a newer schemaVersion', async () => {
    const { GET, PUT } = await import('../route');
    const g = await GET(getReq(), ctx('notebook', 'item-1'));
    const etag = g.headers.get('ETag')!;
    const r = await PUT(
      putReq(etag, { definition: { schemaVersion: 99, state: {} } }),
      ctx('notebook', 'item-1'),
    );
    const j = await r.json();
    expect(r.status).toBe(409);
    expect(j.code).toBe('schema_too_new');
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
