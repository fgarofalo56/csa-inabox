/**
 * GET /api/access-requests — the multi-tier approval inbox (F16).
 *
 * Query params:
 *   ?tier=manager|privacy|approver|access-provider   filter to one workflow tier
 *   ?status=open|denied|completed                     default 'open'
 *
 * Returns every matching access-request doc for the authenticated tenant
 * (tenantId = s.claims.oid). The inbox UI passes ?tier=<active tab> so each
 * tier panel shows ONLY the requests awaiting that tier's action — the
 * "approver inbox filtered to the signed-in approver's current tier".
 *
 * When `tier` is omitted, all requests at the chosen status are returned
 * (overview / history). No Fabric dependency — Cosmos only.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { accessRequestWorkflowContainer } from '@/lib/azure/cosmos-client';
import { TIER_SEQUENCE, type ApprovalStatus, type ApprovalTier } from '@/lib/types/access-request-workflow';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUSES = new Set<ApprovalStatus>(['open', 'denied', 'completed']);

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const tierParam = req.nextUrl.searchParams.get('tier') || '';
  const statusParam = (req.nextUrl.searchParams.get('status') || 'open') as ApprovalStatus;
  const status: ApprovalStatus = STATUSES.has(statusParam) ? statusParam : 'open';
  const tier = TIER_SEQUENCE.includes(tierParam as ApprovalTier) ? (tierParam as ApprovalTier) : null;

  try {
    const c = await accessRequestWorkflowContainer();
    const parameters: { name: string; value: string }[] = [
      { name: '@t', value: s.claims.oid },
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
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
