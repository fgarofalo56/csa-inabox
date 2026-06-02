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
import type { AppBundle } from './types';

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
};

export function getBundle(appId: string): AppBundle | undefined {
  return REGISTRY[appId];
}

export function listBundleIds(): string[] {
  return Object.keys(REGISTRY);
}

/**
 * Resolve the rich content for a single ref `{ type, template? }` from
 * Cosmos against an app's bundle. Returns undefined if the bundle is not
 * registered or the type isn't part of the bundle.
 */
export function resolveBundleItem(
  appId: string,
  itemType: string,
): { displayName: string; description: string; content: unknown; learnDoc?: string } | undefined {
  const b = REGISTRY[appId];
  if (!b) return undefined;
  const match = b.items.find((i) => i.itemType === itemType);
  if (!match) return undefined;
  return {
    displayName: match.displayName,
    description: match.description,
    content: match.content,
    learnDoc: match.learnDoc,
  };
}
