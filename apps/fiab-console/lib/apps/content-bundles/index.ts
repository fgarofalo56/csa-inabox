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
 */
import type { AppBundle, BundleItem, LakehouseContent } from './types';

import casinoAnalytics from './app-casino-analytics';
import iotRealtime from './app-iot-realtime';
import healthcarePopmgt from './app-healthcare-popmgt';
import fedrampTracker from './app-fedramp-tracker';
import ragBuilder from './app-rag-builder';
import pipelineDesigner from './app-pipeline-designer';
import lakehouseInspector from './app-lakehouse-inspector';
import dataSteward from './app-data-steward';
import finopsCost from './app-finops-cost';
import fabricMirrorOnboard from './app-fabric-mirror-onboard';
import changeFeedProcessor from './app-change-feed-processor';
import directLakeReplacement from './app-direct-lake-replacement';
import federalDataMesh from './app-federal-data-mesh';
import mlPipeline from './app-ml-pipeline';
import multiAgencyOnboarding from './app-multi-agency-onboarding';
import azureRealtimeAnalytics from './app-azure-realtime-analytics';
import sovereignAiAgents from './app-sovereign-ai-agents';
import logicAppsIntegration from './app-logic-apps-integration';
import dataGovernance from './app-data-governance';
import realTimeDashboards from './app-real-time-dashboards';
import hybridTopology from './app-hybrid-topology';
import workspaceMonitoring from './app-workspace-monitoring';

const REGISTRY: Record<string, AppBundle> = {
  [casinoAnalytics.appId]: casinoAnalytics,
  [iotRealtime.appId]: iotRealtime,
  [healthcarePopmgt.appId]: healthcarePopmgt,
  [fedrampTracker.appId]: fedrampTracker,
  [ragBuilder.appId]: ragBuilder,
  [pipelineDesigner.appId]: pipelineDesigner,
  [lakehouseInspector.appId]: lakehouseInspector,
  [dataSteward.appId]: dataSteward,
  [finopsCost.appId]: finopsCost,
  [fabricMirrorOnboard.appId]: fabricMirrorOnboard,
  [changeFeedProcessor.appId]: changeFeedProcessor,
  [directLakeReplacement.appId]: directLakeReplacement,
  [federalDataMesh.appId]: federalDataMesh,
  [mlPipeline.appId]: mlPipeline,
  [multiAgencyOnboarding.appId]: multiAgencyOnboarding,
  [azureRealtimeAnalytics.appId]: azureRealtimeAnalytics,
  [sovereignAiAgents.appId]: sovereignAiAgents,
  [logicAppsIntegration.appId]: logicAppsIntegration,
  [dataGovernance.appId]: dataGovernance,
  [realTimeDashboards.appId]: realTimeDashboards,
  [hybridTopology.appId]: hybridTopology,
  [workspaceMonitoring.appId]: workspaceMonitoring,
};

export function getBundle(appId: string): AppBundle | undefined {
  return REGISTRY[appId];
}

export function listBundleIds(): string[] {
  return Object.keys(REGISTRY);
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
export function resolveBundleItem(
  appId: string,
  itemType: string,
  displayName?: string,
): { displayName: string; description: string; content: unknown; learnDoc?: string } | undefined {
  const b = REGISTRY[appId];
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
 */
export function listNotebookImports(): NotebookImportOption[] {
  const out: NotebookImportOption[] = [];
  for (const b of Object.values(REGISTRY)) {
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
 * wizard picked without the resolveBundleItem() first-of-type fallback. */
export function getBundleNotebooks(appId: string, displayName?: string): BundleItem[] {
  const b = REGISTRY[appId];
  if (!b) return [];
  const nbs = b.items.filter((i) => (NOTEBOOK_ITEM_TYPES as readonly string[]).includes(i.itemType));
  if (displayName) return nbs.filter((i) => i.displayName === displayName);
  return nbs;
}

/**
 * Return a bundle's lakehouse BundleItems that carry seedable sample rows.
 * The "with sample data" import path provisions these alongside the notebook
 * so the lakehouse provisioner writes the real CSVs into ADLS Delta. */
export function getSampleDataLakehouses(appId: string): BundleItem[] {
  const b = REGISTRY[appId];
  if (!b) return [];
  return b.items.filter(lakehouseHasSampleData);
}
