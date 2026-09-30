/**
 * GET /api/storage/accounts — the refusal hint names the role, and no longer
 * offers a manual storage-URI entry (#4619: the workspace storage binding has
 * none). Each assertion names the input that breaks it.
 */
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

let session: any = { claims: { oid: 'u', tid: 't' } };
vi.mock('@/lib/auth/session', () => ({ getSession: () => session }));
let fail: Error | null = null;
let listed = 0;
vi.mock('@/lib/azure/storage-discovery', async () => {
  class StorageDiscoveryError extends Error {
    status: number;
    constructor(message: string, status: number) { super(message); this.status = status; }
  }
  return {
    StorageDiscoveryError,
    listStorageAccounts: async () => {
      listed += 1;
      if (fail) throw fail;
      return [{ id: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/lakea', name: 'lakea' }];
    },
  };
});

import { GET } from '../route';
import { StorageDiscoveryError } from '@/lib/azure/storage-discovery';

const call = () => GET(new NextRequest('http://localhost/api/storage/accounts'), { params: Promise.resolve({}) } as any);

describe('GET /api/storage/accounts', () => {
  it('a Reader refusal answers ok:false with its error and a role-only hint', async () => {
    // Breaks if the hint again offers manual entry ("manually"), or stops
    // naming the role and the permission the listing needs.
    fail = new (StorageDiscoveryError as any)('AuthorizationFailed', 403);
    const res = await call();
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.error).toBe('AuthorizationFailed');
    expect(j.hint).toContain('Reader role');
    expect(j.hint).toContain('Microsoft.Storage/storageAccounts/read');
    expect(j.hint).not.toMatch(/manual/i);
  });

  it('a successful listing returns the accounts (positive pair)', async () => {
    // Breaks if the route stopped returning the discovered accounts.
    fail = null;
    const res = await call();
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.accounts.map((a: any) => a.name)).toEqual(['lakea']);
  });

  it('401 without a session, before any listing', async () => {
    // Breaks if the session check is dropped: the listing would run (listed
    // grows) and answer 200 with the accounts.
    session = null;
    fail = null;
    const before = listed;
    const res = await call();
    expect(res.status).toBe(401);
    expect((await res.json()).ok).toBe(false);
    expect(listed).toBe(before);
    session = { claims: { oid: 'u', tid: 't' } };
  });
});
