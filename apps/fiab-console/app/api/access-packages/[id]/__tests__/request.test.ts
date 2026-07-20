/**
 * Contract test for POST /api/access-packages/[id]/request (access-governance W2):
 * SoD block, and per-grant fan-out with the approval-plan snapshot.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
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

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue({ claims: { oid: 'consumer', upn: 'c@x' } });
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
  });
});
