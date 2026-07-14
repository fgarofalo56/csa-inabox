/**
 * GET  /api/admin/platform-settings — the deployment-wide runtime platform
 *   settings + how each effective value was resolved (runtime / env / default).
 *   Admin-gated (tenant admin) so the toggle can render "set by admin" state.
 *
 * PUT  /api/admin/platform-settings — body: { biBackend: 'loom-native'|'powerbi' }
 *   Persists the admin-selected BI backend to the singleton platform doc (real
 *   Cosmos upsert) + an audit entry. Admin-gated. No rebuild, no ARM revision —
 *   the value is served to clients at runtime via GET /api/config/ui.
 *
 * This is the in-console home for the Power BI backend opt-in that previously
 * lived ONLY in the NEXT_PUBLIC_LOOM_BI_BACKEND build var (which could never be
 * runtime-toggled). Azure-native stays the DEFAULT (no-fabric-dependency.md) —
 * enabling Power BI here is an explicit, disclosed opt-in.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError, apiServerError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { pdpCheck } from '@/lib/auth/pdp/enforce';
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import {
  resolveBiBackendWithSource,
  writeBiBackendMode,
  isBiBackendMode,
  resolveMapsAccount,
  writeMapsAccount,
} from '@/lib/admin/platform-settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  try {
    const bi = await resolveBiBackendWithSource();
    const mapsAccount = await resolveMapsAccount();
    return NextResponse.json({
      ok: true,
      biBackend: bi,
      // The env value (if any) is surfaced so the pane can explain that a
      // deploy-time LOOM_BI_BACKEND is being OVERRIDDEN by the runtime setting.
      envFallback: bi.envValue ?? null,
      // Azure Maps account (runtime > env). Non-secret — the credential stays
      // server-side; this is just the public account label used to prefill editors.
      mapsAccount,
      mapsEnvFallback: (process.env.LOOM_AZURE_MAPS_ACCOUNT || process.env.LOOM_AZURE_MAPS_CLIENT_ID || '').trim() || null,
    });
  } catch (e: any) {
    return apiServerError(e);
  }
}

export async function PUT(req: NextRequest) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const tenantId = s.claims.oid;
  // HARD admin gate — this reshapes a deployment-wide backend selection.
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  // PDP gate (default-shadow / enforce-ready) — admin write at domain scope.
  const blocked = await pdpCheck(s, { level: 'domain', id: tenantId }, 'admin');
  if (blocked) return blocked;

  const body = await req.json().catch(() => ({}));
  const hasBi = body?.biBackend !== undefined;
  const hasMaps = typeof body?.mapsAccount === 'string';
  if (!hasBi && !hasMaps) {
    return apiError("provide 'biBackend' ('loom-native'|'powerbi') and/or 'mapsAccount' (string)", 400);
  }
  if (hasBi && !isBiBackendMode(body.biBackend)) {
    return apiError("biBackend must be 'loom-native' or 'powerbi'", 400);
  }

  try {
    const who = s.claims.upn || s.claims.email || tenantId;

    // ── Azure Maps account (runtime override of LOOM_AZURE_MAPS_ACCOUNT) ──
    if (hasMaps) {
      const beforeMaps = await resolveMapsAccount();
      await writeMapsAccount(body.mapsAccount, who);
      emitAuditEvent({
        actorOid: s.claims.oid,
        actorUpn: who,
        action: 'platform-settings.update',
        targetType: 'platform-settings',
        targetId: 'platform-settings',
        tenantId: s.claims.tid || tenantId,
        detail: { key: 'mapsAccount', from: beforeMaps, to: body.mapsAccount },
      });
    }

    if (!hasBi) {
      return NextResponse.json({
        ok: true,
        biBackend: await resolveBiBackendWithSource(),
        mapsAccount: await resolveMapsAccount(),
      });
    }

    const next = body.biBackend;
    const before = await resolveBiBackendWithSource();
    const doc = await writeBiBackendMode(next, who);

    // Audit — record the backend flip (governance-relevant: it enables/disables
    // the Fabric-family Power BI path deployment-wide).
    try {
      const audit = await auditLogContainer();
      await audit.items.create({
        id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        itemId: 'platform-settings',
        tenantId,
        who,
        at: doc.updatedAt,
        kind: 'platform-settings.biBackend',
        key: 'biBackend',
        from: before.mode,
        to: next,
      }).catch(() => {});
    } catch { /* audit failure is non-blocking */ }

    emitAuditEvent({
      actorOid: s.claims.oid,
      actorUpn: who,
      action: 'platform-settings.update',
      targetType: 'platform-settings',
      targetId: 'platform-settings',
      tenantId: s.claims.tid || tenantId,
      detail: { key: 'biBackend', from: before.mode, to: next },
    });

    return NextResponse.json({
      ok: true,
      biBackend: await resolveBiBackendWithSource(),
      mapsAccount: await resolveMapsAccount(),
      changed: before.mode !== next,
    });
  } catch (e: any) {
    return apiServerError(e);
  }
}
