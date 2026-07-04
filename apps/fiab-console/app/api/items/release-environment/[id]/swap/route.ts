/**
 * GET  /api/items/release-environment/[id]/swap?resourceGroup=&site= → { ok, slots } | { ok:false, gate }
 *   Lists the deployment slots of an App Service-backed environment.
 * POST /api/items/release-environment/[id]/swap { resourceGroup, site, targetSlot, sourceSlot?, preserveVnet?, action? }
 *   → { ok, result, swaps } | { ok:false, gate }
 *
 * Drives REAL Microsoft.Web/sites slot operations (swap / swap-with-preview
 * apply+complete / cancel) for blue-green promotion + rollback, then appends a
 * swap record to the item state for the History tab. Honest gate when
 * LOOM_SUBSCRIPTION_ID is unset. Azure-native — no Microsoft Fabric required.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem } from '../../../_lib/item-crud';
import {
  listSlots, swapSlots, type SwapAction,
  AppServiceNotConfiguredError, AppServiceSlotsError,
} from '@/lib/azure/app-service-slots-client';
import { apiError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const ITEM_TYPE = 'release-environment';
function err(error: string, status: number, code?: string) {
  return apiError(error, status, code ? { code } : undefined);
}
function gateBody(missing: string[]) {
  return {
    ok: false as const,
    code: 'appservice_gate',
    gate: {
      missing,
      reason: 'App Service slot operations are not configured.',
      remediation: `Set ${missing.join(', ')} on the Console and grant the Console UAMI "Website Contributor" on the target site. No Microsoft Fabric required.`,
      link: 'https://learn.microsoft.com/azure/app-service/deploy-staging-slots',
    },
  };
}

interface SwapRecord {
  id: string; site: string; resourceGroup: string; sourceSlot?: string; targetSlot: string;
  action: SwapAction; status: number; at: string; by?: string;
}

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401, 'unauthenticated');
  const sp = req.nextUrl.searchParams;
  const resourceGroup = String(sp.get('resourceGroup') || '').trim();
  const site = String(sp.get('site') || '').trim();
  if (!resourceGroup || !site) return err('resourceGroup and site are required', 400, 'missing_target');
  try {
    const slots = await listSlots({ resourceGroup, site });
    return NextResponse.json({ ok: true, slots });
  } catch (e) {
    if (e instanceof AppServiceNotConfiguredError) return NextResponse.json(gateBody(e.missing));
    const status = e instanceof AppServiceSlotsError ? e.status : 500;
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({} as any));
  const resourceGroup = String(body?.resourceGroup || '').trim();
  const site = String(body?.site || '').trim();
  const targetSlot = String(body?.targetSlot || '').trim();
  const sourceSlot = String(body?.sourceSlot || '').trim() || undefined;
  const action = (String(body?.action || 'swap').trim() as SwapAction);
  const preserveVnet = body?.preserveVnet !== false;
  if (!resourceGroup || !site || !targetSlot) return err('resourceGroup, site and targetSlot are required', 400, 'missing_target');

  let result: { ok: true; status: number; action: SwapAction; operationLocation?: string };
  try {
    result = await swapSlots({ resourceGroup, site, sourceSlot, targetSlot, preserveVnet, action });
  } catch (e) {
    if (e instanceof AppServiceNotConfiguredError) return NextResponse.json(gateBody(e.missing), { status: 409 });
    const status = e instanceof AppServiceSlotsError ? e.status : 502;
    return err((e as Error).message, status, 'appservice_error');
  }

  // Append a swap record to the item state (History tab) — best-effort.
  let swaps: SwapRecord[] = [];
  if (id && id !== 'new') {
    const env = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
    if (env) {
      const state = { ...((env.state || {}) as Record<string, unknown>) };
      const prior: SwapRecord[] = Array.isArray(state.swaps) ? (state.swaps as SwapRecord[]) : [];
      const record: SwapRecord = {
        id: `swap_${Date.now()}`, site, resourceGroup, sourceSlot, targetSlot, action,
        status: result.status, at: new Date().toISOString(),
        by: s.claims.upn || s.claims.email || s.claims.oid,
      };
      swaps = [record, ...prior].slice(0, 200);
      state.swaps = swaps;
      await updateOwnedItem(id, ITEM_TYPE, s.claims.oid, { state });
    }
  }
  return NextResponse.json({ ok: true, result, swaps });
}
