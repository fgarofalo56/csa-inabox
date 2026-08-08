/**
 * POST /api/access-governance/sweep — the expiry sweeper (access-governance W3).
 *
 * Finds entitlement-ledger assignments that are ACTIVE and past their expiresAt,
 * revokes the real grant (revokeStructuredGrant for SQL/ADX + revokeAccessGrant
 * for the ARM role assignment), and marks the ledger row 'expired'. Eligible
 * (not-activated) and permanent (no expiresAt) assignments are skipped.
 *
 * Idempotent (an already-expired row is never re-processed) and audited. Supports
 * ?dryRun=1 (report what WOULD expire, revoke nothing). Runs day-one via the
 * admin "Run sweep" button (tenant-admin session), AND on a schedule from the
 * in-VNet `loom-access-sweep` Container App Job
 * (modules/admin-plane/access-governance-sweeper-job.bicep), which presents the
 * deploy-minted shared internal token.
 *
 * C17: the machine path used to require LOOM_SWEEPER_TOKEN, which the deploy set
 * NOWHERE — so the schedule never ran and expiry auto-revoke was
 * admin-button-only. See lib/access/sweep-auth.ts for the measurement and fix.
 */
import { NextRequest, NextResponse } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { accessAssignmentsContainer, auditLogContainer } from '@/lib/azure/cosmos-client';
import type { AccessAssignment } from '@/lib/types/access-assignment';
import { revokeAccessGrant, revokeStructuredGrant, type AccessScopeType, type AccessPermission } from '@/lib/azure/access-policy-client';
import { expireAssignment } from '@/lib/access/assignment-ledger';
import { selectExpired } from '@/lib/access/expiry';
import { isSweepSystemCaller } from '@/lib/access/sweep-auth';
import crypto from 'node:crypto';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The sweep itself — identical work for the system caller and a human admin. */
async function runSweep(req: NextRequest, by: string): Promise<Response> {
  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1';
  const now = new Date();

  const c = await accessAssignmentsContainer();
  // Query the candidates server-side, then re-filter with the pure selector.
  const { resources } = await c.items
    .query<AccessAssignment>({
      query: "SELECT * FROM c WHERE c.state = 'active' AND IS_DEFINED(c.expiresAt) AND c.expiresAt != null AND c.expiresAt <= @now",
      parameters: [{ name: '@now', value: now.toISOString() }],
    })
    .fetchAll();
  const due = selectExpired(resources || [], now);

  if (dryRun) {
    return NextResponse.json({
      ok: true, dryRun: true, candidates: due.length,
      assignments: due.map((a) => ({ id: a.id, principalId: a.principalId, resourceType: a.resourceType, resourceRef: a.resourceRef, expiresAt: a.expiresAt })),
    });
  }

  let expired = 0; const errors: string[] = [];
  const al = await auditLogContainer();
  for (const a of due) {
    // Revoke the real grant (both paths, best-effort — neither blocks the sweep).
    if (a.roleAssignmentId) { try { await revokeAccessGrant(a.roleAssignmentId); } catch (e: any) { errors.push(`${a.id}: ${e?.message || e}`); } }
    try {
      await revokeStructuredGrant({
        principalId: a.principalId,
        principalName: a.principalUpn,
        principalType: (a.principalType as any) || 'User',
        scopeType: a.resourceType as AccessScopeType,
        scopeRef: a.resourceRef,
        permission: (a.permission as AccessPermission) || 'read',
      });
    } catch (e: any) { errors.push(`${a.id}: ${e?.message || e}`); }
    const ok = await expireAssignment(a.id, a.principalId);
    if (ok) {
      expired++;
      try {
        await al.items.create({
          id: crypto.randomUUID(),
          itemId: a.resourceRef,
          itemType: a.resourceType,
          action: 'access-expired',
          summary: `Time-bound access for ${a.principalUpn || a.principalId} on ${a.resourceName || a.resourceRef} expired at ${a.expiresAt} and was revoked (sweeper).`,
          upn: a.principalUpn || a.principalId,
          at: new Date().toISOString(),
        });
      } catch { /* audit best-effort */ }
    }
  }

  return NextResponse.json({
    ok: true, dryRun: false, candidates: due.length, expired,
    ...(errors.length ? { revokeWarnings: errors.slice(0, 20) } : {}),
    by,
  });
}

/** Human-admin path — session (401) + tenant-admin (403) through the toolkit. */
const adminSweep = withTenantAdmin(async (req: NextRequest, { session }) =>
  runSweep(req, session.claims.upn || session.claims.oid),
);

export async function POST(req: NextRequest) {
  // Auth: the scheduled ACA job presents the deploy-minted internal token; a
  // human admin goes through the shared route-toolkit. Either satisfies the
  // guard, and neither path is weaker than before.
  if (!isSweepSystemCaller(req)) return adminSweep(req, { params: Promise.resolve({}) });
  try {
    return await runSweep(req, 'system');
  } catch (e) {
    return apiServerError(e);
  }
}
