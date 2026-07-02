/**
 * App-template registry — multi-item scaffold specs for demoted "app" tiles.
 *
 * Background
 * ----------
 * Waves A/C demoted a few catalog tiles to *templates* of a richer head item
 * using the catalog fields `templateOf` / `templateId` / `searchOnly`. For
 * PIPELINE-flavored demotes (e.g. geo-pipeline) `templateId` resolves against
 * PIPELINE_TEMPLATES (lib/components/pipeline/templates/catalog.ts) and seeds a
 * SINGLE head item — the head editor merges one spec into its canvas.
 *
 * APP-flavored demotes need more than that. A "Slate app" or a "Rayfin app" is
 * not one editable spec — it is a small SYSTEM of real, individually-runnable
 * Loom items (a web tier + an API + a store, etc.). Demoting such a tile to a
 * single seeded head would be a placeholder shell, which `no-vaporware.md`
 * forbids. So app-templates extend the same mechanism but describe MULTIPLE
 * real backing items plus the wiring between them.
 *
 * How it is consumed
 * ------------------
 * - The New-item dialog imports THIS module (client-safe — see below). When the
 *   picked entry's `templateId` satisfies `isAppTemplate(...)`, the dialog POSTs
 *   a server-side instantiation route instead of the single-item create path.
 * - That route (server-only; it imports createOwnedItem / updateOwnedItem /
 *   getSession) walks `items[]`, calls createOwnedItem per item with its
 *   `seedState`, then applies each item's `bindings[]` via updateOwnedItem to
 *   wire siblings together. It returns the created PRIMARY item's id, and the
 *   dialog routes the user to that real item's own editor.
 * - Every scaffolded item is a REAL, editable/runnable Loom item — not a copy
 *   of a bundle and not a placeholder.
 *
 * Azure-native (no-fabric-dependency.md)
 * --------------------------------------
 * Every slug scaffolded here is Azure-native by default: workshop-app runs on
 * Azure Container Apps over an ontology Synapse warehouse; data-api-builder is
 * DAB on ACA; user-data-function is Azure Functions; azure-cosmos-account is
 * Cosmos; slate-app generates an Azure Static Web Apps bundle. No Fabric or
 * Power BI workspace is required on the default path, and any unprovisioned
 * Azure runtime surfaces each editor's existing honest MessageBar gate while
 * the full UI still renders.
 *
 * Back-compat
 * -----------
 * slate-app / rayfin-app keep their slug, restType, per-item BFF routes, and
 * registry editors. Existing instances open at /items/<slug>/<id> (isNew=false)
 * → their own editor, unchanged. Direct navigation to /items/<slug>/new still
 * opens that slug's OWN create editor (page.tsx forces applyTemplate=false when
 * the item carries an app-template id). New gallery picks flow through the
 * instantiation route to the scaffolded primary's real id and never land on a
 * head editor with an unknown templateId.
 *
 * TypeScript / bundling
 * ---------------------
 * This module is PURE DATA + string helpers. It deliberately imports nothing
 * (no @fluentui, no next, no cosmos, no server code) so it tree-shakes cleanly
 * into the client dialog without dragging server-only modules into the browser
 * bundle.
 *
 * Design note on `role`
 * ---------------------
 * The original sketch typed `role` as the union 'primary' | 'backing'. That is
 * ambiguous for templates with MORE THAN ONE backing item (rayfin-azure-stack
 * has both a Cosmos store and a Functions API), because a binding's `fromRole`
 * could match either backing. So `role` is a STABLE, UNIQUE token per item
 * within a template (e.g. 'data-api', 'app', 'cosmos', 'functions', 'web') and
 * a separate boolean `primary` marks the single landing item. `fromRole` in a
 * binding references a sibling's `role` token and therefore resolves
 * unambiguously.
 */

/** Which computed field of a created sibling item a binding reads. */
export type AppTemplateBindingField = 'id' | 'apiBaseUrl' | 'restBase';

/**
 * One sibling-wiring assignment, applied AFTER every item in the template has
 * been created. Reads `fromField` of the item whose `role` === `fromRole` and
 * writes it onto THIS item's `state[stateKey]`.
 */
export interface AppTemplateBinding {
  /** state key written on the item that owns this binding */
  stateKey: string;
  /** stable `role` token of the sibling item to read from */
  fromRole: string;
  /** which computed field of the sibling to read */
  fromField: AppTemplateBindingField;
}

/**
 * A single real Loom item to scaffold as part of an app template.
 */
export interface AppTemplateScaffoldItem {
  /** catalog slug of the item type to create (must exist in FABRIC_ITEM_TYPES) */
  slug: string;
  /**
   * Stable, unique token for this item WITHIN its template. Bindings reference
   * it via `fromRole`. (Not the catalog slug — two items could share a slug.)
   */
  role: string;
  /** true for exactly one item per template — the item the user lands on. */
  primary: boolean;
  /** appended to the template-instance display name for this item ('' = none). */
  nameSuffix: string;
  /** optional state merged into the created item (editors have honest fallbacks). */
  seedState?: Record<string, unknown>;
  /** sibling field wiring applied after all items are created. */
  bindings?: AppTemplateBinding[];
}

/**
 * A push-button app template: a set of real backing items + their wiring, all
 * created atomically server-side by the instantiation route.
 */
export interface AppTemplate {
  /** template id — matched against a catalog entry's `templateId`. */
  id: string;
  /** gallery / dialog title. */
  title: string;
  /** one-line description (Azure-native framing). */
  description: string;
  /** the primary item's slug — where the user lands after instantiate. */
  primarySlug: string;
  /** real items to scaffold; exactly one must have `primary: true`. */
  items: AppTemplateScaffoldItem[];
}

export const APP_TEMPLATES: AppTemplate[] = [
  // ── slate-app demote ──────────────────────────────────────────────────
  //
  // Creates a runnable Workshop low-code app (primary) bound to a REAL Data
  // API surface (backing). The user lands in the Workshop editor already wired
  // to the Data API. Azure-native: workshop-app runs on Azure Container Apps
  // over an ontology's Synapse warehouse, data-api-builder is DAB on ACA — no
  // Fabric workspace. Wiring is bidirectional so lineage/back-references are
  // accurate: the app points at the API, and the API records the app it backs.
  {
    id: 'slate-workshop-app',
    title: 'Workshop app + Data API',
    description:
      'Scaffold a runnable Workshop low-code app wired to a real Data API query ' +
      'surface. Azure-native (Workshop on Azure Container Apps over an ontology ' +
      'Synapse warehouse, Data API builder on ACA) — no Microsoft Fabric required.',
    primarySlug: 'workshop-app',
    items: [
      {
        slug: 'data-api-builder',
        role: 'data-api',
        primary: false,
        nameSuffix: ' — Data API',
        seedState: {
          dataSourceType: 'mssql',
          connectionStringRef: '@env("LOOM_SQL_CONNECTION_STRING")',
          entities: [],
        },
        // Back-reference so the Data API knows which app it backs.
        bindings: [{ stateKey: 'appItemId', fromRole: 'app', fromField: 'id' }],
      },
      {
        slug: 'workshop-app',
        role: 'app',
        primary: true,
        nameSuffix: '',
        bindings: [
          { stateKey: 'dataApiItemId', fromRole: 'data-api', fromField: 'id' },
          { stateKey: 'dataApiBaseUrl', fromRole: 'data-api', fromField: 'restBase' },
        ],
      },
    ],
  },

  // ── rayfin-app demote ─────────────────────────────────────────────────
  //
  // Azure-native parity for the Fabric-only Rayfin runtime: an Azure Static Web
  // Apps web tier (primary) backed by an Azure Functions API and a Cosmos
  // store — the Functions+Cosmos+SWA stack the user can actually run. No Fabric
  // / Power BI dependency. Wiring: the Functions API points at the Cosmos
  // store; the web tier points at the Functions API (and keeps the SWA `/api`
  // linked-backend convention as its apiBaseUrl).
  {
    id: 'rayfin-azure-stack',
    title: 'Rayfin app (Azure stack)',
    description:
      'Scaffold the Azure-native Rayfin stack: an Azure Static Web Apps web tier ' +
      'backed by an Azure Functions API and an Azure Cosmos DB store — a runnable ' +
      'Functions + Cosmos + SWA app with no Microsoft Fabric dependency.',
    primarySlug: 'slate-app',
    items: [
      {
        slug: 'azure-cosmos-account',
        role: 'cosmos',
        primary: false,
        nameSuffix: ' — Cosmos store',
      },
      {
        slug: 'user-data-function',
        role: 'functions',
        primary: false,
        nameSuffix: ' — Functions API',
        seedState: {
          runtime: 'python',
          entrypoint: 'main',
        },
        // The Functions API reads/writes the scaffolded Cosmos store.
        bindings: [{ stateKey: 'cosmosItemId', fromRole: 'cosmos', fromField: 'id' }],
      },
      {
        slug: 'slate-app',
        role: 'web',
        primary: true,
        nameSuffix: ' — Web app',
        // '/api' is the Azure Static Web Apps convention for a linked Functions
        // backend; the editor's honest gate covers an undeployed runtime.
        seedState: {
          apiBaseUrl: '/api',
          widgets: [],
        },
        bindings: [{ stateKey: 'functionItemId', fromRole: 'functions', fromField: 'id' }],
      },
    ],
  },
];

/** All registered app-template ids (used by the dialog to branch the create path). */
export const APP_TEMPLATE_IDS: readonly string[] = APP_TEMPLATES.map((t) => t.id);

/** Resolve an app template by id, or undefined when it is not one. */
export function findAppTemplate(id: string): AppTemplate | undefined {
  return APP_TEMPLATES.find((t) => t.id === id);
}

/** True when `id` names a registered app template. */
export function isAppTemplate(id: string | undefined | null): boolean {
  return typeof id === 'string' && APP_TEMPLATE_IDS.includes(id);
}
