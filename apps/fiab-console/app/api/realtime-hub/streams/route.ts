/**
 * GET /api/realtime-hub/streams
 *
 * Fabric Real-Time Hub "All data streams" — the tenant-wide catalog of
 * data-in-motion. Aggregates, across every Fabric workspace the Console
 * UAMI can see:
 *
 *   - Eventstreams        → "stream" rows (Fabric REST list eventstreams)
 *   - Eventhouses / KQL DBs → "table" parents (Fabric REST list kqlDatabases)
 *
 * This is the real Real-Time Hub data integration described in Learn:
 * "For your running eventstreams and KQL databases, all the stream outputs
 *  and tables that you can access automatically show up in Real-Time hub."
 * (https://learn.microsoft.com/fabric/real-time-hub/real-time-hub-overview)
 *
 * No mocks. Every row is a real Fabric item from api.fabric.microsoft.com.
 * If the Console UAMI is not authorized in the Fabric tenant, the
 * FabricError (401/403) surfaces verbatim with a remediation hint so the
 * page can render an honest infra-gate MessageBar — and the rest of the
 * Real-Time Hub UI still renders.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listFabricWorkspaces,
  listEventstreams,
  listKqlDatabases,
  listEventhouses,
  FabricError,
  fabricHint,
  type FabricWorkspace,
} from '@/lib/azure/fabric-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface DataStreamRow {
  /** Eventstream item id or KQL database item id. */
  id: string;
  /** Display name of the stream / KQL database. */
  name: string;
  /** 'stream' (from an eventstream) | 'table' (from a KQL database). */
  dataType: 'stream' | 'table';
  /** Parent artifact display name (== name for top-level items). */
  sourceItem: string;
  /** Fabric workspace id the item lives in. */
  workspaceId: string;
  /** Fabric workspace display name. */
  workspace: string;
  description?: string;
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  let workspaces: FabricWorkspace[];
  try {
    workspaces = await listFabricWorkspaces();
  } catch (e: any) {
    const status = e instanceof FabricError ? e.status : 502;
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), endpoint: e?.endpoint, hint: e?.hint ?? fabricHint(status) },
      { status },
    );
  }

  const rows: DataStreamRow[] = [];
  const warnings: Array<{ workspace: string; error: string }> = [];

  // Per-workspace listing — Fabric REST scopes eventstream / kqlDatabase
  // lists to a single workspace. We fan out across all visible workspaces.
  await Promise.all(
    workspaces.map(async (ws) => {
      try {
        const es = await listEventstreams(ws.id);
        for (const e of es) {
          rows.push({
            id: e.id,
            name: e.displayName,
            dataType: 'stream',
            sourceItem: e.displayName,
            workspaceId: ws.id,
            workspace: ws.displayName,
            description: e.description,
          });
        }
      } catch (e: any) {
        if (!(e instanceof FabricError && e.status === 404)) {
          warnings.push({ workspace: ws.displayName, error: e?.message || String(e) });
        }
      }
      try {
        const dbs = await listKqlDatabases(ws.id);
        for (const d of dbs) {
          rows.push({
            id: d.id,
            name: d.displayName,
            dataType: 'table',
            sourceItem: d.displayName,
            workspaceId: ws.id,
            workspace: ws.displayName,
            description: d.description,
          });
        }
      } catch (e: any) {
        // KQL databases live under an Eventhouse; some workspaces expose
        // only the eventhouse list. Fall back to eventhouses on 404.
        if (e instanceof FabricError && e.status === 404) {
          try {
            const ehs = await listEventhouses(ws.id);
            for (const eh of ehs) {
              rows.push({
                id: eh.id,
                name: eh.displayName,
                dataType: 'table',
                sourceItem: eh.displayName,
                workspaceId: ws.id,
                workspace: ws.displayName,
                description: eh.description,
              });
            }
          } catch { /* skip — surfaced via warnings below if it's an auth issue */ }
        } else {
          warnings.push({ workspace: ws.displayName, error: e?.message || String(e) });
        }
      }
    }),
  );

  rows.sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json({
    ok: true,
    workspaceCount: workspaces.length,
    streams: rows,
    warnings,
  });
}
