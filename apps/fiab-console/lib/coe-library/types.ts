/**
 * CoE Power BI report-template library — types.
 *
 * A default library of Cloud Center of Excellence (CoE) Power BI report
 * templates surfaced in the Organizational Visuals admin surface. Each template
 * is a version-controlled PBIP (PBIR report + TMDL semantic model) under
 * docs/fiab/org-visuals/coe-library/. Users preview a template and "Use this
 * template" to clone it into their own tenant collection for editing/publishing.
 *
 * Azure-native: templates query the customer's own Azure estate (Cost
 * Management, Azure Resource Graph, Log Analytics, Defender, Purview, Graph).
 * No real Microsoft Fabric / Power BI workspace is required to browse or clone;
 * publishing to Power BI is an explicit, opt-in admin action (publish script).
 */

export interface CoeTemplate {
  /** Stable id / slug, e.g. "cloud-cost-finops". */
  id: string;
  title: string;
  description: string;
  category: string;
  /** Always "pbip-report" for this library. */
  kind: string;
  /** Relative path (within the library) to a thumbnail SVG. */
  thumbnail: string;
  /** Relative path to the .pbip project file. */
  pbipPath: string;
  /** Relative path to the .Report folder. */
  reportPath: string;
  /** Relative path to the .SemanticModel folder. */
  semanticModelPath: string;
  /** Report page display names. */
  pages: string[];
  /** Count of DAX measures across the model. */
  measures: number;
  /** Azure data planes the template reads. */
  dataSources: string[];
  /** Azure / Graph roles required to refresh against live data. */
  requiredRoles: string[];
  /** Power Query parameters the cloned template prompts for. */
  parameters: string[];
  /** True — templates ship with clearly-labelled SAMPLE data until connected. */
  sampleData: boolean;
}

export interface CoeCatalog {
  $schema: string;
  version: string;
  generator: string;
  description: string;
  templates: CoeTemplate[];
}

/** A per-tenant clone of a CoE template, persisted in the `coe-templates` Cosmos container. */
export interface CoeTemplateCloneDoc {
  /** cloneId (also the Cosmos document id). */
  id: string;
  /** Partition key — tenant (Entra oid) scope. */
  tenantId: string;
  /** Source template id (slug). */
  templateId: string;
  /** Snapshot of the source title at clone time. */
  title: string;
  category: string;
  /** User-supplied display name for the clone (defaults to the title). */
  displayName: string;
  /** Number of PBIP files copied. */
  fileCount: number;
  /**
   * Path within the org-visuals Blob container the PBIP files were copied to,
   * when LOOM_ORG_VISUALS_URL is configured. Empty when the blob copy was
   * skipped (metadata-only clone) — see `blobCopied`.
   */
  blobPrefix: string;
  /** True when the PBIP bytes were copied into Blob (org-visuals configured). */
  blobCopied: boolean;
  status: 'cloned';
  clonedAt: string;
  clonedBy: string;
}
