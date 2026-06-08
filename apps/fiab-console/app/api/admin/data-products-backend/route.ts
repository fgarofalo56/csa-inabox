/**
 * GET /api/admin/data-products-backend — the Settings indicator BFF.
 *
 * Reports which DataProductStore adapter is active for this deployment, so the
 * /admin/tenant-settings page can render:
 *   "Backend: Cosmos (default) | Purview Unified Catalog"
 * with the active one emphasized. Routing is 100% env-driven (per
 * .claude/rules/loom_no_freeform_config) — this endpoint only REPORTS the
 * resolved decision; it does not change it.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { resolveDataProductBackend, backendLabel } from '@/lib/dataproducts/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const backend = resolveDataProductBackend();
  const boundary = process.env.CSA_LOOM_BOUNDARY || 'Commercial';
  const wantUnified = process.env.LOOM_DATAPRODUCTS_BACKEND === 'purview-unified';
  const accountConfigured = !!(process.env.LOOM_PURVIEW_UNIFIED_ACCOUNT || process.env.LOOM_PURVIEW_UC_ENDPOINT);
  return NextResponse.json({
    ok: true,
    backend,
    label: backendLabel(backend),
    options: [
      { id: 'cosmos', label: backendLabel('cosmos') },
      { id: 'purview-unified', label: backendLabel('purview-unified') },
    ],
    // Why the opt-in did or did not take effect (Gov fall-through is silent in
    // the product, but transparent to an admin on this diagnostics endpoint).
    details: {
      requestedBackend: process.env.LOOM_DATAPRODUCTS_BACKEND || 'cosmos',
      boundary,
      accountConfigured,
      // True only when the operator asked for Unified but the boundary forced
      // the Cosmos fall-through (GCC / GCC-High / IL5).
      govFallThrough: wantUnified && accountConfigured && boundary !== 'Commercial',
    },
  });
}
