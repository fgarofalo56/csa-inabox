/**
 * #3580 — discoverability contract for `GET /api/data-products/[id]`.
 *
 * THE DEFECT THESE PIN. The route ran the SAME unscoped cross-partition
 * `SELECT * FROM c WHERE c.id = @id AND c.itemType = @t` its `[id]/ports` sibling
 * was fixed for under GHSA-hf73-rp4q-66pf, and then returned the raw
 * `WorkspaceItem`. `state.ports` rides in that item, and a port `ref` is an
 * infrastructure ADDRESS — an `abfss://` container path, a Synapse
 * `schema.table`, an ADX database. So a DRAFT product in ANOTHER Entra tenant
 * disclosed its addresses to any signed-in caller. The route's own docblock said
 * "GET is NOT ownership gated"; that sentence was the entire implementation.
 *
 * WHAT IS DELIBERATELY *NOT* MOCKED. `resolveDiscoveryAccess`,
 * `authorizeWorkspace`, `sameTenantConfirmed` and the DP-1
 * `resolveLifecycleState` resolver all RUN FOR REAL; only Cosmos, the ACL
 * resolver and the two best-effort side-services are stubbed. Fixture shape is
 * the ports route's (`../../[id]/ports/__tests__/route.test.ts`) so the two
 * sides of the shared decision are exercised against the same rows.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AccessRole } from '@/lib/auth/workspace-access';

/** Cosmos `items` rows, keyed by the id the query asked for. */
let items: Record<string, any> = {};
/** Cosmos `workspaces` rows: workspaceId → { tid }. */
let workspaces: Record<string, { tid?: string }> = {};

const idOf = (params: any[]) => params.find((p) => p.name === '@id')?.value;

const emptyQuery = () => ({ query: () => ({ fetchAll: async () => ({ resources: [] }) }) });

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: {
      query: (spec: any) => ({
        fetchAll: async () => {
          const row = items[idOf(spec.parameters)];
          return { resources: row ? [row] : [] };
        },
      }),
    },
  }),
  workspacesContainer: async () => ({
    items: {
      query: (spec: any) => ({
        fetchAll: async () => {
          const row = workspaces[idOf(spec.parameters)];
          return { resources: row ? [row] : [] };
        },
      }),
    },
  }),
  accessRequestsContainer: async () => ({ items: emptyQuery() }),
  auditLogContainer: async () => ({ items: emptyQuery() }),
}));

const resolveWorkspaceAccessByOid = vi.fn();
vi.mock('@/lib/auth/workspace-access', () => ({
  resolveWorkspaceAccessByOid: (...a: any[]) => resolveWorkspaceAccessByOid(...a),
}));

// The owning workspace's tenantId drives only the `isOwner` flag, and is a
// different lookup from the discovery tenant test (owner-tenant.ts resolves the
// CREATOR's oid; discoverability.ts resolves the Entra `tid`). Stubbed so this
// spec measures the discovery decision and not that helper.
vi.mock('@/lib/dataproducts/owner-tenant', () => ({
  resolveOwnerTenantId: async () => 'creator-oid',
  resolveDataProductDocTenant: async () => null,
}));
vi.mock('@/lib/marketplace/listing-analytics', () => ({ recordListingView: () => undefined }));

/** withSession supplies the session; injecting it here keeps the real route
 *  handler (and every guard inside it) running unmocked. */
let SESSION: any = { claims: { oid: 'oid-1', tid: 'tid-1' } };
vi.mock('@/lib/api/route-toolkit', () => ({
  withSession: (fn: any) => (req: any, ctx: any) =>
    fn(req, { session: SESSION, params: ctx.params }),
}));

import { GET } from '../route';

const ctx = (id: string) => ({ params: { id } }) as any;
const req = {} as any;

const MEMBER = { workspace: { id: 'ws-1' }, role: 'Viewer' as AccessRole, via: 'acl', canWrite: false };

const SECRET_REF = 'abfss://gold@acct.dfs.core.windows.net/customers';

function product(id: string, opts: { workspaceId: string; lifecycle?: string }) {
  return {
    id,
    itemType: 'data-product',
    workspaceId: opts.workspaceId,
    displayName: `Product ${id}`,
    description: 'A product',
    state: {
      ...(opts.lifecycle ? { lifecycleState: opts.lifecycle } : {}),
      contract: { version: '2.1.0', schema: [{ name: 'a' }, { name: 'b' }] },
      ports: {
        input: [],
        output: [{ id: 'o1', name: 'Gold Delta', kind: 'delta', ref: SECRET_REF }],
        management: [],
      },
      purviewDataProductId: 'purview-guid-do-not-leak',
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  SESSION = { claims: { oid: 'oid-1', tid: 'tid-1' } };
  resolveWorkspaceAccessByOid.mockResolvedValue(null); // non-member by default
  workspaces = { 'ws-1': { tid: 'tid-1' }, 'ws-other': { tid: 'tid-OTHER' } };
  items = {
    'dp-published': product('dp-published', { workspaceId: 'ws-1', lifecycle: 'published' }),
    'dp-draft': product('dp-draft', { workspaceId: 'ws-1', lifecycle: 'draft' }),
    'dp-deprecated': product('dp-deprecated', { workspaceId: 'ws-1', lifecycle: 'deprecated' }),
    'dp-foreign': product('dp-foreign', { workspaceId: 'ws-other', lifecycle: 'published' }),
  };
});

describe('GET is discovery-gated (#3580)', () => {
  it('a DRAFT product 404s a non-member — its port refs are not disclosed', async () => {
    // Before the fix: 200 with the whole WorkspaceItem, every `ref` included.
    const res = await GET(req, ctx('dp-draft'));
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain('abfss://');
  });

  it('a product in ANOTHER Entra tenant 404s even when published', async () => {
    const res = await GET(req, ctx('dp-foreign'));
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain('abfss://');
  });

  it('the refusal is byte-identical to "no such product", so it is not an existence oracle', async () => {
    // CONTENT-identical. Deliberately NOT a timing claim — a refusal costs one
    // to three more Cosmos round-trips than a miss, so a side-channel remains
    // and is disclosed in the route rather than implied away.
    const missing = await GET(req, ctx('dp-does-not-exist'));
    const refused = await GET(req, ctx('dp-draft'));
    expect(missing.status).toBe(refused.status);
    expect(await missing.json()).toEqual(await refused.json());
  });

  it('a caller whose session carries NO tid claim is REFUSED (positive-match tenant test)', async () => {
    SESSION = { claims: { oid: 'outsider', tid: undefined } };
    const res = await GET(req, ctx('dp-published'));
    expect(res.status).toBe(404);
  });

  it('a legacy workspace doc with NO recorded tid is REFUSED', async () => {
    workspaces['ws-1'] = {};
    const res = await GET(req, ctx('dp-published'));
    expect(res.status).toBe(404);
  });
});

describe('the documented Purview-UC discovery model still works, at catalog scope', () => {
  it('a PUBLISHED in-tenant product is discoverable to a non-member — but WITHOUT the raw record', async () => {
    const res = await GET(req, ctx('dp-published'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // The catalog projection is present and useful…
    expect(body.product.name).toBe('Product dp-published');
    expect(body.item.displayName).toBe('Product dp-published');
    expect(body.item.description).toBe('A product');
    // …and the record's internals are not.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('abfss://');
    expect(raw).not.toContain('purview-guid-do-not-leak');
    expect(body.doc).toBeUndefined();
    expect(body.preconditions).toBeUndefined();
    expect(body.isOwner).toBe(false);
  });

  it('a DEPRECATED product stays discoverable, so DP-9 propagation still resolves', async () => {
    const res = await GET(req, ctx('dp-deprecated'));
    expect(res.status).toBe(200);
  });

  it('lifecycle is read through the DP-1 canonical resolver, not raw state.publishStatus', async () => {
    // A ribbon-published product carries only `lifecycleStatus: 'PUBLISHED'`.
    const base = product('dp-legacy', { workspaceId: 'ws-1' });
    items['dp-legacy'] = { ...base, state: { ...base.state, lifecycleStatus: 'PUBLISHED' } };
    expect((await GET(req, ctx('dp-legacy'))).status).toBe(200);
  });
});

describe('a MEMBER of the owning workspace still gets the full owner payload', () => {
  // CONTROL. Without this the refusals above would equally be explained by the
  // whole GET being dead.
  beforeEach(() => resolveWorkspaceAccessByOid.mockResolvedValue(MEMBER));

  it('sees their own DRAFT, with the raw item, doc and delete preconditions', async () => {
    const res = await GET(req, ctx('dp-draft'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.item.state.ports.output[0].ref).toBe(SECRET_REF);
    expect(body.doc).toBeDefined();
    expect(body.preconditions).toBeDefined();
    expect(body.current).toBeDefined();
    expect(body).toHaveProperty('subscriberCount');
  });

  it('sees a published product in ANOTHER tenant when they are a member of its workspace', async () => {
    // Step 1 of the ladder admits on workspace access alone — the tenant test is
    // step 2 and only runs for non-members. Pinned so a later "tighten it"
    // cannot silently lock workspace members out of their own cross-tenant
    // shared products without turning this red.
    const res = await GET(req, ctx('dp-foreign'));
    expect(res.status).toBe(200);
    expect((await res.json()).item.state.ports.output[0].ref).toBe(SECRET_REF);
  });
});
