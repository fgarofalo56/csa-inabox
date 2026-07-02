/**
 * GET /api/governance/classifications/system
 *
 * Microsoft Purview ships 200+ BUILT-IN ("system") classifications — the
 * sensitive-information types it auto-detects on a scan (Government IDs, credit
 * cards, SSNs, addresses, email, secrets, health identifiers, …). They are a
 * FIXED Microsoft-defined catalog, NOT something the scan-plane returns: the
 * classification-RULES API (`/scan/classificationrules`) returns only the
 * tenant's CUSTOM rules, so deriving the built-ins from it came back EMPTY and
 * the live call also timed out (>6s).
 *
 * This route therefore serves a STATIC reference catalog
 * (`lib/azure/purview-system-classifications`) — no Purview call, no timeout —
 * so the admin Classifications page can always surface the real built-ins
 * (U.S. SSN, Credit Card, Email, IP Address, Physical Address, Passport, …) as
 * a read-only catalog and offer them in the rule-authoring dropdown.
 *
 * `configured` reflects LOOM_PURVIEW_ACCOUNT presence (so the page can show the
 * live-vs-honest-gate banner), but the catalog is returned REGARDLESS — it is
 * reference data, not tenant data. When Purview IS configured these same types
 * are exactly what its scans auto-apply.
 *
 * Reference: https://learn.microsoft.com/purview/data-map-classification-supported-list
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  isPurviewConfigured,
  getPurviewAccountName,
  notConfiguredHint,
} from '@/lib/azure/purview-client';
import {
  buildSystemClassificationGroups,
  SYSTEM_CLASSIFICATION_COUNT,
} from '@/lib/azure/purview-system-classifications';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const configured = isPurviewConfigured();
  return NextResponse.json({
    ok: true,
    // Whether a Purview account is bound — drives the live-sync vs. honest-gate
    // banner. NOT a gate on the catalog: the catalog is static reference data.
    configured,
    account: getPurviewAccountName(),
    // Static Microsoft built-in classification catalog — always returned.
    groups: buildSystemClassificationGroups(),
    total: SYSTEM_CLASSIFICATION_COUNT,
    source: 'microsoft-system-catalog',
    // Informational only (never a blocking gate): names the env var that wires
    // the live Purview Data Map for scanning/sync when it isn't set.
    ...(configured ? {} : { hint: notConfiguredHint('LOOM_PURVIEW_ACCOUNT') }),
  });
}
