/**
 * LOOM BRAIN ACTIONS — shared test fixtures (#4242).
 *
 * A structurally COMPLETE `BrainSnapshot` whose defaults are the happy path:
 * complete collection, ownership confirmed on a fresh tag read, a non-vacuous
 * detector with a non-blind population over a graph that holds `configured`
 * edges, and a Container App subject with full ARM coordinates. Every guard
 * test then breaks exactly ONE of those properties, so a passing arm and its
 * refusal arm differ by a single field — which is what makes "this guard is
 * the thing being tested" true rather than asserted.
 *
 * NO REAL IDENTIFIERS: synthetic subscription GUID, no tenant or real resource
 * id anywhere (public repository).
 */

import type {
  BrainSnapshot,
  CollectionReport,
  ProvenanceCoverage,
  WireDetectorRun,
  WireFinding,
  WireNode,
} from '@/app/api/admin/brain/_lib/wire';
import type { Population } from '@/lib/brain/graph';

export const SUB = '00000000-0000-4000-8000-000000000001';
export const RG = 'rg-loom';
export const APP_NAME = 'loom-capacity-broker';
/** Node ids are `azure:` + the lowercased ARM id (lib/brain/graph/node-id). */
export const NODE_ID =
  `azure:/subscriptions/${SUB}/resourcegroups/${RG}` +
  `/providers/microsoft.app/containerapps/${APP_NAME}`;
export const DETECTOR = 'unreachable-always-on';
export const FINDING_ID = `${DETECTOR}:${NODE_ID}`;

export function population(overrides: Partial<Population> = {}): Population {
  return {
    subject: 'nodes',
    examined: 4,
    edgesExamined: 6,
    scope: '4 azure-resource nodes of type Microsoft.App/containerApps',
    blind: false,
    byProvenance: { declared: 0, configured: 3, imports: 0, observed: 0, owns: 2 },
    ...overrides,
  };
}

export function wireNode(overrides: Partial<WireNode> = {}): WireNode {
  return {
    id: NODE_ID,
    kind: 'azure-resource',
    displayName: APP_NAME,
    resourceType: 'Microsoft.App/containerApps',
    subscriptionId: SUB,
    resourceGroup: RG,
    location: 'centralus',
    provisioningState: 'Succeeded',
    scale: { minReplicas: 2, maxReplicas: 5, cpu: 0.5, memory: '1Gi', source: 'resource-graph' },
    ingress: { external: false, fqdn: 'broker.internal.example', targetPort: 8080 },
    tags: { 'loom-estate-id': 'estate-1' },
    inboundByProvenance: { declared: 0, configured: 0, imports: 0, observed: 0, owns: 1 },
    outboundTotal: 0,
    unreachableConfigured: true,
    alwaysOn: true,
    scaleMeasured: true,
    ownershipConfirmed: true,
    danglingIntendedFor: 1,
    ...overrides,
  };
}

export function wireFinding(overrides: Partial<WireFinding> = {}): WireFinding {
  return {
    id: FINDING_ID,
    detector: DETECTOR,
    severity: 'high',
    title: `${APP_NAME} is always-on and unreachable`,
    summary: `'${APP_NAME}' runs 2 always-on replica(s) and nothing points at it.`,
    subjects: [NODE_ID],
    confidence: 'medium',
    remediation: {
      kind: 'proposal',
      summary: `Scale '${APP_NAME}' to minReplicas 0, or wire its consumer.`,
      proposedChange: '# scale: { minReplicas: 0, maxReplicas: 5 }',
      requiresHumanApproval: true,
      mutatesAzure: false,
    },
    population: population(),
    evidence: {
      nodes: [NODE_ID],
      edges: [],
      query: "nodesWithNoInboundEdge(graph, 'configured') INTERSECT alwaysOnNodes(graph)",
      notes: ['zero inbound RESOLVED configured edges'],
    },
    ownershipConfirmed: true,
    ...overrides,
  };
}

export function detectorRun(overrides: Partial<WireDetectorRun> = {}): WireDetectorRun {
  return {
    detector: DETECTOR,
    findingCount: 1,
    population: population(),
    skipped: [],
    vacuous: false,
    ...overrides,
  };
}

function cov(collected: boolean, edgeCount: number, note: string): ProvenanceCoverage {
  return { collected, edgeCount, note };
}

export function collectionReport(overrides: Partial<CollectionReport> = {}): CollectionReport {
  return {
    rowsFetched: 40,
    totalRecords: 40,
    pages: 1,
    complete: true,
    subscriptionsSeen: 2,
    containerApps: 4,
    containerAppJobs: 0,
    managedEnvironments: 1,
    envEntriesRead: 12,
    envEntriesEmpty: 1,
    envEntriesSecretRef: 2,
    durationMs: 1200,
    ...overrides,
  };
}

export function brainSnapshot(overrides: Partial<BrainSnapshot> = {}): BrainSnapshot {
  return {
    generatedAt: '2026-08-31T00:00:00.000Z',
    nodes: [wireNode()],
    edges: [],
    findings: [wireFinding()],
    detectors: [detectorRun()],
    coverage: {
      declared: cov(false, 0, 'bicep is not collected at runtime'),
      configured: cov(true, 3, 'live container-app env wires'),
      imports: cov(false, 0, 'source imports are not collected at runtime'),
      observed: cov(false, 0, 'telemetry is not collected yet'),
      owns: cov(true, 2, 'ownership tags read fresh from Resource Graph'),
    },
    ownership: {
      confirmed: 1,
      examined: 4,
      indeterminate: 0,
      blind: false,
      note: 'owns edges present for this estate',
    },
    collection: collectionReport(),
    nodesByKind: { 'azure-resource': 4, 'loom-item': 0, 'deploy-artifact': 0, 'code-module': 0 },
    edgesByProvenance: { declared: 0, configured: 3, imports: 0, observed: 0, owns: 2 },
    edgesByResolution: { resolved: 5, dangling: 1 },
    skipped: [],
    cloud: 'AzureCloud',
    ...overrides,
  };
}
