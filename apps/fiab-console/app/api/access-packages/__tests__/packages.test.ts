/**
 * Contract tests for the access-packages routes (access-governance W2):
 * list/create + the sanitizer. Admin gate, validation, and the non-admin
 * requestable filter. Cosmos + the admin gate are stubbed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/auth/feature-gate', () => ({ requireTenantAdmin: vi.fn(), isTenantAdmin: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({ accessPackagesContainer: vi.fn() }));

import { GET, POST, sanitizePackage } from '../route';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin, isTenantAdmin } from '@/lib/auth/feature-gate';
import { accessPackagesContainer } from '@/lib/azure/cosmos-client';

function container(resources: any[], sink?: { doc?: any }) {
  return {
    items: {
      query: () => ({ fetchAll: async () => ({ resources }) }),
      create: async (doc: any) => { if (sink) sink.doc = doc; return { resource: doc }; },
    },
  };
}
function req(qs = '', body?: any) {
  return { nextUrl: new URL(`http://x/api/access-packages${qs}`), json: async () => body } as any;
}

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue({ claims: { oid: 'admin' } });
  (requireTenantAdmin as any).mockReturnValue(null);
  (isTenantAdmin as any).mockReturnValue(true);
});

describe('sanitizePackage', () => {
  it('requires a name and at least one grant', () => {
    expect(sanitizePackage({}).error).toMatch(/name/);
    expect(sanitizePackage({ name: 'X', grants: [] }).error).toMatch(/grant/);
  });
  it('normalizes grants + defaults', () => {
    const { pkg } = sanitizePackage({ name: 'Sales', grants: [{ resourceType: 'workspace', resourceRef: 'ws-1' }] });
    expect(pkg?.grants[0].role).toBe('Viewer');
    expect(pkg?.requestable).toBe(true);
    expect(pkg?.sodMode).toBe('block');
    expect(pkg?.enabled).toBe(true);
  });
});

describe('GET /api/access-packages', () => {
  it('non-admin catalog view returns only enabled + requestable', async () => {
    (isTenantAdmin as any).mockReturnValue(false);
    (accessPackagesContainer as any).mockResolvedValue(container([
      { id: '1', name: 'A', enabled: true, requestable: true, grants: [] },
      { id: '2', name: 'B', enabled: false, requestable: true, grants: [] },
      { id: '3', name: 'C', enabled: true, requestable: false, grants: [] },
    ]));
    const res = await GET(req());
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.packages.map((p: any) => p.id)).toEqual(['1']);
  });
  it('admin scope requires admin', async () => {
    (requireTenantAdmin as any).mockReturnValue(NextResponse.json({ ok: false }, { status: 403 }));
    const res = await GET(req('?scope=admin'));
    expect(res.status).toBe(403);
  });
});

describe('POST /api/access-packages', () => {
  it('403 for a non-admin', async () => {
    (requireTenantAdmin as any).mockReturnValue(NextResponse.json({ ok: false }, { status: 403 }));
    const res = await POST(req('', { name: 'X', grants: [{ resourceType: 'workspace', resourceRef: 'ws-1' }] }));
    expect(res.status).toBe(403);
  });
  it('400 without a grant', async () => {
    const res = await POST(req('', { name: 'X' }));
    expect(res.status).toBe(400);
  });
  it('201 creates a package', async () => {
    const sink: { doc?: any } = {};
    (accessPackagesContainer as any).mockResolvedValue(container([], sink));
    const res = await POST(req('', { name: 'Sales', grants: [{ resourceType: 'kql-database', resourceRef: 'db-1', role: 'viewer' }] }));
    expect(res.status).toBe(201);
    expect(sink.doc.kind).toBe('access-package');
    expect(sink.doc.tenantId).toBe('admin');
    expect(sink.doc.grants[0].resourceRef).toBe('db-1');
  });
});
