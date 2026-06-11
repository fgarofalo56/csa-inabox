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
import sovereignAiAgents from './app-sovereign-ai-agents';
import logicAppsIntegration from './app-logic-apps-integration';
import dataGovernance from './app-data-governance';
import realTimeDashboards from './app-real-time-dashboards';
import hybridTopology from './app-hybrid-topology';
import workspaceMonitoring from './app-workspace-monitoring';
import superchargeBronze from './app-supercharge-bronze';
import superchargeSilver from './app-supercharge-silver';
import superchargeGold from './app-supercharge-gold';
import superchargeMl from './app-supercharge-ml';
import superchargeStreaming from './app-supercharge-streaming';
import superchargeUtils from './app-supercharge-utils';
import superchargeGuide from './app-supercharge-guide';

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
  [superchargeBronze.appId]: superchargeBronze,
  [superchargeSilver.appId]: superchargeSilver,
  [superchargeGold.appId]: superchargeGold,
  [superchargeMl.appId]: superchargeMl,
  [superchargeStreaming.appId]: superchargeStreaming,
  [superchargeUtils.appId]: superchargeUtils,
  [superchargeGuide.appId]: superchargeGuide,
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
