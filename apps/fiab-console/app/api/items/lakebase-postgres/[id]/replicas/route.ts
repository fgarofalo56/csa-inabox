/**
 * GET  /api/items/lakebase-postgres/[id]/replicas
 *   List read replicas of the item's bound Flexible Server (ARM .../replicas).
 *
 * POST /api/items/lakebase-postgres/[id]/replicas
 *   Create an async read replica (createMode: Replica) for DR / read-scale.
 *   Body: { newServerName, resourceGroup?, location? }
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError, apiServerError, apiHonestError } from '@/lib/api/respond';
import { listReplicas, createReplica, PostgresError } from '@/lib/azure/postgres-flex-client';
import { authItem, isError, requireBoundServer } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const r = await authItem(id);
  if (isError(r)) return r.error;
  const bound = requireBoundServer(r.state);
  if ('error' in bound) return bound.error;
  try {
    const replicas = await listReplicas(bound.server.id || bound.server.name);
    return apiOk({ replicas });
  } catch (e) {
    if (e instanceof PostgresError) return apiHonestError(e.message, e.status >= 400 && e.status < 600 ? e.status : 502);
    return apiServerError(e, 'failed to list replicas');
  }
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const r = await authItem(id, { write: true });
  if (isError(r)) return r.error;
  const bound = requireBoundServer(r.state);
  if ('error' in bound) return bound.error;

  let body: any;
  try { body = await req.json(); } catch { return apiError('Invalid JSON', 400, { code: 'bad_json' }); }
  const newServerName = String(body?.newServerName || '').trim();
  if (!newServerName) return apiError('newServerName required', 400);

  try {
    const result = await createReplica({
      sourceServerNameOrId: bound.server.id || bound.server.name,
      newServerName,
      resourceGroup: typeof body?.resourceGroup === 'string' ? body.resourceGroup : undefined,
      location: typeof body?.location === 'string' ? body.location : undefined,
    });
    if (!result.ok) return apiHonestError(result.error, result.status >= 400 && result.status < 600 ? result.status : 502);
    return apiOk({ replica: result }, { status: 202 });
  } catch (e) {
    if (e instanceof PostgresError) return apiHonestError(e.message, e.status >= 400 && e.status < 600 ? e.status : 502);
    return apiServerError(e, 'replica create failed');
  }
}
