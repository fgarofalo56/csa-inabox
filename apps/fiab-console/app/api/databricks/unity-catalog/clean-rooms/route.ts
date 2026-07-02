/**
 * Databricks Clean Rooms — wave c4 (completes UC feature coverage).
 *
 *   GET /api/databricks/unity-catalog/clean-rooms                    → { ok, cleanRooms[] }
 *   GET /api/databricks/unity-catalog/clean-rooms?name=<name>        → { ok, cleanRoom }
 *   GET /api/databricks/unity-catalog/clean-rooms?name=<name>&assets=true
 *                                                                    → { ok, cleanRoom, assets[] }
 *
 * Read surface over the documented stable Clean Rooms REST
 * (/api/2.0/clean-rooms*). A clean room is a privacy-safe collaboration
 * environment where multiple parties run approved workloads on each other's data
 * without exposing the rows. List + view (collaborators + assets) is the solid
 * surface; creating a room (which needs each collaborator's global_metastore_id)
 * and running CLEAN ROOM TASK DDL are surfaced as honest notes in the UI (niche /
 * Public-Preview flows), per no-vaporware.md. This route is read-only.
 *
 * Honest gate when Databricks is not configured and at the GCC-High / DoD
 * boundary (Clean Rooms is a Unity Catalog feature; the Gov Hive path has no UC).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { databricksConfigGate } from '@/lib/azure/databricks-client';
import { isGovCloud, cloudBoundaryLabel } from '@/lib/azure/cloud-endpoints';
import {
  primaryWorkspaceHost,
  listCleanRooms,
  getCleanRoom,
  listCleanRoomAssets,
} from '@/lib/azure/unity-catalog-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Gate { gated: true; error: string }

function resolveGate(): Gate | null {
  const cfg = databricksConfigGate();
  if (cfg) {
    return { gated: true, error: `Databricks is not configured in this deployment. Set ${cfg.missing} on the Console (landing-zone bicep deploys the Databricks workspace).` };
  }
  if (isGovCloud()) {
    return {
      gated: true,
      error:
        `Databricks Clean Rooms are not available at the ${cloudBoundaryLabel()} boundary. ` +
        `They require a Commercial or GCC Databricks account with a Microsoft Entra-connected Unity Catalog metastore. ` +
        `At this boundary, collaborate via governed Delta Sharing shares instead.`,
    };
  }
  return null;
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = resolveGate();
  if (gate) return NextResponse.json({ ok: false, gated: true, error: gate.error }, { status: 200 });

  const sp = req.nextUrl.searchParams;
  let host: string;
  try {
    host = await primaryWorkspaceHost();
  } catch (e: any) {
    return NextResponse.json({ ok: false, gated: true, error: e?.message || String(e) }, { status: 200 });
  }

  try {
    // ---- Single clean room (+ optional assets) ----
    const name = sp.get('name')?.trim();
    if (name) {
      if (sp.get('assets') === 'true') {
        // Assets read is best-effort: a collaborator may see the room but not be
        // permitted to enumerate every party's assets — surface what we can.
        const [cleanRoom, assets] = await Promise.all([
          getCleanRoom(host, name),
          listCleanRoomAssets(host, name).catch(() => []),
        ]);
        return NextResponse.json({ ok: true, cleanRoom, assets });
      }
      const cleanRoom = await getCleanRoom(host, name);
      return NextResponse.json({ ok: true, cleanRoom });
    }

    // ---- List clean rooms ----
    const cleanRooms = await listCleanRooms(host);
    return NextResponse.json({ ok: true, cleanRooms });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}
