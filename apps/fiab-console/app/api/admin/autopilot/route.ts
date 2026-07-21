/**
 * WS-10.1 — GET/PUT /api/admin/autopilot  (LCU-Autopilot, self-driving FinOps)
 *
 *   GET → the current loop state: persisted approval mode (auto|propose), the
 *         real LCU telemetry (per-compute LCU + $ + idle state, capacity ceiling),
 *         a freshly-computed (dry-run, non-actuating) recommendation set with $
 *         impact, the blocked-gate signal, and the recent action history. GET
 *         NEVER actuates — the loop runs in propose+non-persist mode so a page
 *         load can never pause a resource.
 *   PUT → set the approval mode { mode: 'auto' | 'propose' } — audited.
 *
 * Tenant-admin gated. Real backends only (chargeback + Azure Monitor + Cosmos),
 * no Fabric dependency (no-vaporware.md / no-fabric-dependency.md).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin, enforceCapability } from '@/lib/auth/feature-gate';
import { apiOk, apiError, apiServerError, apiUnauthorized } from '@/lib/api/respond';
import {
  runLcuAutopilotLoop,
  loadAutopilotState,
  setAutopilotMode,
  type AutopilotMode,
} from '@/lib/admin/lcu-autopilot-loop';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 45;

export async function GET() {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const denied = requireTenantAdmin(session);
  if (denied) return denied;

  const tenantId = session.claims.oid;
  const who = session.claims.upn || session.claims.email || tenantId;
  try {
    const state = await loadAutopilotState(tenantId);
    const loop = await runLcuAutopilotLoop({
      tenantId,
      tid: session.claims.tid,
      who,
      actorOid: session.claims.oid,
      mode: 'propose',
      persist: false,
    });
    // Surface the PERSISTED approval mode (not the dry-run's 'propose').
    return apiOk({ ...loop, mode: state.mode }) as NextResponse;
  } catch (e) {
    return apiServerError(e, 'Failed to read the LCU-Autopilot state');
  }
}

export async function PUT(req: NextRequest) {
  const session = getSession();
  const capGate = await enforceCapability(session, 'admin.env-config', 'Admin');
  if (capGate) return capGate;
  const tenantId = session!.claims.oid;
  const who = session!.claims.upn || session!.claims.email || tenantId;

  const body = await req.json().catch(() => ({}));
  const mode = body?.mode;
  if (mode !== 'auto' && mode !== 'propose') {
    return apiError("mode must be 'auto' or 'propose'", 400);
  }
  try {
    const state = await setAutopilotMode({
      tenantId,
      tid: session!.claims.tid,
      who,
      actorOid: session!.claims.oid,
      mode: mode as AutopilotMode,
    });
    return apiOk({ mode: state.mode }) as NextResponse;
  } catch (e) {
    return apiServerError(e, 'Failed to update the autopilot approval mode');
  }
}
