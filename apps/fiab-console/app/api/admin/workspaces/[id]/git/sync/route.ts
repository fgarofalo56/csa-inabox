/**
 * F12 Git integration — sync: commit every workspace item to source control.
 *
 * POST /api/admin/workspaces/[id]/git/sync
 *
 * Real backend per no-vaporware.md: loads every WorkspaceItem from Cosmos,
 * serializes each to a deterministic `*.item.json` blob (+ a `.loom/workspace.json`
 * manifest), retrieves the PAT from Key Vault, and commits the whole tree in ONE
 * atomic push to the bound Azure DevOps repo (ADO push REST) or GitHub repo
 * (GitHub Git Data API). The real commit SHA returned by the service is recorded
 * on the binding and returned to the caller — that SHA is the receipt.
 *
 * Lives under `/api/admin/.../git/sync` — front-door.bicep's custom Allow rule
 * scopes the OWASP-`.git`-rule bypass to exactly this admin path family.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { workspacesContainer, itemsContainer } from '@/lib/azure/cosmos-client';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';
import { loadBinding, resolveSecret, recordSync } from '@/lib/azure/git-binding-store';
import {
  serializeItem, itemFilePath, workspaceManifestPath, serializeManifest,
  adoGetBranchTip, adoExistingPaths, adoPushFiles,
  githubBatchCommit, githubCloudGate, githubApiBase,
  type SyncFile, GitIntegrationError,
} from '@/lib/clients/git-integration-client';

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

function fail(error: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error, ...extra }, { status });
}

export async function POST(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const s = getSession();
  if (!s) return fail('unauthenticated', 401);

  const ws = await loadWorkspace(params.id, s.claims.oid);
  if (!ws) return fail('workspace not found', 404);

  const binding = await loadBinding(params.id);
  if (!binding) return fail('No Git binding for this workspace. Connect a repository first.', 400, { code: 'not_connected' });

  try {
    // 1. Resolve the PAT from Key Vault.
    const pat = await resolveSecret(binding);

    // 2. Load every workspace item.
    const items = await itemsContainer();
    const { resources } = await items.items
      .query<WorkspaceItem>(
        { query: 'SELECT * FROM c WHERE c.workspaceId = @w', parameters: [{ name: '@w', value: ws.id }] },
        { partitionKey: ws.id },
      )
      .fetchAll();

    // 3. Serialize to a file tree (manifest + one blob per item).
    const now = new Date().toISOString();
    const files: SyncFile[] = [
      {
        path: workspaceManifestPath(binding.folder),
        content: serializeManifest({
          loomVersion: '1', id: ws.id, name: ws.name, description: ws.description ?? null,
          tenantId: ws.tenantId, syncedAt: now, itemCount: resources.length,
        }),
      },
      ...resources.map((it) => ({ path: itemFilePath(binding.folder, it), content: serializeItem(it) })),
    ];

    const comment = `Loom workspace sync — ${ws.name} (${resources.length} item${resources.length === 1 ? '' : 's'}) at ${now}`;

    // 4. Push to the bound provider.
    let commitId: string;
    if (binding.provider === 'ado') {
      if (!binding.adoOrg || !binding.adoProject || !binding.repoId) {
        return fail('Azure DevOps binding is incomplete (org/project/repo).', 400, { code: 'binding_incomplete' });
      }
      const oldObjectId = await adoGetBranchTip(binding.adoOrg, binding.adoProject, binding.repoId, binding.branch, pat);
      const existing = await adoExistingPaths(binding.adoOrg, binding.adoProject, binding.repoId, binding.branch, binding.folder, pat);
      let result;
      try {
        result = await adoPushFiles({
          org: binding.adoOrg, project: binding.adoProject, repoId: binding.repoId, branch: binding.branch,
          oldObjectId, files, existing, comment, pat,
        });
      } catch (e: any) {
        // Concurrent-push race (stale oldObjectId) → refresh tip + existing, retry once.
        if (e instanceof GitIntegrationError && (e.status === 409 || e.code === 'ado_error')) {
          const tip2 = await adoGetBranchTip(binding.adoOrg, binding.adoProject, binding.repoId, binding.branch, pat);
          const existing2 = await adoExistingPaths(binding.adoOrg, binding.adoProject, binding.repoId, binding.branch, binding.folder, pat);
          result = await adoPushFiles({
            org: binding.adoOrg, project: binding.adoProject, repoId: binding.repoId, branch: binding.branch,
            oldObjectId: tip2, files, existing: existing2, comment, pat,
          });
        } else {
          throw e;
        }
      }
      commitId = result.commitId;
    } else {
      const gate = githubCloudGate();
      if (gate) return fail(gate.message, gate.status, { code: gate.code });
      if (!binding.githubOwner || !binding.githubRepo) {
        return fail('GitHub binding is incomplete (owner/repo).', 400, { code: 'binding_incomplete' });
      }
      const result = await githubBatchCommit({
        owner: binding.githubOwner, repo: binding.githubRepo, branch: binding.branch, files, message: comment, pat,
        base: githubApiBase(binding.githubHost),
      });
      commitId = result.commitId;
    }

    // 5. Record the real commit on the binding.
    await recordSync(params.id, {
      lastSyncAt: now, lastSyncCommitId: commitId, lastSyncFileCount: files.length,
      lastSyncError: undefined, status: 'connected', statusDetail: undefined,
    });

    return NextResponse.json({ ok: true, commitId, syncedAt: now, fileCount: files.length, itemCount: resources.length });
  } catch (e: any) {
    const msg = e?.message || 'sync failed';
    await recordSync(params.id, { lastSyncError: msg, status: 'error', statusDetail: msg }).catch(() => {});
    if (e instanceof GitIntegrationError) return fail(e.message, e.status, { code: e.code });
    if (e?.status) return fail(msg, e.status, { code: e.code, missing: e.missing });
    return fail(msg, 500);
  }
}
