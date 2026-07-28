/**
 * POST /api/workspaces/[id]/import — EXP1: import a `.loomws` bundle into
 * THIS workspace with an explicit collision strategy.
 *
 *   body: { bundle: LoomWsBundle, strategy?: 'new-ids' | 'skip-existing' | 'overwrite' }
 *   → { ok, summary: { created, skipped, overwritten, foldersCreated,
 *       foldersReused, refsRemapped, strategy } }
 *
 * 'new-ids' (the DEFAULT) creates every folder + item fresh; the old→new id
 * map is deep-applied across item states so intra-bundle relationships
 * (task-flow bindings, lakehouse↔SQL-endpoint pairing, pipeline refs) point
 * at the IMPORTED graph, never back at the source. Secrets can't be imported
 * because the bundle format never carries them (workspace-export.ts); role
 * grants in `rolesManifest` are informational and are NOT applied.
 *
 * Real Cosmos writes + AI-Search doc upserts (workspace-bundle-io.ts).
 * AuthZ: write-capable access to the TARGET workspace. Kill-switch (FLAG0):
 * `exp1-workspace-portability`.
 */
import type { NextRequest } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { apiOk, apiError } from '@/lib/api/respond';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { resolveWorkspaceAccessByOid } from '@/lib/auth/workspace-access';
import { runtimeFlag } from '@/lib/admin/runtime-flags';
import { itemsContainer, foldersContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem, WorkspaceFolder } from '@/lib/types/workspace';
import { WORKSPACE_PORTABILITY_FLAG } from '@/lib/workspace/workspace-export';
import {
  validateLoomWsBundle,
  planWorkspaceImport,
  isCollisionStrategy,
  type CollisionStrategy,
} from '@/lib/workspace/workspace-import';
import { executeWorkspaceImport, auditWorkspacePortability } from '@/lib/workspace/workspace-bundle-io';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  if (!(await runtimeFlag(WORKSPACE_PORTABILITY_FLAG))) {
    return apiError(
      `Workspace import is disabled via the '${WORKSPACE_PORTABILITY_FLAG}' runtime flag — re-enable it under /admin/runtime-flags.`,
      503,
      { code: 'flag_disabled' },
    );
  }
  const body = (await req.json().catch(() => ({}))) as { bundle?: unknown; strategy?: unknown };
  const validated = validateLoomWsBundle(body.bundle);
  if (!validated.ok) return apiError(validated.error, 400, { code: 'bad_bundle' });
  const strategy: CollisionStrategy = isCollisionStrategy(body.strategy) ? body.strategy : 'new-ids';

  const claims = session.claims as { oid: string; tid?: string; groups?: string[]; upn?: string; email?: string };
  const access = await resolveWorkspaceAccessByOid(claims.oid, params.id, {
    groups: claims.groups,
    callerTid: claims.tid,
    tenantAdmin: isTenantAdmin(session),
  });
  if (!access) return apiError('Workspace not found', 404, { code: 'not_found' });
  if (!access.canWrite) {
    return apiError('Importing into a workspace requires a write-capable role (Owner/Admin/Member).', 403, { code: 'read_only_role' });
  }
  const ws = access.workspace;
  const who = claims.upn || claims.email || claims.oid;

  // Current target docs — what collision resolution needs (ids + identity
  // fields only for items; the heavy state stays out of the plan input).
  const [existingItems, existingFolders] = await Promise.all([
    (async () => {
      const c = await itemsContainer();
      const { resources } = await c.items
        .query<Pick<WorkspaceItem, 'id' | 'itemType' | 'displayName'>>({
          query: 'SELECT c.id, c.itemType, c.displayName FROM c WHERE c.workspaceId = @w',
          parameters: [{ name: '@w', value: ws.id }],
        }, { partitionKey: ws.id })
        .fetchAll();
      return resources;
    })(),
    (async () => {
      const c = await foldersContainer();
      const { resources } = await c.items
        .query<Pick<WorkspaceFolder, 'id' | 'name' | 'parent'>>({
          query: 'SELECT c.id, c.name, c.parent FROM c WHERE c.workspaceId = @w',
          parameters: [{ name: '@w', value: ws.id }],
        })
        .fetchAll();
      return resources;
    })(),
  ]);

  const plan = planWorkspaceImport(validated.bundle, {
    workspaceId: ws.id,
    existingItems,
    existingFolders,
  }, { strategy, createdBy: who });
  const summary = await executeWorkspaceImport(plan, ws);

  await auditWorkspacePortability(
    { oid: claims.oid, who, tenantId: claims.tid || ws.tenantId },
    {
      action: 'import',
      workspaceId: ws.id,
      workspaceName: ws.name,
      detail: {
        sourceWorkspaceId: validated.bundle.source?.workspaceId,
        sourceName: validated.bundle.source?.name,
        ...summary,
      },
    },
  );
  return apiOk({ summary });
});
