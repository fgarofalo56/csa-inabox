/**
 * POST /api/workspaces/[id]/clone — EXP1: clone = export + import COMPOSED.
 *
 *   body: { name?: string, description?: string }
 *   → { ok, workspace: <the new Workspace doc>, summary: ImportSummary }
 *
 * Collects the source workspace's `.loomws` bundle in memory (the SAME
 * serializer the export download uses — secrets and per-estate provisioning
 * refs excluded by construction), creates a fresh workspace owned by the
 * CALLER (non-secret config copied: capacity / domain / license / contacts),
 * then imports the bundle into it with the 'new-ids' strategy — every item +
 * folder gets a fresh id and intra-workspace references are remapped onto the
 * clone. Role grants are NOT copied (the cloner owns the clone and shares it
 * deliberately).
 *
 * Post-create side-effects (capacity assignment / domain registration /
 * workspace identity) run best-effort via the same applyWorkspaceBindings the
 * workspace-create route uses — never blocking, outcome recorded on the doc.
 *
 * AuthZ: write-capable access to the SOURCE workspace. Kill-switch (FLAG0):
 * `exp1-workspace-portability`. Real Cosmos reads/writes only.
 */
import crypto from 'node:crypto';
import type { NextRequest } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { apiOk, apiError } from '@/lib/api/respond';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { resolveWorkspaceAccessByOid } from '@/lib/auth/workspace-access';
import { runtimeFlag } from '@/lib/admin/runtime-flags';
import { workspacesContainer } from '@/lib/azure/cosmos-client';
import { upsertLoomDoc, docForWorkspace } from '@/lib/azure/loom-search';
import { applyWorkspaceBindings } from '@/lib/azure/workspace-bindings';
import type { Workspace } from '@/lib/types/workspace';
import { WORKSPACE_PORTABILITY_FLAG } from '@/lib/workspace/workspace-export';
import { planWorkspaceImport } from '@/lib/workspace/workspace-import';
import { collectWorkspaceBundle, executeWorkspaceImport, auditWorkspacePortability } from '@/lib/workspace/workspace-bundle-io';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  if (!(await runtimeFlag(WORKSPACE_PORTABILITY_FLAG))) {
    return apiError(
      `Workspace clone is disabled via the '${WORKSPACE_PORTABILITY_FLAG}' runtime flag — re-enable it under /admin/runtime-flags.`,
      503,
      { code: 'flag_disabled' },
    );
  }
  const body = (await req.json().catch(() => ({}))) as { name?: unknown; description?: unknown };
  const claims = session.claims as { oid: string; tid?: string; groups?: string[]; upn?: string; email?: string };
  const access = await resolveWorkspaceAccessByOid(claims.oid, params.id, {
    groups: claims.groups,
    callerTid: claims.tid,
    tenantAdmin: isTenantAdmin(session),
  });
  if (!access) return apiError('Workspace not found', 404, { code: 'not_found' });
  if (!access.canWrite) {
    return apiError('Cloning a workspace requires a write-capable role (Owner/Admin/Member).', 403, { code: 'read_only_role' });
  }
  const source = access.workspace;
  const who = claims.upn || claims.email || claims.oid;

  // Export half — the in-memory bundle (secrets/provisioning excluded).
  const bundle = await collectWorkspaceBundle(source, who);

  // New workspace owned by the CALLER (same doc conventions as the create route).
  const cloneName = (typeof body.name === 'string' && body.name.trim()) ? body.name.trim().slice(0, 120) : `${source.name} (clone)`;
  const now = new Date().toISOString();
  const ws: Workspace = {
    id: crypto.randomUUID(),
    tenantId: claims.oid,
    ownerOid: claims.oid,
    ...(claims.tid ? { tid: claims.tid } : {}),
    name: cloneName,
    description: (typeof body.description === 'string' && body.description.trim())
      ? body.description.trim()
      : (source.description || `Clone of "${source.name}".`),
    capacity: source.capacity,
    domain: source.domain,
    ...(source.licenseMode ? { licenseMode: source.licenseMode } : {}),
    ...(source.contacts?.length ? { contacts: [...source.contacts] } : {}),
    createdBy: who,
    createdAt: now,
    updatedAt: now,
  };
  const c = await workspacesContainer();
  const { resource: created } = await c.items.create<Workspace>(ws);
  if (!created) return apiError('Cosmos returned no resource on clone create', 500, { code: 'cosmos_no_resource' });
  void upsertLoomDoc(docForWorkspace(created));

  // Import half — 'new-ids' into the (empty) clone.
  const plan = planWorkspaceImport(bundle, {
    workspaceId: created.id,
    existingItems: [],
    existingFolders: [],
  }, { strategy: 'new-ids', createdBy: who });
  const summary = await executeWorkspaceImport(plan, created);

  // Best-effort post-create bindings (capacity / domain / identity) — the same
  // never-blocking side-effect pass the workspace-create route runs.
  let merged: Workspace = created;
  try {
    const bindings = await applyWorkspaceBindings(created);
    merged = {
      ...created,
      ...(bindings.capacityAssignment ? { capacityAssignment: bindings.capacityAssignment } : {}),
      ...(bindings.domainRegistration ? { domainRegistration: bindings.domainRegistration } : {}),
      ...(bindings.workspaceIdentity ? { workspaceIdentity: bindings.workspaceIdentity } : {}),
      updatedAt: new Date().toISOString(),
    };
    try {
      await c.item(merged.id, merged.tenantId).replace(merged);
    } catch {
      merged = created; // replace raced — the clone itself already succeeded
    }
  } catch {
    /* bindings are best-effort; the clone stands either way */
  }

  await auditWorkspacePortability(
    { oid: claims.oid, who, tenantId: claims.tid || source.tenantId },
    {
      action: 'clone',
      workspaceId: source.id,
      workspaceName: source.name,
      detail: { cloneWorkspaceId: merged.id, cloneName: merged.name, ...summary },
    },
  );
  return apiOk({ workspace: merged, summary });
});
