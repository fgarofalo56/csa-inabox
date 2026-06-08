/**
 * POST /api/admin/domains/assign-workspaces
 *
 * Bulk-assign workspaces to a domain — the Azure-native equivalent of Fabric's
 * "Assign workspaces to this domain" side pane. Mirrors Fabric's override
 * behavior: a workspace already assigned to a DIFFERENT domain is only
 * re-tagged when the caller passes `allowOverride: true`; otherwise the call
 * returns `overrideRequired: true` plus the affected workspace ids so the UI
 * can warn before reassigning (Fabric shows an icon + warning toast for these).
 *
 *   body: { domainId: string, workspaceIds: string[], allowOverride?: boolean }
 *   ->    { ok, updated, skipped, overrideRequired?, affected?: [{id,name,domain}] }
 *
 * Backed by the workspaces Cosmos container (partition key /tenantId). Each
 * assigned workspace gets its `domain` field set to `domainId`. No Fabric
 * dependency — this is pure Cosmos.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { workspacesContainer, tenantSettingsContainer } from '@/lib/azure/cosmos-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface DomainsDoc { items: Array<{ id: string }>; }

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;
  const body = await req.json().catch(() => ({}));
  const domainId = (body?.domainId || '').toString().trim();
  const workspaceIds: string[] = Array.isArray(body?.workspaceIds)
    ? body.workspaceIds.map((w: unknown) => String(w).trim()).filter(Boolean)
    : [];
  const allowOverride = body?.allowOverride === true;
  if (!domainId) return NextResponse.json({ ok: false, error: 'domainId required' }, { status: 400 });
  if (workspaceIds.length === 0) return NextResponse.json({ ok: false, error: 'workspaceIds required' }, { status: 400 });

  try {
    // Validate the domain exists in the tenant's domain doc.
    const tsC = await tenantSettingsContainer();
    let domainExists = false;
    try {
      const { resource } = await tsC.item(`domains:${tenantId}`, tenantId).read<DomainsDoc>();
      domainExists = !!resource?.items?.some((d) => d.id === domainId);
    } catch (e: any) { if (e?.code !== 404) throw e; }
    if (!domainExists) return NextResponse.json({ ok: false, error: `domain '${domainId}' not found` }, { status: 404 });

    const wsC = await workspacesContainer();

    // First pass: read each workspace, detect those already on a different domain.
    const affected: Array<{ id: string; name?: string; domain: string }> = [];
    const targets: any[] = [];
    let skipped = 0;
    for (const wid of workspaceIds) {
      let resource: any;
      try {
        ({ resource } = await wsC.item(wid, tenantId).read());
      } catch (e: any) { if (e?.code !== 404) throw e; }
      if (!resource) { skipped++; continue; }
      if (resource.domain && resource.domain !== domainId) {
        affected.push({ id: resource.id, name: resource.name, domain: resource.domain });
      }
      targets.push(resource);
    }

    // If any workspace already belongs to another domain and the caller hasn't
    // confirmed the override, stop and report — no writes happen.
    if (affected.length > 0 && !allowOverride) {
      return NextResponse.json({ ok: true, updated: 0, skipped, overrideRequired: true, affected });
    }

    // Second pass: write the domain tag.
    let updated = 0;
    for (const ws of targets) {
      if (ws.domain === domainId) { continue; } // already on target — no-op
      ws.domain = domainId;
      ws.updatedAt = new Date().toISOString();
      await wsC.item(ws.id, tenantId).replace(ws);
      updated++;
    }
    return NextResponse.json({ ok: true, updated, skipped, overrodeCount: affected.length });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
