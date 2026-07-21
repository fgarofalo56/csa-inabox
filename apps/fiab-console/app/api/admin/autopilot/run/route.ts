/**
 * WS-10.1 — POST /api/admin/autopilot/run  (run the self-driving loop on demand)
 *
 * Runs one iteration of the LCU-Autopilot loop. Body (optional):
 *   { mode?: 'auto' | 'propose' }
 *     - omitted → use the tenant's persisted approval mode.
 *     - 'auto'  → ACTUATE: pause idle compute + roll the capacity env-config for
 *                 every auto-applicable recommendation, audited.
 *     - 'propose' → compute + persist the decision but actuate NOTHING.
 *
 * The "Run now" button behind /admin/autopilot and the on-demand trigger a
 * scheduler can call. Tenant-admin + env-config capability gated (an auto run
 * performs real pause/stop + env-config writes). Every actuation is audited.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceCapability } from '@/lib/auth/feature-gate';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { runLcuAutopilotLoop, type AutopilotMode } from '@/lib/admin/lcu-autopilot-loop';

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
    const loop = await runLcuAutopilotLoop({
      tenantId,
      tid: session!.claims.tid,
      who,
      actorOid: session!.claims.oid,
      mode: mode as AutopilotMode | undefined,
      persist: true,
    });
    return apiOk({ ...loop }) as NextResponse;
  } catch (e) {
    return apiServerError(e, 'The LCU-Autopilot loop failed to run');
  }
}
