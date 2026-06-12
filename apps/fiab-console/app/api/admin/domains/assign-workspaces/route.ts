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
 * Authorization (D2 tier model — was previously UNGATED, any session could
 * re-tag any workspace):
 *   • Tenant admin / domain admin of the target domain → may assign any workspace.
 *   • Domain contributor (or legacy contributors.scope AllTenant /
 *     SpecificUsersAndGroups) → may assign only workspaces they hold the
 *     workspace Admin role on (Fabric requires workspace-admin to assign).
 *   • Otherwise → 403.
 *
 * Backed by the workspaces Cosmos container (partition key /tenantId). Each
 * assigned workspace gets its `domain` field set to `domainId`. No Fabric
 * dependency — this is pure Cosmos + Entra/Graph.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { workspacesContainer, tenantSettingsContainer } from '@/lib/azure/cosmos-client';
import {
  resolveDomainTier,
  canAssignWorkspaceToDomain,
  isAtLeastDomainAdmin,
  type DomainTierDomain,
} from '@/lib/auth/domain-role';
import { resolveEffectiveRole } from '@/lib/azure/workspace-roles-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface DomainsDoc {
  items: Array<DomainTierDomain & { id: string; name?: string }>;
}

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
    // Validate the domain exists in the tenant's domain doc + load its full
    // shape for tier resolution.
    const tsC = await tenantSettingsContainer();
    let domain: (DomainTierDomain & { id: string; name?: string }) | undefined;
    try {
      const { resource } = await tsC.item(`domains:${tenantId}`, tenantId).read<DomainsDoc>();
      domain = resource?.items?.find((d) => d.id === domainId);
    } catch (e: any) { if (e?.code !== 404) throw e; }
    if (!domain) return NextResponse.json({ ok: false, error: `domain '${domainId}' not found` }, { status: 404 });

    // --- D2 authorization -----------------------------------------------------
    const tier = await resolveDomainTier(s, domain);
    const elevated = isAtLeastDomainAdmin(tier); // tenant-admin or domain-admin → assign anything
    // For non-elevated callers (domain contributors / AllTenant / Specific), the
    // caller must hold workspace Admin on EACH workspace being assigned. Resolve
    // each effective role using the cached session group claim (no per-group
    // Graph fan-out on the hot path).
    const groupIds = s.claims.groups || [];
    if (!elevated) {
      // Cheap pre-check: if the tier model can't possibly authorize this caller
      // (no contributor tier AND no permissive contributors.scope), reject before
      // touching any workspace.
      const couldAssignSomething =
        tier === 'domain-contributor' ||
        domain.contributors?.scope === 'AllTenant' ||
        domain.contributors?.scope === 'SpecificUsersAndGroups';
      if (!couldAssignSomething) {
        return NextResponse.json(
          {
            ok: false,
            error:
              'You are not an admin or contributor of this domain. A tenant admin can grant you the domain admin/contributor Entra group at /admin/permissions (Domain access), or set the domain contributor scope.',
          },
          { status: 403 },
        );
      }
    }

    const wsC = await workspacesContainer();

    // First pass: read each workspace, detect those already on a different domain.
    const affected: Array<{ id: string; name?: string; domain: string }> = [];
    const targets: any[] = [];
    let skipped = 0;
    const forbidden: string[] = [];
    for (const wid of workspaceIds) {
      let resource: any;
      try {
        ({ resource } = await wsC.item(wid, tenantId).read());
      } catch (e: any) { if (e?.code !== 404) throw e; }
      if (!resource) { skipped++; continue; }
      // Per-workspace authorization for non-elevated callers.
      if (!elevated) {
        const role = await resolveEffectiveRole(s.claims.oid, wid, { userGroupIds: groupIds });
        const isWsAdmin = role === 'Admin';
        if (!canAssignWorkspaceToDomain(s, domain, tier, isWsAdmin)) {
          forbidden.push(wid);
          continue;
        }
      }
      if (resource.domain && resource.domain !== domainId) {
        affected.push({ id: resource.id, name: resource.name, domain: resource.domain });
      }
      targets.push(resource);
    }

    // A contributor who lacks workspace-admin on one or more requested workspaces
    // gets an honest 403 listing them — no partial silent drop.
    if (forbidden.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          error:
            'Domain contributors can only assign workspaces they administer. You are not a workspace Admin on: ' +
            forbidden.join(', ') + '.',
          forbidden,
        },
        { status: 403 },
      );
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
