/**
 * GET /api/items/mirrored-database/[id]/sql-endpoint?workspaceId=<id>
 *
 * Resolves the paired `synapse-serverless-sql-pool` item for a mirror so the
 * mirrored-database editor can offer a "SQL analytics endpoint" link. The
 * pairing engine (registry.ts → ITEM_PAIRING_RULES['mirrored-database']) creates
 * the paired item with `state.content.mirrorItemId = <mirror id>` and
 * `state.content.database = loom_mirror_<name>` when the mirror is provisioned on
 * the Azure-native ADF-CDC backend (no Microsoft Fabric). When no pairing exists
 * (Fabric backend, or the mirror hasn't been installed/provisioned yet) the route
 * returns `{ ok: true, provisioned: false }` and the editor shows an honest
 * "run Install to provision it" hint rather than a dead link.
 *
 * The Serverless endpoint FQDN is the env-bound workspace's `-ondemand` host,
 * resolved sovereign-cloud-correctly by serverlessEndpoint(). Per
 * no-vaporware.md this is a real Cosmos query against the items partition — no
 * mock data.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { assertOwner } from '@/lib/auth/workspace-guard';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { serverlessEndpoint } from '@/lib/azure/synapse-sql-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  if (!(await assertOwner(workspaceId, session.claims.oid))) return NextResponse.json({ ok: false, error: 'mirrored database not found' }, { status: 404 });

  try {
    const items = await itemsContainer();
    // The mirrorItemId field is only present on mirror-paired Serverless items,
    // so lakehouse-paired siblings (no mirrorItemId) are excluded — no false
    // positives. Partition-scoped query (workspaceId) keeps it a point read.
    const { resources } = await items.items
      .query<WorkspaceItem>(
        {
          query:
            'SELECT c.id, c.displayName, c.state FROM c ' +
            'WHERE c.workspaceId = @w AND c.itemType = @t AND c.state.content.mirrorItemId = @m',
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
    const content = ((paired?.state as Record<string, unknown> | undefined)?.content || {}) as Record<string, unknown>;

    // Endpoint FQDN — only when a Synapse Serverless workspace is configured.
    let endpoint: string | null = null;
    try {
      endpoint = process.env.LOOM_SYNAPSE_WORKSPACE ? serverlessEndpoint() : null;
    } catch {
      endpoint = null;
    }

    return NextResponse.json({
      ok: true,
      provisioned: !!paired,
      sqlItemId: paired?.id ?? null,
      endpoint,
      database: (content.database as string) ?? null,
    });
  } catch (e: any) {
    return apiServerError(e);
  }
}
