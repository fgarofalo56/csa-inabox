/**
 * GHSA-hf73-rp4q-66pf — item-level authorization contract for the two
 * `graphql-api/[id]/**` routes that had none.
 *
 * THE DEFECT THESE PIN.
 *   - `publish` upserted an API into the deployment's SHARED APIM instance under
 *     the caller-supplied `[id]`, so any signed-in caller could create or
 *     OVERWRITE another tenant's published API — its `path`, its SDL and its
 *     backend `serviceUrl`, which is what every subsequent gateway call resolves
 *     through.
 *   - `query` executed a caller-authored GraphQL document against another
 *     tenant's published API using the SERVER-HELD APIM all-access key, so the
 *     caller needed no credential of their own.
 * Both were excused by check-route-guards' SHARED_BACKEND_ITEM_ROUTES on "no
 * per-tenant Cosmos ownership to scope", which their own sibling
 * `graphql-api/[id]` disproves — it resolves that `[id]` through `loadOwnedItem`.
 *
 * WHY THIS FAMILY USES `withWorkspaceOwner` AND THE POWER BI FAMILIES DO NOT.
 * A `graphql-api` `[id]` is ALWAYS a Loom Cosmos item — the APIM apiId is minted
 * FROM it by `publish` — so the stricter wrapper, which 404s an id with no item
 * behind it, costs no reachable caller. On the Power BI families that same
 * strictness would have 404'd the whole opt-in path, where `[id]` is a raw
 * backend GUID.
 *
 * WHAT IS DELIBERATELY *NOT* MOCKED. `withWorkspaceOwner` runs for real; only
 * `getSession` and `loadOwnedItem` are stubbed. Mocking the wrapper would leave a
 * suite that passes with the wrapper deleted.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const getSession = vi.fn();
vi.mock('@/lib/auth/session', async () => {
  const actual = await vi.importActual<any>('@/lib/auth/session');
  return { ...actual, getSession: () => getSession() };
});

const loadOwnedItem = vi.fn();
vi.mock('@/app/api/items/_lib/item-crud', () => ({
  loadOwnedItem: (...a: any[]) => loadOwnedItem(...a),
}));

const publishGraphqlApi = vi.fn(async () => ({ id: 'api-1', path: 'p' }));
const getApi = vi.fn(async () => ({ id: 'api-1', path: 'p' }));
const testApiCall = vi.fn(async () => ({ status: 200, body: '{"data":{}}' }));
vi.mock('@/lib/azure/apim-client', () => ({
  publishGraphqlApi: (...a: any[]) => publishGraphqlApi(...a),
  getApi: (...a: any[]) => getApi(...a),
  testApiCall: (...a: any[]) => testApiCall(...a),
  ApimError: class ApimError extends Error { status = 502; },
}));
vi.mock('@/lib/azure/rate-limiter', () => ({ enforceRateLimit: async () => null }));

import { POST as publish } from '../publish/route';
import { POST as query } from '../query/route';

const ID = 'gql-1';
const ctxFor = (id: string) => ({ params: Promise.resolve({ id }) }) as any;
const req = (body: any = {}) => ({ json: async () => body }) as any;

const SESSION = { claims: { oid: 'oid-1', tid: 'tid-1' } };
const ITEM = { id: ID, workspaceId: 'ws-1', itemType: 'graphql-api', state: {} };

const PUBLISH_BODY = { displayName: 'D', path: 'p', sdl: 'type Query { a: String }' };

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockReturnValue(SESSION);
  loadOwnedItem.mockResolvedValue(ITEM);
  publishGraphqlApi.mockResolvedValue({ id: 'api-1', path: 'p' });
  getApi.mockResolvedValue({ id: 'api-1', path: 'p' });
  testApiCall.mockResolvedValue({ status: 200, body: '{"data":{}}' });
});

describe('GHSA-hf73-rp4q-66pf — authentication', () => {
  it('publish 401s with no session, and never reaches the item lookup or APIM', async () => {
    getSession.mockReturnValue(null);
    const res = await publish(req(PUBLISH_BODY), ctxFor(ID));
    expect(res.status).toBe(401);
    expect(loadOwnedItem).not.toHaveBeenCalled();
    expect(publishGraphqlApi).not.toHaveBeenCalled();
  });

  it('query 401s with no session, and never reaches the item lookup or APIM', async () => {
    getSession.mockReturnValue(null);
    const res = await query(req({ query: '{ a }' }), ctxFor(ID));
    expect(res.status).toBe(401);
    expect(loadOwnedItem).not.toHaveBeenCalled();
    expect(getApi).not.toHaveBeenCalled();
  });
});

describe('GHSA-hf73-rp4q-66pf — a NON-OWNER is refused (the defect)', () => {
  it('publish 404s a non-owner and never writes to the shared APIM instance', async () => {
    // Before the fix this returned 200 and OVERWROTE the named tenant's API.
    loadOwnedItem.mockResolvedValue(null);
    const res = await publish(req(PUBLISH_BODY), ctxFor('someone-elses-api'));
    expect(res.status).toBe(404);
    expect(publishGraphqlApi).not.toHaveBeenCalled();
  });

  it('query 404s a non-owner and never calls the gateway with the server-held key', async () => {
    loadOwnedItem.mockResolvedValue(null);
    const res = await query(req({ query: '{ a }' }), ctxFor('someone-elses-api'));
    expect(res.status).toBe(404);
    expect(getApi).not.toHaveBeenCalled();
    expect(testApiCall).not.toHaveBeenCalled();
  });

  it('the guard runs BEFORE body validation, so an unauthorized caller cannot probe the route', async () => {
    loadOwnedItem.mockResolvedValue(null);
    const res = await publish(req({}), ctxFor('someone-elses-api'));
    expect(res.status).toBe(404); // not the 400 "displayName required"
  });
});

describe('GHSA-hf73-rp4q-66pf — the READ/WRITE split', () => {
  it('publish is WRITE-scoped: it does not opt into read roles', async () => {
    await publish(req(PUBLISH_BODY), ctxFor(ID));
    expect(loadOwnedItem).toHaveBeenCalledWith(
      ID, 'graphql-api', 'oid-1',
      expect.not.objectContaining({ allowReadRoles: true }),
    );
  });

  it('query opts into read roles, so a Viewer can still run a query', async () => {
    await query(req({ query: '{ a }' }), ctxFor(ID));
    expect(loadOwnedItem).toHaveBeenCalledWith(
      ID, 'graphql-api', 'oid-1',
      expect.objectContaining({ allowReadRoles: true }),
    );
  });

  it('a legitimate owner still publishes, and a reader still queries', async () => {
    const pub = await publish(req(PUBLISH_BODY), ctxFor(ID));
    expect(pub.status).toBe(200);
    expect(publishGraphqlApi).toHaveBeenCalledWith(ID, expect.objectContaining({ path: 'p' }));

    const q = await query(req({ query: '{ a }' }), ctxFor(ID));
    expect(q.status).toBe(200);
    expect(await q.json()).toMatchObject({ ok: true, status: 200 });
  });

  it('threads the caller session so the cross-tenant tid boundary runs from claims (#2703)', async () => {
    await query(req({ query: '{ a }' }), ctxFor(ID));
    expect(loadOwnedItem.mock.calls[0][3].session).toBe(SESSION);
  });
});

describe('GHSA-hf73-rp4q-66pf — the APIM apiId still uses the RAW route id', () => {
  it('publish upserts under the raw `loom:`-prefixed id, not the resolved item.id', async () => {
    // `loadOwnedItem` resolves the `loom:` synthetic-id prefix for the OWNERSHIP
    // lookup only. Naming the APIM upsert from `item.id` would diverge for every
    // bundle-installed API and publish would write an apiId that query never
    // reads. This is the trap that cost real time on the copy-job fix.
    loadOwnedItem.mockResolvedValue({ ...ITEM, id: ID });
    await publish(req(PUBLISH_BODY), ctxFor(`loom:${ID}`));
    expect(publishGraphqlApi).toHaveBeenCalledWith(`loom:${ID}`, expect.anything());
  });

  it('query resolves the same raw id, so publish and query agree', async () => {
    loadOwnedItem.mockResolvedValue({ ...ITEM, id: ID });
    await query(req({ query: '{ a }' }), ctxFor(`loom:${ID}`));
    expect(getApi).toHaveBeenCalledWith(`loom:${ID}`);
  });
});
