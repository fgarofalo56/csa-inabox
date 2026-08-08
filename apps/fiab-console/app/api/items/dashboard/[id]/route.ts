/**
 * GET    /api/items/dashboard/[id]?workspaceId=...   → overlay + (optional) PBI tiles
 * PUT    /api/items/dashboard/[id]                    → upsert the Loom overlay (Cosmos)
 * DELETE /api/items/dashboard/[id]                    → drop the Loom overlay
 *
 * The Loom overlay (pinned-DAX tiles, Q&A tiles, streaming ADX tiles, grid
 * layout) is the Azure-native dashboard surface — it persists to Cosmos and
 * works with NO Power BI / Fabric workspace bound (no-fabric-dependency.md).
 * When a Power BI workspace IS supplied (`workspaceId`), the GET also merges
 * the read-only Power BI REST tile list so pinned PBI visuals embed alongside
 * the Loom-native tiles. Power BI is the opt-in path; ADX/AAS is the default.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import type { SessionPayload } from '@/lib/auth/session';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { getDashboard, listDashboardTiles, PowerBiError } from '@/lib/azure/powerbi-client';
import { pbiDashboardOverlaysContainer } from '@/lib/azure/cosmos-client';
import { sanitizeOverlay, type DashboardOverlay } from '@/lib/azure/dashboard-overlay';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DASHBOARD_ITEM_TYPE = 'dashboard';
const DASHBOARD_NOT_FOUND = 'dashboard not found';

/**
 * C22 (#3122) — the overlay is partitioned by the DASHBOARD ID (`item(id, id)`),
 * not by a tenant, so `readOverlay`/`delete` reach any tenant's overlay from any
 * signed-in session. Every handler here was `getSession()`-only: GET read, PUT
 * overwrote and DELETE dropped ANY overlay by id.
 *
 * This file passed the route-guard checker because `PUT` mentions
 * `session.claims.upn || session.claims.oid` — as the overlay's `savedBy`
 * ATTRIBUTION, never as a check. That is the presence-vs-use gap this round of
 * C22 exists to close, found in shipped code by the re-keyed checker rather than
 * by review.
 *
 * `authorizeItemWorkspace` runs the canonical owner → tenant-admin → shared-ACL
 * ladder and resolves the workspace FROM THE ITEM when `?workspaceId=` is
 * absent, so authorization cannot be skipped by dropping the parameter. Its one
 * permissive case — an id naming no `dashboard` item anywhere — is deliberately
 * kept here: a raw Power BI dashboard id with no Loom item is still reachable,
 * so the opt-in Power BI path (no-fabric-dependency.md) is unchanged.
 */
async function denyUnlessAuthorized(session: SessionPayload, id: string, workspaceId: string | null, opts?: { allowReadRoles?: boolean }) {
  return authorizeItemWorkspace(session, {
    workspaceId,
    itemId: id,
    itemType: DASHBOARD_ITEM_TYPE,
    notFound: DASHBOARD_NOT_FOUND,
    ...(opts?.allowReadRoles ? { allowReadRoles: true } : {}),
  });
}

async function readOverlay(id: string): Promise<DashboardOverlay | null> {
  const container = await pbiDashboardOverlaysContainer();
  try {
    const { resource } = await container.item(id, id).read<DashboardOverlay>();
    return resource ?? null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

export const GET = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const id = params.id;
  const workspaceId = req.nextUrl.searchParams.get('workspaceId') || '';
  // READ surface → any workspace role may look at the dashboard.
  const denied = await denyUnlessAuthorized(session, id, workspaceId || null, { allowReadRoles: true });
  if (denied) return denied;

  // Loom overlay (always available — Azure-native, no PBI workspace required).
  let overlay: DashboardOverlay | null = null;
  try {
    overlay = await readOverlay(id);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }

  // Power BI REST merge — only when a PBI workspace is explicitly supplied AND
  // the dashboard id is a real PBI dashboard. Soft-fail so the overlay still
  // returns when there is no PBI dashboard (a pure Loom-native dashboard).
  let dashboard: unknown = null;
  let tiles: unknown[] = [];
  if (workspaceId) {
    try {
      [dashboard, tiles] = await Promise.all([
        getDashboard(workspaceId, id).catch(() => null),
        listDashboardTiles(workspaceId, id).catch(() => []),
      ]);
    } catch (e: any) {
      // Non-fatal: the Loom overlay is the source of truth.
      const status = e instanceof PowerBiError ? e.status : 502;
      return NextResponse.json(
        { ok: true, workspaceId, dashboard: null, tiles: [], overlay, pbiError: e?.message || String(e), pbiStatus: status },
      );
    }
  }

  return NextResponse.json({ ok: true, workspaceId, dashboard, tiles, overlay });
});

export const PUT = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const id = params.id;
  // WRITE surface → intentionally NO `allowReadRoles`: a read-only Viewer must
  // not be able to rewrite another member's dashboard layout.
  const denied = await denyUnlessAuthorized(session, id, req.nextUrl.searchParams.get('workspaceId'));
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ ok: false, error: 'body required' }, { status: 400 });
  }
  const doc = sanitizeOverlay(id, body, session.claims.upn || session.claims.oid);
  try {
    const container = await pbiDashboardOverlaysContainer();
    const { resource } = await container.items.upsert<DashboardOverlay>(doc);
    return NextResponse.json({ ok: true, overlay: resource ?? doc });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
});

export const DELETE = withSession<{ id: string }>(async (_req: NextRequest, { session, params }) => {
  const id = params.id;
  // WRITE surface → write-scoped (no `allowReadRoles`).
  const denied = await denyUnlessAuthorized(session, id, _req.nextUrl.searchParams.get('workspaceId'));
  if (denied) return denied;
  try {
    const container = await pbiDashboardOverlaysContainer();
    await container.item(id, id).delete().catch((e: any) => { if (e?.code !== 404) throw e; });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
});
