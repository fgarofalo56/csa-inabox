/**
 * F12 Git integration — "Branch out to a new workspace".
 *
 * POST /api/admin/workspaces/[id]/git/branch-out
 *   body: { newBranchName, newWorkspaceName }
 *
 * Azure-native parity for Fabric's "Branch out to another workspace": from a
 * workspace already bound to Git, create a NEW git branch (off the source
 * branch's current tip), create a NEW Loom workspace, bind that workspace to the
 * new branch, and apply the source workspace's item set to it. Real end-to-end:
 *   1. Real Git Data API branch create — Azure DevOps `POST /_apis/git/refs`
 *      (oldObjectId=zero → create) or GitHub `POST /git/refs` — at the source
 *      branch tip resolved from the live provider.
 *   2. Real workspace create (Cosmos `workspaces`, same path the /api/workspaces
 *      POST uses — inherits the source domain/capacity, best-effort bindings +
 *      search index).
 *   3. Real Git binding for the new workspace (git-binding-store → PAT re-written
 *      to Key Vault, branch = the new branch).
 *   4. Real item copy — every source item re-created in the new workspace via the
 *      shared item-crud create path.
 *
 * Honest gate: 400 when the source workspace is not connected to Git; a clear
 * 409 when the source branch has no commit to branch from (sync first) or when
 * the target branch already exists. No Fabric / Power BI dependency.
 *
 * Lives under `/api/admin/.../git/branch-out` — front-door.bicep's custom Allow
 * rule scopes the OWASP-`.git`-rule bypass to exactly this admin path family
 * (a bare `/api/workspaces/.../git/*` POST would be 403'd by the WAF).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { workspacesContainer } from '@/lib/azure/cosmos-client';
import { upsertLoomDoc, docForWorkspace } from '@/lib/azure/loom-search';
import { applyWorkspaceBindings } from '@/lib/azure/workspace-bindings';
import { listAllOwnedItems, createOwnedItem } from '@/app/api/items/_lib/item-crud';
import { loadBinding, saveBinding, resolveSecret } from '@/lib/azure/git-binding-store';
import {
  adoGetBranchTip, adoCreateBranch, ADO_ZERO_OBJECT_ID,
  githubGetBranchSha, githubCreateBranch, githubCloudGate, githubApiBase,
  GitIntegrationError,
} from '@/lib/clients/git-integration-client';
import type { Workspace } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function fail(error: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error, ...extra }, { status });
}

/** Git ref-name safety: reject the characters git forbids in a branch name. */
function sanitizeBranchName(raw: string): string | null {
  const b = (raw || '').trim().replace(/^\/+|\/+$/g, '');
  if (!b) return null;
  if (b.length > 200) return null;
  if (/\s/.test(b)) return null;
  if (/\.\.|@\{|[~^:?*[\\]|\/\/|\.lock$|^\.|\/$/.test(b)) return null;
  if (!/^[\w./-]+$/.test(b)) return null;
  return b;
}

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

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const s = getSession();
  if (!s) return fail('unauthenticated', 401);
  const tenantId = s.claims.oid;

  const source = await loadWorkspace(params.id, tenantId);
  if (!source) return fail('workspace not found', 404);

  const body = await req.json().catch(() => ({}));
  const newBranch = sanitizeBranchName(String(body?.newBranchName || ''));
  const newWorkspaceName = String(body?.newWorkspaceName || '').trim().slice(0, 256);
  if (!newBranch) {
    return fail('A valid new branch name is required (no spaces or git-reserved characters).', 400, { code: 'bad_branch_name' });
  }
  if (!newWorkspaceName) return fail('A name for the new workspace is required.', 400, { code: 'bad_workspace_name' });

  const binding = await loadBinding(params.id);
  if (!binding) {
    return fail(
      'This workspace is not connected to Git. Connect a repository in Git integration first, then branch out.',
      400, { code: 'not_connected' },
    );
  }

  try {
    // 1. Resolve the PAT/SPN secret from Key Vault (honest-gates when KV is unset).
    const pat = await resolveSecret(binding);

    // 2. Create the new branch at the source branch tip — real Git Data API.
    let fromCommit: string;
    if (binding.provider === 'ado') {
      if (!binding.adoOrg || !binding.adoProject || !binding.repoId) {
        return fail('Azure DevOps binding is incomplete (org/project/repo).', 400, { code: 'binding_incomplete' });
      }
      const tip = await adoGetBranchTip(binding.adoOrg, binding.adoProject, binding.repoId, binding.branch, pat);
      if (!tip || tip === ADO_ZERO_OBJECT_ID) {
        return fail(
          `The source branch "${binding.branch}" has no commits yet. Sync this workspace to Git first, then branch out.`,
          409, { code: 'no_source_commit' },
        );
      }
      const created = await adoCreateBranch(binding.adoOrg, binding.adoProject, binding.repoId, newBranch, tip, pat);
      fromCommit = created.objectId;
    } else {
      const gate = githubCloudGate();
      if (gate) return fail(gate.message, gate.status, { code: gate.code });
      if (!binding.githubOwner || !binding.githubRepo) {
        return fail('GitHub binding is incomplete (owner/repo).', 400, { code: 'binding_incomplete' });
      }
      const base = githubApiBase(binding.githubHost);
      const tip = await githubGetBranchSha(binding.githubOwner, binding.githubRepo, binding.branch, pat, base);
      if (!tip) {
        return fail(
          `The source branch "${binding.branch}" has no commits yet. Sync this workspace to Git first, then branch out.`,
          409, { code: 'no_source_commit' },
        );
      }
      const created = await githubCreateBranch(binding.githubOwner, binding.githubRepo, newBranch, tip, pat, base);
      fromCommit = created.sha;
    }

    // 3. Create the new workspace (same path /api/workspaces POST uses — inherit
    //    the source domain/capacity; best-effort bindings + search index).
    const now = new Date().toISOString();
    const newWs: Workspace = {
      id: crypto.randomUUID(),
      tenantId,
      // rel-T11: carry owner oid + Entra tenant id onto the branched workspace.
      ownerOid: tenantId,
      ...(s.claims.tid ? { tid: s.claims.tid } : {}),
      name: newWorkspaceName,
      description: source.description
        ? `${source.description} (branched from ${source.name})`
        : `Branched from ${source.name} @ ${binding.branch}`,
      capacity: source.capacity,
      domain: source.domain,
      createdBy: s.claims.upn || s.claims.email || tenantId,
      createdAt: now,
      updatedAt: now,
    };
    const wsc = await workspacesContainer();
    const { resource: createdWs } = await wsc.items.create<Workspace>(newWs);
    if (!createdWs) return fail('Failed to create the new workspace.', 500, { code: 'workspace_create_failed' });

    let mergedWs: Workspace = createdWs;
    if (createdWs.capacity || createdWs.domain) {
      try {
        const bindings = await applyWorkspaceBindings(createdWs);
        mergedWs = {
          ...createdWs,
          ...(bindings.capacityAssignment ? { capacityAssignment: bindings.capacityAssignment } : {}),
          ...(bindings.domainRegistration ? { domainRegistration: bindings.domainRegistration } : {}),
          updatedAt: new Date().toISOString(),
        };
        try { await wsc.item(mergedWs.id, tenantId).replace(mergedWs); } catch { /* race — keep original */ }
      } catch { /* applyWorkspaceBindings never throws, but fail-safe */ }
    }
    void upsertLoomDoc(docForWorkspace(mergedWs));

    // 4. Bind the new workspace to the new branch — real git binding (PAT → KV).
    await saveBinding({
      workspaceId: mergedWs.id,
      provider: binding.provider,
      adoOrg: binding.adoOrg,
      adoProject: binding.adoProject,
      repoId: binding.repoId,
      repoName: binding.repoName,
      githubOwner: binding.githubOwner,
      githubRepo: binding.githubRepo,
      githubHost: binding.githubHost,
      branch: newBranch,
      folder: binding.folder,
      authMethod: binding.authMethod,
      spnTenantId: binding.spnTenantId,
      spnClientId: binding.spnClientId,
      secret: pat,
      connectedBy: s.claims.upn || s.claims.email || tenantId,
    });

    // 5. Apply the source item set to the new workspace (real item-crud creates).
    const items = await listAllOwnedItems(tenantId, source.id);
    let itemsCopied = 0;
    const itemsFailed: Array<{ displayName: string; itemType: string; error: string }> = [];
    for (const it of items) {
      const res = await createOwnedItem(s, it.itemType, {
        workspaceId: mergedWs.id,
        displayName: it.displayName,
        description: it.description,
        state: { ...((it.state as Record<string, unknown>) || {}) },
        folderId: it.folderId ?? null,
      });
      if (res.ok) itemsCopied++;
      else itemsFailed.push({ displayName: it.displayName, itemType: it.itemType, error: res.error });
    }

    return NextResponse.json({
      ok: true,
      data: {
        workspaceId: mergedWs.id,
        workspaceName: mergedWs.name,
        branch: newBranch,
        fromBranch: binding.branch,
        fromCommit,
        provider: binding.provider,
        repo: binding.provider === 'ado'
          ? `${binding.adoOrg}/${binding.adoProject}/${binding.repoName || binding.repoId}`
          : `${binding.githubOwner}/${binding.githubRepo}`,
        itemsCopied,
        itemsFailed,
      },
    });
  } catch (e: any) {
    if (e instanceof GitIntegrationError) return fail(e.message, e.status, { code: e.code });
    if (e?.status) return fail(e.message || 'Branch out failed', e.status, { code: e.code, missing: e.missing });
    return fail(e?.message || 'Branch out failed', 500);
  }
}
