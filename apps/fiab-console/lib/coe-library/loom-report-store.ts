/**
 * Loom-native published-report store (server-side).
 *
 * Persists a PUBLISHED SNAPSHOT of a Loom report Azure-natively so it can be
 * surfaced in the Organization reports consumer gallery WITHOUT Microsoft
 * Fabric / Power BI. A snapshot captures everything the consumer view needs to
 * re-render the report against the LIVE backend:
 *   - the resolved `ReportContent` (pages + visuals — layout, wells, format,
 *     filters), and
 *   - the report's `dataSource` ref (semantic-model item / direct-query /
 *     AAS binding).
 * The consumer render path replays that data source through
 * `/api/items/report/[id]/query`, so the gallery shows REAL rows from the
 * customer's own Azure estate (Synapse / lakehouse / AAS), not a frozen
 * thumbnail. (no-vaporware.md)
 *
 * Storage: the existing `coe-templates` Cosmos container (PK `/tenantId`),
 * discriminated by `kind:'loom-report'` so it lives alongside CoE template
 * clones (`kind` undefined) and Loom-native dashboards (`kind:'loom-dashboard'`)
 * without a new container or extra ARM/Bicep step — the Console UAMI already
 * holds Cosmos DB Built-in Data Contributor. This mirrors `setClonePublished`
 * (coe-library-client.ts) and `listPublishedDashboards` (builder/dashboard-store.ts).
 *
 * Azure-native by default (no-fabric-dependency.md): publishing here is the
 * DEFAULT path and reaches no Fabric/Power BI host. Publishing to Power BI is a
 * separate, strictly opt-in admin action (`NEXT_PUBLIC_LOOM_BI_BACKEND=powerbi`
 * + a bound workspace) handled elsewhere via the PBIR provisioner — never from
 * this module.
 *
 * NOTE for the CoE consumer gallery: `coe-library-client.listPublishedReports()`
 * currently excludes only `kind:'loom-dashboard'`. Loom reports carry the
 * distinct `kind:'loom-report'` discriminator and MUST be read through this
 * module's `listPublishedLoomReports()`; the org-reports route merges the two
 * sources (kind `loom-report` vs CoE clone) into the gallery.
 */

import { coeTemplatesContainer } from '../azure/cosmos-client';
import type { ReportContent } from '../apps/content-bundles/types';
// Server-side data-source union (the shape `readReportDataSource()` returns and
// that the routes hand us). Type-only import — no runtime coupling to the
// resolver's server deps.
import type { ReportDataSource } from '../azure/report-model-resolver';

/** Discriminator separating published Loom reports from CoE clones + dashboards. */
export const LOOM_REPORT_KIND = 'loom-report' as const;

/**
 * The portable snapshot a caller hands to `publishLoomReport`. Captures the
 * resolved report content + the data-source ref so the consumer view can
 * re-query the live backend; everything else (audit fields, kind, id) is filled
 * in by the store.
 */
export interface LoomReportSnapshot {
  /** Display name for the gallery card (falls back to 'Untitled report'). */
  name: string;
  /** Optional one-line description shown under the card title. */
  description?: string;
  /** Gallery category label for the consumer card (falls back to 'Reports'). */
  category?: string;
  /** The resolved report content — pages + visuals (layout/wells/format/filters). */
  content: ReportContent;
  /**
   * The report's bound data source, replayed by the consumer render path. May be
   * null when the report has no source bound yet — the snapshot still publishes
   * (the consumer view shows the report's own honest "pick a data source" gate).
   */
  dataSource: ReportDataSource | null;
}

/** A persisted published Loom report (Cosmos doc in `coe-templates`). */
export interface LoomReportDoc {
  /** Cosmos document id — the source `report` item id (so publish is idempotent). */
  id: string;
  /** Partition key — tenant (Entra oid) scope. */
  tenantId: string;
  /** Discriminator separating Loom reports from CoE clones + dashboards. */
  kind: typeof LOOM_REPORT_KIND;
  /** The source `report` item id (equal to `id`; kept explicit for queries/joins). */
  reportId: string;
  name: string;
  description?: string;
  /** Gallery category label for the consumer card (falls back to 'Reports'). */
  category?: string;
  /** Snapshotted report content — pages + visuals — re-rendered by the consumer view. */
  content: ReportContent;
  /** Snapshotted data-source ref — re-queried against the live Azure backend (or null when unbound). */
  dataSource: ReportDataSource | null;
  /** Published to the org-reports consumer gallery? */
  published: boolean;
  /** ISO timestamp the report was last published (cleared on unpublish). */
  publishedAt?: string;
  /** UPN/email of the user who published it (cleared on unpublish). */
  publishedBy?: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

/** Read the existing snapshot doc for a report within a tenant (or undefined). */
async function readDoc(tenantId: string, reportId: string): Promise<LoomReportDoc | undefined> {
  const c = await coeTemplatesContainer();
  const { resource } = await c.item(reportId, tenantId).read<LoomReportDoc>();
  return resource && resource.tenantId === tenantId && resource.kind === LOOM_REPORT_KIND
    ? resource
    : undefined;
}

/**
 * A concise gallery subtitle derived from the snapshotted content: page +
 * visual counts. Single source of truth for the consumer card's secondary line
 * (used by the Organization reports route) so the title is never stale.
 */
export function describeReportContent(content: ReportContent | null): string {
  const pages = content?.pages?.length ?? 0;
  const visuals = (content?.pages || []).reduce((n, p) => n + (p.visuals?.length || 0), 0);
  return `${pages || 1} page${pages === 1 ? '' : 's'} · ${visuals} visual${visuals === 1 ? '' : 's'} · Loom-native report`;
}

/**
 * Publish a report: persist (upsert) its snapshot with `published:true` + audit
 * fields. Re-publishing the same report re-snapshots its content/data-source
 * while preserving the original create audit. This is the DEFAULT Azure-native
 * publish path — no Power BI / Fabric host is contacted.
 */
export async function publishLoomReport(
  tenantId: string,
  who: string,
  reportId: string,
  snapshot: LoomReportSnapshot,
): Promise<LoomReportDoc> {
  const existing = await readDoc(tenantId, reportId);
  const now = new Date().toISOString();
  const doc: LoomReportDoc = {
    id: reportId,
    tenantId,
    kind: LOOM_REPORT_KIND,
    reportId,
    name: snapshot.name?.trim() || 'Untitled report',
    ...(snapshot.description ? { description: snapshot.description } : {}),
    ...(snapshot.category ? { category: snapshot.category } : {}),
    content: snapshot.content,
    dataSource: snapshot.dataSource,
    published: true,
    publishedAt: now,
    publishedBy: who,
    createdAt: existing?.createdAt ?? now,
    createdBy: existing?.createdBy ?? who,
    updatedAt: now,
    updatedBy: who,
  };
  const c = await coeTemplatesContainer();
  await c.items.upsert(doc);
  return doc;
}

/**
 * Flip a published report's visibility without re-snapshotting. `false`
 * unpublishes (removes it from the consumer gallery) but RETAINS the snapshot so
 * it can be re-published later; `true` re-shows the retained snapshot. Throws if
 * no snapshot exists for the report (nothing to toggle).
 */
export async function setPublished(
  tenantId: string,
  reportId: string,
  published: boolean,
): Promise<LoomReportDoc> {
  const existing = await readDoc(tenantId, reportId);
  if (!existing) throw new Error(`no published snapshot for report: ${reportId}`);
  const now = new Date().toISOString();
  const doc: LoomReportDoc = {
    ...existing,
    published,
    publishedAt: published ? (existing.publishedAt ?? now) : undefined,
    publishedBy: published ? (existing.publishedBy ?? existing.updatedBy) : undefined,
    updatedAt: now,
    updatedBy: existing.updatedBy,
  };
  const c = await coeTemplatesContainer();
  await c.item(reportId, tenantId).replace(doc);
  return doc;
}

/**
 * Idempotent unpublish — remove a report from the consumer gallery while
 * RETAINING its snapshot for a later re-publish. Returns `false` (rather than
 * throwing) when no snapshot exists, so a DELETE on a never-published report is
 * a safe no-op. Use this from the publish route's DELETE handler; use
 * `setPublished(…, true)` to re-show a retained snapshot.
 */
export async function unpublishLoomReport(tenantId: string, reportId: string): Promise<boolean> {
  const existing = await readDoc(tenantId, reportId);
  if (!existing) return false;
  const now = new Date().toISOString();
  const doc: LoomReportDoc = {
    ...existing,
    published: false,
    publishedAt: undefined,
    publishedBy: undefined,
    updatedAt: now,
    updatedBy: existing.updatedBy,
  };
  const c = await coeTemplatesContainer();
  await c.item(reportId, tenantId).replace(doc);
  return true;
}

/**
 * Every published Loom report across the deployment (cross-partition). The
 * console serves a single Entra tenant, so `published = true` is the org
 * gallery. Most-recently-published first.
 */
export async function listPublishedLoomReports(): Promise<LoomReportDoc[]> {
  const c = await coeTemplatesContainer();
  const { resources } = await c.items
    .query<LoomReportDoc>({
      query: 'SELECT * FROM c WHERE c.kind = @k AND c.published = true ORDER BY c.publishedAt DESC',
      parameters: [{ name: '@k', value: LOOM_REPORT_KIND }],
    })
    .fetchAll();
  return resources || [];
}

/** Read a single published Loom report by id (cross-partition; only if published). */
export async function getPublishedLoomReport(id: string): Promise<LoomReportDoc | undefined> {
  const c = await coeTemplatesContainer();
  const { resources } = await c.items
    .query<LoomReportDoc>({
      query: 'SELECT * FROM c WHERE c.id = @id AND c.kind = @k AND c.published = true',
      parameters: [{ name: '@id', value: id }, { name: '@k', value: LOOM_REPORT_KIND }],
    })
    .fetchAll();
  return resources?.[0];
}
