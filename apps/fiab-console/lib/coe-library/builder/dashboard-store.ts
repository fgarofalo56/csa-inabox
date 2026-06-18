/**
 * Loom-native dashboard store (server-side).
 *
 * Persists builder-authored dashboards Azure-natively:
 *   - metadata + the full spec JSON → Cosmos `coe-templates` container
 *     (PK /tenantId), discriminated by `kind:'loom-dashboard'` so it lives
 *     alongside CoE template clones without a new container.
 *   - the spec JSON is ALSO written as a real blob in the `org-visuals` Blob
 *     container when LOOM_ORG_VISUALS_URL is configured (parity with how CoE
 *     clones copy their PBIP bytes); when unset the save still succeeds
 *     (metadata-only) and the caller surfaces an honest gate.
 *
 * No Microsoft Fabric / Power BI dependency: a dashboard renders from its spec
 * over the customer's own Azure estate (see report-render/live-bindings).
 */

import { randomUUID } from 'node:crypto';
import { uploadBlob, deletePath } from '../../azure/adls-client';
import { coeTemplatesContainer } from '../../azure/cosmos-client';
import {
  ORG_VISUALS_CONTAINER,
  orgVisualsAccount,
  isConfigured,
} from '../../clients/embed-codes-client';
import type { DashboardSpec } from './dashboard-model';

export const DASHBOARD_KIND = 'loom-dashboard';

/** A persisted Loom-native dashboard (Cosmos doc in `coe-templates`). */
export interface DashboardDoc {
  /** dashboardId (also the Cosmos document id). */
  id: string;
  /** Partition key — tenant (Entra oid) scope. */
  tenantId: string;
  /** Discriminator separating dashboards from CoE template clones in the container. */
  kind: typeof DASHBOARD_KIND;
  name: string;
  description?: string;
  category: string;
  /** The full builder spec (also blob-persisted when org-visuals is configured). */
  spec: DashboardSpec;
  tileCount: number;
  /** True when the spec JSON was copied to the org-visuals Blob container. */
  blobCopied: boolean;
  /** Blob path of the spec JSON (empty when metadata-only). */
  blobPath: string;
  /** Published to the org-reports consumer gallery? */
  published?: boolean;
  publishedAt?: string;
  publishedBy?: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

function specBlobPath(tenantId: string, id: string): string {
  return `dashboards/${tenantId}/${id}/dashboard.json`;
}

/** Best-effort copy of the spec JSON to Blob; never throws (metadata is authoritative). */
async function copySpecToBlob(tenantId: string, id: string, spec: DashboardSpec): Promise<{ blobCopied: boolean; blobPath: string }> {
  if (!isConfigured()) return { blobCopied: false, blobPath: '' };
  try {
    const account = orgVisualsAccount();
    const path = specBlobPath(tenantId, id);
    await uploadBlob(ORG_VISUALS_CONTAINER, path, Buffer.from(JSON.stringify(spec, null, 2)), 'application/json', account);
    return { blobCopied: true, blobPath: path };
  } catch {
    return { blobCopied: false, blobPath: '' };
  }
}

export async function listDashboards(tenantId: string): Promise<DashboardDoc[]> {
  const c = await coeTemplatesContainer();
  const { resources } = await c.items
    .query<DashboardDoc>({
      query: 'SELECT * FROM c WHERE c.tenantId = @t AND c.kind = @k ORDER BY c.updatedAt DESC',
      parameters: [{ name: '@t', value: tenantId }, { name: '@k', value: DASHBOARD_KIND }],
    })
    .fetchAll();
  return resources || [];
}

/** Every published Loom-native dashboard (cross-partition; consumer gallery). */
export async function listPublishedDashboards(): Promise<DashboardDoc[]> {
  const c = await coeTemplatesContainer();
  const { resources } = await c.items
    .query<DashboardDoc>({
      query: 'SELECT * FROM c WHERE c.kind = @k AND c.published = true ORDER BY c.publishedAt DESC',
      parameters: [{ name: '@k', value: DASHBOARD_KIND }],
    })
    .fetchAll();
  return resources || [];
}

/** Read a single published dashboard by id (cross-partition; only if published). */
export async function getPublishedDashboard(id: string): Promise<DashboardDoc | undefined> {
  const c = await coeTemplatesContainer();
  const { resources } = await c.items
    .query<DashboardDoc>({
      query: 'SELECT * FROM c WHERE c.id = @id AND c.kind = @k AND c.published = true',
      parameters: [{ name: '@id', value: id }, { name: '@k', value: DASHBOARD_KIND }],
    })
    .fetchAll();
  return resources?.[0];
}

export async function getDashboard(tenantId: string, id: string): Promise<DashboardDoc | null> {
  const c = await coeTemplatesContainer();
  const { resource } = await c.item(id, tenantId).read<DashboardDoc>();
  if (!resource || resource.tenantId !== tenantId || resource.kind !== DASHBOARD_KIND) return null;
  return resource;
}

export async function createDashboard(tenantId: string, who: string, spec: DashboardSpec): Promise<DashboardDoc> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const { blobCopied, blobPath } = await copySpecToBlob(tenantId, id, spec);
  const doc: DashboardDoc = {
    id,
    tenantId,
    kind: DASHBOARD_KIND,
    name: spec.name,
    ...(spec.description ? { description: spec.description } : {}),
    category: spec.category,
    spec,
    tileCount: spec.tiles.length,
    blobCopied,
    blobPath,
    createdAt: now,
    createdBy: who,
    updatedAt: now,
    updatedBy: who,
  };
  const c = await coeTemplatesContainer();
  await c.items.upsert(doc);
  return doc;
}

export async function updateDashboard(tenantId: string, who: string, id: string, spec: DashboardSpec): Promise<DashboardDoc> {
  const existing = await getDashboard(tenantId, id);
  if (!existing) throw new Error('dashboard not found');
  const { blobCopied, blobPath } = await copySpecToBlob(tenantId, id, spec);
  const updated: DashboardDoc = {
    ...existing,
    name: spec.name,
    description: spec.description,
    category: spec.category,
    spec,
    tileCount: spec.tiles.length,
    blobCopied: blobCopied || existing.blobCopied,
    blobPath: blobPath || existing.blobPath,
    updatedAt: new Date().toISOString(),
    updatedBy: who,
  };
  const c = await coeTemplatesContainer();
  await c.item(id, tenantId).replace(updated);
  return updated;
}

export async function setDashboardPublished(tenantId: string, who: string, id: string, published: boolean): Promise<DashboardDoc> {
  const existing = await getDashboard(tenantId, id);
  if (!existing) throw new Error('dashboard not found');
  const updated: DashboardDoc = {
    ...existing,
    published,
    publishedAt: published ? new Date().toISOString() : undefined,
    publishedBy: published ? who : undefined,
    updatedAt: new Date().toISOString(),
    updatedBy: who,
  };
  const c = await coeTemplatesContainer();
  await c.item(id, tenantId).replace(updated);
  return updated;
}

export async function deleteDashboard(tenantId: string, id: string): Promise<void> {
  const existing = await getDashboard(tenantId, id);
  if (!existing) return;
  if (existing.blobCopied && existing.blobPath && isConfigured()) {
    try { await deletePath(ORG_VISUALS_CONTAINER, existing.blobPath); } catch { /* Cosmos delete is authoritative */ }
  }
  const c = await coeTemplatesContainer();
  await c.item(id, tenantId).delete();
}
