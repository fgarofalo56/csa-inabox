/**
 * LOOM BRAIN — detector: ORPHAN.
 *
 * A node whose PARENT no longer exists: a Loom item in a deleted workspace, an
 * Azure child resource whose parent resource is gone, a container app whose
 * managed environment was removed. PRP §0: "Orphan from a deleted workspace |
 * node whose parent is gone".
 *
 * ── A PARENT IS ESTABLISHED, NEVER GUESSED ─────────────────────────────────
 * The whole detector turns on one question: how do you know what X's parent is?
 * Get that wrong and the finding is "this thing is orphaned" pointed at a
 * perfectly healthy resource — the worst possible failure for a system whose
 * recommendations touch 12 non-Loom container environments.
 *
 * So a parent is established exactly three ways, all of them from data that
 * ALREADY STATES the relationship:
 *
 *   1. A CALLER-SUPPLIED MAP (`parentOf`). This is the `envVarBindings` pattern:
 *      reviewable data, not inference. It exists because the relationship that
 *      matters most on this estate — container app -> managed environment — lives
 *      in `properties.managedEnvironmentId`, which no extractor currently reads.
 *      A caller that HAS read it passes it here; nothing is invented in its
 *      absence.
 *   2. `LoomItemNode.workspaceId` — the item itself names its workspace.
 *   3. ARM ID NESTING. `/subscriptions/S/resourceGroups/G/providers/NS/t1/n1/t2/n2`
 *      is by definition a child of `.../providers/NS/t1/n1`. This is structural,
 *      not heuristic: it is how ARM defines containment.
 *
 * Everything else is SKIPPED with a reason. A node whose parent could not be
 * established is NOT a node that passed.
 *
 * ── MEASURED: THIS DETECTOR IS BLIND ON TODAY'S ESTATE, AND SAYS SO ────────
 * The container tier discovered on 2026-08-23 is 63 apps, 29 jobs and 13 managed
 * environments — all TOP-LEVEL ARM resources, so rule 3 establishes no parents for
 * any of them. And `loom-item` node count is 0, so rule 2 establishes none either.
 * Without a caller-supplied `parentOf` map this detector examines a real
 * population and establishes a parent for NONE of it.
 *
 * That is reported — every node lands in `skipped` with the reason, and the
 * population's scope states how many parents were established. A detector that
 * returned "0 findings" over that without saying so would be the exact
 * green-and-blind failure this program is built to avoid.
 */

import {
  azureResourceNodeId,
  loomItemNodeId,
  type BrainGraphView,
  type BrainNode,
  type Detector,
  type DetectorResult,
  type Finding,
  type NodeId,
  type SkippedSubject,
} from '../graph';
import {
  bySeverity,
  detectorPopulation,
  evidence,
  findingId,
  ownership,
  scopedProposal,
  skip,
} from './detector-kit';

export const ORPHAN = 'orphan';

export interface OrphanOptions {
  /**
   * Node id -> the node id of its parent, established OUT OF BAND by the caller.
   *
   * The canonical use: container app -> its managed environment, read from
   * `properties.managedEnvironmentId`. Supplied as data rather than inferred,
   * for the same reason `envVarBindings` is — an inferred parent produces a
   * confident orphan finding against a healthy resource.
   *
   * A mapping whose VALUE is not in the graph is exactly what this detector
   * reports; a mapping whose KEY is not in the graph is recorded as a skip.
   */
  readonly parentOf?: Readonly<Record<string, NodeId>>;
  /** How the caller established `parentOf`. Lands verbatim in the evidence. */
  readonly parentSource?: string;
}

interface EstablishedParent {
  readonly parent: NodeId;
  readonly how: string;
}

/**
 * The parent of an Azure resource from ARM id nesting.
 *
 * An ARM id has the form `/subscriptions/S/resourceGroups/G/providers/NS/t1/n1[/t2/n2...]`.
 * With two or more type/name pairs the resource is a CHILD, and its parent is the
 * id truncated by one pair. With one pair it is top-level and has no ARM parent —
 * which returns `null`, not a guess.
 */
export function armParentId(armResourceId: string): string | null {
  const at = armResourceId.toLowerCase().indexOf('/providers/');
  if (at < 0) return null;
  const head = armResourceId.slice(0, at + '/providers/'.length);
  const tail = armResourceId.slice(at + '/providers/'.length).replace(/\/+$/, '');
  const segs = tail.split('/').filter(Boolean);
  // segs = [namespace, t1, n1, t2, n2, ...]. Fewer than 5 means top-level.
  if (segs.length < 5) return null;
  return head + segs.slice(0, segs.length - 2).join('/');
}

function establishParent(
  node: BrainNode,
  options: OrphanOptions,
): EstablishedParent | null {
  const supplied = options.parentOf?.[node.id];
  if (supplied) {
    return {
      parent: supplied,
      how: `caller-supplied parentOf map${options.parentSource ? ` (${options.parentSource})` : ''}`,
    };
  }
  if (node.kind === 'loom-item' && node.workspaceId) {
    return {
      parent: loomItemNodeId('workspace', node.workspaceId),
      how: `LoomItemNode.workspaceId = '${node.workspaceId}'`,
    };
  }
  if (node.kind === 'azure-resource') {
    const parentArm = armParentId(node.resourceId);
    if (parentArm) {
      return { parent: azureResourceNodeId(parentArm), how: `ARM id nesting: parent is '${parentArm}'` };
    }
  }
  return null;
}

/** The zero-configuration form. Establishes parents from node data only. */
export const orphan: Detector = orphanDetector();

/** The configurable form. Pass `parentOf` when the caller has read containment. */
export function orphanDetector(options: OrphanOptions = {}): Detector {
  return (graph: BrainGraphView): DetectorResult => {
    const skipped: SkippedSubject[] = [];
    const candidates = graph.nodes;

    let established = 0;
    // Findings are drafted WITHOUT their population and stamped with the final
    // one below. Attaching it inline would freeze each finding at the running
    // count at the moment it was created, so the first finding would understate
    // what the detector went on to examine — a population that is wrong in the
    // reassuring direction.
    const drafts: Omit<Finding, 'population'>[] = [];

    for (const node of candidates) {
      const parent = establishParent(node, options);
      if (parent === null) {
        skipped.push(
          skip(
            node.id,
            `no parent could be ESTABLISHED for this ${node.kind} node. Not evaluated — this is neither ` +
              'an orphan nor a node with a healthy parent. Supply OrphanOptions.parentOf (e.g. container ' +
              'app -> properties.managedEnvironmentId) to evaluate it.',
          ),
        );
        continue;
      }
      established += 1;

      // THE PREDICATE. The parent is named and it is not in the graph.
      const parentNode = graph.node(parent.parent);
      if (parentNode !== undefined) continue;

      const own = ownership(graph, node.id);
      drafts.push({
        id: findingId(ORPHAN, node.id),
        detector: ORPHAN,
        severity: 'medium',
        title: `${node.displayName} names a parent that is not in the graph`,
        summary:
          `'${node.displayName}' (${node.kind}) states its parent as '${parent.parent}', and no node with ` +
          'that id exists in the graph. Either the parent was deleted and this is an orphan, or discovery ' +
          'did not cover the parent — those are different problems and the graph cannot tell them apart.',
        subjects: [node.id],
        evidence: evidence({
          nodes: [node.id],
          edges: [],
          query: `establishParent(node) -> '${parent.parent}'; graph.node('${parent.parent}') === undefined`,
          notes: [
            `parent established by: ${parent.how}`,
            `parent node id: ${parent.parent}`,
            `graph.node(parent) is undefined over ${graph.nodes.length} node(s)`,
            'R7 — this finding does NOT establish that the parent was deleted. It establishes that the ' +
              'parent is absent from THIS graph. Confirm the discovery scope covered the parent before ' +
              'concluding deletion.',
          ],
        }),
        // Deliberately not `high`: absence from the graph and absence from Azure
        // are different claims, and only the first was measured.
        confidence: 'medium',
        remediation: scopedProposal(
          `Confirm whether '${node.displayName}' is orphaned or merely out of discovery scope`,
          `1. Re-run discovery with the parent's subscription in scope and check whether '${parent.parent}' ` +
            `appears.\n2. If it does not exist in Azure either, '${node.displayName}' is an orphan and can ` +
            `be proposed for removal.\n3. If it does exist, the defect is the discovery scope, not the resource.`,
          own,
        ),
      });
    }

    const population = detectorPopulation(
      graph,
      candidates,
      `${candidates.length} node(s) examined; a parent was ESTABLISHED for ${established} and could NOT be ` +
        `established for ${candidates.length - established} (skipped, not cleared). Parent sources: ` +
        `caller-supplied parentOf=${Object.keys(options.parentOf ?? {}).length} entr(ies), ` +
        'LoomItemNode.workspaceId, ARM id nesting.',
    );

    const findings: Finding[] = drafts.map((d) => ({ ...d, population }));

    return {
      detector: ORPHAN,
      findings: [...findings].sort(bySeverity),
      population,
      skipped,
    };
  };
}
