/**
 * POST /api/items/activation-sync/[id]/run   body { mode?: 'full' | 'incremental' }
 *
 * Runs the reverse-ETL sync: reads the source (full, or Delta-CDF incremental),
 * maps, and pushes idempotent upserts/deletes to the destination (Dataverse /
 * webhook / Event Grid / Service Bus). Persists the run to the item's bounded
 * run history, advances the incremental watermark on success, writes an audit
 * row, and routes an O1 alert on failure — all in the shared run service.
 *
 * FLAG0 `n7c-activation-sync` (default-ON) gates this surface; when an admin
 * flips it OFF the route 403s with a precise notice. No Fabric dependency; the
 * lake read runs on the in-boundary DuckDB tier (honest 503 gate when unset).
 */

import { NextResponse } from 'next/server';
import { jerr } from '../../../_lib/item-crud';
import { withWorkspaceOwner } from '@/lib/api/route-toolkit';
import { runtimeFlag } from '@/lib/admin/runtime-flags';
import { executeActivationRun } from '@/lib/activation/run-service';
import type { ActivationMode } from '@/lib/activation/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// withWorkspaceOwner does the owner-scoped load (404 if not owned) at the boundary;
// the run service re-resolves ownership too. `id` comes from the resolved params.
export const POST = withWorkspaceOwner('activation-sync', async (req, { session, params }) => {
  if (!(await runtimeFlag('n7c-activation-sync', { default: true }))) {
    return jerr('Activation sync is disabled by the n7c-activation-sync runtime flag (Admin → Runtime flags).', 403);
  }

  const { id } = params;
  const body = await req.json().catch(() => ({}));
  const mode: ActivationMode = body?.mode === 'incremental' ? 'incremental' : 'full';

  try {
    const res = await executeActivationRun(session, id, mode);
    if (!res.run) {
      return NextResponse.json(
        { ok: false, error: res.error, ...(res.missing ? { missing: res.missing, code: 'not_configured' } : {}) },
        { status: res.status },
      );
    }
    return NextResponse.json({ ok: res.ok, run: res.run }, { status: res.status });
  } catch (e: any) {
    return jerr(e?.message || String(e), 502);
  }
});
