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
 * BI / Fabric workspace is involved. Three publish surfaces feed the gallery:
 *   - CoE template clones (PBIP) → render from the bundled PBIR + TMDL.
 *   - Loom-native builder dashboards (kind:'loom-dashboard').
 *   - Loom-native report-designer snapshots (kind:'loom-report') published from
 *     the report designer — bound to a Loom semantic model over Synapse/lakehouse
 *     (or AAS), rendered Azure-natively via /api/items/report/<id>/query. Power
 *     BI is never called on this path.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listPublishedReports } from '@/lib/coe-library/coe-library-client';
import { listPublishedDashboards } from '@/lib/coe-library/builder/dashboard-store';
import {
  listPublishedLoomReports,
  describeReportContent,
} from '@/lib/coe-library/loom-report-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    // Three kinds of published org reports: CoE template clones (PBIP),
    // Loom-native builder dashboards, and Loom-native report-designer snapshots.
    // All render Azure-natively (no Power BI / Fabric); the consumer renders each
    // via its own endpoint keyed by `kind`.
    const [clones, dashboards, loomReports] = await Promise.all([
      listPublishedReports().catch(() => []),
      listPublishedDashboards().catch(() => []),
      listPublishedLoomReports().catch(() => []),
    ]);
    // The CoE clone query excludes loom-dashboard but not loom-report, so a
    // published loom-report can also surface in `clones`; de-dup by id so each
    // report appears once — as its richer, kind-aware loom-report entry.
    const loomReportIds = new Set(loomReports.map((d) => d.id));
    const reports = [
      ...clones.filter((d) => !loomReportIds.has(d.id)).map((d) => ({
        id: d.id, kind: 'report' as const, templateId: d.templateId,
        displayName: d.displayName, title: d.title, category: d.category,
        publishedBy: d.publishedBy, publishedAt: d.publishedAt,
      })),
      ...dashboards.map((d) => ({
        id: d.id, kind: 'dashboard' as const, templateId: '',
        displayName: d.name, title: `${d.tileCount} tile${d.tileCount === 1 ? '' : 's'} · Loom-native dashboard`,
        category: d.category, publishedBy: d.publishedBy, publishedAt: d.publishedAt,
      })),
      ...loomReports.map((d) => ({
        id: d.id, kind: 'loom-report' as const, templateId: '',
        displayName: d.name || 'Report',
        title: describeReportContent(d.content),
        category: d.category || 'Reports',
        publishedBy: d.publishedBy, publishedAt: d.publishedAt,
      })),
    ].sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')));
    return NextResponse.json({ ok: true, reports });
  } catch (e: any) {
    // Empty gallery is a valid state; surface the warning but don't 500 the page.
    return NextResponse.json({ ok: true, reports: [], warning: e?.message || String(e) });
  }
}
