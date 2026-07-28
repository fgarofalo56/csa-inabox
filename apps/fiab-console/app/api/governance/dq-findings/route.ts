/**
 * /api/governance/dq-findings   (N7d → N17 hand-off)
 *
 * GET → the tenant's data-quality findings feed, newest-first. This is the
 *       PRODUCER endpoint N17's incident console reads to list / group / promote
 *       findings into incidents. N7d owns detection + emission; **N17 owns the
 *       incident UX** — this route deliberately only READS findings.
 *
 *       query: ?itemId= &runId= &openOnly=1 &limit=
 *
 * Real Cosmos query (loom-dq-findings, single-partition on /tenantId) — no mocks.
 */
import type { NextRequest } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { apiOk } from '@/lib/api/respond';
import { listDqFindings } from '@/lib/azure/dq-finding-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession(async (req: NextRequest, { session }) => {
  const url = new URL(req.url);
  const itemId = url.searchParams.get('itemId') || undefined;
  const runId = url.searchParams.get('runId') || undefined;
  const openOnly = url.searchParams.get('openOnly') === '1' || url.searchParams.get('openOnly') === 'true';
  const limitRaw = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;

  const findings = await listDqFindings(session.claims.oid, { itemId, runId, openOnly, limit });
  return apiOk({ findings, count: findings.length });
});
