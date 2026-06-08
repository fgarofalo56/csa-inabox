/**
 * BFF contract tests for the F15 data-product consumer + access-request routes:
 *   - GET  /api/data-products/[id]                  (consumer read, no owner gate)
 *   - GET  /api/data-products/[id]/policies         (cross-tenant permitted purposes)
 *   - POST /api/data-products/[id]/access-requests  (create purpose-bound request)
 *   - GET  /api/data-products/[id]/access-requests  (T12 mine / T14 approver)
 *
 * Verifies: auth gate (401), input validation (400), not-found (404), the
 * happy-path Cosmos write (status 'pending', purpose-bound), purpose filtering
 * (Access-kind + matching scope + enabled), and the approver authorization gate
 * (403 for non-owners). Cosmos containers are stubbed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(),
  workspacesContainer: vi.fn(),
  tenantSettingsContainer: vi.fn(),
  accessRequestsContainer: vi.fn(),
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

function queryContainer(resources: any[], createSink?: { doc?: any }) {
  return {
    items: {
      query: () => ({ fetchAll: async () => ({ resources }) }),
      create: async (doc: any) => { if (createSink) createSink.doc = doc; return { resource: doc }; },
    },
  };
}

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
    (getSession as any).mockReturnValue({ claims: { oid: OWNER_OID } });
    (itemsContainer as any).mockResolvedValue(queryContainer([{ id: PRODUCT_ID, itemType: 'data-product', workspaceId: WS_ID, displayName: 'Sales' }]));
    (workspacesContainer as any).mockResolvedValue(queryContainer([{ tenantId: OWNER_OID }]));
    const res = await productGET(getReq() as any, ctx);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.isOwner).toBe(true);
    expect(j.item.id).toBe(PRODUCT_ID);
  });

  it('returns isOwner=false for a non-owner consumer', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: CONSUMER_OID } });
    (itemsContainer as any).mockResolvedValue(queryContainer([{ id: PRODUCT_ID, itemType: 'data-product', workspaceId: WS_ID, displayName: 'Sales' }]));
    (workspacesContainer as any).mockResolvedValue(queryContainer([{ tenantId: OWNER_OID }]));
    const res = await productGET(getReq() as any, ctx);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.isOwner).toBe(false);
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
