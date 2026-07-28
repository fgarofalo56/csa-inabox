/**
 * GET /api/workspaces/[id]/export — EXP1: the portable whole-workspace
 * `.loomws` bundle download (items + content + folders + non-secret config +
 * informational roles manifest; secrets EXCLUDED with the explicit manifest
 * note — see lib/workspace/workspace-export.ts).
 *
 * The workspace-scoped sibling of the app-scoped `.loomapp` export
 * (/api/items/loom-app-runtime/[id]/export) — same download convention
 * (content-disposition attachment, pretty JSON), generalized to the whole
 * metadata plane. Real Cosmos reads only; cloud-invariant; the bundle travels
 * through the caller's session so IL5 estates keep it in-boundary.
 *
 * AuthZ: write-capable workspace access (Owner/Admin/Member) — the bundle
 * carries every item's content plus the membership manifest, so read-only
 * shared roles may not exfiltrate it wholesale. Kill-switch (FLAG0):
 * `exp1-workspace-portability`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { apiError } from '@/lib/api/respond';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { resolveWorkspaceAccessByOid } from '@/lib/auth/workspace-access';
import { runtimeFlag } from '@/lib/admin/runtime-flags';
import { WORKSPACE_PORTABILITY_FLAG, loomwsFilename } from '@/lib/workspace/workspace-export';
import { collectWorkspaceBundle, auditWorkspacePortability } from '@/lib/workspace/workspace-bundle-io';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession<{ id: string }>(async (_req: NextRequest, { session, params }) => {
  if (!(await runtimeFlag(WORKSPACE_PORTABILITY_FLAG))) {
    return apiError(
      `Workspace export is disabled via the '${WORKSPACE_PORTABILITY_FLAG}' runtime flag — re-enable it under /admin/runtime-flags.`,
      503,
      { code: 'flag_disabled' },
    );
  }
  const claims = session.claims as { oid: string; tid?: string; groups?: string[]; upn?: string; email?: string };
  const access = await resolveWorkspaceAccessByOid(claims.oid, params.id, {
    groups: claims.groups,
    callerTid: claims.tid,
    tenantAdmin: isTenantAdmin(session),
  });
  if (!access) return apiError('Workspace not found', 404, { code: 'not_found' });
  if (!access.canWrite) {
    return apiError('Exporting a workspace requires a write-capable role (Owner/Admin/Member).', 403, { code: 'read_only_role' });
  }
  const who = claims.upn || claims.email || claims.oid;
  const bundle = await collectWorkspaceBundle(access.workspace, who);
  await auditWorkspacePortability(
    { oid: claims.oid, who, tenantId: claims.tid || access.workspace.tenantId },
    {
      action: 'export',
      workspaceId: access.workspace.id,
      workspaceName: access.workspace.name,
      detail: {
        itemCount: bundle.manifest.itemCount,
        folderCount: bundle.manifest.folderCount,
        secretsScrubbed: bundle.manifest.scrubbedPaths.length,
      },
    },
  );
  return new NextResponse(JSON.stringify(bundle, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'content-disposition': `attachment; filename="${loomwsFilename(access.workspace.name)}"`,
    },
  });
});
