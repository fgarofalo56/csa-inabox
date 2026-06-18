/**
 * Organization reports BFF (consumer gallery).
 *
 * GET /api/org-reports → every CoE report a colleague has published to the
 * organization. Available to ANY authenticated member of the deployment (this
 * is the consumer surface, not the admin library), so it is session-gated but
 * NOT admin-gated.
 *
 * The console serves a single Entra tenant, so the org gallery is a
 * cross-partition Cosmos query for `published = true`. Azure-native — no Power
 * BI / Fabric workspace is involved; published reports render from the bundled
 * PBIP (real PBIR + TMDL SAMPLE data) via /api/org-reports/render.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listPublishedReports } from '@/lib/coe-library/coe-library-client';
import { listPublishedDashboards } from '@/lib/coe-library/builder/dashboard-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    // Two kinds of published org reports: CoE template clones (PBIP) and
    // Loom-native dashboards built in the visual builder. Both render
    // Azure-natively (no Power BI / Fabric); the consumer renders each via its
    // own endpoint keyed by `kind`.
    const [clones, dashboards] = await Promise.all([
      listPublishedReports().catch(() => []),
      listPublishedDashboards().catch(() => []),
    ]);
    const reports = [
      ...clones.map((d) => ({
        id: d.id, kind: 'report' as const, templateId: d.templateId,
        displayName: d.displayName, title: d.title, category: d.category,
        publishedBy: d.publishedBy, publishedAt: d.publishedAt,
      })),
      ...dashboards.map((d) => ({
        id: d.id, kind: 'dashboard' as const, templateId: '',
        displayName: d.name, title: `${d.tileCount} tile${d.tileCount === 1 ? '' : 's'} · Loom-native dashboard`,
        category: d.category, publishedBy: d.publishedBy, publishedAt: d.publishedAt,
      })),
    ].sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')));
    return NextResponse.json({ ok: true, reports });
  } catch (e: any) {
    // Empty gallery is a valid state; surface the warning but don't 500 the page.
    return NextResponse.json({ ok: true, reports: [], warning: e?.message || String(e) });
  }
}
