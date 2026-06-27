/**
 * GET /api/items/report/[id]/map-token
 *
 * Report-designer parity · WAVE 5 — the Azure-Maps visual's data-plane TOKEN
 * broker. The map visual (map-visual.tsx) renders a REAL aggregate from the same
 * …/query rows; to draw bubbles / a filled choropleth — or to geocode a Location
 * NAME column via Azure Maps Search Fuzzy — the browser needs a short-lived
 * data-plane credential for atlas.microsoft.com. This route mints it.
 *
 * It is the ONLY new backend route Wave 5 adds (every other Wave-5 capability —
 * true chart geometry, the slicer, anomalies / X-lines / shaded ranges — renders
 * client-side over the unchanged …/query rows). Per no-vaporware.md the map is
 * either backed by a REAL token (or subscription key) here, or it shows an HONEST
 * gate naming the exact env var + the bicep module that provisions the account —
 * never a dead control.
 *
 * ── BACKEND SELECTION (resolveMapsBackend, below) ───────────────────────────────
 * Driven entirely by env, Azure-native only — no Fabric / Power BI on ANY path
 * (no-fabric-dependency.md), and the AAD token is scoped to atlas.microsoft.com
 * ALONE (never management/graph/fabric):
 *
 *   • LOOM_MAPS_BACKEND !== 'azure-maps'  → honest gate (412). The map UI still
 *     renders its panels + the real aggregate rows; only the basemap tiles are
 *     gated. Names LOOM_MAPS_BACKEND + the azure-maps.bicep module.
 *
 *   • LOOM_AZURE_MAPS_CLIENT_ID set (PREFERRED, gov-safe — Entra-only auth):
 *     mint a short-lived token via the console's ACA-first UAMI credential chain
 *     (uamiArmCredential — the Console UAMI carries 'Azure Maps Data Reader' on
 *     the account, granted by azure-maps.bicep) for the atlas data-plane scope.
 *     Returns mode:'aad' + the token + the account's data-plane client id
 *     (LOOM_AZURE_MAPS_CLIENT_ID — the value the Web SDK sends as the
 *     `x-ms-client-id` request header) + the token's expiry (ms). The browser
 *     SDK refreshes by calling this route again before expiry.
 *
 *   • LOOM_AZURE_MAPS_KEY set (commercial fallback): return mode:'key' + the
 *     subscription key (Azure Maps subscription keys are designed for client SDK
 *     use; AAD is preferred and noted). Only reached when no client id is set.
 *
 *   • 'azure-maps' selected but NEITHER credential present → honest gate (412).
 *
 * Owner-checked exactly like …/query and …/script-visual: the token is brokered
 * only to a signed-in caller who owns (tenant-scopes) THIS report item — a 401
 * without a session, a 404 when the report isn't the caller's.
 *
 * 200 OK → { ok:true, mode:'aad', token, clientId, expiresOn }
 *        | { ok:true, mode:'key', key }
 * 401    → { ok:false, error }                                  (unauthenticated)
 * 404    → { ok:false, error }                                  (report not found / not owned)
 * 412    → { ok:false, error, envVar:'LOOM_MAPS_BACKEND',
 *            bicep:'platform/fiab/bicep/modules/landing-zone/azure-maps.bicep' }
 */

import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadModelItem } from '@/lib/azure/model-binding';
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import {
  isLoomContentId,
  cosmosIdFromLoomId,
  loadContentBackedItem,
} from '../../../_lib/pbi-content-fallback';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Azure Maps data-plane AAD scope. atlas.microsoft.com ONLY — never management /
 * graph / api.fabric / api.powerbi (no-fabric-dependency.md). The same audience
 * across clouds; the `uamiArmCredential` chain reaches the cloud-correct AAD
 * authority for it.
 */
const AZURE_MAPS_SCOPE = 'https://atlas.microsoft.com/.default';

/** The bicep module that provisions the Maps account + the Console-UAMI role
 *  grant — surfaced in every honest gate so the operator has the exact fix. */
const AZURE_MAPS_BICEP = 'platform/fiab/bicep/modules/landing-zone/azure-maps.bicep';

/**
 * The resolved Azure-Maps client credential for the report renderer, or an honest
 * config gate. Pure-ish: reads env + (on the AAD path) mints one short-lived
 * data-plane token. Mirrors the maps-client contract; implemented in-route so the
 * token broker is self-contained (no cross-module coupling on the default path).
 */
type MapsBackend =
  | { ok: true; mode: 'aad'; token: string; clientId: string; expiresOn: number }
  | { ok: true; mode: 'key'; key: string }
  | { ok: false; error: string };

async function resolveMapsBackend(): Promise<MapsBackend> {
  const backend = (process.env.LOOM_MAPS_BACKEND || '').trim().toLowerCase();
  if (backend !== 'azure-maps') {
    return {
      ok: false,
      error:
        'The Azure Maps visual is not enabled in this deployment. Set LOOM_MAPS_BACKEND=azure-maps ' +
        '(and provision an Azure Maps account) to render basemap tiles. The map panels and the real ' +
        'aggregate rows still render without it — only the basemap is gated. No Power BI / Fabric / ' +
        'ArcGIS dependency (Azure Maps is the Azure-native basemap; filled maps use a bundled OSS ' +
        'TopoJSON asset).',
    };
  }

  // ── AAD path (PREFERRED, gov-safe — Entra-only, no key on disk) ───────────────
  // LOOM_AZURE_MAPS_CLIENT_ID is the Maps account's data-plane AAD client id (the
  // `x-ms-client-id` the Web SDK sends); the token is minted by the Console UAMI,
  // which azure-maps.bicep grants 'Azure Maps Data Reader' on the account.
  const clientId = (process.env.LOOM_AZURE_MAPS_CLIENT_ID || '').trim();
  if (clientId) {
    try {
      const cred = uamiArmCredential();
      const at = await cred.getToken(AZURE_MAPS_SCOPE);
      if (!at?.token) {
        return {
          ok: false,
          error:
            'Azure Maps is configured for Entra (AAD) auth, but the console identity could not mint ' +
            'an atlas.microsoft.com token. Confirm the Console UAMI has the "Azure Maps Data Reader" ' +
            'role on the Maps account (granted by azure-maps.bicep).',
        };
      }
      return {
        ok: true,
        mode: 'aad',
        token: at.token,
        clientId,
        // `expiresOnTimestamp` is ms-since-epoch; the Web SDK uses it to refresh
        // (re-call this route) before the short-lived token lapses.
        expiresOn: at.expiresOnTimestamp,
      };
    } catch (e: any) {
      return {
        ok: false,
        error:
          'Azure Maps is configured for Entra (AAD) auth, but minting an atlas.microsoft.com token ' +
          `failed: ${e?.message || String(e)}. Confirm the Console UAMI has the "Azure Maps Data ` +
          'Reader" role on the Maps account (granted by azure-maps.bicep).',
      };
    }
  }

  // ── Subscription-key path (commercial fallback) ──────────────────────────────
  const key = (process.env.LOOM_AZURE_MAPS_KEY || '').trim();
  if (key) {
    return { ok: true, mode: 'key', key };
  }

  // 'azure-maps' selected but no credential present → honest gate.
  return {
    ok: false,
    error:
      'LOOM_MAPS_BACKEND=azure-maps is set, but no Azure Maps credential is configured. Set ' +
      'LOOM_AZURE_MAPS_CLIENT_ID (Entra/AAD — preferred, gov-safe) or LOOM_AZURE_MAPS_KEY ' +
      '(commercial subscription key). Both are wired by azure-maps.bicep.',
  };
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }

  // ── Owner-check the report item (parity with …/query and …/script-visual) ─────
  // The token is brokered ONLY to a caller who tenant-owns THIS report. id may be
  // a loom: content id (template) or a plain Cosmos id — resolved identically to
  // the sibling routes.
  const id = (await ctx.params).id;
  let item: WorkspaceItem | null;
  if (isLoomContentId(id)) {
    item = await loadContentBackedItem(cosmosIdFromLoomId(id), 'report', session.claims.oid);
    if (!item) {
      return NextResponse.json({ ok: false, error: 'report template not found' }, { status: 404 });
    }
  } else {
    item = await loadModelItem(id, 'report', session.claims.oid);
    if (!item) {
      return NextResponse.json({ ok: false, error: 'report item not found' }, { status: 404 });
    }
  }

  // ── Resolve the basemap credential (or the honest gate) ──────────────────────
  const backend = await resolveMapsBackend();
  if (!backend.ok) {
    // Honest config gate (no-vaporware): name the env var + the bicep module that
    // provisions the account. The map UI keeps its panels + the real aggregate
    // rows; only the basemap tiles are gated.
    return NextResponse.json(
      {
        ok: false,
        error: backend.error,
        envVar: 'LOOM_MAPS_BACKEND',
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
