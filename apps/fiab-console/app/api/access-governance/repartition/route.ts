/**
 * POST /api/access-governance/repartition — move pre-fix F16 access requests
 * onto the tenant partition key. Tenant-admin only.
 *
 * Body: { confirm?: boolean }   — DRY RUN unless `confirm: true`.
 *
 * Background. `access-request-workflow` is partitioned by `/tenantId`. That
 * field used to be stamped with the REQUESTER's Entra `oid`, while the approval
 * inbox and the decision route read the SIGNED-IN user's `oid` — so an approver
 * saw zero rows and a decision POST 404'd. The routes now stamp and read
 * `tenantScopeId(session)` (the Entra tenant). Cosmos partition keys are
 * immutable, so requests filed BEFORE that change are still in per-requester
 * partitions and remain invisible to the inbox until they are physically
 * rewritten. This endpoint does that rewrite.
 *
 * It is safe to run repeatedly (idempotent), it never silently skips a document
 * it could not move, and it verifies the outcome with an independent re-scan
 * instead of trusting its own counters. See lib/access/repartition-access-requests.
 *
 * ORDER OF OPERATIONS on an existing estate:
 *   1. POST here with no body      → dry run; read `plan` + `needingMigration`.
 *   2. POST here with {confirm:true} → apply; require `ok:true, residual:0`.
 *   3. POST /api/access-governance/backfill → seed the entitlement ledger.
 * Running step 3 before step 2 completes would seed the ledger from requests
 * the inbox still cannot show.
 *
 * Route-toolkit: withTenantAdmin (R3).
 */
import { NextResponse } from 'next/server';
import { tenantScopeId } from '@/lib/auth/session';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { accessRequestWorkflowContainer, auditLogContainer } from '@/lib/azure/cosmos-client';
import {
  repartitionAccessRequests, tenantFingerprint,
  type RepartitionContainer,
} from '@/lib/access/repartition-access-requests';
import { apiServerError } from '@/lib/api/respond';
import crypto from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withTenantAdmin(async (req, { session: s }) => {
  const body = await req.json().catch(() => ({} as any));
  const dryRun = body?.confirm !== true;

  const targetTenantId = tenantScopeId(s);
  // tenantScopeId falls back to `oid` when the session carries no `tid`. Moving
  // every document onto ONE user's oid would re-create the very defect this
  // migration exists to undo, so refuse rather than proceed on that fallback.
  if (!s.claims.tid) {
    return NextResponse.json(
      {
        ok: false,
        error: 'no_tenant_claim',
        reason:
          'Your session carries no Entra tenant (`tid`) claim, so the destination ' +
          'partition could not be determined. NOTHING was scanned or moved — this ' +
          'is a refusal, not a completed no-op.',
        remediation:
          'Sign out and sign in again so a current session is minted (sessions ' +
          'issued before the tid claim was added lack it), then retry.',
      },
      { status: 409 },
    );
  }

  try {
    const c = (await accessRequestWorkflowContainer()) as unknown as RepartitionContainer;
    const result = await repartitionAccessRequests(c, targetTenantId, { dryRun });

    if (!dryRun) {
      // Audit the mutation itself — including a failed one.
      const al = await auditLogContainer();
      await al.items.create({
        id: crypto.randomUUID(),
        itemId: 'access-request-workflow',
        itemType: 'migration',
        action: 'repartition-access-requests',
        summary:
          `Repartitioned access requests onto tenant ${tenantFingerprint(targetTenantId)}: ` +
          `scanned ${result.scanned}, needed ${result.needingMigration}, moved ${result.moved}, ` +
          `already-migrated ${result.alreadyMigrated}, failed ${result.failed.length}, ` +
          `residual ${result.residual}.`,
        upn: s.claims.upn || s.claims.oid,
        at: new Date().toISOString(),
      });
    }

    return NextResponse.json(
      { ...result, targetTenant: tenantFingerprint(targetTenantId) },
      { status: result.ok ? 200 : 500 },
    );
  } catch (e: any) {
    return apiServerError(e);
  }
});
