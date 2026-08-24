/**
 * LOOM BRAIN — the graph substrate. Public surface.
 *
 * This is the import point for everything else in the Brain: detectors, the
 * agent layer, the cost layer, and the visualizer. The shared TYPE contract
 * lives one level up in `../types` and is re-exported here so a consumer needs
 * exactly one import path.
 *
 * ── THE SHAPE OF A DETECTOR ────────────────────────────────────────────────
 * PRP §0: a detector is a QUERY, not a bespoke rule. The founding finding —
 * `loom-capacity-broker`, minReplicas 2, healthy, internal FQDN, and
 * `LOOM_BROKER_URL: ''` — is this:
 *
 *     const unreachable = nodesWithNoInboundEdge(graph, 'configured', {
 *       resourceType: 'Microsoft.App/containerApps',
 *       describe: 'container apps',
 *     });
 *     const alwaysOn = alwaysOnNodes(graph, { resourceType: 'Microsoft.App/containerApps' });
 *     // the finding: in BOTH sets. the evidence:
 *     const why = graph.danglingEdgesIntendedFor(brokerId);
 *
 * and the same call finds every other member of that class. Read
 * `.population` before `.result` on every one of them — a query over an empty
 * set is green and blind, and `population.blind` is how you see it.
 *
 * ── NOTHING HERE MUTATES AZURE ─────────────────────────────────────────────
 * Every module under `lib/brain/graph` is pure: data in, data out. There is no
 * Azure client, no fetch, and no code path that could delete or scale a
 * resource. Per PRP §1 decision 1 the Brain recommends and a human approves, and
 * `RemediationProposal` in `../types` pins that in the type system.
 */

export * from '../types';

export {
  azureResourceNodeId,
  canonicalPath,
  codeModuleNodeId,
  deployArtifactNodeId,
  edgeId,
  edgeIdFromPersisted,
  loomItemNodeId,
  nodeIdFromPersisted,
} from './node-id';

export {
  alwaysOnNodes,
  buildGraph,
  danglingEdges,
  hasInboundOnly,
  makePopulation,
  nodesWithNoInboundEdge,
  scaleUnknownCount,
  type BrainGraph,
  type ReachabilityFilter,
} from './graph';

export {
  extractFromResourceGraph,
  LOOM_ESTATE_TAG_KEY,
  type ResourceGraphExtractionOptions,
  type ResourceGraphRow,
} from './extractors/resource-graph';

export { extractFromBicep, type BicepFileInput } from './extractors/bicep';

export {
  extractFromContainerAppEnv,
  type ContainerAppEnvEntry,
  type ContainerAppEnvInput,
} from './extractors/container-app-env';

export {
  extractFromSourceImports,
  type SourceImportOptions,
  type SourceModuleInput,
} from './extractors/source-imports';
