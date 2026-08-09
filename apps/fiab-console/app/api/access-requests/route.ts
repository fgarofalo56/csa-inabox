/**
 * GET /api/access-requests — the multi-tier approval inbox (F16).
 *
 * Query params:
 *   ?tier=manager|privacy|approver|access-provider   filter to one workflow tier
 *   ?status=open|denied|completed                     default 'open'
 *
 * PARTITION KEY — read this before changing the query.
 *
 * The `access-request-workflow` container is partitioned by `/tenantId`, and
 * that field carries `tenantScopeId(session)` = `claims.tid || claims.oid`, i.e.
 * the ENTRA TENANT. It must not carry the signed-in user's `oid`. This route
 * reads state that a DIFFERENT user wrote — the requester writes it, an approver
 * reads it — so keying on the caller's `oid` returns zero rows for every
 * approver who is not also the requester, which is what it did until this
 * adoption. See lib/auth/session.ts::tenantScopeId, whose whole purpose is state
 * that "resolves for any grantee in the same tenant".
 *
 * AUTHORIZATION — a tenant-wide inbox is not a tenant-wide right to approve.
 * The oid-keyed partition used to confine every caller to their own rows, which
 * incidentally hid the fact that this route had no authorization at all. That
 * accident is gone, so the boundary is now explicit AND structural: the route
 * is wrapped in `withApprovalAuthority` (route-toolkit), so there is no
 * `if (gate) return gate;` line that can be dropped. A caller without authority
 * gets an honest 403 naming the remediation, never a silently empty inbox.
 *
 * Route-toolkit: withApprovalAuthority (R3).
 *
 * When `tier` is omitted, all requests at the chosen status are returned
 * (overview / history). No Fabric dependency — Cosmos only.
 */
import { NextResponse } from 'next/server';
import { tenantScopeId } from '@/lib/auth/session';
import { withApprovalAuthority } from '@/lib/api/route-toolkit';
import { accessRequestWorkflowContainer } from '@/lib/azure/cosmos-client';
import { TIER_SEQUENCE, type ApprovalStatus, type ApprovalTier } from '@/lib/types/access-request-workflow';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUSES = new Set<ApprovalStatus>(['open', 'denied', 'completed']);

export const GET = withApprovalAuthority(async (req, { session }) => {
  const tierParam = req.nextUrl.searchParams.get('tier') || '';
  const statusParam = (req.nextUrl.searchParams.get('status') || 'open') as ApprovalStatus;
  const status: ApprovalStatus = STATUSES.has(statusParam) ? statusParam : 'open';
  const tier = TIER_SEQUENCE.includes(tierParam as ApprovalTier) ? (tierParam as ApprovalTier) : null;

  const c = await accessRequestWorkflowContainer();
  const parameters: { name: string; value: string }[] = [
    { name: '@t', value: tenantScopeId(session) },
    { name: '@s', value: status },
  ];
  let query =
    'SELECT * FROM c WHERE c.tenantId = @t AND c.kind = "access-request" AND c.status = @s';
  if (tier) {
    query += ' AND c.tier = @tier';
    parameters.push({ name: '@tier', value: tier });
  }
  query += ' ORDER BY c.requestedAt DESC';

  const { resources } = await c.items.query({ query, parameters }).fetchAll();
  return NextResponse.json({ ok: true, requests: resources });
});
