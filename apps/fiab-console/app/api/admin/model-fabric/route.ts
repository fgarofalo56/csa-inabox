/**
 * WS-7 — GET/PUT /api/admin/model-fabric  (Closed-Loop Model Fabric)
 *
 *   GET  → the current loop state: approval mode (auto|propose), the live
 *          serving traffic split + per-deployment signals feeding the loop, a
 *          freshly-computed (dry-run, non-actuating) promote/demote proposal,
 *          the reasoning-tier state + proposal, the global latency-SLO guard,
 *          the recent decision history, and the serving honest-gate when no
 *          serving backend is configured.
 *   PUT  → set the approval mode { mode: 'auto' | 'propose' } — audited.
 *
 * Tenant-admin gated. Real backends only (model-serving + AOAI + Cosmos), no
 * Fabric/Power BI dependency (no-vaporware.md / no-fabric-dependency.md). GET
 * NEVER actuates — it runs the loop in propose+non-persist mode so a page load
 * can never reshape live traffic.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin, enforceCapability } from '@/lib/auth/feature-gate';
import { apiOk, apiError, apiServerError, apiUnauthorized } from '@/lib/api/respond';
import { runModelFabricLoop, loadFabricState, setFabricMode, type FabricMode } from '@/lib/admin/model-fabric-loop';

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
    const state = await loadFabricState(tenantId);
    // Dry run: propose-only + non-persist so a GET never actuates or writes.
    const loop = await runModelFabricLoop({
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
    return apiServerError(e, 'Failed to read the model-fabric loop state');
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
    const state = await setFabricMode({
      tenantId,
      tid: session!.claims.tid,
      who,
      actorOid: session!.claims.oid,
      mode: mode as FabricMode,
    });
    return apiOk({ mode: state.mode }) as NextResponse;
  } catch (e) {
    return apiServerError(e, 'Failed to update the model-fabric approval mode');
  }
}
