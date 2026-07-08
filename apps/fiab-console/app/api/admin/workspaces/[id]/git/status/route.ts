/**
 * F12 Git integration — live status: real head commit on the bound branch.
 *
 * GET /api/admin/workspaces/[id]/git/status
 *
 * Returns the binding's cached sync result (commit + time from the last push) AND
 * a LIVE read of the branch's current head commit from ADO / GitHub REST, so the
 * UI can show the real SHA + whether the remote has moved since the last sync.
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveAdminWorkspace } from '@/lib/auth/workspace-guard';
import { loadBinding, resolveSecret, toView } from '@/lib/azure/git-binding-store';
import { adoLastCommit, githubLastCommit, githubCloudGate, githubApiBase, GitIntegrationError } from '@/lib/clients/git-integration-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const resolved = await resolveAdminWorkspace(params.id);
  if (resolved.resp) return resolved.resp;

  const binding = await loadBinding(params.id);
  if (!binding) return NextResponse.json({ ok: true, git: null });

  const localSync = {
    commitId: binding.lastSyncCommitId || null,
    syncedAt: binding.lastSyncAt || null,
    fileCount: binding.lastSyncFileCount ?? null,
    error: binding.lastSyncError || null,
  };

  let remoteHead: { commitId: string; commitDate?: string; authorName?: string; comment?: string } | null = null;
  let remoteError: string | null = null;
  try {
    const pat = await resolveSecret(binding);
    if (binding.provider === 'ado' && binding.adoOrg && binding.adoProject && binding.repoId) {
      remoteHead = await adoLastCommit(binding.adoOrg, binding.adoProject, binding.repoId, binding.branch, pat);
    } else if (binding.provider === 'github' && binding.githubOwner && binding.githubRepo) {
      const gate = githubCloudGate();
      if (gate) { remoteError = gate.message; }
      else remoteHead = await githubLastCommit(binding.githubOwner, binding.githubRepo, binding.branch, pat, githubApiBase(binding.githubHost));
    }
  } catch (e: any) {
    remoteError = e instanceof GitIntegrationError ? e.message : (e?.message || 'could not read remote head');
  }

  return NextResponse.json({ ok: true, git: toView(binding), localSync, remoteHead, remoteError });
}
