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
import { getSession } from '@/lib/auth/session';
import { tenantSettingsContainer, auditLogContainer } from '@/lib/azure/cosmos-client';
import { defaultSettings, TENANT_SETTING_GROUPS, type TenantSettingsDoc } from '@/lib/types/tenant-settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}

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
    updatedAt: new Date().toISOString(),
    updatedBy: who,
  };
  await c.items.create(seeded);
  return seeded;
}

export async function GET() {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const tenantId = s.claims.oid;
  try {
    const doc = await loadOrSeed(tenantId, s.claims.upn || s.claims.email || tenantId);
    return NextResponse.json({
      ok: true,
      tenantId,
      settings: doc.settings,
      updatedAt: doc.updatedAt,
      updatedBy: doc.updatedBy,
      groups: TENANT_SETTING_GROUPS,
    });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

export async function PUT(req: NextRequest) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const tenantId = s.claims.oid;
  const body = await req.json().catch(() => ({}));
  const incoming = body?.settings;
  if (!incoming || typeof incoming !== 'object') return err('settings (object) required', 400);

  try {
    const c = await tenantSettingsContainer();
    const current = await loadOrSeed(tenantId, s.claims.upn || tenantId);
    const validKeys = new Set(Object.keys(defaultSettings()));

    // Compute deltas — only persist known keys.
    const next: Record<string, boolean> = { ...current.settings };
    const changes: Array<{ key: string; from: boolean; to: boolean }> = [];
    for (const [k, v] of Object.entries(incoming)) {
      if (!validKeys.has(k)) continue;
      const before = !!current.settings[k];
      const after = !!v;
      if (before !== after) {
        next[k] = after;
        changes.push({ key: k, from: before, to: after });
      }
    }

    if (changes.length === 0) {
      return NextResponse.json({ ok: true, settings: current.settings, changedCount: 0 });
    }

    const who = s.claims.upn || s.claims.email || tenantId;
    const updated: TenantSettingsDoc = {
      ...current,
      settings: next,
      updatedAt: new Date().toISOString(),
      updatedBy: who,
    };
    await c.item(tenantId, tenantId).replace(updated);

    // Audit log — one entry per changed toggle.
    try {
      const audit = await auditLogContainer();
      for (const ch of changes) {
        await audit.items.create({
          id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          itemId: `tenant-settings:${tenantId}`,
          tenantId,
          who,
          at: updated.updatedAt,
          kind: 'tenant-settings.toggle',
          key: ch.key,
          from: ch.from,
          to: ch.to,
        }).catch(() => {});
      }
    } catch { /* audit failures are non-blocking */ }

    return NextResponse.json({
      ok: true,
      settings: updated.settings,
      changedCount: changes.length,
      changes,
      updatedAt: updated.updatedAt,
    });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}
