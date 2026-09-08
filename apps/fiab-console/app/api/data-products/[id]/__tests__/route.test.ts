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
/** A dataset's Purview `qualifiedName` is the SAME class of secret as a port
 *  `ref` — for an ADLS asset it IS the abfss address — and the catalog
 *  projection must redact it while still populating the Datasets tab. */
const DATASET_REF = 'abfss://silver@acct.dfs.core.windows.net/customers';
/** The Purview Unified Catalog data-product GUID. NOT in the class above: it is
 *  an opaque catalog identifier, not an address, and the Overview grid renders a
 *  FALSE sentence when it is missing (see the projection test below). */
const PURVIEW_ID = 'purview-dp-guid-0001';

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
      // The catalog-metadata half of the record — what ConsumerDataProductDetail
      // renders on Overview / Contract / Datasets / Glossary.
      domain: 'Finance',
      owner: 'Ada Lovelace',
      sla: '99.9% availability, daily refresh',
      certified: true,
      datasets: [{
        name: 'customers', typeName: 'azure_datalake_gen2_path',
        qualifiedName: DATASET_REF, guid: 'dataset-guid-do-not-leak',
        classifications: ['PII'],
      }],
      glossaryLinks: [{ name: 'Customer', guid: 'glossary-guid-do-not-leak' }],
      ports: {
        input: [],
        output: [{ id: 'o1', name: 'Gold Delta', kind: 'delta', ref: SECRET_REF }],
        management: [],
      },
      purviewDataProductId: PURVIEW_ID,
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

  // ---------------------------------------------------------------------------
  // REVIEW REGRESSION — the redaction traded a disclosure for a broken surface.
  //
  // The first cut projected `state` down to `{displayName}`. Review measured
  // what ConsumerDataProductDetail then renders: an Overview of em-dashes
  // (domain / owner / SLA / endorsement all read `state.*`), an empty Contract
  // tab and an empty Datasets tab — "a tab that exists and renders empty",
  // which ux-baseline.md forbids. These pin BOTH halves at once: the catalog
  // metadata is present AND the addresses are still gone. Asserting only the
  // second half is what let the broken surface through.
  // ---------------------------------------------------------------------------
  it('the catalog projection POPULATES the consumer surface — not a page of em-dashes', async () => {
    const body = await (await GET(req, ctx('dp-published'))).json();
    const st = body.item.state;
    expect(st.domain).toBe('Finance');
    expect(st.owner).toBe('Ada Lovelace');
    expect(st.sla).toBe('99.9% availability, daily refresh');
    expect(st.certified).toBe(true);
    // The Contract tab reads state.contract; {displayName} left it undefined.
    expect(st.contract?.version).toBe('2.1.0');
    // The Datasets and Glossary tabs read these; both rendered EmptyState before.
    expect(st.datasets).toHaveLength(1);
    expect(st.datasets[0].name).toBe('customers');
    expect(st.datasets[0].classifications).toEqual(['PII']);
    expect(st.glossaryLinks).toEqual([{ name: 'Customer' }]);
  });

  it('projects purviewDataProductId, because withholding it made the Overview LIE', async () => {
    // R7 on a SURFACE, not on a log line. `ConsumerDataProductDetail` renders
    //   state.purviewDataProductId ? 'Registered <guid>' : 'Not registered with
    //   the unified catalog'
    // so the first cut of this projection made a REGISTERED product tell every
    // catalog reader it was not registered — a new false assertion shipped in the
    // name of redaction. The guid is an opaque catalog identifier for a product
    // this caller may already discover, in their own tenant; it is not an address
    // and it is not a credential, which is exactly why the two real addresses in
    // this fixture (the port `ref` and the dataset `qualifiedName`) stay redacted
    // in the very next test.
    const body = await (await GET(req, ctx('dp-published'))).json();
    expect(body.item.state.purviewDataProductId).toBe(PURVIEW_ID);
  });

  it('and it REDACTS the dataset qualifiedName, which is the same secret as a port ref', async () => {
    const body = await (await GET(req, ctx('dp-published'))).json();
    const raw = JSON.stringify(body);
    // The whole point: the tab is populated WITHOUT the address behind it.
    expect(raw).not.toContain('abfss://');
    expect(raw).not.toContain(DATASET_REF);
    expect(body.item.state.datasets[0].qualifiedName).toBeUndefined();
    expect(raw).not.toContain('dataset-guid-do-not-leak');
    expect(raw).not.toContain('glossary-guid-do-not-leak');
  });

  it('a state key nobody allowlisted is still excluded BY DEFAULT', async () => {
    // The allowlist property itself — a field `state` grows tomorrow must not
    // ride along. Without this the projection could regress to a denylist and
    // every assertion above would still pass.
    const base = product('dp-new-field', { workspaceId: 'ws-1', lifecycle: 'published' });
    items['dp-new-field'] = {
      ...base,
      state: { ...base.state, someFieldAddedNextQuarter: 'https://internal.example/secret' },
    };
    const body = await (await GET(req, ctx('dp-new-field'))).json();
    expect(body.item.state.someFieldAddedNextQuarter).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('internal.example');
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
