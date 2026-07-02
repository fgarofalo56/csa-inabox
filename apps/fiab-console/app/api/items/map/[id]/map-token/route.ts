/**
 * GET /api/items/map/[id]/map-token
 *
 * Fabric-IQ Map · the Azure-Maps data-plane TOKEN broker for the interactive
 * map editor (lib/components/graph/azure-maps-canvas.tsx). The map editor binds
 * REAL geo rows (Lakehouse / KQL / Ontology) through …/data and renders them on
 * a live Azure Maps Web SDK surface; to reach the atlas.microsoft.com data-plane
 * the browser SDK needs a short-lived AAD token (preferred, gov-safe) or a
 * subscription key (commercial). This route mints it — the exact mirror of the
 * report-designer's `…/report/[id]/map-token`, re-pointed at the `map` item.
 *
 * Per no-vaporware.md the map is either backed by a REAL credential here, or the
 * canvas falls back to the offline SVG vector overlay behind an HONEST gate that
 * names the exact env var + the bicep module — never a dead control, never blank.
 *
 * ── Backend selection (resolveMapsBackend, lib/azure/maps-client.ts) ─────────────
 * Azure-native ONLY — no Fabric / Power BI on ANY path (no-fabric-dependency.md);
 * the AAD token is scoped to atlas.microsoft.com ALONE:
 *   • LOOM_MAPS_BACKEND !== 'azure-maps'                → honest gate (412)
 *   • LOOM_AZURE_MAPS_CLIENT_ID set (PREFERRED, Entra)  → mode:'aad' + token
 *   • LOOM_AZURE_MAPS_KEY set (commercial fallback)     → mode:'key'
 *   • opted-in but no credential present                → honest gate (412)
 *
 * Owner-checked exactly like …/data: the token is brokered only to a signed-in
 * caller who owns THIS map item — 401 without a session, 404 when the map isn't
 * the caller's. A not-yet-saved map (id === 'new') only requires a session: the
 * token is account-scoped (not item-scoped), so the editor can light up the live
 * basemap before the first save.
 *
 * 200 OK → { ok:true, mode:'aad', token, clientId, expiresOn }
 *        | { ok:true, mode:'key', key }
 * 401    → { ok:false, error }                                  (unauthenticated)
 * 404    → { ok:false, error }                                  (map not found / not owned)
 * 412    → { ok:false, error, envVar:'LOOM_MAPS_BACKEND',
 *            bicep:'platform/fiab/bicep/modules/landing-zone/azure-maps.bicep' }
 */

import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { resolveMapsBackend } from '@/lib/azure/maps-client';
import { loadOwnedItem } from '../../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'map';

/** The bicep module that provisions the Maps account + the Console-UAMI role
 *  grant — surfaced in every honest gate so the operator has the exact fix. */
const AZURE_MAPS_BICEP = 'platform/fiab/bicep/modules/landing-zone/azure-maps.bicep';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }

  // ── Owner-check THIS map item (parity with …/data). A not-yet-saved map
  //    (id === 'new') is allowed: the token is account-scoped, so the editor can
  //    preview the live basemap before the first save. ───────────────────────────
  const { id } = await ctx.params;
  if (id && id !== 'new') {
    try {
      const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
      if (!item) {
        return NextResponse.json({ ok: false, error: 'map item not found' }, { status: 404 });
      }
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
    }
  }

  // ── Resolve the basemap credential (or the honest gate) ──────────────────────
  const backend = await resolveMapsBackend();
  if (!backend.ok) {
    // Honest config gate (no-vaporware): name the env var + the bicep module that
    // provisions the account. The map editor keeps its full surface + the SVG
    // vector overlay; only the interactive basemap tiles are gated.
    return NextResponse.json(
      {
        ok: false,
        error: backend.reason,
        envVar: backend.envVar,
        bicep: AZURE_MAPS_BICEP,
      },
      { status: 412 },
    );
  }

  if (backend.mode === 'aad') {
    return NextResponse.json({
      ok: true,
      mode: 'aad',
      token: backend.token,
      clientId: backend.clientId,
      expiresOn: backend.expiresOn,
    });
  }

  // mode === 'key'
  return NextResponse.json({ ok: true, mode: 'key', key: backend.key });
}
