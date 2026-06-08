/**
 * /api/data-products/[id]/cdes
 *
 * F10 "Linked resources" — Critical Data Elements section (READ-ONLY). CDEs are
 * auto-derived from the Purview classifications carried by the assets mapped to
 * this data product (via the Datasets tab / T9). On the classic Data Map the
 * unified-catalog "CDE" object isn't available, so a CDE is modeled as an Atlas
 * classification whose typeName starts with `CDE.` on a mapped asset.
 *
 *   GET → { ok, cdes, gated?, note? }
 *
 * Honest gate (per no-vaporware): when LOOM_PURVIEW_ACCOUNT is unset the
 * section still renders — returns { ok:true, cdes:[], gated:true, hint } rather
 * than a 5xx, so the read-only panel shows an info MessageBar instead of
 * breaking. Azure-native default; no Fabric/Power BI dependency.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getAssetCdeClassifications,
  isPurviewConfigured,
  PurviewNotConfiguredError,
} from '@/lib/azure/purview-client';
import { loadOwnedItem } from '../../../items/_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-product';

interface Dataset { name?: string; guid?: string; }
interface Cde { typeName: string; displayName: string; assetGuid: string; assetName?: string; }

function err(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return err('unauthenticated', 401);

  const item = await loadOwnedItem((await ctx.params).id, ITEM_TYPE, session.claims.oid);
  if (!item) return err('data-product item not found', 404);

  // Honest infra gate — render the read-only panel with guidance, no 5xx.
  if (!isPurviewConfigured()) {
    return NextResponse.json({
      ok: true,
      cdes: [],
      gated: true,
      hint:
        'CDEs are auto-detected from the Purview classifications on mapped assets. ' +
        'Set LOOM_PURVIEW_ACCOUNT (bicep module admin-plane/catalog.bicep) to enable.',
    });
  }

  const state = (item.state || {}) as Record<string, unknown>;
  const datasets: Dataset[] = Array.isArray(state.datasets) ? (state.datasets as Dataset[]) : [];
  const mapped = datasets.filter((d) => d?.guid);
  if (mapped.length === 0) {
    return NextResponse.json({
      ok: true,
      cdes: [],
      note: 'No mapped assets carry a GUID yet. Register/map an asset on the Datasets tab to surface its CDEs.',
    });
  }

  // De-duplicate by typeName across all mapped assets (a CDE can appear on
  // more than one asset; the editor lists the unique critical-data elements).
  const byType = new Map<string, Cde>();
  try {
    for (const d of mapped) {
      const found = await getAssetCdeClassifications(d.guid!);
      for (const c of found) {
        if (!byType.has(c.typeName)) {
          byType.set(c.typeName, {
            typeName: c.typeName,
            displayName: c.displayName,
            assetGuid: c.entityGuid,
            assetName: d.name,
          });
        }
      }
    }
  } catch (e: any) {
    if (e instanceof PurviewNotConfiguredError) {
      return NextResponse.json({ ok: true, cdes: [], gated: true, hint: e.message });
    }
    return err(e?.message || 'Failed to read CDE classifications from Purview', 502);
  }

  return NextResponse.json({ ok: true, cdes: Array.from(byType.values()) });
}
