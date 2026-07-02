/**
 * Mirrored Database detail. Cosmos-backed in v3.25.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { mirroredDatabaseFromContent } from '../../_lib/ai-content-fallback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';



export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  try {
    const items = await itemsContainer();
    const { resource } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!resource || resource.itemType !== 'mirrored-database') return apiError('mirrored database not found', 404);
    const liveDefinition = (resource.state as any)?.definition || null;
    // Bundle-installed mirror with no live definition yet: project the
    // bundle's MirroredDatabaseContent (source + tables) into the editor's
    // definition + per-table replication shape so it opens FULLY BUILT-OUT.
    if (!liveDefinition) {
      const fallback = mirroredDatabaseFromContent(resource);
      if (fallback) {
        return NextResponse.json({
          ok: true,
          mirroredDatabase: { id: resource.id, displayName: resource.displayName, description: resource.description },
          definition: fallback.definition,
          status: fallback.status,
          tables: fallback.tables,
          source: 'bundle',
        });
      }
    }
    const st = (resource.state as any) || {};
    // Project the engine's real per-table metrics into the editor's grid shape.
    const tablesStatus = Array.isArray(st.tablesStatus) ? st.tablesStatus : null;
    const tables = tablesStatus
      ? {
          data: tablesStatus.map((t: any) => ({
            sourceSchemaName: t.schema,
            sourceTableName: t.table,
            status: t.status === 'replicated' ? 'Replicated' : 'Error',
            metrics: { processedRows: t.rows, processedBytes: t.bytes, lastSyncDateTime: t.lastSync },
            path: t.path,
            openrowset: t.openrowset,
            truncated: t.truncated,
            // Incremental vs full snapshot + the per-table CT watermark / disclosure.
            mode: t.mode,
            syncVersion: t.syncVersion,
            note: t.note,
            error: t.error,
          })),
        }
      : null;
    return NextResponse.json({
      ok: true,
      mirroredDatabase: { id: resource.id, displayName: resource.displayName, description: resource.description },
      definition: liveDefinition,
      status: { mirroringStatus: st.mirroringStatus || 'NotStarted', error: st.lastRun?.error },
      // Source config so the editor can pre-fill the Edit form + Test connection.
      // BigQuery (projectId) + Oracle (serviceName/gateway/syncUser) round-trip too.
      source: {
        sourceType: st.sourceType, server: st.server, database: st.database,
        connectionId: st.connectionId, tables: st.tables || [],
        includeIcebergTables: !!st.includeIcebergTables,
        projectId: st.projectId, serviceName: st.serviceName, gateway: st.gateway, syncUser: st.syncUser,
        syncMode: st.syncMode,
      },
      lastRun: st.lastRun || null,
      tables,
    });
  } catch (e: any) {
    if (e?.code === 404) return apiError('mirrored database not found', 404);
    return apiError(e?.message || String(e), 500);
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  try {
    const items = await itemsContainer();
    await items.item((await ctx.params).id, workspaceId).delete();
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e?.code === 404) return NextResponse.json({ ok: true });
    return apiError(e?.message || String(e), 500);
  }
}

/**
 * PATCH — edit an existing mirror's config (name/description + source). Any
 * mirror can be edited after creation: change the source type, server/database,
 * the Key Vault-backed connection, or the table subset. The change feed / landed
 * snapshots are untouched until the next Start re-runs the mirror.
 *
 * Body (all optional): { displayName, description, sourceType, server, database,
 *   connectionId, tables:[{schema,table}], definition }
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  const body = await req.json().catch(() => ({} as any));
  try {
    const items = await itemsContainer();
    const { resource: existing } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!existing || existing.itemType !== 'mirrored-database') return apiError('mirrored database not found', 404);
    const state = (existing.state || {}) as Record<string, any>;

    const tables = Array.isArray(body?.tables)
      ? body.tables.filter((t: any) => t?.schema && t?.table).map((t: any) => ({ schema: String(t.schema), table: String(t.table) }))
      : state.tables || [];

    const nextState: Record<string, any> = {
      ...state,
      definition: body?.definition ?? state.definition,
      sourceType: body?.sourceType ?? state.sourceType,
      server: body?.server ?? state.server,
      database: body?.database ?? state.database,
      connectionId: body?.connectionId !== undefined ? body.connectionId : state.connectionId,
      // BigQuery + Oracle source-specific fields (undefined = leave prior value).
      projectId: body?.projectId !== undefined ? body.projectId : state.projectId,
      serviceName: body?.serviceName !== undefined ? body.serviceName : state.serviceName,
      gateway: body?.gateway !== undefined ? body.gateway : state.gateway,
      syncUser: body?.syncUser !== undefined ? body.syncUser : state.syncUser,
      tables,
      includeIcebergTables: body?.includeIcebergTables !== undefined ? !!body.includeIcebergTables : state.includeIcebergTables,
      syncMode: body?.syncMode !== undefined ? body.syncMode : state.syncMode,
    };
    const next: WorkspaceItem = {
      ...existing,
      displayName: typeof body?.displayName === 'string' && body.displayName.trim() ? body.displayName.trim() : existing.displayName,
      description: typeof body?.description === 'string' ? body.description : existing.description,
      state: nextState,
      updatedAt: new Date().toISOString(),
    };
    await items.item(existing.id, workspaceId).replace(next);
    return NextResponse.json({
      ok: true,
      mirroredDatabase: { id: next.id, displayName: next.displayName, description: next.description },
      source: {
        sourceType: nextState.sourceType, server: nextState.server, database: nextState.database,
        connectionId: nextState.connectionId, tables: nextState.tables,
        includeIcebergTables: !!nextState.includeIcebergTables,
        projectId: nextState.projectId, serviceName: nextState.serviceName, gateway: nextState.gateway, syncUser: nextState.syncUser,
        syncMode: nextState.syncMode,
      },
    });
  } catch (e: any) {
    if (e?.code === 404) return apiError('mirrored database not found', 404);
    return apiError(e?.message || String(e), 500);
  }
}
