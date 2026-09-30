/**
 * /api/governance/policies — Access policies are managed by tenant admins.
 *
 * An Access policy is enforced as a real Azure role assignment, so creating,
 * editing or deleting one requires the `admin.permissions` capability at Admin
 * role. The other kinds (DLP, Masking, RLS, Retention) only persist a rule
 * document and keep their per-author behaviour.
 *
 * Seams: the feature gate is mocked to one switch (`admin`), and the test also
 * asserts WHICH capability/role the route asked for, so a route gating on a
 * weaker capability cannot pass. The grant client is a spy. The policy store is
 * REAL, over the partition-honest Cosmos fake, so the tenant-doc location
 * (`access-policies:<tid>` in partition `<tid>`) is observed, not assumed.
 *
 * Each load-bearing assertion names the defect that would turn it red.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('@/lib/auth/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/session')>();
  return { ...actual, getSession: vi.fn() };
});
vi.mock('@/lib/azure/cosmos-client', () => {
  class CosmosNotConfiguredError extends Error {}
  return { tenantSettingsContainer: vi.fn(), workspacesContainer: vi.fn(), CosmosNotConfiguredError };
});
vi.mock('@/lib/auth/feature-gate', () => ({ checkCapability: vi.fn(), enforceCapability: vi.fn() }));
vi.mock('@/lib/azure/access-policy-client', () => ({
  enforceAccessGrant: vi.fn(), revokeAccessGrant: vi.fn(), revokeStructuredGrant: vi.fn(),
}));

import { GET, POST, PUT, DELETE } from '../policies/route';
import { getSession } from '@/lib/auth/session';
import { tenantSettingsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import { checkCapability, enforceCapability } from '@/lib/auth/feature-gate';
import { enforceAccessGrant, revokeAccessGrant, revokeStructuredGrant } from '@/lib/azure/access-policy-client';
import { loadOrSeedPolicies } from '@/lib/governance/policy-store';
import {
  makePartitionedContainer, type FakeContainer,
} from '@/app/api/access-requests/__tests__/partitioned-cosmos-fake';

const TENANT = 'tenant-1-tid';
const USER = { oid: 'user-oid', tid: TENANT, upn: 'user@contoso.com' };
const OTHER = 'other-author-oid';
const TENANT_DOC_ID = `access-policies:${TENANT}`;
const RA_ID = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/acct/blobServices/default/containers/gold/providers/Microsoft.Authorization/roleAssignments/ra-1';

let admin = false;
let settings: FakeContainer;

function accessPolicy(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, name: `Access ${id}`, kind: 'Access', scope: 'tenant', rule: '', enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'someone',
    principalId: 'grantee-oid', principalType: 'User', scopeType: 'adls-container', scopeRef: 'gold',
    permission: 'read', enforcement: { status: 'active', roleAssignmentId: RA_ID },
    ...extra,
  };
}

function seedSettings() {
  settings = makePartitionedContainer({
    partitionKeyPath: '/tenantId',
    seed: [
      // The tenant Access-policy doc.
      { id: TENANT_DOC_ID, tenantId: TENANT, kind: 'access-policies', items: [accessPolicy('tenant-ap')], updatedAt: 'x' },
      // The caller's own doc, holding an Access policy recorded before the tenant doc.
      {
        id: `policies:${USER.oid}`, tenantId: USER.oid, kind: 'policies', seededDefaults: [],
        items: [accessPolicy('own-legacy-ap')], updatedAt: 'x',
      },
      // Another author's doc with a pre-existing Access policy.
      {
        id: `policies:${OTHER}`, tenantId: OTHER, kind: 'policies', seededDefaults: [],
        items: [accessPolicy('other-legacy-ap')], updatedAt: 'x',
      },
    ],
  });
  (tenantSettingsContainer as any).mockResolvedValue(settings);
}

function docById(id: string) {
  return settings.__all().find((d) => d.id === id);
}
function itemIds(id: string): string[] {
  return (docById(id)?.items || []).map((p: any) => p.id);
}

function jsonReq(body: any) {
  return { json: async () => body, nextUrl: new URL('http://console.local/api/governance/policies') } as any;
}
function delReq(id: string) {
  return { nextUrl: new URL(`http://console.local/api/governance/policies?id=${encodeURIComponent(id)}`) } as any;
}
const CTX = { params: Promise.resolve({}) } as any;

beforeEach(async () => {
  vi.resetAllMocks();
  admin = false;
  (getSession as any).mockReturnValue({ claims: USER, exp: Date.now() / 1000 + 3600 });
  seedSettings();
  (workspacesContainer as any).mockResolvedValue({
    items: { query: () => ({ fetchAll: async () => ({ resources: [USER.oid, OTHER] }) }) },
  });
  (checkCapability as any).mockImplementation(async () => ({ allow: admin }));
  (enforceCapability as any).mockImplementation(async () =>
    admin ? null : NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 }));
  (enforceAccessGrant as any).mockResolvedValue({ status: 'active', roleName: 'Storage Blob Data Reader', roleAssignmentId: RA_ID });
  (revokeAccessGrant as any).mockResolvedValue(undefined);
  (revokeStructuredGrant as any).mockResolvedValue(undefined);
  // Settle the caller's doc: the first read of a `policies:<oid>` doc seeds the
  // built-in DLP/label defaults, which is a write unrelated to Access policies.
  // Doing it here keeps the "nothing is written" snapshots below about the gate.
  await loadOrSeedPolicies(USER.oid);
});

const ACCESS_BODY = {
  name: 'Grant gold', kind: 'Access',
  principalId: 'grantee-oid', principalType: 'User', scopeType: 'adls-container', scopeRef: 'gold', permission: 'admin',
};

describe('POST — creating an Access policy', () => {
  it('403 for a non-admin: no grant is made and nothing is saved', async () => {
    // Breaks on: dropping `if (gate) return gate` (→ 200, 1 grant, tenant doc grows).
    const before = JSON.stringify(settings.__all());
    const res = await POST(jsonReq(ACCESS_BODY), CTX);
    expect(res.status).toBe(403);
    expect(enforceAccessGrant).not.toHaveBeenCalled();
    expect(JSON.stringify(settings.__all())).toBe(before);
    // The gate asked for the tenant-admin capability, not a weaker one.
    expect(enforceCapability).toHaveBeenCalledWith(expect.anything(), 'admin.permissions', 'Admin');
  });

  it('an admin creates it in the tenant doc and the grant is made', async () => {
    // Positive pair for the 403 above. Breaks on: a gate that refuses admins,
    // or saving into the author's own `policies:<oid>` doc instead.
    admin = true;
    const res = await POST(jsonReq(ACCESS_BODY), CTX);
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(enforceAccessGrant).toHaveBeenCalledTimes(1);
    expect(enforceAccessGrant).toHaveBeenCalledWith(expect.objectContaining({
      principalId: 'grantee-oid', scopeType: 'adls-container', scopeRef: 'gold', permission: 'admin',
    }));
    expect(itemIds(TENANT_DOC_ID)).toContain(j.policy.id);
    expect(docById(TENANT_DOC_ID).tenantId).toBe(TENANT);
    expect(itemIds(`policies:${USER.oid}`)).not.toContain(j.policy.id);
  });

  it('a non-admin still creates a DLP policy (non-Access kinds are unchanged)', async () => {
    // Breaks on: gating every kind (→ 403).
    const res = await POST(jsonReq({ name: 'PII', kind: 'DLP', rule: 'block ssn' }), CTX);
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(itemIds(`policies:${USER.oid}`)).toContain(j.policy.id);
    expect(enforceCapability).not.toHaveBeenCalled();
    expect(enforceAccessGrant).not.toHaveBeenCalled();
  });
});

describe('PUT — editing an Access policy', () => {
  it.each(['tenant-ap', 'own-legacy-ap'])('403 for a non-admin editing %s; nothing is written', async (id) => {
    // own-legacy-ap is in the caller's OWN doc — breaks on a gate that only
    // covers the tenant doc. Breaks on: dropping the PUT gate (→ 200, renamed).
    const before = JSON.stringify(settings.__all());
    const res = await PUT(jsonReq({ id, name: 'renamed', enabled: false }), CTX);
    expect(res.status).toBe(403);
    expect(JSON.stringify(settings.__all())).toBe(before);
  });

  it('an admin edits the name but not the grant fields', async () => {
    // Breaks on: a PUT that spreads the body (scopeRef → 'other').
    admin = true;
    const res = await PUT(jsonReq({ id: 'tenant-ap', name: 'renamed', scopeRef: 'other', permission: 'admin' }), CTX);
    expect(res.status).toBe(200);
    const p = docById(TENANT_DOC_ID).items.find((x: any) => x.id === 'tenant-ap');
    expect(p.name).toBe('renamed');
    expect(p.scopeRef).toBe('gold');
    expect(p.permission).toBe('read');
  });

  it("a non-admin cannot address another author's Access policy (404, not found)", async () => {
    // Breaks on: searching other users' docs for a non-admin.
    const res = await PUT(jsonReq({ id: 'other-legacy-ap', name: 'x' }), CTX);
    expect(res.status).toBe(404);
  });
});

describe('DELETE — removing an Access policy', () => {
  it.each(['tenant-ap', 'own-legacy-ap'])('403 for a non-admin deleting %s; no revoke, nothing removed', async (id) => {
    // Breaks on: dropping the DELETE gate (→ 200, revokeAccessGrant(RA_ID), item gone).
    const before = JSON.stringify(settings.__all());
    const res = await DELETE(delReq(id), CTX);
    expect(res.status).toBe(403);
    expect(revokeAccessGrant).not.toHaveBeenCalled();
    expect(revokeStructuredGrant).not.toHaveBeenCalled();
    expect(JSON.stringify(settings.__all())).toBe(before);
  });

  it("an admin deletes another author's pre-existing Access policy and its grant is revoked", async () => {
    // Positive pair. Breaks on: legacy docs not addressable by an admin (404),
    // or the revoke skipped.
    admin = true;
    const res = await DELETE(delReq('other-legacy-ap'), CTX);
    expect(res.status).toBe(200);
    expect(revokeAccessGrant).toHaveBeenCalledWith(RA_ID);
    expect(itemIds(`policies:${OTHER}`)).not.toContain('other-legacy-ap');
    expect(docById(`policies:${OTHER}`)).toBeTruthy(); // the doc itself is kept
  });
});

describe('GET — listing', () => {
  it('a non-admin sees their own policies only, with canManageAccess=false', async () => {
    // Breaks on: listing the tenant doc to everyone (tenant-ap present).
    const res = await GET(jsonReq({}), CTX);
    const j = await res.json();
    const ids = j.policies.map((p: any) => p.id);
    expect(j.canManageAccess).toBe(false);
    expect(ids).toContain('own-legacy-ap');
    expect(ids).not.toContain('tenant-ap');
    expect(ids).not.toContain('other-legacy-ap');
  });

  it("an admin sees the tenant doc and other authors' pre-existing Access policies", async () => {
    admin = true;
    const res = await GET(jsonReq({}), CTX);
    const j = await res.json();
    const ids = j.policies.map((p: any) => p.id);
    expect(j.canManageAccess).toBe(true);
    expect(ids).toEqual(expect.arrayContaining(['own-legacy-ap', 'tenant-ap', 'other-legacy-ap']));
  });
});
