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
import { withSession } from '@/lib/api/route-toolkit';
import { enforceCapability } from '@/lib/auth/feature-gate';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { runModelFabricLoop, type FabricMode } from '@/lib/admin/model-fabric-loop';
import { loadTenantCopilotConfig } from '@/lib/azure/copilot-config-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// R3 boy-scout: withSession supplies the authenticated session (same 401
// envelope this handler produced by hand); the CAPABILITY check stays explicit
// because no toolkit wrapper models `admin.env-config` - it is a stricter,
// different check than tenant-admin. Bonus: the `session!` assertions go away.
export const POST = withSession(async (req, { session }) => {
  const capGate = await enforceCapability(session, 'admin.env-config', 'Admin');
  if (capGate) return capGate;
  const tenantId = session.claims.oid;
  const who = session.claims.upn || session.claims.email || tenantId;

  const body = await req.json().catch(() => ({}));
  const mode = body?.mode;
  if (mode !== undefined && mode !== 'auto' && mode !== 'propose') {
    return apiError("mode, when provided, must be 'auto' or 'propose'", 400);
  }

  try {
    const loop = await runModelFabricLoop({
      tenantId,
      tid: session.claims.tid,
      who,
      actorOid: session.claims.oid,
      mode: mode as FabricMode | undefined,
      // The reasoning tier is configured per-TENANT (modelTiers.strong in the
      // copilot config), so the loop MUST be given that config. Without it
      // `tierCfg` was undefined, `reasoningTierConfigured(null)` returned false,
      // and the panel reported "reasoning tier not set" + refused to promote
      // even on a tenant that HAD set modelTiers.strong. Verified live: config
      // held {strong:'gpt-5.6-sol'} while the loop reported currentStrong=null.
      tierCfg: await loadTenantCopilotConfig(tenantId),
      persist: true,
    });
    return apiOk({ ...loop }) as NextResponse;
  } catch (e) {
    return apiServerError(e, 'The model-fabric loop failed to run');
  }
});
