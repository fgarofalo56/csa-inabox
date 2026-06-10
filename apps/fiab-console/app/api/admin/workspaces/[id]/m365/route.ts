/**
 * POST /api/admin/workspaces/{id}/m365 — link / create / unlink the Microsoft
 * 365 unified group that backs a workspace (settings → "Teams and SharePoint"
 * tab). Real Microsoft Graph + Cosmos persist.
 *
 * Body: { action: 'link' | 'create' | 'unlink', groupId?, displayName? }
 *   - link   { groupId }     → resolve the group + its SharePoint site URL, persist
 *   - create { displayName? } → create a new M365 unified group (UAMI needs
 *                               Group.Create / Group.ReadWrite.All; gated by
 *                               LOOM_WORKSPACE_M365_LINK), then persist
 *   - unlink                 → clear m365GroupId / m365SiteUrl / m365GroupName
 *
 * This is an Entra/Graph surface, NOT a Fabric/Power BI API, so it is permitted
 * on the default path (no-fabric-dependency.md). The workspace works fully
 * without an M365 group bound.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { workspacesContainer } from '@/lib/azure/cosmos-client';
import { upsertLoomDoc, docForWorkspace } from '@/lib/azure/loom-search';
import { getM365Group, createM365Group, m365LinkEnabled, M365GroupError } from '@/lib/azure/m365-groups';
import type { Workspace } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function loadWorkspace(id: string, tenantId: string): Promise<Workspace | null> {
  const c = await workspacesContainer();
  try {
    const { resource } = await c.item(id, tenantId).read<Workspace>();
    if (!resource || resource.tenantId !== tenantId) return null;
    return resource;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

async function persist(ws: Workspace): Promise<Workspace> {
  const c = await workspacesContainer();
  const next = { ...ws, updatedAt: new Date().toISOString() };
  const { resource } = await c.item(ws.id, ws.tenantId).replace<Workspace>(next);
  if (resource) void upsertLoomDoc(docForWorkspace(resource));
  return resource || next;
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 }); }
  const action = body?.action;

  let ws: Workspace | null;
  try {
    ws = await loadWorkspace(params.id, s.claims.oid);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'Cosmos error' }, { status: 500 });
  }
  if (!ws) return NextResponse.json({ ok: false, error: 'Workspace not found' }, { status: 404 });

  try {
    if (action === 'unlink') {
      const updated = await persist({ ...ws, m365GroupId: undefined, m365SiteUrl: undefined, m365GroupName: undefined });
      return NextResponse.json({ ok: true, workspace: updated });
    }

    if (action === 'link') {
      const groupId = typeof body?.groupId === 'string' ? body.groupId.trim() : '';
      if (!groupId) return NextResponse.json({ ok: false, error: 'groupId is required to link a group' }, { status: 400 });
      const group = await getM365Group(groupId);
      const updated = await persist({
        ...ws,
        m365GroupId: group.id,
        m365GroupName: group.displayName,
        m365SiteUrl: group.siteUrl,
      });
      return NextResponse.json({ ok: true, workspace: updated, group });
    }

    if (action === 'create') {
      if (!m365LinkEnabled()) {
        return NextResponse.json(
          {
            ok: false,
            gate: true,
            error: 'M365 group creation is disabled in this deployment.',
            hint: 'Set LOOM_WORKSPACE_M365_LINK=true and grant the Console UAMI Group.Create (or Group.ReadWrite.All) Graph permission. See platform/fiab/bicep/modules/admin-plane/identity-graph-rbac.bicep.',
          },
          { status: 503 },
        );
      }
      const displayName = (typeof body?.displayName === 'string' && body.displayName.trim()) ? body.displayName.trim() : ws.name;
      const group = await createM365Group({
        displayName,
        description: ws.description,
        ownerObjectId: s.claims.oid,
      });
      const updated = await persist({
        ...ws,
        m365GroupId: group.id,
        m365GroupName: group.displayName,
        m365SiteUrl: group.siteUrl,
      });
      return NextResponse.json({ ok: true, workspace: updated, group });
    }

    return NextResponse.json({ ok: false, error: "action must be 'link', 'create', or 'unlink'" }, { status: 400 });
  } catch (e: any) {
    if (e instanceof M365GroupError) {
      return NextResponse.json(
        { ok: false, gate: e.status === 503, error: e.message, hint: e.remediation },
        { status: e.status },
      );
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
