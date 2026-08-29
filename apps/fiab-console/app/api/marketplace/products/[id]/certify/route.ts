/**
 * WS-10.4 Living Marketplace — RE-CERTIFY a product (owner action / gate fix).
 *
 *   POST /api/marketplace/products/[id]/certify
 *
 * Re-runs the gate registry as auto-certification against the CURRENT env and
 * updates the product's certification + publish status. Use after a "Fix it"
 * gate remediation flips a blocked gate to configured so the product can go
 * from failed → certified → published without re-publishing from scratch.
 */
import { NextRequest } from 'next/server';
import { tenantScopeId } from '@/lib/auth/session';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { classifyTenantMatch, sameTenantConfirmed, tenantUnconfirmedCause } from '@/lib/auth/tenant-boundary';
import { apiOk, apiForbidden, apiNotFound, apiServerError } from '@/lib/api/respond';
import { getProduct, upsertProduct } from '@/lib/marketplace/product-store';
import { runCertification } from '@/lib/marketplace/certification';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withSession<{ id: string }>(async (_req: NextRequest, { session, params }) => {
  try {
    const { id } = params;
    const tenantId = tenantScopeId(session);

    const product = await getProduct(tenantId, id);
    if (!product) return apiNotFound('product not found');
    // Only the owner — or a tenant admin IN THE PRODUCT'S OWN TENANT — may
    // re-certify. TWO boundaries, and the first pass at #3943 only closed one.
    //
    // 1. OWNERSHIP, positively matched. `ownerOid` is optional, so
    //    `product.ownerOid && product.ownerOid !== oid` short-circuited to a
    //    PASS on every unowned product (seeded / imported / created before the
    //    field), and certifying flips draft → published below — i.e. any tenant
    //    user could publish someone else's draft. An absent owner is a REFUSAL.
    //
    // 2. TENANCY, positively matched. The admin branch is the escape hatch that
    //    keeps a genuinely orphaned row recoverable (an admin can adopt +
    //    certify), but it is a grant over a product the caller does NOT own, and
    //    `isTenantAdmin` establishes only that the caller is an admin OF THIS
    //    DEPLOYMENT — it reads env-configured group ids / a bootstrap oid
    //    (`lib/auth/feature-gate.ts`) and says nothing about which Entra tenant
    //    the caller is in. The only thing bounding the grant was the partition
    //    key of the point read above, and `tenantScopeId` is `tid || oid`: for a
    //    session carrying no `tid` — a supported state by design, see
    //    `lib/auth/msal.ts` / `lib/auth/pat.ts` — that silently degrades to a
    //    PER-PRINCIPAL scope, so the admin grant was never subjected to a tenant
    //    comparison at all. `sameTenantConfirmed` (`lib/auth/tenant-boundary.ts`,
    //    the ONE implementation of this comparison) is a POSITIVE match that
    //    fails closed on `unconfirmed`, which is the contract that module states
    //    for precisely this caller: one "about to make a TENANT-WIDE grant".
    //
    // The owner path is untouched by (2): an oid identity match needs no tenant
    // lookup, so an owner whose session carries no `tid` keeps working.
    //
    // `isTenantAdmin(session)` IS DELIBERATELY INLINE IN THE `if`, not hoisted
    // into a named const. Section 8h of `scripts/ci/check-tid-boundary-chokepoint.mjs`
    // finds this shape by reading the path condition of the allowing return;
    // hoisting it reads better and would make the guard blind to this decision,
    // which is the exact evasion that file exists to prevent. The census entry
    // for this route lives in that guard's ADMIN_SHAPE_UNSCOPED — keep both.
    //
    // #4010 — THE ESCAPE HATCH WAS DEAD IN THE ONE DEPLOYMENT IT WAS WRITTEN FOR.
    //
    // `sameTenantConfirmed` alone never discriminated here, and the measurement
    // is the read above: `getProduct` is a STRICT POINT READ on a container whose
    // partition key IS `/tenantId`, so `product.tenantId === tenantScopeId(session)`
    // holds by construction — the document could not have been read otherwise.
    // `tenantScopeId` is `tid || oid`, so the conjunct was
    //   - always TRUE for a tid-bearing session (the partition key WAS the tid), and
    //   - always FALSE for a tid-less one (no tid to positively match).
    // The second branch is the single-operator bootstrap `lib/auth/session.ts`
    // names as the reason the `|| oid` fallback exists: an orphaned product (no
    // `ownerOid`) was a PERMANENT 403 whose remediation — "supply a tid" — the
    // operator cannot act on, in exactly the deployment most likely to hold
    // orphaned rows. A dead end with an unactionable remediation is what
    // `auto-bind-by-default.md` and `ux-baseline.md` G2 forbid.
    //
    // WHAT REPLACES IT, AND WHY IT IS NOT A WIDENING. `unconfirmed` is admitted
    // ONLY when partition identity stands in for the comparison — the row was
    // read out of the caller's OWN scope partition. On the tid-less path that
    // partition is the caller's own `oid`, so the grant reaches a row nobody else
    // could have written under that key; on the tid-bearing path
    // `sameTenantConfirmed` still carries the decision and `different-tenant`
    // still refuses. Nothing cross-tenant is admitted that was not already
    // reachable: the point read is the bound, and it ran first.
    const scopeId = tenantScopeId(session);
    const partitionBound = !!scopeId && scopeId === product.tenantId;
    const tenantOk =
      sameTenantConfirmed(session.claims.tid, product.tenantId)
      || (partitionBound && classifyTenantMatch(session.claims.tid, product.tenantId) === 'unconfirmed');
    const isOwner = !!product.ownerOid && product.ownerOid === session.claims.oid;
    if (!isOwner && !(isTenantAdmin(session) && tenantOk)) {
      // R7 — say what was actually established. An admin refused for an
      // unconfirmed tenancy is a different fact from "you are not an admin",
      // and only the first one has a remediation the caller can act on.
      const cause = isTenantAdmin(session)
        ? tenantUnconfirmedCause(session.claims.tid, product.tenantId)
        : null;
      return apiForbidden(
        cause
          ? `tenant admins may only re-certify a product in their own Entra tenant, and the tenancy could not be confirmed: ${cause}`
          : "only the product owner or a tenant admin in the product's own tenant can re-certify",
      );
    }

    const cert = runCertification(product.productKind);
    product.certification = cert.certification;
    product.requiredGateIds = cert.requiredGateIds;
    product.certGates = cert.gates;
    if (cert.certification === 'certified') {
      product.certifiedAt = new Date().toISOString();
      if (product.publishStatus === 'draft') product.publishStatus = 'published';
    }
    const saved = await upsertProduct(product);

    return apiOk({ product: saved, certification: cert.certification, gates: cert.gates, blockers: cert.blockers });
  } catch (e) {
    return apiServerError(e, 'failed to re-certify product', 'marketplace_certify_failed');
  }
});
