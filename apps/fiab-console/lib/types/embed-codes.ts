/**
 * F22 — Embed codes.
 *
 * Loom's Azure-native equivalent of Fabric's Admin-portal "Embed codes":
 * a tenant-scoped, signed, read-only URL to a published report / visual bundle
 * blob, generated with a Blob Storage USER-DELEGATION SAS (signed with the
 * Console UAMI's Microsoft Entra credentials — never the account key). No
 * Fabric / Power BI workspace dependency: the signed URL points at the DLZ
 * ADLS `org-visuals` Blob container.
 *
 * Each code record lives in the Cosmos `embed-codes` container (PK /tenantId).
 */

export type EmbedCodeStatus = 'active' | 'revoked';

export interface EmbedCodeDoc {
  /** embedCodeId (also the Cosmos document id). */
  id: string;
  /** Partition key — tenant (Entra oid) scope. */
  tenantId: string;
  /** Logical report / visual the code embeds (display label + blob path). */
  report: string;
  /** Blob path within the `org-visuals` container the SAS is scoped to. */
  blobPath: string;
  status: EmbedCodeStatus;
  /** The live user-delegation SAS URL. Empty string once revoked. */
  signedUrl: string;
  /** ISO timestamp the SAS expires (≤ 7 days out — Azure user-delegation max). */
  expiresAt: string;
  createdAt: string;
  /** UPN / email of the admin who created the code. */
  createdBy: string;
  revokedAt?: string;
  revokedBy?: string;
}
