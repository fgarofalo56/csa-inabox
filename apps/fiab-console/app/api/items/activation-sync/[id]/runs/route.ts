/**
 * GET /api/items/activation-sync/[id]/runs → { ok, runs } from the item's
 * bounded, persisted run history (newest first). Owner-scoped read.
 */

import { apiOk } from '@/lib/api/respond';
import { withWorkspaceOwner } from '@/lib/api/route-toolkit';
import { coerceSpec } from '@/lib/activation/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withWorkspaceOwner('activation-sync', { allowReadRoles: true }, (_req, { item }) => {
  const spec = coerceSpec(item.state);
  return apiOk({ runs: spec.runs || [], lastSyncedVersion: spec.lastSyncedVersion });
});
