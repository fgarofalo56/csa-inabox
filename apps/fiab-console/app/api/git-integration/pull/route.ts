/**
 * POST /api/git-integration/pull
 * body: { workspaceId, itemIds?: string[] }
 *
 * Reads item files from the connected repo, deserializes them, and applies any
 * changed content back to the Loom items (Cosmos state.content). Returns the
 * head SHA + applied count + diff. Receipt: headSha + applied + diff.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pullItemFiles } from '@/lib/azure/git-integration-client';
import { loadGitCtx, loadWorkspaceItems, applyPulledContent, recordSyncSha, gitError } from '../_lib/ctx';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const workspaceId = String(body?.workspaceId || '');
  const itemIds: string[] | undefined = Array.isArray(body?.itemIds) ? body.itemIds.map(String) : undefined;

  const loaded = await loadGitCtx(workspaceId);
  if ('error' in loaded) return loaded.error;
  const { ctx } = loaded;

  try {
    const items = await loadWorkspaceItems(ctx.tenantId, workspaceId, itemIds);
    const result = await pullItemFiles(ctx.config, ctx.pat, items);
    const applied = await applyPulledContent(result.items, workspaceId);
    await recordSyncSha(workspaceId, result.headSha);
    return NextResponse.json({
      ok: true,
      headSha: result.headSha,
      applied,
      diff: result.diff,
      items: result.items.map((i) => ({ id: i.cosmosItemId, displayName: i.displayName, itemType: i.itemType })),
    });
  } catch (e) {
    return gitError(e);
  }
}
