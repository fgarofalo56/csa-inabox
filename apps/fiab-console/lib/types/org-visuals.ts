/**
 * F23 — Organizational (tenant-wide) custom visuals.
 *
 * Loom's Azure-native equivalent of Fabric / Power BI Admin-portal "Organizational
 * visuals": a tenant admin uploads a custom visual bundle (`.pbiviz`), which is
 * stored as a real blob in the DLZ ADLS `org-visuals` Blob container, and a
 * metadata document is written to the Cosmos `org-visuals` container (PK
 * /tenantId). Each visual carries a version and an enabled/disabled toggle that
 * controls tenant-wide availability. No Fabric / Power BI workspace dependency.
 */

export interface OrgVisualDoc {
  /** visualId (also the Cosmos document id). */
  id: string;
  /** Partition key — tenant (Entra oid) scope. */
  tenantId: string;
  /** Display name. */
  name: string;
  /** Original uploaded file name, e.g. "CustomBarChart.pbiviz". */
  fileName: string;
  /** Path within the `org-visuals` Blob container the bundle is stored at. */
  blobPath: string;
  /** Bundle byte size. */
  size: number;
  /** Semantic version, e.g. "1.0.0". */
  version: string;
  /** Tenant-wide availability toggle. */
  enabled: boolean;
  uploadedAt: string;
  /** UPN / email of the admin who uploaded the bundle. */
  uploadedBy: string;
  enabledAt?: string;
  enabledBy?: string;
}
