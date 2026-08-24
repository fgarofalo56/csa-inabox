/**
 * LOOM BRAIN — assemble THE SNAPSHOT.
 *
 * One Resource Graph pull -> one graph -> one detector sweep -> one payload.
 * The canvas and the recommendations list are two renderings of the object this
 * module returns, which is the mechanism behind PRP §3.6's claim that "the
 * picture and the analysis cannot disagree". See `./wire.ts` for why that is a
 * property of the architecture rather than a promise.
 *
 * ── VERDICTS ARE COMPUTED HERE, ONCE ───────────────────────────────────────
 * `unreachableConfigured`, `alwaysOn`, `ownershipConfirmed` and the inbound
 * edge tallies are all computed server-side and shipped as data. The client
 * never recounts edges. If it did, it would have to re-implement the
 * resolved/dangling exclusion (P2) in a second place — and the second
 * implementation is the one that drifts, silently, in the direction of "this
 * node looks reachable".
 *
 * ── READ-ONLY ──────────────────────────────────────────────────────────────
 * The only Azure call in the tree below is the ARG query. Nothing here can
 * create, scale or delete a resource.
 */

import {
  EDGE_PROVENANCES,
  isDanglingEdge,
  type AzureResourceNode,
  type BrainGraphView,
  type EdgeProvenance,
  type NodeId,
} from '@/lib/brain/graph';
import { collectEstate, ESTATE_QUERY_TEXT, type CollectionResult } from './arg-collect';
import { runDetectors } from './detect';
import { buildLiveGraph } from './live-graph';
import type { BrainSnapshot, WireEdge, WireNode } from './wire';

function zeroProvenance(): Record<EdgeProvenance, number> {
  return { declared: 0, configured: 0, imports: 0, observed: 0, owns: 0 };
}

/** Inbound RESOLVED edges per node, per provenance. Dangling never counts. */
function inboundTallies(graph: BrainGraphView): Map<string, Record<EdgeProvenance, number>> {
  const m = new Map<string, Record<EdgeProvenance, number>>();
  for (const n of graph.nodes) m.set(n.id as string, zeroProvenance());
  for (const e of graph.edges) {
    if (e.resolution !== 'resolved') continue;
    const t = m.get(e.to as string);
    if (t) t[e.provenance] += 1;
  }
  return m;
}

function outboundTallies(graph: BrainGraphView): Map<string, number> {
  const m = new Map<string, number>();
  for (const n of graph.nodes) m.set(n.id as string, 0);
  for (const e of graph.edges) {
    if (e.resolution !== 'resolved') continue;
    m.set(e.from as string, (m.get(e.from as string) ?? 0) + 1);
  }
  return m;
}

function danglingIntendedTallies(graph: BrainGraphView): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of graph.edges) {
    if (!isDanglingEdge(e) || e.intendedTo === null) continue;
    const k = e.intendedTo as string;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

/**
 * Build a snapshot from ALREADY-COLLECTED rows.
 *
 * Split from {@link loadSnapshot} so every step after the network call is a
 * pure function of its input — which is what makes the acceptance test
 * (`loom-capacity-broker` surfaces as unreachable, always-on, with its evidence
 * chain) runnable with no Azure tenant.
 */
export function snapshotFromCollection(
  collection: CollectionResult,
  opts?: { readonly estateId?: string; readonly now?: () => Date },
): BrainSnapshot {
  const now = opts?.now ?? (() => new Date());
  const live = buildLiveGraph(collection.rows, {
    ...(opts?.estateId ? { estateId: opts.estateId } : {}),
  });
  const { graph, coverage, ownership } = live;

  const owned = new Set<string>();
  for (const e of graph.edges) {
    if (e.provenance === 'owns' && e.resolution === 'resolved') owned.add(e.to as string);
  }

  const inbound = inboundTallies(graph);
  const outbound = outboundTallies(graph);
  const danglingFor = danglingIntendedTallies(graph);

  const nodes: WireNode[] = graph.nodes.map((n) => {
    const key = n.id as string;
    const inb = inbound.get(key) ?? zeroProvenance();
    const azure = n.kind === 'azure-resource' ? (n as AzureResourceNode) : undefined;
    return {
      id: key,
      kind: n.kind,
      displayName: n.displayName,
      ...(azure?.resourceType ? { resourceType: azure.resourceType } : {}),
      ...(azure?.subscriptionId ? { subscriptionId: azure.subscriptionId } : {}),
      ...(azure?.resourceGroup ? { resourceGroup: azure.resourceGroup } : {}),
      ...(azure?.location ? { location: azure.location } : {}),
      ...(azure?.provisioningState ? { provisioningState: azure.provisioningState } : {}),
      ...(azure?.scale ? { scale: azure.scale } : {}),
      ...(azure?.ingress ? { ingress: azure.ingress } : {}),
      tags: azure ? azure.tags : null,
      ...(azure?.tagsError ? { tagsError: azure.tagsError } : {}),
      inboundByProvenance: inb,
      outboundTotal: outbound.get(key) ?? 0,
      unreachableConfigured: inb.configured === 0,
      // `false` when scale was NOT MEASURED. `scaleMeasured` carries that
      // distinction so a renderer can show "unknown" rather than "scales to zero".
      alwaysOn: azure?.scale !== undefined && azure.scale.minReplicas > 0,
      scaleMeasured: azure?.scale !== undefined,
      ownershipConfirmed: owned.has(key),
      danglingIntendedFor: danglingFor.get(key) ?? 0,
    };
  });

  const edges: WireEdge[] = graph.edges.map((e) => ({
    id: e.id as string,
    provenance: e.provenance,
    from: e.from as string,
    to: e.to === null ? null : (e.to as string),
    resolution: e.resolution,
    ...(isDanglingEdge(e) ? { danglingReason: e.danglingReason } : {}),
    ...(isDanglingEdge(e)
      ? { intendedTo: e.intendedTo === null ? null : (e.intendedTo as NodeId as string) }
      : {}),
    evidence: e.evidence,
  }));

  const { findings, runs } = runDetectors({ graph, coverage, owned });

  const edgesByProvenance = zeroProvenance();
  for (const p of EDGE_PROVENANCES) edgesByProvenance[p] = graph.report.edgesByProvenance[p];

  return {
    generatedAt: now().toISOString(),
    nodes,
    edges,
    findings,
    detectors: runs,
    coverage,
    ownership,
    collection: {
      rowsFetched: collection.stats.rowsFetched,
      totalRecords: collection.stats.totalRecords,
      pages: collection.stats.pages,
      complete: collection.stats.complete,
      subscriptionsSeen: collection.stats.subscriptionsSeen,
      containerApps: live.containerApps,
      containerAppJobs: live.containerAppJobs,
      managedEnvironments: live.managedEnvironments,
      envEntriesRead: live.env.entriesRead,
      envEntriesEmpty: live.env.entriesEmpty,
      envEntriesSecretRef: live.env.entriesSecretRef,
      durationMs: collection.stats.durationMs,
    },
    nodesByKind: graph.report.nodesByKind,
    edgesByProvenance,
    edgesByResolution: graph.report.edgesByResolution,
    skipped: [
      ...graph.report.skipped,
      ...live.unresolvedBindings.map((reason) => ({
        subject: 'wire-binding table',
        reason,
      })),
      ...(collection.stats.truncatedByPageCap
        ? [
            {
              subject: 'Azure Resource Graph pagination',
              reason:
                `the page cap was reached with a $skipToken still outstanding after ` +
                `${collection.stats.pages} page(s). The estate is INCOMPLETE and every ` +
                'reachability verdict below ranges over a partial graph.',
            },
          ]
        : []),
      ...(collection.stats.complete
        ? []
        : [
            {
              subject: 'collection completeness',
              reason:
                `rowsFetched=${collection.stats.rowsFetched} vs ARG totalRecords=` +
                `${collection.stats.totalRecords ?? 'UNKNOWN'}. ` +
                (collection.stats.totalRecords === null
                  ? 'ARG did not report a total, so completeness is UNKNOWN — not confirmed.'
                  : 'These disagree, so rows were lost.'),
            },
          ]),
    ],
    cloud: collection.stats.cloud,
  };
}

/** Query text, so a UI or a finding can show exactly what was asked of ARG. */
export { ESTATE_QUERY_TEXT };

/** Collect from Azure and build the snapshot. The only path that touches network. */
export async function loadSnapshot(opts?: {
  readonly estateId?: string;
}): Promise<BrainSnapshot> {
  const collection = await collectEstate();
  return snapshotFromCollection(collection, opts);
}
