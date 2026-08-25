/**
 * LOOM BRAIN W9 — project a LIVE graph into a storable version.
 *
 * The one direction that matters: {@link import('../types').BrainGraphView} in,
 * {@link GraphVersionContent} out. Pure, total, and deterministic — the same
 * graph always projects to the same content, and therefore to the same digest.
 *
 * ── WHAT IS DROPPED, AND WHY EACH DROP IS DELIBERATE ───────────────────────
 * A version is a CHANGE-DETECTION RECORD, not a second copy of the estate.
 * Everything a finding needs beyond these fields it reads from the live graph,
 * joined on the ids kept here.
 *
 *   evidence.line       A wire moving from `main.bicep:4730` to `:4731` because
 *                       a comment was inserted above it is not a change to the
 *                       estate. Keeping the line would turn every unrelated
 *                       bicep edit into estate drift.
 *   evidence.rawValue   Replaced by a CLASS + a LENGTH + a 64-bit digest. An env
 *                       var value can be a connection string; this repo counts
 *                       every place a secret comes to rest as a publication
 *                       surface, and a stored graph is one more. The
 *                       empty/nonempty distinction survives because it IS the
 *                       founding finding.
 *   tag VALUES          Only the key set is kept (plus `loom-estate-id`, which
 *                       is load-bearing for ownership). Tag values are arbitrary
 *                       customer text and Azure Policy rewrites them on its own
 *                       schedule — a perfect noise source.
 *
 * ── SORTING IS PART OF THE CONTRACT ────────────────────────────────────────
 * Nodes and edges come out sorted by id. Azure Resource Graph does NOT promise a
 * stable row order between calls, and the extractors iterate rows in whatever
 * order they arrive. Project without sorting and the SAME estate produces a
 * different digest on the next pull — every capture stored, every diff empty,
 * the history worthless. `./digest` sorts again; belt and braces, because this
 * is the single property the feature rests on.
 */

import {
  isDanglingEdge,
  type AzureResourceNode,
  type BrainEdge,
  type BrainGraphView,
  type BrainNode,
  type EdgeEvidence,
} from '../types';
import { LOOM_ESTATE_TAG_KEY } from '../graph/extractors/resource-graph';
import { HISTORY_FORMAT_VERSION } from './model';
import type {
  GraphVersionContent,
  RawValueClass,
  VersionEdgeEvidence,
  VersionEdgeRecord,
  VersionNode,
  VersionNodeIngress,
  VersionNodeScale,
} from './model';
import { shortDigest } from './sha256';

function projectScale(n: AzureResourceNode): VersionNodeScale | null {
  const s = n.scale;
  if (s === undefined) return null;
  return {
    minReplicas: s.minReplicas,
    maxReplicas: s.maxReplicas ?? null,
    cpu: s.cpu ?? null,
    memory: s.memory ?? null,
  };
}

function projectIngress(n: AzureResourceNode): VersionNodeIngress | null {
  const i = n.ingress;
  if (i === undefined) return null;
  return { external: i.external, fqdn: i.fqdn };
}

function projectNode(n: BrainNode): VersionNode {
  const azure = n.kind === 'azure-resource' ? (n as AzureResourceNode) : null;
  // `tags === null` means the tags could NOT be read — INDETERMINATE, not empty.
  // Flattening that to `[]` is how a fail-open ownership inference gets in, and
  // per PRP §1 a wrong ownership inference on this estate reaches 12 non-Loom
  // Container App environments.
  const tagKeys =
    azure === null ? null : azure.tags === null ? null : Object.keys(azure.tags).sort();
  const estateTag =
    azure === null || azure.tags === null ? null : (azure.tags[LOOM_ESTATE_TAG_KEY] ?? null);

  return {
    id: n.id,
    kind: n.kind,
    displayName: n.displayName,
    resourceType: azure?.resourceType ?? null,
    subscriptionId: azure?.subscriptionId ?? null,
    resourceGroup: azure?.resourceGroup ?? null,
    location: azure?.location ?? null,
    provisioningState: azure?.provisioningState ?? null,
    scale: azure === null ? null : projectScale(azure),
    ingress: azure === null ? null : projectIngress(azure),
    tagKeys,
    estateTag,
  };
}

/**
 * Classify + fingerprint an authored value without persisting it.
 *
 * Three states, never two. `absent` (the artifact carried no value at all),
 * `empty` (`value: ''` — the wire exists and points nowhere) and `nonempty`.
 * Collapsing `absent` into `empty` erases the difference between "this wire was
 * deleted" and "this wire was zeroed", which are opposite remediations.
 */
export function classifyRawValue(raw: string | undefined): {
  readonly rawValueClass: RawValueClass;
  readonly rawValueLength: number;
  readonly rawValueDigest: string | null;
} {
  if (raw === undefined) {
    return { rawValueClass: 'absent', rawValueLength: 0, rawValueDigest: null };
  }
  if (raw === '') {
    // An empty value still gets a digest, so the field is uniformly comparable
    // and `rawValueDigest === null` means exactly one thing: no value at all.
    return { rawValueClass: 'empty', rawValueLength: 0, rawValueDigest: shortDigest('') };
  }
  return {
    rawValueClass: 'nonempty',
    rawValueLength: raw.length,
    rawValueDigest: shortDigest(raw),
  };
}

function projectEvidence(e: EdgeEvidence): VersionEdgeEvidence {
  return {
    artifact: e.artifact,
    symbol: e.symbol ?? null,
    extractor: e.extractor,
    ...classifyRawValue(e.rawValue),
  };
}

function projectEdge(e: BrainEdge): VersionEdgeRecord {
  const dangling = isDanglingEdge(e);
  return {
    id: e.id,
    provenance: e.provenance,
    from: e.from,
    to: dangling ? null : e.to,
    resolution: e.resolution,
    intendedTo: dangling ? e.intendedTo : null,
    danglingReason: dangling ? e.danglingReason : null,
    evidence: projectEvidence(e.evidence),
  };
}

function byId<T extends { readonly id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Project a built graph into the content a version stores. */
export function projectGraph(graph: BrainGraphView): GraphVersionContent {
  const nodes = graph.nodes.map(projectNode).sort(byId);
  const edges = graph.edges.map(projectEdge).sort(byId);
  return { formatVersion: HISTORY_FORMAT_VERSION, nodes, edges };
}
