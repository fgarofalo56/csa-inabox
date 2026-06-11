/**
 * F23 — Organizational (tenant-wide) custom visuals client (server-side).
 *
 * Azure-native equivalent of Fabric / Power BI Admin "Organizational visuals".
 * A tenant admin uploads a `.pbiviz` bundle → the raw bytes are stored as a real
 * blob in the DLZ `org-visuals` Blob container, and a metadata document is
 * written to the Cosmos `org-visuals` container. Each visual carries a version
 * and an enabled/disabled toggle controlling tenant-wide availability.
 *
 * No Fabric / Power BI workspace dependency. Gated only on the Azure-side
 * `LOOM_ORG_VISUALS_URL` env var.
 */

import { randomUUID } from 'node:crypto';
import { uploadBlob, deletePath } from '../azure/adls-client';
import { orgVisualsContainer } from '../azure/cosmos-client';
import type { OrgVisualDoc } from '../types/org-visuals';
import {
  ORG_VISUALS_CONTAINER,
  NotConfiguredError,
  orgVisualsAccount,
  isConfigured,
} from './embed-codes-client';

export { NotConfiguredError, isConfigured };

function bundlePath(tenantId: string, visualId: string, fileName: string): string {
  const safeName = fileName.replace(/[^A-Za-z0-9._-]/g, '_');
  return `visuals/${tenantId}/${visualId}/${safeName}`;
}

export async function listOrgVisuals(tenantId: string): Promise<OrgVisualDoc[]> {
  const c = await orgVisualsContainer();
  const { resources } = await c.items
    .query<OrgVisualDoc>({
      query: 'SELECT * FROM c WHERE c.tenantId = @t ORDER BY c.uploadedAt DESC',
      parameters: [{ name: '@t', value: tenantId }],
    })
    .fetchAll();
  return resources || [];
}

/**
 * Upload a custom-visual bundle: store the real bytes in Blob, write the Cosmos
 * metadata (enabled=false until explicitly enabled tenant-wide). Optional
 * `description` + `iconDataUri` carry parity with Fabric's "Add visual" dialog
 * and are persisted inline on the metadata doc.
 */
export async function uploadOrgVisual(
  tenantId: string,
  who: string,
  name: string,
  fileName: string,
  version: string,
  body: Buffer,
  opts: { description?: string; iconDataUri?: string } = {},
): Promise<OrgVisualDoc> {
  const account = orgVisualsAccount();
  const id = randomUUID();
  const blobPath = bundlePath(tenantId, id, fileName);
  const now = new Date().toISOString();

  const up = await uploadBlob(
    ORG_VISUALS_CONTAINER,
    blobPath,
    body,
    'application/octet-stream',
    account,
  );

  const doc: OrgVisualDoc = {
    id,
    tenantId,
    name,
    fileName,
    blobPath,
    size: up.size,
    version,
    ...(opts.description ? { description: opts.description } : {}),
    ...(opts.iconDataUri ? { iconDataUri: opts.iconDataUri } : {}),
    enabled: false,
    uploadedAt: now,
    uploadedBy: who,
  };
  const c = await orgVisualsContainer();
  await c.items.upsert(doc);
  return doc;
}

/** Enable / disable a visual tenant-wide. */
export async function toggleOrgVisual(
  tenantId: string,
  visualId: string,
  enabled: boolean,
  who: string,
): Promise<OrgVisualDoc> {
  const c = await orgVisualsContainer();
  const { resource } = await c.item(visualId, tenantId).read<OrgVisualDoc>();
  if (!resource || resource.tenantId !== tenantId) {
    throw new Error('org visual not found');
  }
  const updated: OrgVisualDoc = {
    ...resource,
    enabled,
    enabledAt: new Date().toISOString(),
    enabledBy: who,
  };
  await c.item(visualId, tenantId).replace(updated);
  return updated;
}

/** Delete a visual: remove the bundle blob + the Cosmos metadata. */
export async function deleteOrgVisual(
  tenantId: string,
  visualId: string,
): Promise<void> {
  const c = await orgVisualsContainer();
  const { resource } = await c.item(visualId, tenantId).read<OrgVisualDoc>();
  if (!resource || resource.tenantId !== tenantId) return;
  if (isConfigured()) {
    try {
      await deletePath(ORG_VISUALS_CONTAINER, resource.blobPath);
    } catch {
      /* blob already gone / transient — Cosmos delete below is authoritative */
    }
  }
  await c.item(visualId, tenantId).delete();
}
