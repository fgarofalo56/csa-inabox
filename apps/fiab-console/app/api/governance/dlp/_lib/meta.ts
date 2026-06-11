/**
 * Shared Cosmos meta-doc for the Governance → DLP surface.
 *
 * Stored as a single doc per tenant in the tenant-settings container under
 * `dlp-meta:<tenantId>` (same container + partition as `policies:<tenantId>`,
 * so no new Cosmos container is required). It records:
 *   - `lastScannedAt`     — when violations were last refreshed from Graph
 *                            (the honest stand-in for a scanner last-run time)
 *   - `scanTriggeredAt`   — when an operator last requested a scanner run
 *   - `restrictions[]`    — every restrict-access action (real RBAC revoke +
 *                            the principal/scope it removed), i.e. the
 *                            authoritative "item-permissions" record.
 */
import { tenantSettingsContainer } from '@/lib/azure/cosmos-client';

export interface DlpRestriction {
  id: string;
  at: string;
  by: string;
  scopeType: 'adls-container' | 'adls-path' | 'warehouse' | 'warehouse-schema' | 'kql-database';
  scopeRef: string;
  /** adls-path only: the directory/file (relative to the container) that was restricted. */
  subPath?: string;
  /** warehouse-schema only: the SQL schema that SELECT was denied on. */
  schema?: string;
  /** warehouse-schema only: the exact DENY statement executed (for auditability). */
  statement?: string;
  principalId: string;
  principalName?: string;
  revokedRoleAssignmentIds: string[];
  revokedRoleNames: string[];
  exemptPrincipalIds: string[];
  armConfirmed: boolean;
  /** adls-path only: read-back confirmed the principal's ACL entry is gone. */
  aclConfirmed?: boolean;
}

export interface DlpMetaDoc {
  id: string;
  tenantId: string;
  kind: 'dlp-meta';
  lastScannedAt?: string;
  scanTriggeredAt?: string;
  restrictions: DlpRestriction[];
  updatedAt: string;
}

function metaId(tenantId: string): string { return `dlp-meta:${tenantId}`; }

export async function loadDlpMeta(tenantId: string): Promise<DlpMetaDoc> {
  const c = await tenantSettingsContainer();
  const id = metaId(tenantId);
  try {
    const { resource } = await c.item(id, tenantId).read<DlpMetaDoc>();
    if (resource) {
      // Backfill the array for docs written before this field existed.
      if (!Array.isArray(resource.restrictions)) resource.restrictions = [];
      return resource;
    }
  } catch (e: any) { if (e?.code !== 404) throw e; }
  const seed: DlpMetaDoc = {
    id, tenantId, kind: 'dlp-meta', restrictions: [], updatedAt: new Date().toISOString(),
  };
  await c.items.create(seed);
  return seed;
}

export async function saveDlpMeta(doc: DlpMetaDoc): Promise<DlpMetaDoc> {
  const c = await tenantSettingsContainer();
  doc.updatedAt = new Date().toISOString();
  await c.item(doc.id, doc.tenantId).replace(doc);
  return doc;
}

/** Stamp the "last checked" time after a successful violations refresh. */
export async function stampLastScanned(tenantId: string): Promise<string> {
  const doc = await loadDlpMeta(tenantId);
  const now = new Date().toISOString();
  doc.lastScannedAt = now;
  await saveDlpMeta(doc);
  return now;
}
