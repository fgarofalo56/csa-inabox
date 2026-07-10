/**
 * WS-PBIMAP — workspace → Power BI workspace mapping.
 *
 * GET  /api/workspaces/[id]/powerbi-mapping
 *   → { ok:true, mapping: PbiWorkspaceMapping | null, pbiConfigured }
 * PUT  /api/workspaces/[id]/powerbi-mapping   { pbiWorkspaceId, pbiWorkspaceName? }
 *   → { ok:true, mapping }  (empty pbiWorkspaceId clears the mapping)
 *
 * Auth mirrors the sibling PATCH /api/workspaces/[id]: any workspace role may
 * READ; setting/clearing the mapping requires a WRITE-capable role (Owner /
 * Admin / Member) via the workspace-roles ACL — the same guard that gates every
 * other workspace setting. The mapping persists on the workspace Cosmos doc; no
 * new container (per no-fabric-dependency the mapping is opt-in).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { workspacesContainer } from '@/lib/azure/cosmos-client';
import { resolveWorkspaceAccessByOid, type WorkspaceAccess } from '@/lib/auth/workspace-access';
import { powerbiConfigGate } from '@/lib/azure/powerbi-client';
import { isPbiWorkspaceId, type PbiWorkspaceMapping } from '@/lib/azure/powerbi-workspace-mapping';
import { apiError } from '@/lib/api/respond';
import type { Workspace } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function loadAccess(id: string): Promise<{ access: WorkspaceAccess | null; session: ReturnType<typeof getSession> }> {
  const session = getSession();
  if (!session) return { access: null, session };
  const claims = session.claims as { oid: string; tid?: string; groups?: string[] };
  const access = await resolveWorkspaceAccessByOid(claims.oid, id, { groups: claims.groups, callerTid: claims.tid });
  return { access, session };
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const { access, session } = await loadAccess(id);
  if (!session) return apiError('unauthenticated', 401);
  if (!access) return apiError('workspace not found', 404);
  return NextResponse.json({
    ok: true,
    mapping: access.workspace.pbiWorkspaceMapping ?? null,
    pbiConfigured: powerbiConfigGate() === null,
  });
}

export async function PUT(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const { access, session } = await loadAccess(id);
  if (!session) return apiError('unauthenticated', 401);
  if (!access) return apiError('workspace not found', 404);
  if (!access.canWrite) return apiError('You have read-only access to this workspace.', 403, { code: 'read_only_role' });

  let body: any;
  try { body = await req.json(); } catch { return apiError('Invalid JSON', 400, { code: 'bad_json' }); }

  const rawId = typeof body?.pbiWorkspaceId === 'string' ? body.pbiWorkspaceId.trim() : '';
  const rawName = typeof body?.pbiWorkspaceName === 'string' ? body.pbiWorkspaceName.trim() : '';

  // Empty id clears the mapping; a non-empty id must be a valid GUID.
  let mapping: PbiWorkspaceMapping | undefined;
  if (rawId) {
    if (!isPbiWorkspaceId(rawId)) {
      return apiError('pbiWorkspaceId must be a Power BI workspace GUID.', 400, { code: 'invalid_guid' });
    }
    mapping = {
      pbiWorkspaceId: rawId,
      pbiWorkspaceName: rawName || undefined,
      mappedBy: session.claims.upn || session.claims.oid,
      mappedAt: new Date().toISOString(),
    };
  }

  try {
    const ws = access.workspace;
    const next: Workspace = { ...ws, pbiWorkspaceMapping: mapping, updatedAt: new Date().toISOString() };
    const c = await workspacesContainer();
    const { resource } = await c.item(ws.id, ws.tenantId).replace<Workspace>(next);
    return NextResponse.json({ ok: true, mapping: resource?.pbiWorkspaceMapping ?? null });
  } catch (e: any) {
    return apiError(e?.message || 'Failed to save Power BI workspace mapping', 500, { code: 'cosmos_error' });
  }
}
