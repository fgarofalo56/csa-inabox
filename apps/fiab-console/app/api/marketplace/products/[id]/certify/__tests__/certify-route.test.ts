/**
 * BFF route tests for POST /api/marketplace/products/[id]/certify — the
 * re-certify (owner action / gate fix) surface.
 *
 * #3943: the ownership guard was `product.ownerOid && product.ownerOid !== oid`,
 * which SHORT-CIRCUITS TO A PASS on any product whose optional `ownerOid` is
 * unset (seeded / imported / migrated / created by a path that omits it).
 * Certifying flips draft → published, so the fail-open let an arbitrary
 * authenticated tenant user PUBLISH someone else's unpublished product.
 *
 * The load-bearing case here is the NARROW one — an UNOWNED product, not a
 * mismatched owner. A suite that only exercises a mismatched owner stays green
 * over the live hole, which is exactly why it went unnoticed.
 *
 * The gate registry is stubbed (ontology requires zero gates, so it is never
 * consulted) and the product store is in-memory — no live Azure. `isTenantAdmin`
 * is the REAL implementation driven by LOOM_TENANT_ADMIN_OID, so the admin test
 * proves the promised branch is actually wired, not that a mock returned true.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MarketplaceProduct } from '@/lib/marketplace/product-types';

const getSessionMock = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getSession: () => getSessionMock(),
  // Real implementation (tid || oid) — these fixtures carry no tid.
  tenantScopeId: (s: any) => s?.claims?.tid || s?.claims?.oid,
}));

const getProductMock = vi.fn();
const upsertProductMock = vi.fn(async (p: MarketplaceProduct) => p);
vi.mock('@/lib/marketplace/product-store', () => ({
  getProduct: (t: string, id: string) => getProductMock(t, id),
  upsertProduct: (p: MarketplaceProduct) => upsertProductMock(p),
}));

// Cut the Cosmos import chain pulled in by lib/auth/feature-gate. Tenant-admin
// resolution itself is claims + env only, so it stays REAL below.
vi.mock('@/lib/azure/cosmos-client', () => ({
  featurePermissionsContainer: vi.fn(),
}));

// ontology requires zero gates, so neither of these is called on these paths —
// stubbed only to keep the certification module's import hermetic.
vi.mock('@/lib/gates/registry', () => ({
  gateStatus: vi.fn(() => ({ id: 'stub', status: 'configured', missing: [] })),
  getGate: vi.fn(() => ({ id: 'stub', title: 'stub' })),
}));

import { POST } from '../route';

const ORIG_ADMIN_OID = process.env.LOOM_TENANT_ADMIN_OID;
const ORIG_ADMIN_GROUP = process.env.LOOM_TENANT_ADMIN_GROUP_ID;

/** An UNOWNED, draft ontology product — the #3943 exploit shape. */
function unownedDraft(): MarketplaceProduct {
  return {
    id: 'mp-ontology-orders',
    docType: 'marketplace-product',
    tenantId: 'victim-tenant',
    productKind: 'ontology',
    name: 'orders',
    displayName: 'Orders ontology',
    // ownerOid deliberately ABSENT — seeded / imported / pre-field row.
    certification: 'draft',
    requiredGateIds: [],
    certGates: [],
    accessModel: 'request',
    grantResourceType: 'ontology',
    grantRole: 'Reader',
    lcuPerSubscription: 0,
    publishStatus: 'draft',
    subscriberCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = () => new Request('http://x/api/marketplace/products/mp-ontology-orders/certify', { method: 'POST' }) as any;

beforeEach(() => {
  // No tenant admin configured by default — the caller is an ordinary user.
  delete process.env.LOOM_TENANT_ADMIN_OID;
  delete process.env.LOOM_TENANT_ADMIN_GROUP_ID;
  getSessionMock.mockReturnValue({ claims: { oid: 'attacker-oid', upn: 'mallory@contoso.com' } });
  upsertProductMock.mockImplementation(async (p: MarketplaceProduct) => p);
});
afterEach(() => {
  vi.clearAllMocks();
  if (ORIG_ADMIN_OID) process.env.LOOM_TENANT_ADMIN_OID = ORIG_ADMIN_OID;
  else delete process.env.LOOM_TENANT_ADMIN_OID;
  if (ORIG_ADMIN_GROUP) process.env.LOOM_TENANT_ADMIN_GROUP_ID = ORIG_ADMIN_GROUP;
  else delete process.env.LOOM_TENANT_ADMIN_GROUP_ID;
});

describe('POST /api/marketplace/products/[id]/certify — ownership (#3943)', () => {
  it('401 without a session', async () => {
    getSessionMock.mockReturnValue(null);
    const res = await POST(req(), ctx('mp-ontology-orders'));
    expect(res.status).toBe(401);
    expect(getProductMock).not.toHaveBeenCalled();
  });

  it('404 when the product does not exist', async () => {
    getProductMock.mockResolvedValue(null);
    const res = await POST(req(), ctx('mp-ontology-missing'));
    expect(res.status).toBe(404);
    expect(upsertProductMock).not.toHaveBeenCalled();
  });

  // ── THE NARROW CASE: unowned product, ordinary caller ─────────────────────
  // Against the pre-#3943 tree this returns 200 and publishStatus flips to
  // 'published'. The non-write + unchanged-status assertions matter: a "fix"
  // that 403s AFTER mutating would still satisfy a status-code-only test.
  it('403 on an UNOWNED product — no write, and the draft is NOT published', async () => {
    const product = unownedDraft();
    getProductMock.mockResolvedValue(product);

    const res = await POST(req(), ctx('mp-ontology-orders'));

    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.error).toMatch(/owner|admin/i);
    expect(upsertProductMock).not.toHaveBeenCalled();
    expect(product.publishStatus).toBe('draft');
    expect(product.certification).toBe('draft');
    expect(product.certifiedAt).toBeUndefined();
  });

  it('403 when the product belongs to another user (no write)', async () => {
    const product = { ...unownedDraft(), ownerOid: 'victim-oid' };
    getProductMock.mockResolvedValue(product);

    const res = await POST(req(), ctx('mp-ontology-orders'));

    expect(res.status).toBe(403);
    expect(upsertProductMock).not.toHaveBeenCalled();
    expect(product.publishStatus).toBe('draft');
  });

  // ── Not over-tight: the legitimate paths still work ───────────────────────
  it('200 for the owner — certifies and publishes the draft', async () => {
    const product = { ...unownedDraft(), ownerOid: 'attacker-oid' }; // caller IS the owner here
    getProductMock.mockResolvedValue(product);

    const res = await POST(req(), ctx('mp-ontology-orders'));

    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.certification).toBe('certified');
    expect(upsertProductMock).toHaveBeenCalledTimes(1);
    expect(product.publishStatus).toBe('published');
    expect(typeof product.certifiedAt).toBe('string');
  });

  // The ONLY test that fails if the tenant-admin branch the old comment
  // promised is left unimplemented — it is the escape hatch that keeps a
  // genuinely orphaned product recoverable instead of permanently stuck.
  it('200 for a tenant admin adopting an UNOWNED product', async () => {
    process.env.LOOM_TENANT_ADMIN_OID = 'attacker-oid'; // same caller, now an admin
    const product = unownedDraft();
    getProductMock.mockResolvedValue(product);

    const res = await POST(req(), ctx('mp-ontology-orders'));

    expect(res.status).toBe(200);
    expect(upsertProductMock).toHaveBeenCalledTimes(1);
    expect(product.publishStatus).toBe('published');
  });

  it('403 for a NON-admin when a different oid is the configured tenant admin', async () => {
    process.env.LOOM_TENANT_ADMIN_OID = 'someone-else-oid';
    const product = unownedDraft();
    getProductMock.mockResolvedValue(product);

    const res = await POST(req(), ctx('mp-ontology-orders'));

    expect(res.status).toBe(403);
    expect(upsertProductMock).not.toHaveBeenCalled();
    expect(product.publishStatus).toBe('draft');
  });
});
