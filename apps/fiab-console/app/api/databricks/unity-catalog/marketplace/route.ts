/**
 * Databricks Marketplace (consumer) — wave c4 (completes UC feature coverage).
 *
 *   GET /api/databricks/unity-catalog/marketplace                       → { ok, listings[] }
 *   GET /api/databricks/unity-catalog/marketplace?q=weather             → { ok, listings[] }  (search)
 *   GET /api/databricks/unity-catalog/marketplace?is_free=true          → { ok, listings[] }
 *   GET /api/databricks/unity-catalog/marketplace?is_staff_pick=true    → { ok, listings[] }
 *   GET /api/databricks/unity-catalog/marketplace?listing_id=<id>       → { ok, listing }
 *   GET /api/databricks/unity-catalog/marketplace?installations=true    → { ok, installations[] }
 *
 * Read-mostly browse of the Databricks Marketplace consumer surface over the
 * documented stable consumer REST (/api/2.1/marketplace-consumer/*). An
 * installed listing materializes as a Delta-Sharing provider + read-only shared
 * catalog (visible in the Marketplace data-shares surface). The privilege to
 * browse + install is `USE MARKETPLACE ASSETS`.
 *
 * Installing a listing (POST .../installations) requires an accepted-terms
 * payload whose version must match the listing's current terms — surfaced as an
 * honest note in the UI (the consumer "Get instant access" flow), not a
 * half-working button (per no-vaporware.md). This route is read-only.
 *
 * Honest gate when Databricks is not configured and at the GCC-High / DoD
 * boundary (Marketplace is a Unity Catalog feature; the Gov Hive path has no UC).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { databricksConfigGate } from '@/lib/azure/databricks-client';
import { isGovCloud, cloudBoundaryLabel } from '@/lib/azure/cloud-endpoints';
import {
  primaryWorkspaceHost,
  listMarketplaceListings,
  searchMarketplaceListings,
  getMarketplaceListing,
  listMarketplaceInstallations,
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
        `Databricks Marketplace is not available at the ${cloudBoundaryLabel()} boundary. ` +
        `It requires a Commercial or GCC Databricks account with a Microsoft Entra-connected Unity Catalog metastore. ` +
        `At this boundary, share data with partners via Delta Sharing instead.`,
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
    // ---- This consumer's installations ----
    if (sp.get('installations') === 'true') {
      const installations = await listMarketplaceInstallations(host);
      return NextResponse.json({ ok: true, installations });
    }

    // ---- Single listing ----
    const listingId = sp.get('listing_id')?.trim();
    if (listingId) {
      const listing = await getMarketplaceListing(host, listingId);
      return NextResponse.json({ ok: true, listing });
    }

    // ---- Search ----
    const q = sp.get('q')?.trim();
    if (q) {
      const listings = await searchMarketplaceListings(host, q);
      return NextResponse.json({ ok: true, listings });
    }

    // ---- List (with optional filters) ----
    const listings = await listMarketplaceListings(host, {
      isFree: sp.get('is_free') === 'true',
      isStaffPick: sp.get('is_staff_pick') === 'true',
      isPrivateExchange: sp.get('is_private_exchange') === 'true',
    });
    return NextResponse.json({ ok: true, listings });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}
