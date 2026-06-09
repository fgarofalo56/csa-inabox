/**
 * POST /api/git-integration/commit
 * body: { workspaceId, itemIds: string[], message: string }
 *
 * Serializes the selected items to canonical repo files and pushes them as a
 * single commit to ADO Repos or GitHub. Returns the commit SHA + web URL.
 * Receipt: commitSha + url + files.
 */

import { NextRequest, NextResponse } from 'next/server';
import { commitItems } from '@/lib/azure/git-integration-client';
import { loadGitCtx, loadWorkspaceItems, recordSyncSha, gitError } from '../_lib/ctx';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const workspaceId = String(body?.workspaceId || '');
  const itemIds: string[] = Array.isArray(body?.itemIds) ? body.itemIds.map(String) : [];
  const message = String(body?.message || '').trim() || 'Loom commit';

  const loaded = await loadGitCtx(workspaceId);
  if ('error' in loaded) return loaded.error;
  const { ctx } = loaded;

  if (itemIds.length === 0)
    return NextResponse.json({ ok: false, error: 'Select at least one item to commit (itemIds required).' }, { status: 400 });

  try {
    const items = await loadWorkspaceItems(ctx.tenantId, workspaceId, itemIds);
    if (items.length === 0)
      return NextResponse.json({ ok: false, error: 'No matching items found in this workspace.' }, { status: 404 });
    const result = await commitItems(ctx.config, ctx.pat, items, message, { name: ctx.name, email: ctx.email });
    await recordSyncSha(workspaceId, result.commitSha);
    return NextResponse.json({
      ok: true,
      commitSha: result.commitSha,
      url: result.url,
      at: result.at,
      files: result.files,
      committed: items.map((i) => ({ id: i.id, displayName: i.displayName, itemType: i.itemType })),
    });
  } catch (e) {
    return gitError(e);
  }
}
