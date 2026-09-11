/**
 * BFF contract tests for the F15 data-product consumer + access-request routes:
 *   - GET  /api/data-products/[id]                  (consumer read, DISCOVERY gated)
 *   - GET  /api/data-products/[id]/policies         (cross-tenant permitted purposes)
 *   - POST /api/data-products/[id]/access-requests  (create purpose-bound request)
 *   - GET  /api/data-products/[id]/access-requests  (T12 mine / T14 approver)
 *
 * Verifies: auth gate (401), input validation (400), not-found (404), the
 * happy-path Cosmos write (status 'pending', purpose-bound), purpose filtering
 * (Access-kind + matching scope + enabled), and the approver authorization gate
 * (403 for non-owners). Cosmos containers are stubbed.
 *
 * #3580 — THE FIRST DESCRIBE'S CONTRACT CHANGED, AND THESE FIXTURES MOVED WITH
 * IT RATHER THAN BEING WORKED AROUND. This file's header used to say GET was a
 * "consumer read, no owner gate", which was the route's own docblock claim and
 * was the entire implementation: any signed-in caller got the raw
 * `WorkspaceItem`, `state.ports` (an `abfss://` / `schema.table` / ADX address)
 * included, for any product in any tenant. `resolveDiscoveryAccess` now decides,
 * so the two fixtures below have to say WHICH population the caller is in:
 *
 *   - the OWNER is admitted by the owner fast-path, which is a partition
 *     point-read (`ws.item(workspaceId, oid)`) — so the workspaces stub needs an
 *     `item()`, not only an `items.query()`. Without it the guard threw a bare
 *     TypeError and the route answered 500, which is why this spec went red
 *     rather than 404: it was never exercising the tenant rule at all.
 *   - the CONSUMER is admitted only by the published-in-my-own-Entra-tenant
 *     rule, so the workspace doc carries a `tid`, the session carries the same
 *     `tid`, and the product is published. A draft, or a different tenant, is
 *     404 — pinned in `../[id]/__tests__/route.test.ts`, not duplicated here.
 *
 * `Workspace.tenantId` is the CREATOR's Entra oid and `Workspace.tid` is the
 * Entra tenant; they are different fields and the guards read different ones.
 * These fixtures now set both, because setting only the first is what made the
 * old rows look authorized while confirming no tenancy at all.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(),
  workspacesContainer: vi.fn(),
  tenantSettingsContainer: vi.fn(),
  accessRequestsContainer: vi.fn(),
  auditLogContainer: vi.fn(async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [0] }) }) },
  })),
  // The ACL step of `resolveWorkspaceAccessByOid`. Empty by default: nobody here
  // holds an explicit workspace-role row, so admission has to come from the
  // owner fast-path or the discovery rule — never from an un-stubbed leaf.
  workspaceRolesContainer: vi.fn(async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
  })),
}));
// PARTIAL mock — only the fire-and-forget view counter the GET fires on a
// non-owner read is a spy. A full replacement would have silently removed
// `recordListingSubscribe`, which the access-request POST calls for real.
vi.mock('@/lib/marketplace/listing-analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/marketplace/listing-analytics')>()),
  recordListingView: vi.fn(async () => {}),
}));

import { GET as productGET } from '../[id]/route';
import { GET as policiesGET } from '../[id]/policies/route';
import { POST as reqPOST, GET as reqGET } from '../[id]/access-requests/route';
import { getSession } from '@/lib/auth/session';
import {
  itemsContainer, workspacesContainer, tenantSettingsContainer, accessRequestsContainer,
} from '@/lib/azure/cosmos-client';

const OWNER_OID = 'owner-oid-111';
const CONSUMER_OID = 'consumer-oid-222';
const PRODUCT_ID = 'dp-abc';
const WS_ID = 'ws-1';
/** The Entra tenant both principals sign in from — `Workspace.tid`, NOT
 *  `Workspace.tenantId` (which holds the creator's oid). */
const TENANT_TID = 'tid-contoso';

function queryContainer(resources: any[], createSink?: { doc?: any }) {
  return {
    items: {
      query: () => ({ fetchAll: async () => ({ resources }) }),
      create: async (doc: any) => { if (createSink) createSink.doc = doc; return { resource: doc }; },
    },
    // The owner fast-path point-read. `workspaces` is partitioned on
    // `/tenantId`, so a doc is only readable from its creator's partition —
    // modelled by answering only when the partition key IS the stored
    // `tenantId`, and 404-ing (the code the guard swallows) otherwise. Returning
    // the doc unconditionally would make every caller an Owner and hide exactly
    // the decision this file now exercises.
    item: (_id: string, pk?: string) => ({
      read: async () => {
        const doc = resources[0];
        if (!doc || (pk !== undefined && doc.tenantId !== pk)) {
          const e: any = new Error('not found'); e.code = 404; throw e;
        }
        return { resource: doc };
      },
    }),
  };
}

/** The owning workspace doc: creator oid AND Entra tenant, which are different
 *  fields read by different guards. */
const WS_DOC = { id: WS_ID, tenantId: OWNER_OID, tid: TENANT_TID };

const ctx = { params: Promise.resolve({ id: PRODUCT_ID }) };
function getReq(url = `http://x/api/data-products/${PRODUCT_ID}/access-requests`) {
  const u = new URL(url);
  return { nextUrl: u, url } as any;
}
function bodyReq(body: any) {
  return { json: async () => body } as any;
}

beforeEach(() => { vi.resetAllMocks(); });

describe('GET /api/data-products/[id]', () => {
  it('401 without a session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await productGET(getReq() as any, ctx);
    expect(res.status).toBe(401);
  });

  it('returns the product + isOwner=true for the owner', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: OWNER_OID, tid: TENANT_TID } });
    (itemsContainer as any).mockResolvedValue(queryContainer([{ id: PRODUCT_ID, itemType: 'data-product', workspaceId: WS_ID, displayName: 'Sales' }]));
    (workspacesContainer as any).mockResolvedValue(queryContainer([WS_DOC]));
    const res = await productGET(getReq() as any, ctx);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.isOwner).toBe(true);
    expect(j.item.id).toBe(PRODUCT_ID);
    // Admitted as a MEMBER, so the owner-shaped payload is intact: the edit
    // dialog's `doc` and the destructive-delete preconditions both ride here.
    expect(j.doc).toBeDefined();
    expect(j.preconditions).toBeDefined();
  });

  it('returns isOwner=false for a non-owner consumer, at CATALOG scope', async () => {
    // #3580 — the consumer is not a workspace member. They are admitted only
    // because the product is PUBLISHED in their own Entra tenant, and what they
    // get is the catalog projection, not the record: no `doc`, no
    // preconditions, no `state.ports`. A draft or a foreign tenant is 404 and is
    // pinned in ../[id]/__tests__/route.test.ts.
    (getSession as any).mockReturnValue({ claims: { oid: CONSUMER_OID, tid: TENANT_TID } });
    (itemsContainer as any).mockResolvedValue(queryContainer([{
      id: PRODUCT_ID, itemType: 'data-product', workspaceId: WS_ID, displayName: 'Sales',
      state: { lifecycleState: 'published', ports: { output: [{ id: 'o1', ref: 'abfss://gold@acct.dfs.core.windows.net/x' }] } },
    }]));
    (workspacesContainer as any).mockResolvedValue(queryContainer([WS_DOC]));
    const res = await productGET(getReq() as any, ctx);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.isOwner).toBe(false);
    expect(j.doc).toBeUndefined();
    expect(j.preconditions).toBeUndefined();
    expect(JSON.stringify(j)).not.toContain('abfss://');
  });

  it('404 when the product does not exist', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: CONSUMER_OID } });
    (itemsContainer as any).mockResolvedValue(queryContainer([]));
    const res = await productGET(getReq() as any, ctx);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/data-products/[id]/policies', () => {
  it('returns only Access-kind policies scoped to this product and enabled', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: CONSUMER_OID } });
    (itemsContainer as any).mockResolvedValue(queryContainer([{ workspaceId: WS_ID }]));
    (workspacesContainer as any).mockResolvedValue(queryContainer([{ tenantId: OWNER_OID }]));
    (tenantSettingsContainer as any).mockResolvedValue({
      item: () => ({
        read: async () => ({
          resource: {
            items: [
              { id: 'p1', name: 'Analytics', kind: 'Access', scope: `data-product:${PRODUCT_ID}`, enabled: true },
              { id: 'p2', name: 'Disabled', kind: 'Access', scope: `data-product:${PRODUCT_ID}`, enabled: false },
              { id: 'p3', name: 'Other product', kind: 'Access', scope: 'data-product:other', enabled: true },
              { id: 'p4', name: 'A masking rule', kind: 'Masking', scope: `data-product:${PRODUCT_ID}`, enabled: true },
            ],
          },
        }),
      }),
    });
    const res = await policiesGET(getReq() as any, ctx);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.policies.map((p: any) => p.id)).toEqual(['p1']);
    expect(j.policies[0].name).toBe('Analytics');
  });

  it('returns empty list when the owner has no policies doc (404)', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: CONSUMER_OID } });
    (itemsContainer as any).mockResolvedValue(queryContainer([{ workspaceId: WS_ID }]));
    (workspacesContainer as any).mockResolvedValue(queryContainer([{ tenantId: OWNER_OID }]));
    (tenantSettingsContainer as any).mockResolvedValue({
      item: () => ({ read: async () => { const e: any = new Error('not found'); e.code = 404; throw e; } }),
    });
    const res = await policiesGET(getReq() as any, ctx);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.policies).toEqual([]);
  });
});

describe('POST /api/data-products/[id]/access-requests', () => {
  it('401 without a session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await reqPOST(bodyReq({ policyId: 'p1', purposeName: 'Analytics' }), ctx);
    expect(res.status).toBe(401);
  });

  it('400 when policyId/purposeName missing', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: CONSUMER_OID } });
    const res = await reqPOST(bodyReq({ justification: 'hi' }), ctx);
    expect(res.status).toBe(400);
  });

  it('404 when the product does not exist', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: CONSUMER_OID } });
    (itemsContainer as any).mockResolvedValue(queryContainer([]));
    const res = await reqPOST(bodyReq({ policyId: 'p1', purposeName: 'Analytics' }), ctx);
    expect(res.status).toBe(404);
  });

  it('creates a pending, purpose-bound request (201)', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: CONSUMER_OID, upn: 'consumer@contoso.com' } });
    (itemsContainer as any).mockResolvedValue(queryContainer([{ workspaceId: WS_ID, displayName: 'Sales', state: { displayName: 'Sales Mart' } }]));
    (workspacesContainer as any).mockResolvedValue(queryContainer([{ tenantId: OWNER_OID }]));
    const sink: { doc?: any } = {};
    (accessRequestsContainer as any).mockResolvedValue(queryContainer([], sink));
    const res = await reqPOST(bodyReq({ policyId: 'p1', purposeName: 'Analytics', justification: 'BI dashboard' }), ctx);
    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(sink.doc.status).toBe('pending');
    expect(sink.doc.dataProductId).toBe(PRODUCT_ID);
    expect(sink.doc.policyId).toBe('p1');
    expect(sink.doc.purposeName).toBe('Analytics');
    expect(sink.doc.requesterId).toBe(CONSUMER_OID);
    expect(sink.doc.requesterUpn).toBe('consumer@contoso.com');
    expect(sink.doc.justification).toBe('BI dashboard');
    expect(sink.doc.dataProductName).toBe('Sales Mart');
  });
});

describe('GET /api/data-products/[id]/access-requests', () => {
  it('T12: returns the caller own requests', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: CONSUMER_OID } });
    (accessRequestsContainer as any).mockResolvedValue(queryContainer([{ id: 'r1', requesterId: CONSUMER_OID, status: 'pending' }]));
    const res = await reqGET(getReq(), ctx);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.requests).toHaveLength(1);
  });

  it('T14: 403 when a non-owner asks for the approver view', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: CONSUMER_OID } });
    (accessRequestsContainer as any).mockResolvedValue(queryContainer([]));
    (itemsContainer as any).mockResolvedValue(queryContainer([{ workspaceId: WS_ID, displayName: 'Sales' }]));
    (workspacesContainer as any).mockResolvedValue(queryContainer([{ tenantId: OWNER_OID }]));
    const res = await reqGET(getReq(`http://x/api/data-products/${PRODUCT_ID}/access-requests?role=approver`), ctx);
    expect(res.status).toBe(403);
  });

  it('T14: owner approver view returns ALL requests', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: OWNER_OID } });
    (accessRequestsContainer as any).mockResolvedValue(queryContainer([
      { id: 'r1', requesterId: CONSUMER_OID, status: 'pending' },
      { id: 'r2', requesterId: 'someone-else', status: 'pending' },
    ]));
    (itemsContainer as any).mockResolvedValue(queryContainer([{ workspaceId: WS_ID, displayName: 'Sales' }]));
    (workspacesContainer as any).mockResolvedValue(queryContainer([{ tenantId: OWNER_OID }]));
    const res = await reqGET(getReq(`http://x/api/data-products/${PRODUCT_ID}/access-requests?role=approver`), ctx);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.requests).toHaveLength(2);
  });
});
