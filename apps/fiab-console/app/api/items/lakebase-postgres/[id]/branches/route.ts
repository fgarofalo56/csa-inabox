/**
 * GET  /api/items/lakebase-postgres/[id]/branches
 *   List the item's branch history (each a real PITR restore into a new server).
 *
 * POST /api/items/lakebase-postgres/[id]/branches
 *   Create a "branch" = a real Flexible Server point-in-time restore
 *   (createMode: PointInTimeRestore) into a NEW server — the Azure-native
 *   parity for Lakebase git-branching. Body:
 *     { newServerName, pointInTimeUTC?, snapshotId?, resourceGroup?, location? }
 *   When snapshotId is given the restore uses that snapshot's captured time.
 */
import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { apiOk, apiError, apiServerError, apiHonestError } from '@/lib/api/respond';
import { createBranch, PostgresError } from '@/lib/azure/postgres-flex-client';
import { recordBranch } from '@/lib/lakebase/lakebase-store';
import { authItem, isError, requireBoundServer } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const r = await authItem(id);
  if (isError(r)) return r.error;
  return apiOk({ branches: r.state.branches || [] });
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const r = await authItem(id, { write: true });
  if (isError(r)) return r.error;
  const { item, state, session } = r;

  const bound = requireBoundServer(state);
  if ('error' in bound) return bound.error;

  let body: any;
  try { body = await req.json(); } catch { return apiError('Invalid JSON', 400, { code: 'bad_json' }); }

  const newServerName = String(body?.newServerName || '').trim();
  if (!newServerName) return apiError('newServerName required', 400);

  // Resolve the point-in-time: an explicit value, a saved snapshot, or now.
  let pointInTimeUTC = String(body?.pointInTimeUTC || '').trim();
  const snapshotId = String(body?.snapshotId || '').trim();
  if (!pointInTimeUTC && snapshotId) {
    const snap = (state.snapshots || []).find((s) => s.id === snapshotId);
    if (!snap) return apiError('snapshotId not found', 404);
    pointInTimeUTC = snap.pointInTimeUTC;
  }
  if (!pointInTimeUTC) pointInTimeUTC = new Date().toISOString();

  try {
    const result = await createBranch({
      sourceServerNameOrId: bound.server.id || bound.server.name,
      newServerName,
      pointInTimeUTC,
      resourceGroup: typeof body?.resourceGroup === 'string' ? body.resourceGroup : undefined,
      location: typeof body?.location === 'string' ? body.location : undefined,
    });
    if (!result.ok) return apiHonestError(result.error, result.status >= 400 && result.status < 600 ? result.status : 502);
    const branch = {
      id: randomUUID(),
      name: newServerName,
      pointInTimeUTC,
      serverId: result.id,
      provisioningState: result.provisioningState,
      createdAt: new Date().toISOString(),
      by: session.claims.oid,
    };
    const updated = await recordBranch(item, branch);
    return apiOk({ branch, branches: (updated.state as any).lakebase.branches }, { status: 202 });
  } catch (e) {
    if (e instanceof PostgresError) return apiHonestError(e.message, e.status >= 400 && e.status < 600 ? e.status : 502);
    return apiServerError(e, 'branch failed');
  }
}
