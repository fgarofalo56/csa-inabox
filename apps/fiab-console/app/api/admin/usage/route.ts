/**
 * GET /api/admin/usage — tenant usage metrics. Two real backends, merged:
 *
 *   Cosmos (always on):
 *     - items per type / per workspace
 *     - daily audit activity (last `days`, from audit-log)
 *     - top items by audit count
 *
 *   Log Analytics (when LOOM_LOG_ANALYTICS_WORKSPACE_ID is set):
 *     - active-users trend (daily DAU from AppRequests)
 *     - feature adoption (events + distinct users per route prefix)
 *     - top items by request events (merged with Cosmos audit counts)
 *
 * Query params:
 *   - days    1–90 (default 30) — window for both backends
 *   - feature drill-through: filters feature adoption + restricts the merged
 *     top-items to that feature's items (live, no page reload)
 *
 * When Log Analytics is unconfigured the LA queries are skipped via
 * Promise.allSettled and `laConfigured:false` is returned — the page renders
 * the Cosmos sections plus an honest MessageBar (never an EmptyState upsell).
 * No Microsoft Fabric required (.claude/rules/no-fabric-dependency.md).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { workspacesContainer, itemsContainer, auditLogContainer } from '@/lib/azure/cosmos-client';
import {
  fetchActiveUsersTrend,
  fetchFeatureAdoption,
  fetchTopItemsFromLa,
  MonitorNotConfiguredError,
  type DayPoint,
  type FeatureRow,
  type LaTopItem,
} from '@/lib/clients/usage-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface MergedTopItem {
  itemId: string;
  /** Cosmos audit-log writes. */
  auditCount: number;
  /** Log Analytics request events (0 when LA unconfigured). */
  requestEvents: number;
  displayName?: string;
  itemType?: string;
  workspaceName?: string;
}

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const adminDenied = requireTenantAdmin(s);
  if (adminDenied) return adminDenied;
  const tenantId = s.claims.oid;

  const url = new URL(req.url);
  const daysRaw = Number(url.searchParams.get('days'));
  const days = Number.isFinite(daysRaw) ? Math.min(90, Math.max(1, Math.floor(daysRaw))) : 30;
  const featureFilter = (url.searchParams.get('feature') || '').trim() || null;

  try {
    const wsC = await workspacesContainer();
    const itC = await itemsContainer();
    const audC = await auditLogContainer();

    const { resources: workspaces } = await wsC.items.query({
      query: 'SELECT c.id, c.name FROM c WHERE c.tenantId = @t',
      parameters: [{ name: '@t', value: tenantId }],
    }, { partitionKey: tenantId }).fetchAll();
    const wsIds = workspaces.map((w: any) => w.id);
    const wsName = new Map(workspaces.map((w: any) => [w.id, w.name]));

    let items: any[] = [];
    if (wsIds.length) {
      const { resources } = await itC.items.query({
        query: 'SELECT c.id, c.workspaceId, c.itemType, c.displayName, c.updatedAt FROM c WHERE ARRAY_CONTAINS(@w, c.workspaceId)',
        parameters: [{ name: '@w', value: wsIds }],
      }).fetchAll();
      items = resources;
    }

    // Items per type
    const byType = new Map<string, number>();
    for (const i of items) byType.set(i.itemType, (byType.get(i.itemType) || 0) + 1);
    const itemsByType = Array.from(byType.entries()).map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count);

    // Items per workspace
    const byWs = new Map<string, number>();
    for (const i of items) byWs.set(i.workspaceId, (byWs.get(i.workspaceId) || 0) + 1);
    const itemsByWorkspace = Array.from(byWs.entries()).map(([wsId, count]) => ({
      workspaceId: wsId, workspaceName: wsName.get(wsId) || wsId, count,
    })).sort((a, b) => b.count - a.count).slice(0, 20);

    // Activity per day (window) from audit-log
    const since = new Date(Date.now() - days * 24 * 3600_000).toISOString();
    let auditCount = 0;
    const byDay = new Map<string, number>();
    const byItem = new Map<string, { itemId: string; count: number }>();
    try {
      const { resources: audits } = await audC.items.query({
        query: 'SELECT c.itemId, c.at FROM c WHERE c.tenantId = @t AND c.at >= @since',
        parameters: [
          { name: '@t', value: tenantId },
          { name: '@since', value: since },
        ],
      }).fetchAll();
      auditCount = audits.length;
      for (const a of audits) {
        const day = (a.at as string).slice(0, 10);
        byDay.set(day, (byDay.get(day) || 0) + 1);
        const cur = byItem.get(a.itemId) || { itemId: a.itemId, count: 0 };
        cur.count++;
        byItem.set(a.itemId, cur);
      }
    } catch { /* audit container may be empty */ }

    const activity = Array.from(byDay.entries())
      .map(([day, count]) => ({ day, count }))
      .sort((a, b) => a.day.localeCompare(b.day));

    // ---- Log Analytics telemetry (parallel, non-blocking) ------------------
    const [trendR, adoptionR, laTopR] = await Promise.allSettled([
      fetchActiveUsersTrend(days),
      fetchFeatureAdoption(days, featureFilter ?? undefined),
      fetchTopItemsFromLa(days),
    ]);

    let laConfigured = true;
    let laError: string | null = null;
    const unwrap = <T>(r: PromiseSettledResult<T>, fallback: T): T => {
      if (r.status === 'fulfilled') return r.value;
      if (r.reason instanceof MonitorNotConfiguredError) { laConfigured = false; return fallback; }
      laError = laError || (r.reason as Error)?.message || String(r.reason);
      return fallback;
    };
    const activeUsersTrend: DayPoint[] = unwrap(trendR, []);
    const featureAdoption: FeatureRow[] = unwrap(adoptionR, []);
    const laTopItems: LaTopItem[] = unwrap(laTopR, []);

    // ---- Merge top items: Cosmos audit counts ⊕ LA request events ----------
    const merged = new Map<string, MergedTopItem>();
    for (const t of byItem.values()) {
      merged.set(t.itemId, { itemId: t.itemId, auditCount: t.count, requestEvents: 0 });
    }
    for (const t of laTopItems) {
      const cur = merged.get(t.itemId);
      if (cur) cur.requestEvents = t.events;
      else merged.set(t.itemId, { itemId: t.itemId, auditCount: 0, requestEvents: t.events });
    }
    // Enrich + (optionally) filter by drill-through feature. The 'items'
    // feature owns every /items/<type>/<id> request, so a feature filter other
    // than 'items' narrows to zero LA item traffic — we then fall back to the
    // Cosmos audit set so the table is never mysteriously empty.
    let topItems = Array.from(merged.values())
      .map((m) => {
        const it = items.find((i) => i.id === m.itemId);
        return {
          ...m,
          displayName: it?.displayName,
          itemType: it?.itemType,
          workspaceName: it ? (wsName.get(it.workspaceId) || it.workspaceId) : undefined,
        };
      })
      .sort((a, b) => (b.requestEvents + b.auditCount) - (a.requestEvents + a.auditCount))
      .slice(0, 25);

    if (featureFilter && featureFilter !== 'items') {
      // Drill-through to a non-item feature: item-level table isn't meaningful,
      // so present the audit-derived items only (keeps the surface honest).
      topItems = topItems.filter((t) => t.auditCount > 0);
    }

    return NextResponse.json({
      ok: true,
      days,
      since,
      featureFilter,
      laConfigured,
      laError,
      totals: {
        workspaces: workspaces.length,
        items: items.length,
        itemTypes: itemsByType.length,
        auditEvents30d: auditCount,
      },
      itemsByType,
      itemsByWorkspace,
      activity,
      topItems,
      activeUsersTrend,
      featureAdoption,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
