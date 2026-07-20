/**
 * Contract tests for the approval-policies routes (access-governance W2):
 * the sanitizer + admin-gated list/create.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/auth/feature-gate', () => ({ requireTenantAdmin: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({ approvalPoliciesContainer: vi.fn() }));

import { GET, POST, sanitizePolicy } from '../route';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { approvalPoliciesContainer } from '@/lib/azure/cosmos-client';

function container(resources: any[], sink?: { doc?: any }) {
  return { items: {
    query: () => ({ fetchAll: async () => ({ resources }) }),
    create: async (doc: any) => { if (sink) sink.doc = doc; return { resource: doc }; },
  } };
}
const req = (body?: any) => ({ json: async () => body } as any);

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue({ claims: { oid: 'admin' } });
  (requireTenantAdmin as any).mockReturnValue(null);
});

describe('sanitizePolicy', () => {
  it('requires a name', () => { expect(sanitizePolicy({}).error).toMatch(/name/); });
  it('requires scope.ref for a non-default policy', () => {
    expect(sanitizePolicy({ name: 'X', scope: { kind: 'package' } }).error).toMatch(/scope.ref/);
  });
  it('defaults to all four stages when none provided, final always on', () => {
    const { pol } = sanitizePolicy({ name: 'X' });
    expect(pol?.stages.map((s) => s.key)).toEqual(['manager', 'privacy', 'approver', 'access-provider']);
    expect(pol?.stages.every((s) => s.enabled)).toBe(true);
  });
  it('keeps a subset but forces the final grant stage enabled', () => {
    const { pol } = sanitizePolicy({ name: 'X', stages: [
      { key: 'manager', enabled: true }, { key: 'access-provider', enabled: false },
    ] });
    const final = pol?.stages.find((s) => s.key === 'access-provider');
    expect(final?.enabled).toBe(true);
  });
});

describe('GET/POST /api/approval-policies', () => {
  it('403 for a non-admin on GET', async () => {
    (requireTenantAdmin as any).mockReturnValue(NextResponse.json({ ok: false }, { status: 403 }));
    expect((await GET()).status).toBe(403);
  });
  it('201 creates a policy', async () => {
    const sink: { doc?: any } = {};
    (approvalPoliciesContainer as any).mockResolvedValue(container([], sink));
    const res = await POST(req({ name: 'Fast-track', scope: { kind: 'default' } }));
    expect(res.status).toBe(201);
    expect(sink.doc.kind).toBe('approval-policy');
    expect(sink.doc.tenantId).toBe('admin');
  });
});
