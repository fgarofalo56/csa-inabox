/**
 * The deployment-default APIM service resource itself (the APIM navigator →
 * "Service & SKU" pane). Reads the service + scales its SKU/capacity via real
 * ARM REST on Microsoft.ApiManagement/service.
 *
 *   GET   /api/apim/service            → { ok, service: { name, location, sku:{name,capacity}, provisioningState } }
 *   PATCH /api/apim/service            body { sku, capacity } → scale (async; returns provisioningState:'Updating')
 *
 * Honest 503 gate when the APIM service is unset (names the missing env var).
 * Real ARM REST. No mocks.
 *
 * This route is the fix for the admin "Service & SKU" pane crashing with
 * "Unexpected token '<' … is not valid JSON": the pane previously fetched
 * `/api/items/apim-service`, which never existed, so Next.js returned its HTML
 * 404 page and `r.json()` threw. The client functions (getApimService /
 * updateApimSku) already existed in apim-client.ts but were never exposed.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  apimConfigGate, getApimService, updateApimSku, ApimError,
} from '@/lib/azure/apim-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Valid sku.name values for the 2024-06-01-preview api-version. PremiumV2 only
// appears from 2025-09-01-preview, so it is intentionally NOT offered here —
// must match the pane's SKU dropdown (apim-service-pane.tsx SKU_OPTIONS).
const ALLOWED_SKUS = ['Developer', 'Basic', 'Standard', 'Premium', 'BasicV2', 'StandardV2'];

function gate() {
  const g = apimConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `APIM service not configured: set ${g.missing}.`, missing: g.missing },
      { status: 503 },
    );
  }
  return null;
}

function fail(e: any) {
  const status = e instanceof ApimError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  try {
    const service = await getApimService();
    if (!service) {
      return NextResponse.json(
        { ok: false, error: 'APIM service not found at the configured scope. Verify LOOM_APIM_NAME / LOOM_APIM_RG / LOOM_APIM_SUB.' },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true, service });
  } catch (e: any) { return fail(e); }
}

export async function PATCH(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));
  const sku = body?.sku ? String(body.sku) : '';
  if (!sku) return NextResponse.json({ ok: false, error: 'sku is required' }, { status: 400 });
  if (!ALLOWED_SKUS.includes(sku)) {
    return NextResponse.json(
      { ok: false, error: `Invalid sku "${sku}". Allowed: ${ALLOWED_SKUS.join(', ')}.` },
      { status: 400 },
    );
  }
  const capacityRaw = Number(body?.capacity);
  const capacity = Number.isFinite(capacityRaw) ? Math.max(1, Math.min(10, Math.trunc(capacityRaw))) : 1;
  try {
    const service = await updateApimSku(sku, capacity);
    return NextResponse.json({ ok: true, service });
  } catch (e: any) { return fail(e); }
}
