/**
 * GHSA-hf73-rp4q-66pf (addendum) — discoverability contract for
 * `GET /api/data-products/[id]/ports`.
 *
 * THE DEFECT THESE PIN. The route said "not ownership-gated (ports are part of
 * the discoverable product surface)" and then ran two unscoped cross-partition
 * `findItem` lookups — no workspaceId, no tid, no lifecycle filter. Nothing in it
 * established that a product WAS discoverable. Two disclosures came out of that:
 *
 *   1. The PORTS MODEL of any product id in any tenant. A port `ref` is an
 *      infrastructure ADDRESS (abfss:// path / Synapse schema.table / ADX
 *      database), not the "contract summary" its allowlist entry claimed.
 *   2. A RESOLVE ECHO on the upstream id: `resolveInput` returned the upstream's
 *      displayName + contract version for ANY id a caller put in a `ref`, and
 *      distinguished not-found from found — an item-existence oracle.
 *
 * WHAT IS DELIBERATELY *NOT* MOCKED. `callerMayDiscover`, `authorizeWorkspace`,
 * `isTenantAdmin` and the DP-1 `resolveLifecycleState` resolver all RUN FOR REAL;
 * only Cosmos and the ACL resolver are stubbed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AccessRole } from '@/lib/auth/workspace-access';

const getSession = vi.fn();
vi.mock('@/lib/auth/session', async () => {
  const actual = await vi.importActual<any>('@/lib/auth/session');
  return { ...actual, getSession: () => getSession() };
});

/** Cosmos `items` rows, keyed by the id the query asked for. */
let items: Record<string, any> = {};
/** Cosmos `workspaces` rows: workspaceId → { tid }. */
let workspaces: Record<string, { tid?: string }> = {};

const idOf = (params: any[]) => params.find((p) => p.name === '@id')?.value;

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
}));

const resolveWorkspaceAccessByOid = vi.fn();
vi.mock('@/lib/auth/workspace-access', () => ({
  resolveWorkspaceAccessByOid: (...a: any[]) => resolveWorkspaceAccessByOid(...a),
}));

import { GET } from '../route';

const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as any;
const req = {} as any;

const SESSION = { claims: { oid: 'oid-1', tid: 'tid-1' } };
const MEMBER = { workspace: { id: 'ws-1' }, role: 'Viewer' as AccessRole, via: 'acl', canWrite: false };

const SECRET_REF = 'abfss://gold@acct.dfs.core.windows.net/customers';

function product(id: string, opts: { workspaceId: string; lifecycle?: string; ports?: any; name?: string }) {
  return {
    id,
    itemType: 'data-product',
    workspaceId: opts.workspaceId,
    displayName: opts.name ?? `Product ${id}`,
    state: {
      ...(opts.lifecycle ? { lifecycleState: opts.lifecycle } : {}),
      contract: { version: '2.1.0', schema: [{ name: 'a' }, { name: 'b' }] },
      ports: opts.ports ?? {
        input: [],
        output: [{ id: 'o1', name: 'Gold Delta', kind: 'delta', ref: SECRET_REF }],
        management: [],
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockReturnValue(SESSION);
  resolveWorkspaceAccessByOid.mockResolvedValue(null); // non-member by default
  workspaces = { 'ws-1': { tid: 'tid-1' }, 'ws-other': { tid: 'tid-OTHER' } };
  items = {
    'dp-published': product('dp-published', { workspaceId: 'ws-1', lifecycle: 'published' }),
    'dp-draft': product('dp-draft', { workspaceId: 'ws-1', lifecycle: 'draft' }),
    'dp-deprecated': product('dp-deprecated', { workspaceId: 'ws-1', lifecycle: 'deprecated' }),
    'dp-foreign': product('dp-foreign', { workspaceId: 'ws-other', lifecycle: 'published' }),
  };
});

describe('the posture is now IMPLEMENTED, not merely asserted', () => {
  it('a DRAFT product 404s a non-member — its port refs are not disclosed', async () => {
    // Before the fix this returned 200 with every port `ref`, i.e. the product's
    // abfss:// / Synapse / ADX addresses, to any signed-in caller.
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
    const missing = await GET(req, ctx('dp-does-not-exist'));
    const refused = await GET(req, ctx('dp-draft'));
    expect(missing.status).toBe(refused.status);
    expect(await missing.json()).toEqual(await refused.json());
  });
});

describe('the documented discovery model still works', () => {
  it('a PUBLISHED in-tenant product is discoverable to a non-member (Purview UC model)', async () => {
    const res = await GET(req, ctx('dp-published'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.ports.output[0].ref).toBe(SECRET_REF);
  });

  it('a DEPRECATED product stays discoverable, so DP-9 breaking-change propagation still resolves', async () => {
    // Dropping `deprecated` from the discoverable set would silently break the
    // downstream deprecation notice that feature exists to deliver.
    const res = await GET(req, ctx('dp-deprecated'));
    expect(res.status).toBe(200);
  });

  it('a MEMBER of the owning workspace sees their own DRAFT', async () => {
    resolveWorkspaceAccessByOid.mockResolvedValue(MEMBER);
    const res = await GET(req, ctx('dp-draft'));
    expect(res.status).toBe(200);
  });

  it('lifecycle is read through the DP-1 canonical resolver, not raw state.publishStatus', async () => {
    // A ribbon-published product carries only `lifecycleStatus: 'PUBLISHED'`.
    // A gate reading `state.publishStatus` directly would call it Draft and hide
    // it — the exact three-fields-three-truths defect DP-1 exists to end.
    items['dp-legacy'] = {
      ...product('dp-legacy', { workspaceId: 'ws-1' }),
      state: { ...product('dp-legacy', { workspaceId: 'ws-1' }).state, lifecycleStatus: 'PUBLISHED' },
    };
    const res = await GET(req, ctx('dp-legacy'));
    expect(res.status).toBe(200);
  });
});

describe('the upstream RESOLVE ECHO is closed', () => {
  const withUpstream = (upstreamId: string) =>
    product('dp-published', {
      workspaceId: 'ws-1',
      lifecycle: 'published',
      ports: {
        input: [{ id: 'i1', name: 'Upstream', kind: 'data-product', ref: `${upstreamId}:port-1` }],
        output: [],
        management: [],
      },
    });

  it('does not name an upstream the caller may not discover', async () => {
    // Before the fix this returned the foreign product's displayName + contract
    // version to anyone who put its id in a `ref`.
    items['dp-published'] = withUpstream('dp-foreign');
    const res = await GET(req, ctx('dp-published'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ports.input[0].resolved).toEqual({
      error: 'Upstream product not found or not discoverable.',
    });
    expect(JSON.stringify(body)).not.toContain('Product dp-foreign');
    expect(JSON.stringify(body)).not.toContain('2.1.0');
  });

  it('an UNDISCOVERABLE upstream and a NON-EXISTENT one are indistinguishable', async () => {
    items['dp-published'] = withUpstream('dp-foreign');
    const foreign = await (await GET(req, ctx('dp-published'))).json();
    items['dp-published'] = withUpstream('dp-nope');
    const missing = await (await GET(req, ctx('dp-published'))).json();
    expect(foreign.ports.input[0].resolved).toEqual(missing.ports.input[0].resolved);
  });

  it('a DISCOVERABLE upstream still resolves to its contract summary', async () => {
    items['dp-upstream'] = product('dp-upstream', { workspaceId: 'ws-1', lifecycle: 'published', name: 'Sales Gold' });
    items['dp-published'] = withUpstream('dp-upstream');
    const body = await (await GET(req, ctx('dp-published'))).json();
    expect(body.ports.input[0].resolved).toEqual({
      productName: 'Sales Gold', contractVersion: '2.1.0', columnCount: 2,
    });
  });
});

describe('authentication is unchanged', () => {
  it('401s with no session, before any Cosmos read', async () => {
    getSession.mockReturnValue(null);
    const res = await GET(req, ctx('dp-published'));
    expect(res.status).toBe(401);
    expect(resolveWorkspaceAccessByOid).not.toHaveBeenCalled();
  });
});

describe('the KNOWN RESIDUAL is a measured fact, not an assumption', () => {
  it('a legacy workspace doc with NO recorded tid cannot be tenant-tested, and is allowed', async () => {
    // Stated in the route and here rather than hidden: failing closed would make
    // every legacy in-tenant product invisible to ordinary catalog readers, which
    // is a regression, not a fix. scripts/csa-loom/backfill-workspace-tid.mjs
    // closes it. This test exists so the gap is VISIBLE and cannot be silently
    // widened — change the behaviour and this test tells you.
    workspaces['ws-1'] = {}; // no tid
    const res = await GET(req, ctx('dp-published'));
    expect(res.status).toBe(200);
  });
});
