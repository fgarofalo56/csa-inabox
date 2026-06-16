/**
 * CoE template-library client (server-side).
 *
 * Surfaces the default Cloud Center of Excellence (CoE) Power BI report
 * templates as a library in the Organizational Visuals admin surface, and
 * implements "Use this template" (clone) into a per-tenant collection.
 *
 * The catalog + the PBIP file bytes are bundled into the app (COE_CATALOG /
 * TEMPLATE_FILES) so they work in the standalone container image where the
 * repo `docs/` folder is not present. Cloning:
 *   1. Always writes a real clone record to the `coe-templates` Cosmos
 *      container (PK /tenantId).
 *   2. When the org-visuals Blob backing is configured (LOOM_ORG_VISUALS_URL),
 *      also copies the template's PBIP files into the tenant's org-visuals
 *      Blob container under `coe-templates/<tenantId>/<cloneId>/...` so the
 *      cloned project is editable / downloadable. When it is not configured,
 *      the clone still succeeds (metadata-only) and the caller surfaces an
 *      honest Fluent gate naming LOOM_ORG_VISUALS_URL.
 *
 * Azure-native: no Microsoft Fabric / Power BI workspace is required to browse
 * or clone. Publishing to Power BI is a separate, opt-in admin action handled
 * by scripts/csa-loom/publish-coe-reports.sh.
 */

import { randomUUID } from 'node:crypto';
import { uploadBlob, deletePath } from '../azure/adls-client';
import { coeTemplatesContainer } from '../azure/cosmos-client';
import {
  ORG_VISUALS_CONTAINER,
  orgVisualsAccount,
  isConfigured,
  NotConfiguredError,
} from '../clients/embed-codes-client';
import { COE_CATALOG } from './catalog';
import { TEMPLATE_FILES, type TemplateFile } from './templates-content';
import type { CoeCatalog, CoeTemplate, CoeTemplateCloneDoc } from './types';

export { isConfigured, NotConfiguredError };

/** The bundled default CoE template catalog. */
export function getCatalog(): CoeCatalog {
  return COE_CATALOG;
}

/** Look up a single template by id (slug). */
export function getTemplate(templateId: string): CoeTemplate | undefined {
  return COE_CATALOG.templates.find((t) => t.id === templateId);
}

/** The bundled PBIP file bytes for a template (real PBIR + TMDL), or []. */
export function getTemplateFiles(templateId: string): TemplateFile[] {
  return TEMPLATE_FILES[templateId] || [];
}

/** Read a single clone document for a tenant (or undefined if not found). */
export async function getClone(tenantId: string, cloneId: string): Promise<CoeTemplateCloneDoc | undefined> {
  const c = await coeTemplatesContainer();
  const { resource } = await c.item(cloneId, tenantId).read<CoeTemplateCloneDoc>();
  return resource && resource.tenantId === tenantId ? resource : undefined;
}

/**
 * Publish (or unpublish) a clone to the organization. Updates the clone's
 * Cosmos doc with the publish flag + audit fields. Azure-native: this surfaces
 * the report in the in-product consumer gallery — no Power BI / Fabric publish.
 */
export async function setClonePublished(
  tenantId: string,
  who: string,
  cloneId: string,
  published: boolean,
): Promise<CoeTemplateCloneDoc> {
  const c = await coeTemplatesContainer();
  const { resource } = await c.item(cloneId, tenantId).read<CoeTemplateCloneDoc>();
  if (!resource || resource.tenantId !== tenantId) throw new Error(`unknown clone: ${cloneId}`);
  const doc: CoeTemplateCloneDoc = {
    ...resource,
    published,
    audience: published ? 'organization' : undefined,
    publishedAt: published ? new Date().toISOString() : undefined,
    publishedBy: published ? who : undefined,
  };
  await c.items.upsert(doc);
  return doc;
}

/**
 * List every clone published to the organization across the deployment.
 * The console serves a single Entra tenant, so a cross-partition query for
 * `published = true` is the org gallery. Most-recently-published first.
 */
export async function listPublishedReports(): Promise<CoeTemplateCloneDoc[]> {
  const c = await coeTemplatesContainer();
  const { resources } = await c.items
    .query<CoeTemplateCloneDoc>({
      query: 'SELECT * FROM c WHERE c.published = true ORDER BY c.publishedAt DESC',
    })
    .fetchAll();
  return resources || [];
}

/** Read a single published clone by id (cross-partition; only if published). */
export async function getPublishedReport(cloneId: string): Promise<CoeTemplateCloneDoc | undefined> {
  const c = await coeTemplatesContainer();
  const { resources } = await c.items
    .query<CoeTemplateCloneDoc>({
      query: 'SELECT * FROM c WHERE c.id = @id AND c.published = true',
      parameters: [{ name: '@id', value: cloneId }],
    })
    .fetchAll();
  return resources?.[0];
}

/** List a tenant's previously-cloned templates (most recent first). */
export async function listClones(tenantId: string): Promise<CoeTemplateCloneDoc[]> {
  const c = await coeTemplatesContainer();
  const { resources } = await c.items
    .query<CoeTemplateCloneDoc>({
      query: 'SELECT * FROM c WHERE c.tenantId = @t ORDER BY c.clonedAt DESC',
      parameters: [{ name: '@t', value: tenantId }],
    })
    .fetchAll();
  return resources || [];
}

function clonePrefix(tenantId: string, cloneId: string): string {
  return `coe-templates/${tenantId}/${cloneId}`;
}

/**
 * "Use this template" — clone a default CoE template into the tenant's library.
 * Writes a real Cosmos record; copies the PBIP bytes into Blob when org-visuals
 * is configured. Returns the clone record.
 */
export async function cloneTemplate(
  tenantId: string,
  who: string,
  templateId: string,
  displayName?: string,
): Promise<CoeTemplateCloneDoc> {
  const tpl = getTemplate(templateId);
  if (!tpl) throw new Error(`unknown template: ${templateId}`);
  const files = TEMPLATE_FILES[templateId] || [];

  const id = randomUUID();
  const now = new Date().toISOString();
  const prefix = clonePrefix(tenantId, id);

  let blobCopied = false;
  if (isConfigured()) {
    const account = orgVisualsAccount();
    // Copy every PBIP file (real bytes) into the tenant's org-visuals container.
    for (const f of files) {
      await uploadBlob(
        ORG_VISUALS_CONTAINER,
        `${prefix}/${f.path}`,
        Buffer.from(f.content, 'utf-8'),
        f.path.endsWith('.json') || f.path.endsWith('.pbip') || f.path.endsWith('.pbir') || f.path.endsWith('.pbism')
          ? 'application/json'
          : 'text/plain; charset=utf-8',
        account,
      );
    }
    blobCopied = files.length > 0;
  }

  const doc: CoeTemplateCloneDoc = {
    id,
    tenantId,
    templateId,
    title: tpl.title,
    category: tpl.category,
    displayName: (displayName || tpl.title).trim(),
    fileCount: files.length,
    blobPrefix: blobCopied ? prefix : '',
    blobCopied,
    status: 'cloned',
    clonedAt: now,
    clonedBy: who,
  };
  const c = await coeTemplatesContainer();
  await c.items.upsert(doc);
  return doc;
}

/** Delete a clone: remove its Blob files (best-effort) + the Cosmos record. */
export async function deleteClone(tenantId: string, cloneId: string): Promise<void> {
  const c = await coeTemplatesContainer();
  const { resource } = await c.item(cloneId, tenantId).read<CoeTemplateCloneDoc>();
  if (!resource || resource.tenantId !== tenantId) return;
  if (resource.blobCopied && resource.blobPrefix && isConfigured()) {
    const files = TEMPLATE_FILES[resource.templateId] || [];
    for (const f of files) {
      try {
        await deletePath(ORG_VISUALS_CONTAINER, `${resource.blobPrefix}/${f.path}`);
      } catch {
        /* blob already gone / transient — Cosmos delete below is authoritative */
      }
    }
  }
  await c.item(cloneId, tenantId).delete();
}
