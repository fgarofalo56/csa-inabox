/**
 * GET /api/realtime-hub/streams
 *
 * Real-Time Hub "All data streams" — the catalog of data-in-motion. **Azure-
 * native by default** (no Microsoft Fabric, per no-fabric-dependency.md): lists
 * the tenant's Loom-native **eventstream** items (data streams) and
 * **kql-database / eventhouse** items (tables) from Cosmos, across the caller's
 * Loom workspaces.
 *
 * Fabric is opt-in: set `LOOM_EVENTSTREAM_BACKEND=fabric` and the route instead
 * aggregates eventstreams + KQL databases across the Fabric workspaces the
 * Console UAMI can see (the legacy Fabric REST path).
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listAllOwnedItems, listOwnedWorkspaces } from '../../items/_lib/item-crud';
import {
  listFabricWorkspaces, listEventstreams, listKqlDatabases, listEventhouses,
  FabricError, fabricHint, type FabricWorkspace,
} from '@/lib/azure/fabric-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface DataStreamRow {
  id: string;
  name: string;
  dataType: 'stream' | 'table';
  sourceItem: string;
  workspaceId: string;
  workspace: string;
  description?: string;
}

const FABRIC_OPT_IN = (process.env.LOOM_EVENTSTREAM_BACKEND || '').toLowerCase() === 'fabric';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const oid = session.claims.oid;

  // ---- Azure-native default: Loom eventstream + kql-database items ----
  if (!FABRIC_OPT_IN) {
    try {
      const [items, workspaces] = await Promise.all([listAllOwnedItems(oid), listOwnedWorkspaces(oid)]);
      const wsName = new Map(workspaces.map((w) => [w.id, w.name] as const));
      const rows: DataStreamRow[] = [];
      for (const it of items) {
        if (it.itemType === 'eventstream') {
          rows.push({ id: it.id, name: it.displayName, dataType: 'stream', sourceItem: it.displayName, workspaceId: it.workspaceId, workspace: wsName.get(it.workspaceId) || it.workspaceId, description: it.description });
        } else if (it.itemType === 'kql-database' || it.itemType === 'eventhouse') {
          rows.push({ id: it.id, name: it.displayName, dataType: 'table', sourceItem: it.displayName, workspaceId: it.workspaceId, workspace: wsName.get(it.workspaceId) || it.workspaceId, description: it.description });
        }
      }
      rows.sort((a, b) => a.name.localeCompare(b.name));
      return NextResponse.json({ ok: true, backend: 'azure-native', workspaceCount: workspaces.length, streams: rows, warnings: [] });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
    }
  }

  // ---- Fabric opt-in path (legacy) ----
  let workspaces: FabricWorkspace[];
  try {
    workspaces = await listFabricWorkspaces();
  } catch (e: any) {
    const status = e instanceof FabricError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), endpoint: e?.endpoint, hint: e?.hint ?? fabricHint(status) }, { status });
  }

  const rows: DataStreamRow[] = [];
  const warnings: Array<{ workspace: string; error: string }> = [];
  await Promise.all(
    workspaces.map(async (ws) => {
      try {
        const es = await listEventstreams(ws.id);
        for (const e of es) rows.push({ id: e.id, name: e.displayName, dataType: 'stream', sourceItem: e.displayName, workspaceId: ws.id, workspace: ws.displayName, description: e.description });
      } catch (e: any) {
        if (!(e instanceof FabricError && e.status === 404)) warnings.push({ workspace: ws.displayName, error: e?.message || String(e) });
      }
      try {
        const dbs = await listKqlDatabases(ws.id);
        for (const d of dbs) rows.push({ id: d.id, name: d.displayName, dataType: 'table', sourceItem: d.displayName, workspaceId: ws.id, workspace: ws.displayName, description: d.description });
      } catch (e: any) {
        if (e instanceof FabricError && e.status === 404) {
          try {
            const ehs = await listEventhouses(ws.id);
            for (const eh of ehs) rows.push({ id: eh.id, name: eh.displayName, dataType: 'table', sourceItem: eh.displayName, workspaceId: ws.id, workspace: ws.displayName, description: eh.description });
          } catch { /* surfaced via warnings if auth */ }
        } else {
          warnings.push({ workspace: ws.displayName, error: e?.message || String(e) });
        }
      }
    }),
  );
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return NextResponse.json({ ok: true, backend: 'fabric', workspaceCount: workspaces.length, streams: rows, warnings });
}
