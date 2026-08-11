/**
 * Contract test for POST /api/access-packages/[id]/request (access-governance W2):
 * SoD block, and per-grant fan-out with the approval-plan snapshot.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Partially mock: `getSession` is stubbed, but `tenantScopeId` must stay REAL —
// the route uses it to stamp the workflow doc's partition key, and replacing
// the whole module would leave it undefined (a 500 that says nothing about the
// behaviour under test).
vi.mock('@/lib/auth/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/session')>();
  return { ...actual, getSession: vi.fn() };
});
vi.mock('@/lib/azure/cosmos-client', () => ({
  accessPackagesContainer: vi.fn(),
  approvalPoliciesContainer: vi.fn(),
  accessRequestWorkflowContainer: vi.fn(),
}));

import { POST } from '../request/route';
import { getSession } from '@/lib/auth/session';
import { accessPackagesContainer, approvalPoliciesContainer, accessRequestWorkflowContainer } from '@/lib/azure/cosmos-client';

function queryOnly(resources: any[]) {
  return { items: { query: () => ({ fetchAll: async () => ({ resources }) }) } };
}
function queryCreate(resources: any[], sink: any[]) {
  return {
    items: {
      query: () => ({ fetchAll: async () => ({ resources }) }),
      create: async (doc: any) => { sink.push(doc); return { resource: doc }; },
    },
  };
}
const ctx = { params: Promise.resolve({ id: 'A' }) };

const TENANT = 'tenant-1-tid';

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue({ claims: { oid: 'consumer', tid: TENANT, upn: 'c@x' } });
  (approvalPoliciesContainer as any).mockResolvedValue(queryOnly([])); // → default plan
});

describe('POST /api/access-packages/[id]/request', () => {
  it('409s on a separation-of-duties block', async () => {
    const A = { id: 'A', name: 'A', enabled: true, requestable: true, sodConflictsWith: ['B'], sodMode: 'block', grants: [{ resourceType: 'workspace', resourceRef: 'ws-1', role: 'Viewer' }] };
    const B = { id: 'B', name: 'B', enabled: true, requestable: true, grants: [] };
    (accessPackagesContainer as any).mockResolvedValue(queryOnly([A, B]));
    // requester already holds B
    (accessRequestWorkflowContainer as any).mockResolvedValue(queryOnly([{ packageId: 'B', status: 'completed' }]));
    const res = await POST({} as any, ctx);
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.sod.status).toBe('block');
    expect(j.sod.conflicts).toContain('B');
  });

  it('creates one workflow doc per grant with the plan snapshot', async () => {
    const A = { id: 'A', name: 'Sales', enabled: true, requestable: true, sodConflictsWith: [], grants: [
      { resourceType: 'workspace', resourceRef: 'ws-1', role: 'Viewer' },
      { resourceType: 'kql-database', resourceRef: 'db-1', role: 'viewer' },
    ] };
    (accessPackagesContainer as any).mockResolvedValue(queryOnly([A]));
    const sink: any[] = [];
    (accessRequestWorkflowContainer as any).mockResolvedValue(queryCreate([], sink));
    const res = await POST({} as any, ctx);
    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j.created).toBe(2);
    expect(j.firstStage).toBe('manager'); // default plan
    expect(sink).toHaveLength(2);
    expect(sink[0].packageId).toBe('A');
    expect(sink[0].tier).toBe('manager');
    expect(sink[0].approvalPlan.stages).toEqual(['manager', 'privacy', 'approver', 'access-provider']);
    expect(sink.map((d) => d.scopeType).sort()).toEqual(['kql-database', 'workspace']);
    // Partition key = the ENTRA TENANT, so an approver (a different user) can
    // reach the request. It must NOT be the requester's oid — that put the doc
    // in a partition the inbox could not read.
    expect(sink.every((d) => d.tenantId === TENANT)).toBe(true);
    expect(sink.every((d) => d.requesterId === 'consumer')).toBe(true);
  });

  it('an ON-BEHALF request is still partitioned by the tenant, not the beneficiary', async () => {
    // A tenant admin opening a request for someone else used to stamp
    // tenantId = the BENEFICIARY's oid, putting the doc in a partition neither
    // the admin nor any approver could point-read.
    const ORIGINAL = process.env.LOOM_TENANT_ADMIN_OID;
    process.env.LOOM_TENANT_ADMIN_OID = 'admin-oid';
    try {
      (getSession as any).mockReturnValue({ claims: { oid: 'admin-oid', tid: TENANT, upn: 'admin@x' } });
      const A = { id: 'A', name: 'Sales', enabled: true, requestable: true, sodConflictsWith: [], grants: [
        { resourceType: 'workspace', resourceRef: 'ws-1', role: 'Viewer' },
      ] };
      (accessPackagesContainer as any).mockResolvedValue(queryOnly([A]));
      const sink: any[] = [];
      (accessRequestWorkflowContainer as any).mockResolvedValue(queryCreate([], sink));

      const req = { json: async () => ({ onBehalfOf: { oid: 'beneficiary-oid', upn: 'ben@x' } }) };
      const res = await POST(req as any, ctx);

      expect(res.status).toBe(201);
      expect(sink).toHaveLength(1);
      expect(sink[0].tenantId).toBe(TENANT);              // NOT 'beneficiary-oid'
      expect(sink[0].requesterId).toBe('beneficiary-oid'); // the beneficiary stays addressable
    } finally {
      if (ORIGINAL === undefined) delete process.env.LOOM_TENANT_ADMIN_OID;
      else process.env.LOOM_TENANT_ADMIN_OID = ORIGINAL;
    }
  });
});
