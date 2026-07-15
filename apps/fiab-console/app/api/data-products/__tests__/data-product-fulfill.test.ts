/**
 * Backend contract tests for the DP-10 owner approve + zero-touch fulfillment:
 *   PATCH /api/data-products/[id]/access-requests
 * session, cosmos-client, the grant client, and events are mocked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
  const reqDoc = { id: 'req-1', dataProductId: 'dp-1', requesterId: 'consumer', requesterUpn: 'c@x', status: 'pending' };
  return {
    productState: { value: {} as Record<string, unknown> },
    replaced: { doc: null as any },
    accessReqItem: {
      read: vi.fn(async () => ({ resource: { ...reqDoc } })),
      replace: vi.fn(async (d: any) => { h.replaced.doc = d; return { resource: d }; }),
    },
    reqDoc,
  };
});

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/access-policy-client', () => ({ enforceAccessGrant: vi.fn() }));
vi.mock('@/lib/marketplace/listing-analytics', () => ({ recordListingSubscribe: vi.fn() }));
vi.mock('@/lib/events/webhook-emitter', () => ({ emitLoomEvent: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => {
  const q = (rows: any[]) => ({ query: () => ({ fetchAll: async () => ({ resources: rows }) }) });
  return {
    accessRequestsContainer: vi.fn(async () => ({ item: () => h.accessReqItem })),
    itemsContainer: vi.fn(async () => ({ items: q([{ workspaceId: 'ws-1', displayName: 'Sales', state: h.productState.value }]) })),
    workspacesContainer: vi.fn(async () => ({ items: q([{ tenantId: 'owner' }]) })),
  };
});

import { PATCH } from '../[id]/access-requests/route';
import { getSession } from '@/lib/auth/session';
import { enforceAccessGrant } from '@/lib/azure/access-policy-client';

function ctx(id: string) { return { params: Promise.resolve({ id }) }; }
function req(body: any) { return { json: async () => body } as any; }

beforeEach(() => {
  vi.clearAllMocks();
  h.replaced.doc = null;
  h.accessReqItem.read.mockResolvedValue({ resource: { ...h.reqDoc } });
  h.productState.value = { ports: { output: [{ name: 'lake', direction: 'output', kind: 'adls', ref: 'curated' }] } };
});

describe('PATCH /access-requests (approve + fulfill)', () => {
  it('403 when the caller is not the product owner', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'not-owner' } });
    const res = await PATCH(req({ requestId: 'req-1', decision: 'approved' }), ctx('dp-1'));
    expect(res.status).toBe(403);
  });

  it('approves + auto-provisions the real grant on the resolved output port', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'owner', upn: 'o@x' } });
    (enforceAccessGrant as any).mockResolvedValue({ status: 'active', roleName: 'Storage Blob Data Reader', roleAssignmentId: 'ra-1' });
    const res = await PATCH(req({ requestId: 'req-1', decision: 'approved' }), ctx('dp-1'));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.provisioned).toBe(true);
    expect(enforceAccessGrant).toHaveBeenCalledWith(expect.objectContaining({ scopeType: 'adls-container', scopeRef: 'curated', principalId: 'consumer' }));
    expect(h.replaced.doc.status).toBe('completed');
    expect(h.replaced.doc.provisionedTargets[0].roleAssignmentId).toBe('ra-1');
  });

  it('honest-gates (approved, not provisioned) when no backing resource resolves', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'owner' } });
    h.productState.value = {}; // no ports, no assets
    const res = await PATCH(req({ requestId: 'req-1', decision: 'approved' }), ctx('dp-1'));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.provisioned).toBe(false);
    expect(j.note).toMatch(/output-port backing resource/);
    expect(enforceAccessGrant).not.toHaveBeenCalled();
    expect(h.replaced.doc.status).toBe('approved');
  });

  it('surfaces a grant infra-gate as approved-not-provisioned (pending)', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'owner' } });
    (enforceAccessGrant as any).mockResolvedValue({ status: 'pending', detail: 'Grant the UAMI User Access Administrator on the RG.' });
    const res = await PATCH(req({ requestId: 'req-1', decision: 'approved' }), ctx('dp-1'));
    expect(res.status).toBe(200);
    expect((await res.json()).provisioned).toBe(false);
    expect(h.replaced.doc.status).toBe('approved');
    expect(h.replaced.doc.fulfillmentNote).toMatch(/User Access Administrator/);
  });

  it('rejects without granting', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'owner' } });
    const res = await PATCH(req({ requestId: 'req-1', decision: 'rejected', reviewComment: 'no' }), ctx('dp-1'));
    expect(res.status).toBe(200);
    expect(h.replaced.doc.status).toBe('rejected');
    expect(enforceAccessGrant).not.toHaveBeenCalled();
  });
});
