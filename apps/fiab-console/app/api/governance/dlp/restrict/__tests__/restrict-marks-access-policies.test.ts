/**
 * POST /api/governance/dlp/restrict — after a revoke, the matching Access
 * policies are marked restricted in BOTH documents that can hold one: the tenant
 * Access-policy doc (`access-policies:<tid>`, partition `<tid>`) and the caller's
 * own `policies:<oid>` doc (Access policies recorded before the tenant doc).
 *
 * The tenant-admin gate and scope validation are covered in restrict-authz.test.ts;
 * this file pins the marking only. The Cosmos fake is partition-honest, so a
 * write to the wrong partition is not found.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  getSession: vi.fn(),
}));
vi.mock('@/lib/azure/cosmos-client', () => ({ tenantSettingsContainer: vi.fn() }));
vi.mock('@/lib/azure/adls-client', () => ({
  listContainerRoleAssignments: vi.fn(),
  revokeContainerRoleAssignment: vi.fn(),
  removePrincipalFromPathAcl: vi.fn(),
}));
vi.mock('@/lib/azure/access-policy-client', () => ({ revokeStructuredGrant: vi.fn(), denySchemaAccess: vi.fn() }));
vi.mock('../../_lib/meta', () => ({
  loadDlpMeta: vi.fn(async () => ({ restrictions: [] })),
  saveDlpMeta: vi.fn(async () => undefined),
}));

import { POST } from '../route';
import { getSession } from '@/lib/auth/session';
import { tenantSettingsContainer } from '@/lib/azure/cosmos-client';
import { listContainerRoleAssignments, revokeContainerRoleAssignment } from '@/lib/azure/adls-client';
import { makePartitionedContainer, type FakeContainer } from '@/app/api/access-requests/__tests__/partitioned-cosmos-fake';

const TID = 't1';
const ADMIN = { claims: { upn: 'a@x', tid: TID, oid: 'admin-oid' } };
const ap = (id: string, extra: Record<string, unknown> = {}) => ({
  id, kind: 'Access', principalId: 'victim-oid', scopeType: 'adls-container', scopeRef: 'bronze', enabled: true, ...extra,
});
let settings: FakeContainer;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LOOM_TENANT_ADMIN_OID = 'admin-oid';
  delete process.env.LOOM_TENANT_ADMIN_GROUP_ID;
  (getSession as any).mockReturnValue(ADMIN);
  settings = makePartitionedContainer({
    partitionKeyPath: '/tenantId',
    seed: [
      { id: `access-policies:${TID}`, tenantId: TID, kind: 'access-policies', items: [ap('tenant-ap'), ap('other-scope', { scopeRef: 'silver' })] },
      { id: 'policies:admin-oid', tenantId: 'admin-oid', kind: 'policies', items: [ap('own-legacy-ap')] },
    ],
  });
  (tenantSettingsContainer as any).mockResolvedValue(settings);
  let reads = 0;
  (listContainerRoleAssignments as any).mockImplementation(async () => {
    reads += 1;
    return reads === 1 ? [{ id: '/ra/1', principalId: 'victim-oid', roleName: 'Storage Blob Data Reader' }] : [];
  });
  (revokeContainerRoleAssignment as any).mockResolvedValue(undefined);
});

describe('POST /api/governance/dlp/restrict — Access-policy marking', () => {
  it('marks the matching policy in the tenant doc AND the caller\'s own doc, and nothing else', async () => {
    // Breaks if either document is dropped from the marking (policiesUpdated 1, and
    // that doc's policy stays enabled), or if the scope match is loosened (the
    // 'silver' policy would be marked too).
    const res = await POST({ json: async () => ({ scopeType: 'adls-container', scopeRef: 'bronze', principalId: 'victim-oid' }) } as any, {} as any);
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.policiesUpdated).toBe(2);
    const tenant = settings.__all().find((d) => d.id === `access-policies:${TID}`);
    const own = settings.__all().find((d) => d.id === 'policies:admin-oid');
    expect(tenant.items.find((p: any) => p.id === 'tenant-ap')).toMatchObject({ enabled: false, dlpRestricted: true });
    expect(own.items[0]).toMatchObject({ enabled: false, dlpRestricted: true });
    expect(tenant.items.find((p: any) => p.id === 'other-scope')).toMatchObject({ enabled: true });
    expect(tenant.items.find((p: any) => p.id === 'other-scope').dlpRestricted).toBeUndefined();
  });
});
