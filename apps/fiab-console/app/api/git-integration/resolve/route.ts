/**
 * POST /api/git-integration/resolve
 * body: { workspaceId, itemId, resolution: 'local' | 'remote' }
 *
 * Conflict resolution for a single item:
 *   'local'  → commit the local version, overwriting the repo.
 *   'remote' → apply the repo version to the Loom item, overwriting local.
 */

import { NextRequest, NextResponse } from 'next/server';
import { commitItems, pullItemFiles } from '@/lib/azure/git-integration-client';
import { loadGitCtx, loadWorkspaceItems, applyPulledContent, recordSyncSha, gitError } from '../_lib/ctx';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const workspaceId = String(body?.workspaceId || '');
  const itemId = String(body?.itemId || '');
  const resolution = String(body?.resolution || '') as 'local' | 'remote';

  const loaded = await loadGitCtx(workspaceId);
  if ('error' in loaded) return loaded.error;
  const { ctx } = loaded;

  if (!itemId) return NextResponse.json({ ok: false, error: 'itemId required' }, { status: 400 });
  if (resolution !== 'local' && resolution !== 'remote')
    return NextResponse.json({ ok: false, error: "resolution must be 'local' or 'remote'" }, { status: 400 });

  try {
    const items = await loadWorkspaceItems(ctx.tenantId, workspaceId, [itemId]);
    if (items.length === 0)
      return NextResponse.json({ ok: false, error: 'Item not found in this workspace.' }, { status: 404 });

    if (resolution === 'local') {
      const result = await commitItems(
        ctx.config,
        ctx.pat,
        items,
        `Resolve conflict (keep local): ${items[0].displayName}`,
        { name: ctx.name, email: ctx.email },
      );
      await recordSyncSha(workspaceId, result.commitSha);
      return NextResponse.json({ ok: true, resolution, commitSha: result.commitSha, url: result.url, at: result.at });
    }

    // remote
    const pulled = await pullItemFiles(ctx.config, ctx.pat, items);
    const applied = await applyPulledContent(pulled.items, workspaceId);
    await recordSyncSha(workspaceId, pulled.headSha);
    return NextResponse.json({ ok: true, resolution, applied, headSha: pulled.headSha });
  } catch (e) {
    return gitError(e);
  }
}
