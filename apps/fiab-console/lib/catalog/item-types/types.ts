/**
 * Shared item-type catalog types.
 *
 * Extracted VERBATIM from lib/catalog/fabric-item-types.ts so the per-category
 * item-types/<category>.ts modules and the barrel can share them without a
 * circular import. Re-exported from lib/catalog/fabric-item-types.ts so the
 * public API (import { FabricItemType, WorkloadCategory, ... }) is unchanged.
 */

export type WorkloadCategory =
  | 'Data Engineering'
  | 'Data Factory'
  | 'Data Warehouse'
  | 'Databases'
  | 'Real-Time Intelligence'
  | 'Data Science'
  | 'Fabric IQ'
  | 'Power BI'
  | 'APIs and functions'
  | 'Synapse Analytics'
  | 'Azure Databricks'
  | 'Azure Data Factory'
  | 'Streaming analytics'
  | 'Azure Data Lake Analytics'
  | 'Azure AI Foundry'
  | 'Azure SQL Database'
  | 'Azure Geoanalytics'
  | 'Azure Graph + Vector'
  | 'CSA Data Products'
  | 'Copilot Studio'
  | 'Power Platform'
  | 'AI & Agents'
  | 'Fabric Apps';

export interface LearnStep {
  title: string;
  body: string;
  /** Optional screenshot path under /public */
  screenshot?: string;
}

export interface LearnContent {
  /** 1-3 sentence overview shown on the Learn dialog's first pane. */
  overview: string;
  /** Numbered getting-started walkthrough — 3-5 steps. */
  steps: LearnStep[];
  /** Optional embed URL for an explainer video. */
  videoUrl?: string;
  /** Authoritative docs link (Microsoft Learn for Fabric/Azure concepts, Loom docs for Loom-only). */
  docsUrl?: string;
  /** Optional sample-data dataset suggestions. */
  sampleData?: string[];
}

export interface CreateConfigChoice {
  /** stable value persisted/forwarded; for `runtimes` this is a PipelineRuntime
   *  ('adf'|'synapse'|'fabric'); for `templates` this is a templateId resolved by
   *  lib/components/pipeline/templates/catalog.ts (or 'blank' for none). */
  value: string;
  label: string;
  desc: string;
  default?: boolean;        // exactly one per axis; the Azure-native one
  /** Wave-D EXTENSION (declared now, unused this wave): route this choice to a
   *  DIFFERENT head slug/editor. When set, the configure step creates an item of
   *  THIS slug instead of the dialog's head item. Lets one "Notebook"/"SQL
   *  database" head fan out to Spark/Synapse/Databricks or azure-sql/synapse-pool/
   *  postgres editors. Omitted (undefined) => use the head item's own slug, which
   *  is exactly the pipeline family's behavior. */
  slug?: string;
}

export interface CreateConfig {
  runtimes?: CreateConfigChoice[];   // -> forwarded as runtimePreset
  templates?: CreateConfigChoice[];  // -> forwarded as templateId
}

export interface FabricItemType {
  /** Route slug — used at /items/[slug]/[id] */
  slug: string;
  /** Display name shown in dialog + editor */
  displayName: string;
  /** REST API type name (matches Fabric REST `type` field) */
  restType: string;
  /** Short one-line summary for the New item dialog card */
  description: string;
  /** Workload category for grouping */
  category: WorkloadCategory;
  /** True when this is a preview-only item type */
  preview?: boolean;
  /**
   * True when this is a LABS / low-usage novelty item type. Labs items stay
   * fully functional (editor + provisioner + BFF routes all work) but are
   * HIDDEN from the default New-item gallery — they only appear when the user
   * flips the "Show Labs items" toggle. A "Labs" Badge marks them wherever
   * they render. Distinct from `preview` (which surfaces by default with a
   * Preview badge): labs = hidden-by-default novelty, not removed.
   */
  labs?: boolean;
  /** True when no Fabric REST API exists (Scorecard, Dataflow Gen1) */
  noRestApi?: boolean;
  /**
   * True when the item type is deprecated and NO create path should be shown.
   * The New item dialog filters these out; the editor surfaces a deprecated
   * MessageBar + a migration action instead of an authoring surface.
   */
  deprecated?: boolean;
  /**
   * True when the item type is a CORE Loom surface reached from a top-level nav
   * destination rather than created per-workspace. The New item dialog filters
   * these out (you don't "create a marketplace") but the editor/route still
   * works so the nav page can render it. Used by data-marketplace, which lives
   * under the unified Loom Marketplace (/marketplace).
   */
  coreSurface?: boolean;
  /** This slug is a DEDUP DUPLICATE consolidated into a canonical sibling (Wave-B catalog merge). The New-item gallery filters it out (you create the canonical one instead), BUT the slug stays fully resolvable — findItemType() returns it and its editor + per-item BFF routes keep working so ALREADY-CREATED instances still open. NEVER also delete the editor/routes an existing instance loads. Azure-native default per no-fabric-dependency.md. */
  hiddenFromGallery?: boolean;
  /**
   * This slug is an alias/preset of another item type; the editor + new-item flow
   * resolve to aliasOf's editor (the unified one), while this entry's own slug +
   * restType + per-item BFF routes stay intact for back-compat with already-created
   * items. See Wave-A catalog-merge (no-fabric-dependency.md): Azure-native default.
   */
  aliasOf?: string;
  /** When this item opens the unified pipeline editor, lock the runtime selector to this value. */
  runtimePreset?: 'adf' | 'synapse' | 'fabric';
  /**
   * This item is a TEMPLATE. templateOf names the PRIMARY head slug the user lands
   * in (page.tsx: applyTemplate = !!templateOf && isNew → effective editor =
   * findItemType(templateOf); already-created instances open their OWN editor for
   * back-compat). Two flavors of templateId resolve against two registries:
   *   • a pipeline-template id → seeds ONE pre-wired spec (PIPELINE_TEMPLATES in
   *     lib/components/pipeline/templates/catalog.ts), or
   *   • an app-template id → scaffolds MULTIPLE real, wired backing items
   *     server-side (app-templates registry + instantiation route). For the
   *     app-template flavor the dialog POSTs the route and routes to the returned
   *     primary item id, so the demote stays fully Azure-native + no-vaporware.
   */
  templateOf?: string;
  /** Template id — resolves via PIPELINE_TEMPLATES (single seeded spec) OR the
   *  app-templates registry (multi-item Azure-native scaffold, e.g.
   *  'slate-workshop-app', 'rayfin-azure-stack'). */
  templateId?: string;
  /** HIDDEN from the default browse grid, but STILL returned by search. Distinct
   *  from hiddenFromGallery (fully hidden everywhere). Use for consolidated
   *  presets/templates that fold into a single head item in browse, yet must stay
   *  findable by keyword ("adf"/"synapse"/"geo"). The slug stays fully resolvable
   *  (findItemType + the alias/template resolution in /items/[type]/[id]/page.tsx)
   *  so ALREADY-CREATED instances open unchanged. Azure-native default per
   *  no-fabric-dependency.md. */
  searchOnly?: boolean;
  /** Reusable create-step descriptor. When present, the New-item dialog's
   *  CONFIGURE step renders a RadioGroup/cards for each axis (no-freeform-config),
   *  then forwards the chosen runtimePreset + templateId into createItem -> editor.
   *  Items WITHOUT createConfig keep the current name-only inline create (no
   *  regression). The Azure-native option MUST be `default:true`; Fabric is opt-in
   *  only (never default) per no-fabric-dependency.md. */
  createConfig?: CreateConfig;
  /** Learn / Getting started popup content. Required for every type. */
  learnContent?: LearnContent;
}
