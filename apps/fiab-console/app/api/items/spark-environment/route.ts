/**
 * GET  /api/items/spark-environment   — list spark-environment items owned by tenant.
 * POST /api/items/spark-environment   body { workspaceId, displayName,
 *                                       description?, state? } → create.
 *
 * `state` shape (SparkEnvironmentState):
 *   sparkVersion, nodeSizeFamily, nodeSize, autoscaleEnabled, nodeCount,
 *   minNodeCount, maxNodeCount, autoPauseEnabled, autoPauseDelay,
 *   sessionLevelPackagesEnabled, requirementsType, requirementsContent,
 *   importChecks[], customLibraries[], sparkProperties{}, publishedToPool?,
 *   publishStatus?, publishedAt?, attachedItemIds[]
 *
 * Publish / library upload / validate / attach are handled by the dedicated
 * routes under /api/spark-environment/[id]/*.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { createOwnedItem, jerr, listOwnedItems } from '../_lib/item-crud';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'spark-environment';

export async function GET() {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  try {
    const items = await listOwnedItems(ITEM_TYPE, session.claims.oid);
    return NextResponse.json({ ok: true, items });
  } catch (e: any) {
    return apiServerError(e);
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const body = await req.json().catch(() => ({}));
  try {
    const r = await createOwnedItem(session, ITEM_TYPE, body);
    if (!r.ok) return jerr(r.error, r.status);
    return NextResponse.json({ ok: true, item: r.item }, { status: 201 });
  } catch (e: any) {
    return apiServerError(e);
  }
}
