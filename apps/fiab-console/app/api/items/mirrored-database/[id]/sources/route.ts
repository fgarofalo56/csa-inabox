/**
 * GET  /api/items/mirrored-database/[id]/sources?workspaceId=...
 *   → { ok, sources: [{ sourceType, server, database, connectionId, tables, hasSecret }] }
 *
 * POST /api/items/mirrored-database/[id]/sources?workspaceId=...
 *   body: { sourceType, server, database, connectionId?, tables?:[{schema,table}] }
 *   → { ok, source }   — set/update the mirror's source binding.
 *
 * A Loom Mirrored Database has one source binding today (Azure SQL DB/MI, SQL
 * Server, PostgreSQL, Cosmos DB), captured as flat state on the item so the
 * mirror engine + ADF CDC path can read it on Start. This route is the explicit
 * multi-source surface — it returns the binding as an array (the extension hook
 * for additional sources) and lets the wizard add/replace it. Credentials are
 * never returned/stored in plaintext: only the connectionId (whose secret lives
 * in Key Vault) and a `hasSecret` flag are exposed.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { loadConnection } from '@/lib/azure/connections-store';
import { MIRROR_SQL_FAMILY, MIRROR_PG_FAMILY, MIRROR_COSMOS_FAMILY } from '@/lib/azure/mirror-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number) { return NextResponse.json({ ok: false, error }, { status }); }

/** Known source types the mirror engine + ADF CDC path can replicate. */
function knownSource(t: string): boolean {
  return MIRROR_SQL_FAMILY.has(t) || MIRROR_PG_FAMILY.has(t) || MIRROR_COSMOS_FAMILY.has(t)
    || t === 'Snowflake' || t === 'GenericMirror';
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  try {
    const items = await itemsContainer();
    const { resource } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!resource || resource.itemType !== 'mirrored-database') return err('mirrored database not found', 404);
    const st = (resource.state || {}) as Record<string, any>;
    const def = st?.definition?.properties?.source?.typeProperties || {};
    const sourceType = String(st.sourceType || st?.definition?.properties?.source?.type || '');
    const server = String(st.server || def.server || '');
    const database = String(st.database || def.database || '');
    const connectionId: string | undefined = st.connectionId || undefined;
    const tables = Array.isArray(st.tables) ? st.tables : [];

    let hasSecret = false;
    if (connectionId) {
      try {
        const conn = await loadConnection(s.claims.oid, connectionId);
        hasSecret = !!conn?.secretRef;
      } catch { /* connection may have been deleted — report no secret */ }
    }

    // One binding today; returned as an array (multi-source extension hook).
    const sources = sourceType || server || database
      ? [{ sourceType, server, database, connectionId, tables, hasSecret }]
      : [];
    return NextResponse.json({ ok: true, sources });
  } catch (e: any) {
    if (e?.code === 404) return err('mirrored database not found', 404);
    return err(e?.message || String(e), 500);
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  const body = await req.json().catch(() => ({} as any));
  const sourceType = String(body?.sourceType || '').trim();
  const server = String(body?.server || '').trim();
  const database = String(body?.database || '').trim();
  const connectionId = body?.connectionId ? String(body.connectionId) : undefined;
  if (!knownSource(sourceType)) return err(`sourceType must be a supported mirror source`, 400);
  if (!database) return err('database is required', 400);

  const tables = Array.isArray(body?.tables)
    ? body.tables.filter((t: any) => t?.schema && t?.table).map((t: any) => ({ schema: String(t.schema), table: String(t.table) }))
    : [];

  try {
    const items = await itemsContainer();
    const { resource: existing } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!existing || existing.itemType !== 'mirrored-database') return err('mirrored database not found', 404);
    const state = (existing.state || {}) as Record<string, any>;

    const nextState: Record<string, any> = {
      ...state,
      sourceType,
      server,
      database,
      connectionId: connectionId !== undefined ? connectionId : state.connectionId,
      tables,
    };
    const next: WorkspaceItem = { ...existing, state: nextState, updatedAt: new Date().toISOString() };
    await items.item(existing.id, workspaceId).replace(next);

    let hasSecret = false;
    if (nextState.connectionId) {
      try {
        const conn = await loadConnection(s.claims.oid, nextState.connectionId);
        hasSecret = !!conn?.secretRef;
      } catch { /* deleted connection — report no secret */ }
    }
    return NextResponse.json({
      ok: true,
      source: { sourceType, server, database, connectionId: nextState.connectionId, tables, hasSecret },
    });
  } catch (e: any) {
    if (e?.code === 404) return err('mirrored database not found', 404);
    return err(e?.message || String(e), 500);
  }
}
