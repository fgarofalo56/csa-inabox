/**
 * GET /api/git-integration/status?workspaceId=<id>
 *
 * Compares the workspace's items to the connected repo and returns the list of
 * changed items (added / modified / removed). Honest-gates if no repo is bound,
 * no Key Vault is configured, or no PAT is stored.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getStatus } from '@/lib/azure/git-integration-client';
import { loadGitCtx, loadWorkspaceItems, gitError } from '../_lib/ctx';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const workspaceId = req.nextUrl.searchParams.get('workspaceId') || '';
  const loaded = await loadGitCtx(workspaceId);
  if ('error' in loaded) return loaded.error;
  const { ctx } = loaded;
  try {
    const items = await loadWorkspaceItems(ctx.tenantId, workspaceId);
    const result = await getStatus(ctx.config, ctx.pat, items);
    return NextResponse.json({
      ok: true,
      workspaceId,
      repo: { provider: ctx.config.provider, repoPath: ctx.config.repoPath, branch: ctx.config.branch },
      headSha: result.headSha,
      lastSyncedSha: ctx.config.lastSyncedSha || null,
      changed: result.changed,
    });
  } catch (e) {
    return gitError(e);
  }
}
