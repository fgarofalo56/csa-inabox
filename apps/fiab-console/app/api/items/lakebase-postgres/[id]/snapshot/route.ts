/**
 * GET  /api/items/lakebase-postgres/[id]/snapshot
 *   List the item's point-in-time snapshot markers.
 *
 * POST /api/items/lakebase-postgres/[id]/snapshot
 *   Capture a snapshot marker: a labelled point-in-time the operator can later
 *   restore into a branch (createBranch consumes snapshotId). Body:
 *     { label?, pointInTimeUTC? }   (pointInTimeUTC defaults to now)
 *
 * A snapshot is a durable restore MARKER (persisted on the item), distinct from
 * the branch which performs the real PITR restore into a new server. Flexible
 * Server has no manual-snapshot API — continuous backup + PITR is the real
 * mechanism, and the earliest restorable time is surfaced from the live server.
 */
import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { recordSnapshot } from '@/lib/lakebase/lakebase-store';
import { authItem, isError, requireBoundServer } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const r = await authItem(id);
  if (isError(r)) return r.error;
  return apiOk({ snapshots: r.state.snapshots || [] });
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

  const pointInTimeUTC = String(body?.pointInTimeUTC || '').trim() || new Date().toISOString();
  const label = String(body?.label || '').trim() || `Snapshot ${new Date(pointInTimeUTC).toISOString()}`;

  try {
    const snap = { id: randomUUID(), label, pointInTimeUTC, createdAt: new Date().toISOString(), by: session.claims.oid };
    const updated = await recordSnapshot(item, snap);
    return apiOk({ snapshot: snap, snapshots: (updated.state as any).lakebase.snapshots });
  } catch (e) {
    return apiServerError(e, 'snapshot failed');
  }
}
