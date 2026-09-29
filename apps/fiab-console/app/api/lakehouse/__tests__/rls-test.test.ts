/**
 * Contract tests for POST /api/lakehouse/permissions/rls-test.
 *
 * Tenant admin only, like the RLS policy writes: the preview returns live pool
 * rows as a caller-named identity. The refusal reads the `testRlsPredicate`
 * CALL ROW SET and is paired with the admin positive arm on the same body.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/synapse-permissions-client', () => ({
  dedicatedTarget: vi.fn(() => ({ server: 's', database: 'd' })),
  testRlsPredicate: vi.fn(),
}));

import { POST } from '../permissions/rls-test/route';
import { getSession } from '@/lib/auth/session';
import { testRlsPredicate } from '@/lib/azure/synapse-permissions-client';

const ADMIN_OID = 'oid-admin';
const body = { objectId: 11, filterColumnId: 2, whereClause: '@cmp = USER_NAME()', testIdentity: 'someone@x' };
const req = (b: any) => ({ json: async () => b } as any);

let savedAdmin: string | undefined;
let savedGroup: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  savedAdmin = process.env.LOOM_TENANT_ADMIN_OID;
  savedGroup = process.env.LOOM_TENANT_ADMIN_GROUP_ID;
  process.env.LOOM_TENANT_ADMIN_OID = ADMIN_OID;
  delete process.env.LOOM_TENANT_ADMIN_GROUP_ID;
  (testRlsPredicate as any).mockResolvedValue({
    schema: 'dbo', table: 't', filterColumn: 'c',
    result: { columns: [{ name: 'c' }], rows: [['v']], rowCount: 1, executionMs: 3, truncated: false },
  });
});

afterEach(() => {
  if (savedAdmin === undefined) delete process.env.LOOM_TENANT_ADMIN_OID;
  else process.env.LOOM_TENANT_ADMIN_OID = savedAdmin;
  if (savedGroup === undefined) delete process.env.LOOM_TENANT_ADMIN_GROUP_ID;
  else process.env.LOOM_TENANT_ADMIN_GROUP_ID = savedGroup;
});

describe('POST /api/lakehouse/permissions/rls-test', () => {
  it('requires tenant-admin (403; no pool query)', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'oid-member', upn: 'm@x' } });
    const res = await POST(req(body));
    expect(res.status).toBe(403);
    expect((testRlsPredicate as any).mock.calls).toEqual([]);
  });

  it('a tenant admin runs the preview as the named identity (positive arm)', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: ADMIN_OID, upn: 'a@x' } });
    const res = await POST(req(body));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.rowCount).toBe(1);
    expect((testRlsPredicate as any).mock.calls.length).toBe(1);
    expect((testRlsPredicate as any).mock.calls[0][1]).toMatchObject({ objectId: 11, testIdentity: 'someone@x' });
  });
});
