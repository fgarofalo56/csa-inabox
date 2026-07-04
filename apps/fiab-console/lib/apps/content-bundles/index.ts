/**
 * Registry of per-app starter-content bundles.
 *
 * Imported by the install route to seed each Cosmos workspace item with
 * rich content (notebook cells, KQL queries, DDL, dbt models, dashboard
 * tiles, etc.) drawn from the corresponding reference architecture in
 * `examples/<industry>/` at build time.
 *
 * Bundles live in-process (no Cosmos round-trip per install). The Cosmos
 * apps-catalog still stores the lean shape `[{type, template}]` so that
 * doc size stays under the 2 MB Cosmos per-doc limit; the rich content
 * is applied client-side-of-Cosmos by the install route at create time.
 *
 * rel-T63 — LAZY PAYLOADS. The per-bundle content payloads total ~3.1 MB
 * (dominated by the Supercharge medallion notebook cells). They are NO LONGER
 * statically imported into the server module graph — each bundle is behind a
 * `() => import()` loader below, so its payload is a separate async chunk
 * fetched only when that bundle is actually installed / imported. `getBundle`
 * and the notebook helpers are therefore async. The LEAN catalog-list path
 * (apps-catalog seed + bootstrap) reads item types from the lightweight
 * `./bundle-items` manifest and NEVER loads a payload. `listBundleIds` /
 * `hasBundle` / `getBundleItemTypes` stay synchronous.
 */
import type { AppBundle, BundleItem, LakehouseContent } from './types';
import { BUNDLE_ITEM_TYPES } from './bundle-items';

// Lazy per-bundle payload loaders — one `() => import()` per bundle so webpack
// code-splits each payload into its own async chunk (keeps the ~3.1 MB out of
// the static server graph; loaded on demand). Keys are the bundle appIds (the
// 'app-<slug>' convention, matching the file name and CATALOG_META id). Named
// REGISTRY (not LOADERS) with the loader type behind a `BundleLoader` alias so
// the offline fixture-gen parser (scripts/csa-loom/gen-apps-catalog-fixture.mjs)
// that enumerates bundle ids from `const REGISTRY = { … }` keeps matching.
type BundleLoader = () => Promise<{ default: AppBundle }>;
const REGISTRY: Record<string, BundleLoader> = {
  'app-casino-analytics': () => import('./app-casino-analytics'),
  'app-iot-realtime': () => import('./app-iot-realtime'),
  'app-healthcare-popmgt': () => import('./app-healthcare-popmgt'),
  'app-fedramp-tracker': () => import('./app-fedramp-tracker'),
  'app-rag-builder': () => import('./app-rag-builder'),
  'app-pipeline-designer': () => import('./app-pipeline-designer'),
  'app-lakehouse-inspector': () => import('./app-lakehouse-inspector'),
  'app-data-steward': () => import('./app-data-steward'),
  'app-finops-cost': () => import('./app-finops-cost'),
  'app-fabric-mirror-onboard': () => import('./app-fabric-mirror-onboard'),
  'app-change-feed-processor': () => import('./app-change-feed-processor'),
  'app-direct-lake-replacement': () => import('./app-direct-lake-replacement'),
  'app-federal-data-mesh': () => import('./app-federal-data-mesh'),
  'app-ml-pipeline': () => import('./app-ml-pipeline'),
  'app-multi-agency-onboarding': () => import('./app-multi-agency-onboarding'),
  'app-azure-realtime-analytics': () => import('./app-azure-realtime-analytics'),
  'app-sovereign-ai-agents': () => import('./app-sovereign-ai-agents'),
  'app-logic-apps-integration': () => import('./app-logic-apps-integration'),
  'app-data-governance': () => import('./app-data-governance'),
  'app-real-time-dashboards': () => import('./app-real-time-dashboards'),
  'app-hybrid-topology': () => import('./app-hybrid-topology'),
  'app-workspace-monitoring': () => import('./app-workspace-monitoring'),
  'app-supercharge-bronze': () => import('./app-supercharge-bronze'),
  'app-supercharge-silver': () => import('./app-supercharge-silver'),
  'app-supercharge-gold': () => import('./app-supercharge-gold'),
  'app-supercharge-ml': () => import('./app-supercharge-ml'),
  'app-supercharge-streaming': () => import('./app-supercharge-streaming'),
  'app-supercharge-utils': () => import('./app-supercharge-utils'),
  'app-supercharge-guide': () => import('./app-supercharge-guide'),
};

/** All registered bundle appIds. Synchronous — never loads a payload. */
export function listBundleIds(): string[] {
  return Object.keys(REGISTRY);
}

/**
 * Does a bundle with this appId exist? Synchronous existence check that does
 * NOT load the (heavy) payload — use this where you only need to know whether a
 * bundle is registered (e.g. the Learn-catalog "installable" gate), never the
 * `getBundle` promise.
 */
export function hasBundle(appId: string): boolean {
  return Object.prototype.hasOwnProperty.call(REGISTRY, appId);
}

/**
 * Lean, ordered item-type list for a bundle (with duplicates preserved) drawn
 * from the lightweight `./bundle-items` manifest. Synchronous — does NOT load
 * the payload. This is what the apps-catalog seed + bootstrap use to build each
 * catalog doc's `items:[{type, template}]` array without pulling 3.1 MB of
 * content into the list route.
 */
export function getBundleItemTypes(appId: string): string[] {
  return BUNDLE_ITEM_TYPES[appId] ?? [];
}

/**
 * Resolve a bundle's FULL payload (all item content). Async — dynamically
 * imports the bundle's chunk on demand. Returns undefined for an unregistered
 * appId.
 */
export async function getBundle(appId: string): Promise<AppBundle | undefined> {
  const loader = REGISTRY[appId];
  if (!loader) return undefined;
  const mod = await loader();
  return mod.default;
}

/**
 * Resolve the rich content for a single ref `{ type, template?, displayName? }`
 * from Cosmos against an app's bundle. Returns undefined if the bundle is not
 * registered or the type isn't part of the bundle.
 *
 * When a bundle ships MORE THAN ONE item of the same `itemType` (e.g. the
 * logic-apps-integration bundle has three distinct `logic-app` workflows —
 * Order Intake, Nightly Invoice Sync, Support Ticket Triage), matching on
 * `itemType` alone collapses every one of them onto the FIRST item, so all
 * copies install with the same displayName AND the same WDL `content`. To
 * disambiguate, the install path passes the per-ref `displayName`; when given
 * we match on (itemType, displayName) so each distinct workflow keeps its own
 * name and data-bearing content. Falls back to itemType-only match (legacy
 * behaviour) when no displayName is supplied.
 */
export async function resolveBundleItem(
  appId: string,
  itemType: string,
  displayName?: string,
): Promise<{ displayName: string; description: string; content: unknown; learnDoc?: string } | undefined> {
  const b = await getBundle(appId);
  if (!b) return undefined;
  const ofType = b.items.filter((i) => i.itemType === itemType);
  if (ofType.length === 0) return undefined;
  // Disambiguate by displayName when the bundle has multiple items of this
  // type and the caller told us which one this ref is.
  const match =
    (displayName && ofType.find((i) => i.displayName === displayName)) ||
    ofType[0];
  return {
    displayName: match.displayName,
    description: match.description,
    content: match.content,
    learnDoc: match.learnDoc,
  };
}

/** Item types whose bundle content is a NotebookContent (Synapse Spark /
 * Databricks / Fabric notebooks). The notebook-import wizard offers exactly
 * these as importable prebuilt notebooks. */
export const NOTEBOOK_ITEM_TYPES = ['notebook', 'databricks-notebook', 'synapse-notebook'] as const;

/** Does a lakehouse BundleItem carry seedable sample rows? */
function lakehouseHasSampleData(item: BundleItem): boolean {
  if (item.itemType !== 'lakehouse') return false;
  const c = item.content as LakehouseContent;
  if (c?.kind !== 'lakehouse') return false;
  return (c.deltaTables || []).some((t) => Array.isArray(t.sampleRows) && t.sampleRows.length > 0);
}

/** A single prebuilt notebook the Learning-Hub import wizard can offer. */
export interface NotebookImportOption {
  /** The owning app bundle id (used to also seed its sample-data lakehouses). */
  bundleId: string;
  /** Friendly bundle label (the app id, humanised — bundles carry no name). */
  bundleLabel: string;
  /** The notebook item's displayName — disambiguates bundles with >1 notebook. */
  notebookDisplayName: string;
  /** notebook | databricks-notebook | synapse-notebook. */
  itemType: string;
  description: string;
  /** Cell count, surfaced in the picker so the user sees notebook depth. */
  cellCount: number;
  /** True when the bundle ships at least one lakehouse with sample rows the
   * "with sample data" option can seed into ADLS Delta. */
  hasSampleData: boolean;
}

/** Humanise an app bundle id (`app-ml-pipeline` → `ML Pipeline`) for display. */
function humaniseBundleId(appId: string): string {
  return appId
    .replace(/^app-/, '')
    .split('-')
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/**
 * Enumerate every prebuilt notebook across all registered bundles, flagging
 * which bundles can additionally seed real ADLS sample data. Drives the
 * Learning-Hub notebook-import wizard's picker. Real registry data — no mocks.
 *
 * Async: loads each bundle's payload (the wizard needs cell counts + sample-data
 * flags). Only the Learning-Hub wizard GET calls this, not any hot path.
 */
export async function listNotebookImports(): Promise<NotebookImportOption[]> {
  const out: NotebookImportOption[] = [];
  for (const appId of Object.keys(REGISTRY)) {
    const b = await getBundle(appId);
    if (!b) continue;
    const hasSampleData = b.items.some(lakehouseHasSampleData);
    for (const item of b.items) {
      if (!(NOTEBOOK_ITEM_TYPES as readonly string[]).includes(item.itemType)) continue;
      const cells = (item.content as { cells?: unknown[] })?.cells;
      out.push({
        bundleId: b.appId,
        bundleLabel: humaniseBundleId(b.appId),
        notebookDisplayName: item.displayName,
        itemType: item.itemType,
        description: item.description,
        cellCount: Array.isArray(cells) ? cells.length : 0,
        hasSampleData,
      });
    }
  }
  return out;
}

/**
 * Return a bundle's notebook BundleItems (optionally filtered to one by
 * displayName). Used by the import route to resolve the exact notebook the
 * wizard picked without the resolveBundleItem() first-of-type fallback.
 * Async — loads the bundle payload on demand. */
export async function getBundleNotebooks(appId: string, displayName?: string): Promise<BundleItem[]> {
  const b = await getBundle(appId);
  if (!b) return [];
  const nbs = b.items.filter((i) => (NOTEBOOK_ITEM_TYPES as readonly string[]).includes(i.itemType));
  if (displayName) return nbs.filter((i) => i.displayName === displayName);
  return nbs;
}

/**
 * Return a bundle's lakehouse BundleItems that carry seedable sample rows.
 * The "with sample data" import path provisions these alongside the notebook
 * so the lakehouse provisioner writes the real CSVs into ADLS Delta.
 * Async — loads the bundle payload on demand. */
export async function getSampleDataLakehouses(appId: string): Promise<BundleItem[]> {
  const b = await getBundle(appId);
  if (!b) return [];
  return b.items.filter(lakehouseHasSampleData);
}
