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
 * THE SECOND BOUNDARY (#3943 follow-on, the #2703 class). Closing the ownership
 * hole introduced a tenant-admin escape hatch, and `isTenantAdmin` establishes
 * only that the caller is an admin OF THE DEPLOYMENT — nothing about which Entra
 * tenant they are in. The only thing bounding it was the partition key of the
 * point read, and `tenantScopeId` is `tid || oid`, so a session with no `tid`
 * scoped the admin grant to a PRINCIPAL and compared no tenancies at all. The
 * route now conjoins `sameTenantConfirmed(session.claims.tid, product.tenantId)`
 * — a POSITIVE match that fails closed. The three tenancy tests below all return
 * 200 without that conjunct, which is what makes them worth having.
 *
 * The store mock deliberately hands back a product whose `tenantId` is NOT the
 * caller's scope. Live Cosmos would 404 that (PK /tenantId point read), so these
 * cases assert the route's OWN boundary rather than the store's — the property
 * that survives a cross-partition query, a store refactor, or a widened read.
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
  // The default session carries NO `tid`, which is deliberate and load-bearing:
  // it proves the tenancy conjunct added for the admin branch did not leak onto
  // the OWNER branch. An oid identity match needs no tenant lookup, so an owner
  // on a PAT / tid-less session must keep working.
  it('200 for the owner — certifies and publishes the draft (no tid needed)', async () => {
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
  // The session now carries the product's OWN tid, because that is the only
  // shape the branch admits after the #2703-class fix below.
  it('200 for a tenant admin IN THE PRODUCT TENANT adopting an UNOWNED product', async () => {
    process.env.LOOM_TENANT_ADMIN_OID = 'admin-oid';
    getSessionMock.mockReturnValue({
      claims: { oid: 'admin-oid', tid: 'victim-tenant', upn: 'admin@victim.example' },
    });
    const product = unownedDraft(); // tenantId: 'victim-tenant'
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

// ── THE TENANT BOUNDARY ON THE ADMIN BRANCH (#2703 class) ───────────────────
// Every case here returns 200 — publishing another tenant's draft — against a
// route whose admin branch is `!isOwner && !isTenantAdmin(session)`. They are
// the differential evidence for the `sameTenantConfirmed` conjunct.
describe('POST /api/marketplace/products/[id]/certify — admin tenant boundary', () => {
  beforeEach(() => {
    process.env.LOOM_TENANT_ADMIN_OID = 'admin-oid';
  });

  it('403 for a tenant admin in ANOTHER tenant — no write, draft stays unpublished', async () => {
    getSessionMock.mockReturnValue({
      claims: { oid: 'admin-oid', tid: 'attacker-tenant', upn: 'admin@attacker.example' },
    });
    const product = unownedDraft(); // tenantId: 'victim-tenant'
    getProductMock.mockResolvedValue(product);

    const res = await POST(req(), ctx('mp-ontology-orders'));

    expect(res.status).toBe(403);
    expect(upsertProductMock).not.toHaveBeenCalled();
    expect(product.publishStatus).toBe('draft');
    expect(product.certification).toBe('draft');
    expect(product.certifiedAt).toBeUndefined();
  });

  // FAILS CLOSED on `unconfirmed`, which is the whole point of using
  // `sameTenantConfirmed` rather than a `tid !== tid` non-contradiction test:
  // an absent claim decides NOTHING, and "decides nothing" must not fall
  // through to a grant. A tid-less session is a supported state (PAT / msal
  // overage), so this is the realistic shape, not an exotic one.
  it('403 for a tenant admin whose session carries NO tid (tenancy unconfirmed)', async () => {
    getSessionMock.mockReturnValue({ claims: { oid: 'admin-oid', upn: 'admin@nowhere.example' } });
    const product = unownedDraft();
    getProductMock.mockResolvedValue(product);

    const res = await POST(req(), ctx('mp-ontology-orders'));

    expect(res.status).toBe(403);
    expect(upsertProductMock).not.toHaveBeenCalled();
    expect(product.publishStatus).toBe('draft');
  });

  // R7 — the refusal states what was actually established. "You are not an
  // admin" would be a false claim about an admin the route could not place in
  // a tenant, and it is the one refusal with a remediation (stamp the claim).
  it('names the UNCONFIRMED tenancy in the refusal, not a bare "not an owner"', async () => {
    getSessionMock.mockReturnValue({ claims: { oid: 'admin-oid', upn: 'admin@nowhere.example' } });
    getProductMock.mockResolvedValue(unownedDraft());

    const res = await POST(req(), ctx('mp-ontology-orders'));
    const j = await res.json();

    expect(j.ok).toBe(false);
    expect(j.error).toMatch(/tenanc/i);
    expect(j.error).toMatch(/no `?tid`? claim|carries no/i);
  });

  // A non-admin gets the ordinary refusal — the tenancy wording must not leak
  // onto a caller whose admin-ness was never in question.
  it('a NON-admin still gets the plain owner/admin refusal', async () => {
    getSessionMock.mockReturnValue({ claims: { oid: 'nobody-oid', upn: 'nobody@x.example' } });
    getProductMock.mockResolvedValue(unownedDraft());

    const res = await POST(req(), ctx('mp-ontology-orders'));
    const j = await res.json();

    expect(res.status).toBe(403);
    expect(j.error).toMatch(/owner|admin/i);
    expect(j.error).not.toMatch(/tenanc/i);
  });

  // The owner branch never consults tenancy, so a cross-tenant *owner* row is
  // still certifiable by its owner. Stated as a deliberate scope line rather
  // than left as an untested assumption: ownership is an oid identity match,
  // and the record reached the handler through a tenant-partitioned point read.
  it('200 for the OWNER even when the record names another tenant', async () => {
    getSessionMock.mockReturnValue({ claims: { oid: 'owner-oid', tid: 'attacker-tenant' } });
    const product = { ...unownedDraft(), ownerOid: 'owner-oid' }; // tenantId: 'victim-tenant'
    getProductMock.mockResolvedValue(product);

    const res = await POST(req(), ctx('mp-ontology-orders'));

    expect(res.status).toBe(200);
    expect(upsertProductMock).toHaveBeenCalledTimes(1);
  });
});
