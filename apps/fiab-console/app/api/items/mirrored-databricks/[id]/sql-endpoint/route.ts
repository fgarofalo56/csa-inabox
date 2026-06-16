/**
 * GET /api/items/mirrored-databricks/[id]/sql-endpoint?workspaceId=<id>
 *
 * Resolves the paired `synapse-serverless-sql-pool` item that makes a mirrored
 * Databricks Unity Catalog queryable in Loom (audit H8). The create route
 * (route.ts) pairs the endpoint and records `sqlItemId` / `sqlDatabase` /
 * `sqlEndpoint` on the mirror's state; this route reads them back AND falls back
 * to a live Cosmos query for the paired item (state.content.databricksMirrorItemId
 * = <mirror id>) so a mirror paired via the install engine (no inline state) is
 * still resolved. When nothing is paired (Databricks/Synapse not configured, or
 * the catalog had no Delta tables) it returns { ok: true, provisioned: false }
 * with the recorded gate so the editor shows an honest hint, not a dead link.
 *
 * Per no-vaporware.md this is a real Cosmos read — no mock data.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { serverlessEndpoint } from '@/lib/azure/synapse-sql-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });

  try {
    const items = await itemsContainer();

    // Read the mirror to surface any recorded pairing / gate.
    let mirrorState: Record<string, unknown> = {};
    try {
      const { resource } = await items.item(id, workspaceId).read<WorkspaceItem>();
      if (resource?.itemType === 'mirrored-databricks') {
        mirrorState = (resource.state as Record<string, unknown>) || {};
      }
    } catch { /* mirror may not exist yet */ }

    // Prefer the live paired item (authoritative for the per-mirror DB name).
    const { resources } = await items.items
      .query<WorkspaceItem>(
        {
          query:
            'SELECT c.id, c.displayName, c.state FROM c ' +
            'WHERE c.workspaceId = @w AND c.itemType = @t AND c.state.content.databricksMirrorItemId = @m',
          parameters: [
            { name: '@w', value: workspaceId },
            { name: '@t', value: 'synapse-serverless-sql-pool' },
            { name: '@m', value: id },
          ],
        },
        { partitionKey: workspaceId },
      )
      .fetchAll();

    const paired = resources[0] ?? null;
    const pairedContent = ((paired?.state as Record<string, unknown> | undefined)?.content || {}) as Record<string, unknown>;

    let endpoint: string | null = null;
    try {
      endpoint = process.env.LOOM_SYNAPSE_WORKSPACE ? serverlessEndpoint() : null;
    } catch {
      endpoint = null;
    }

    const provisioned = !!paired || !!mirrorState.sqlItemId;
    return NextResponse.json({
      ok: true,
      provisioned,
      sqlItemId: paired?.id ?? (mirrorState.sqlItemId as string) ?? null,
      endpoint: endpoint ?? (mirrorState.sqlEndpoint as string) ?? null,
      database:
        (mirrorState.sqlDatabase as string) ??
        (pairedContent.database as string) ??
        ((paired?.state as Record<string, unknown> | undefined)?.content as Record<string, unknown> | undefined)
          ?.database as string ??
        null,
      viewCount: (mirrorState.viewCount as string) ?? null,
      catalogName: (mirrorState.catalogName as string) ?? null,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
