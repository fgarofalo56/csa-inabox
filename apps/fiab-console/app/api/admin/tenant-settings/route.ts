/**
 * GET  /api/admin/tenant-settings — returns the current tenant's toggles
 * (auto-seeds defaults on first call)
 * PUT  /api/admin/tenant-settings — body: { settings: Record<string,boolean> }
 *   Returns: { ok, settings, changedCount }
 *   Each toggle delta emits an entry to the audit-log container.
 *
 * Persistence: one doc per tenantId in the `tenant-settings` Cosmos container.
 * No mocks, no stubs — real Cosmos persistence + audit trail.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { pdpCheck } from '@/lib/auth/pdp/enforce';
import { tenantSettingsContainer, auditLogContainer } from '@/lib/azure/cosmos-client';
import {
  defaultSettings,
  numericDefaults,
  numericParamDefs,
  scopableToggleIds,
  numericParamIds,
  isValidAppliesTo,
  appliesToEqual,
  TENANT_SETTING_GROUPS,
  type AppliesToConfig,
  type TenantSettingsDoc,
} from '@/lib/types/tenant-settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';



async function loadOrSeed(tenantId: string, who: string): Promise<TenantSettingsDoc> {
  const c = await tenantSettingsContainer();
  try {
    const { resource } = await c.item(tenantId, tenantId).read<TenantSettingsDoc>();
    if (resource) {
      // Merge in any new toggles added since this tenant last saved (so the
      // schema stays forward-compatible when we add a new toggle row).
      const defaults = defaultSettings();
      let missing = 0;
      for (const k of Object.keys(defaults)) {
        if (!(k in resource.settings)) { resource.settings[k] = defaults[k]; missing++; }
      }
      // Same forward-compat merge for numeric companion params.
      const numDefaults = numericDefaults();
      if (!resource.numericParams) resource.numericParams = {};
      for (const k of Object.keys(numDefaults)) {
        if (!(k in resource.numericParams)) { resource.numericParams[k] = numDefaults[k]; missing++; }
      }
      if (missing > 0) {
        resource.updatedAt = new Date().toISOString();
        resource.updatedBy = `system (added ${missing} defaults)`;
        await c.item(tenantId, tenantId).replace(resource);
      }
      return resource;
    }
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
  const seeded: TenantSettingsDoc = {
    id: tenantId,
    tenantId,
    settings: defaultSettings(),
    scopeConfig: {},
    numericParams: numericDefaults(),
    updatedAt: new Date().toISOString(),
    updatedBy: who,
  };
  await c.items.create(seeded);
  return seeded;
}

export async function GET() {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const tenantId = s.claims.oid;
  try {
    const doc = await loadOrSeed(tenantId, s.claims.upn || s.claims.email || tenantId);
    return NextResponse.json({
      ok: true,
      tenantId,
      settings: doc.settings,
      scopeConfig: doc.scopeConfig ?? {},
      numericParams: doc.numericParams ?? numericDefaults(),
      updatedAt: doc.updatedAt,
      updatedBy: doc.updatedBy,
      groups: TENANT_SETTING_GROUPS,
    });
  } catch (e: any) {
    return apiError(e?.message || String(e), 500);
  }
}

export async function PUT(req: NextRequest) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const tenantId = s.claims.oid;
  // HARD admin gate — this writes tenant-wide governance toggles (DLP,
  // sensitivity labels, feature enablement). The pdpCheck below is DEFAULT-OFF
  // (returns null when LOOM_PDP_ENFORCE is unset), so it CANNOT be the sole
  // authorization for a privileged write. Require a tenant admin first; keep the
  // pdpCheck as an additional shadow/enforce layer.
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  // PDP gate (default-off / shadow-ready). Admin write to tenant-wide toggles.
  const blocked = await pdpCheck(s, { level: 'domain', id: tenantId }, 'admin');
  if (blocked) return blocked;
  const body = await req.json().catch(() => ({}));
  const incoming = body?.settings;
  const incomingScope = body?.scopeConfig;
  const incomingNumeric = body?.numericParams;
  const hasSettings = incoming && typeof incoming === 'object';
  const hasScope = incomingScope && typeof incomingScope === 'object';
  const hasNumeric = incomingNumeric && typeof incomingNumeric === 'object';
  if (!hasSettings && !hasScope && !hasNumeric) {
    return apiError('one of settings / scopeConfig / numericParams (object) required', 400);
  }

  try {
    const c = await tenantSettingsContainer();
    const current = await loadOrSeed(tenantId, s.claims.upn || tenantId);
    const validKeys = new Set(Object.keys(defaultSettings()));

    // ---- boolean toggle deltas (known keys only) ----
    const next: Record<string, boolean> = { ...current.settings };
    const changes: Array<{ key: string; from: boolean; to: boolean }> = [];
    if (hasSettings) {
      for (const [k, v] of Object.entries(incoming)) {
        if (!validKeys.has(k)) continue;
        const before = !!current.settings[k];
        const after = !!v;
        if (before !== after) {
          next[k] = after;
          changes.push({ key: k, from: before, to: after });
        }
      }
    }

    // ---- "Apply to" scope deltas (scopable toggles only) ----
    const validScopeKeys = scopableToggleIds();
    const nextScope: Record<string, AppliesToConfig> = { ...(current.scopeConfig ?? {}) };
    const scopeChanges: Array<{ key: string; from: AppliesToConfig | null; to: { mode: string; groupIds: string[] } }> = [];
    if (hasScope) {
      for (const [k, v] of Object.entries(incomingScope as Record<string, unknown>)) {
        if (!validScopeKeys.has(k)) continue;       // no-freeform-config whitelist
        if (!isValidAppliesTo(v)) continue;
        // Persist mode + ids only; display names are an ephemeral UI cache.
        const cleaned: AppliesToConfig = {
          mode: v.mode,
          groupIds: v.mode === 'entire-org' ? [] : [...new Set(v.groupIds.filter(Boolean))],
        };
        const before = current.scopeConfig?.[k] ?? null;
        if (!appliesToEqual(before, cleaned)) {
          nextScope[k] = cleaned;
          scopeChanges.push({ key: k, from: before, to: { mode: cleaned.mode, groupIds: cleaned.groupIds } });
        }
      }
    }

    // ---- numeric companion deltas (declared params only) ----
    const validNumericKeys = numericParamIds();
    const numDefs = numericParamDefs();
    const numDefaults = numericDefaults();
    const nextNumeric: Record<string, number> = { ...(current.numericParams ?? numDefaults) };
    const numericChanges: Array<{ key: string; from: number; to: number }> = [];
    if (hasNumeric) {
      for (const [k, v] of Object.entries(incomingNumeric as Record<string, unknown>)) {
        if (!validNumericKeys.has(k)) continue;     // no-freeform-config whitelist
        const n = Number(v);
        if (!Number.isFinite(n) || !Number.isInteger(n)) continue;
        const def = numDefs[k];
        const clamped = def ? Math.max(def.min, Math.min(def.max, n)) : n;
        const before = nextNumeric[k] ?? numDefaults[k];
        if (before !== clamped) {
          nextNumeric[k] = clamped;
          numericChanges.push({ key: k, from: before, to: clamped });
        }
      }
    }

    const totalChanges = changes.length + scopeChanges.length + numericChanges.length;
    if (totalChanges === 0) {
      return NextResponse.json({
        ok: true,
        settings: current.settings,
        scopeConfig: current.scopeConfig ?? {},
        numericParams: current.numericParams ?? numDefaults,
        changedCount: 0,
        scopeChangedCount: 0,
        numericChangedCount: 0,
      });
    }

    const who = s.claims.upn || s.claims.email || tenantId;
    const updated: TenantSettingsDoc = {
      ...current,
      settings: next,
      scopeConfig: nextScope,
      numericParams: nextNumeric,
      updatedAt: new Date().toISOString(),
      updatedBy: who,
    };
    await c.item(tenantId, tenantId).replace(updated);

    // Audit log — one entry per changed toggle / scope / numeric param.
    try {
      const audit = await auditLogContainer();
      const mkId = () => `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      for (const ch of changes) {
        await audit.items.create({
          id: mkId(), itemId: `tenant-settings:${tenantId}`, tenantId, who, at: updated.updatedAt,
          kind: 'tenant-settings.toggle', key: ch.key, from: ch.from, to: ch.to,
        }).catch(() => {});
      }
      for (const ch of scopeChanges) {
        await audit.items.create({
          id: mkId(), itemId: `tenant-settings:${tenantId}`, tenantId, who, at: updated.updatedAt,
          kind: 'tenant-settings.scope', key: ch.key, from: ch.from, to: ch.to,
        }).catch(() => {});
      }
      for (const ch of numericChanges) {
        await audit.items.create({
          id: mkId(), itemId: `tenant-settings:${tenantId}`, tenantId, who, at: updated.updatedAt,
          kind: 'tenant-settings.numeric', key: ch.key, from: ch.from, to: ch.to,
        }).catch(() => {});
      }
    } catch { /* audit failures are non-blocking */ }

    return NextResponse.json({
      ok: true,
      settings: updated.settings,
      scopeConfig: updated.scopeConfig ?? {},
      numericParams: updated.numericParams ?? numDefaults,
      changedCount: changes.length,
      scopeChangedCount: scopeChanges.length,
      numericChangedCount: numericChanges.length,
      changes,
      scopeChanges,
      numericChanges,
      updatedAt: updated.updatedAt,
    });
  } catch (e: any) {
    return apiError(e?.message || String(e), 500);
  }
}
