/**
 * POST /api/items/dataflow/[id]/refresh?workspaceId=...
 *   Triggers a refresh on the dataflow.
 *
 * v3.25: Cosmos-backed dataflow's Refresh is Preview — the ADF Mapping
 * Data Flow dispatch lands in a follow-up release. Returns 503 with
 * an actionable hint so BackendStateBar renders it as a quiet warning.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  if (!getSession()) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  return NextResponse.json({
    ok: false,
    error: 'Dataflow Refresh runtime not yet wired in this Loom release. Use a Data pipeline + Notebook to ingest data for now.',
    hint: 'Tracked in docs/fiab/wiring-audit.md Phase B. The dataflow definition is saved to Cosmos and visible to Apps + Lineage; Refresh dispatch is the remaining piece.',
  }, { status: 503 });
}
