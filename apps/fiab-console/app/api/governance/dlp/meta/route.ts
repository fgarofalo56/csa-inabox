/**
 * GET /api/governance/dlp/meta
 *
 * Lightweight surface metadata for the Governance → DLP panel:
 *   - boundary               — friendly cloud label (Commercial / GCC High / DoD)
 *   - dlpPolicyApiAvailable  — false in Gov/DoD (drives the honest-gate MessageBar)
 *   - lastScannedAt          — last violations refresh time
 *   - scanTriggeredAt        — last operator-requested scan time
 *   - restrictions           — recorded restrict-access actions (item-permissions)
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { graphDlpPolicyApiAvailable, cloudBoundaryLabel } from '@/lib/azure/cloud-endpoints';
import { dlpEnabled } from '@/lib/azure/dlp-graph-client';
import { loadDlpMeta } from '../_lib/meta';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  let lastScannedAt: string | undefined;
  let scanTriggeredAt: string | undefined;
  let restrictions: unknown[] = [];
  try {
    const meta = await loadDlpMeta(s.claims.oid);
    lastScannedAt = meta.lastScannedAt;
    scanTriggeredAt = meta.scanTriggeredAt;
    restrictions = meta.restrictions || [];
  } catch { /* meta best-effort — boundary still returned for the gate */ }
  return NextResponse.json({
    ok: true,
    boundary: cloudBoundaryLabel(),
    dlpPolicyApiAvailable: graphDlpPolicyApiAvailable(),
    enabled: dlpEnabled(),
    lastScannedAt,
    scanTriggeredAt,
    restrictions,
  });
}
