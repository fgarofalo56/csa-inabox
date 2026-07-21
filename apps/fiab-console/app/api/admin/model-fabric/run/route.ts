/**
 * WS-7 — POST /api/admin/model-fabric/run  (run the closed loop on demand)
 *
 * Runs one iteration of the Closed-Loop Model Fabric. Body (optional):
 *   { mode?: 'auto' | 'propose' }
 *     - omitted → use the tenant's persisted approval mode.
 *     - 'auto'  → ACTUATE: apply the promote/demote traffic-split (WS-1.2) +
 *                 the reasoning-tier env promotion (WS-1.1), audited.
 *     - 'propose' → compute + persist the decision but actuate NOTHING (an
 *                 explicit "dry run + record").
 *
 * This is the "run loop" button behind the admin/model-fabric page, and the
 * on-demand trigger a scheduler can call. Tenant-admin + env-config capability
 * gated (an auto run performs real env-config + traffic writes). Real backends
 * only; every actuation is audited (no-vaporware.md).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceCapability } from '@/lib/auth/feature-gate';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { runModelFabricLoop, type FabricMode } from '@/lib/admin/model-fabric-loop';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const session = getSession();
  const capGate = await enforceCapability(session, 'admin.env-config', 'Admin');
  if (capGate) return capGate;
  const tenantId = session!.claims.oid;
  const who = session!.claims.upn || session!.claims.email || tenantId;

  const body = await req.json().catch(() => ({}));
  const mode = body?.mode;
  if (mode !== undefined && mode !== 'auto' && mode !== 'propose') {
    return apiError("mode, when provided, must be 'auto' or 'propose'", 400);
  }

  try {
    const loop = await runModelFabricLoop({
      tenantId,
      tid: session!.claims.tid,
      who,
      actorOid: session!.claims.oid,
      mode: mode as FabricMode | undefined,
      persist: true,
    });
    return apiOk({ ...loop }) as NextResponse;
  } catch (e) {
    return apiServerError(e, 'The model-fabric loop failed to run');
  }
}
