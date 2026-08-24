/**
 * LOOM BRAIN — canonical node identity.
 *
 * The ONLY sanctioned constructors for {@link NodeId} and {@link EdgeId}.
 *
 * ── WHY NORMALIZATION IS SAFETY-CRITICAL HERE ──────────────────────────────
 * ARM resource ids are case-INSENSITIVE, and Azure returns them in
 * inconsistent casing: Resource Graph, an ARM GET and a bicep `resourceId()`
 * expression routinely disagree on the casing of `resourceGroups`, the provider
 * namespace, and the resource name itself, for the SAME physical resource.
 *
 * If two extractors mint ids by string concatenation, that resource becomes TWO
 * nodes. Each carries half its edges. Every reachability answer is then wrong,
 * and — this is the part that matters — wrong in the direction of "no inbound
 * edges". The system would MANUFACTURE the exact finding it exists to report,
 * and the finding would look completely credible: a real resource, a real ARM
 * id, zero inbound edges.
 *
 * So identity is lowercased and trailing-slash-stripped, and the ORIGINAL
 * casing is preserved separately on `AzureResourceNode.resourceId` for display
 * and for ARM calls.
 *
 * Paths are normalized to forward slashes for the same reason: this repo is
 * developed on Windows and read by CI on Linux, so `lib\brain\x.ts` and
 * `lib/brain/x.ts` are the same module and must be the same node.
 */

import type { EdgeId, EdgeProvenance, NodeId } from '../types';

/**
 * Lowercase + trim + strip trailing slashes. Applied to every id component.
 *
 * NOT applied: any form of unicode folding or whitespace collapsing. An ARM
 * name containing an interior space is a different resource from one without,
 * and quietly equating them would be the same class of bug in the other
 * direction.
 */
function canon(s: string): string {
  return s.trim().replace(/\/+$/, '').toLowerCase();
}

/** Forward slashes, no leading `./`, no trailing slash. */
export function canonicalPath(p: string): string {
  return p
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

/**
 * The node id for an Azure resource, from its ARM resource id.
 *
 * Throws on an empty id rather than minting `azure:` — a node whose identity is
 * a prefix with nothing after it would collide with every other such node,
 * merging unrelated resources into one. Failing loudly is the only safe answer;
 * silently returning a shared id is how a graph gets quietly wrong.
 */
export function azureResourceNodeId(armResourceId: string): NodeId {
  const c = canon(armResourceId);
  if (!c) {
    throw new Error(
      'azureResourceNodeId: empty ARM resource id. An empty id would collide ' +
        'with every other empty id and merge unrelated resources into one node.',
    );
  }
  return `azure:${c}` as NodeId;
}

/** The node id for a Loom logical item. */
export function loomItemNodeId(itemType: string, itemId: string): NodeId {
  const t = canon(itemType);
  const i = canon(itemId);
  if (!t || !i) {
    throw new Error(`loomItemNodeId: both itemType and itemId are required (got '${itemType}'/'${itemId}').`);
  }
  return `loom:${t}/${i}` as NodeId;
}

/** The node id for a deploy artifact (bicep module, param file, workflow). */
export function deployArtifactNodeId(repoRelativePath: string): NodeId {
  const p = canonicalPath(repoRelativePath).toLowerCase();
  if (!p) throw new Error('deployArtifactNodeId: empty path.');
  return `deploy:${p}` as NodeId;
}

/** The node id for a source module. */
export function codeModuleNodeId(repoRelativePath: string): NodeId {
  const p = canonicalPath(repoRelativePath).toLowerCase();
  if (!p) throw new Error('codeModuleNodeId: empty path.');
  return `code:${p}` as NodeId;
}

/**
 * A deterministic edge id.
 *
 * Determinism is the requirement: two runs of the same extractor over the same
 * inputs must produce the same edge ids, or an evidence chain recorded in a
 * finding cannot be re-resolved on the next run, and the visualizer's selection
 * state resets on every refresh.
 *
 * `discriminator` separates two edges that share (provenance, from, target) but
 * come from different lines or symbols — e.g. two env vars on the same app both
 * pointing at the same backend. Without it the second would overwrite the first
 * and one wire would vanish from the graph.
 */
export function edgeId(
  provenance: EdgeProvenance,
  from: NodeId,
  targetRef: string,
  discriminator: string,
): EdgeId {
  // `targetRef` is NOT canon()'d away when empty: an empty target is a real,
  // meaningful state (a dangling `empty-value` edge) and needs a stable id like
  // any other. It renders as the explicit token `<empty>` so two distinct empty
  // wires on the same node stay distinguishable via `discriminator`.
  const t = targetRef.trim() === '' ? '<empty>' : canon(targetRef);
  return `${provenance}|${from}|${t}|${canon(discriminator)}` as EdgeId;
}

/**
 * Cast a pre-computed string to a NodeId.
 *
 * ONLY for deserializing ids this module previously produced (a persisted
 * finding, a URL parameter). Never call it on a value read from Azure — use the
 * typed constructors above so normalization actually happens.
 */
export function nodeIdFromPersisted(id: string): NodeId {
  return id as NodeId;
}

/** Deserialization counterpart to {@link nodeIdFromPersisted}. */
export function edgeIdFromPersisted(id: string): EdgeId {
  return id as EdgeId;
}
