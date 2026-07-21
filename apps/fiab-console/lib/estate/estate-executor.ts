/**
 * WS-8 — estate plan **executor**.
 *
 * Walks an {@link EstatePlan} in topological order and runs the chain for real:
 *   • create nodes → an injected {@link CreateDispatch} (real `createOwnedItem`);
 *   • weave nodes  → an injected {@link WeaveDispatch} that POSTs to the REAL
 *     ThreadAction route (the actual Weave bridge — same code the Weave menu
 *     runs), resolving the bridge's `from` from the upstream node's created item.
 *
 * The dispatches are INJECTED so this orchestration is unit-testable with mocked
 * bridge calls while the wiring stays real: the BFF `/api/estate/execute` route
 * supplies dispatches backed by the genuine thread routes + `createOwnedItem`
 * (no-vaporware.md — the approved plan actually creates items via the 13
 * bridges). A failed node marks its whole downstream subtree `skipped` (a bridge
 * can't run from an item that was never created), so the receipt is honest.
 */

import {
  type EstatePlan,
  type EstatePlanNode,
  topoOrderNodes,
} from './estate-plan-model';

/** Result of running a single create/weave step against the real backend. */
export interface DispatchResult {
  ok: boolean;
  /** Cosmos id of the created item (present on ok). */
  itemId?: string;
  /** The created item type (present on ok; usually === node.itemType). */
  itemType?: string;
  /** Display name of the created item. */
  name?: string;
  /** Deep link to open the created item. */
  link?: string;
  /** Honest error / gate message on failure. */
  error?: string;
}

/** Create a ROOT item directly (real `createOwnedItem`). */
export type CreateDispatch = (input: {
  itemType: string;
  title: string;
}) => Promise<DispatchResult>;

/** Run a Weave bridge (ThreadAction) FROM an already-created upstream item. */
export type WeaveDispatch = (input: {
  action: string;
  from: { id: string; type: string; name: string };
  values: Record<string, unknown>;
}) => Promise<DispatchResult>;

export interface ExecuteEstateOptions {
  createDispatch: CreateDispatch;
  weaveDispatch: WeaveDispatch;
  /** Optional progress callback fired as each node finishes (for streaming). */
  onNode?: (node: EstatePlanNode) => void;
}

export interface EstateExecResult {
  /** The plan with every node's status/result filled in. */
  plan: EstatePlan;
  /** True when every node reached 'created' (none failed or skipped). */
  ok: boolean;
  createdCount: number;
  failedCount: number;
  skippedCount: number;
  /** One-line receipt summary. */
  summary: string;
}

/**
 * Execute the estate plan. Runs nodes in dependency order; a `create` node calls
 * `createDispatch`; a `weave` node resolves its `fromNodeId`'s created item and
 * calls `weaveDispatch(action, from, values)`. When a source node failed/was
 * skipped, the dependent weave node is `skipped` (never run against a phantom
 * source). Returns a new plan object with per-node status + results — never
 * mutates the input plan.
 */
export async function executeEstatePlan(
  plan: EstatePlan,
  opts: ExecuteEstateOptions,
): Promise<EstateExecResult> {
  const { order } = topoOrderNodes(plan);
  // Work on deep-ish copies so the input plan is untouched.
  const nodes: EstatePlanNode[] = (plan.nodes || []).map((n) => ({ ...n, status: 'pending' as const }));
  const byId = new Map(nodes.map((n) => [n.id, n]));

  for (const id of order) {
    const node = byId.get(id);
    if (!node) continue;
    node.status = 'running';

    try {
      if (node.op === 'create') {
        const res = await opts.createDispatch({ itemType: node.itemType, title: node.title });
        applyResult(node, res);
      } else {
        // weave — resolve the upstream created item as the bridge source.
        const src = node.fromNodeId ? byId.get(node.fromNodeId) : undefined;
        if (!src || src.status !== 'created' || !src.resultItemId) {
          node.status = 'skipped';
          node.error = src
            ? `Upstream "${src.title}" was not created (${src.status || 'unknown'}), so this bridge was skipped.`
            : 'No upstream source item resolved for this bridge.';
          opts.onNode?.(node);
          continue;
        }
        if (!node.action) {
          node.status = 'failed';
          node.error = 'Weave node has no action.';
          opts.onNode?.(node);
          continue;
        }
        const res = await opts.weaveDispatch({
          action: node.action,
          from: { id: src.resultItemId, type: src.resultType || src.itemType, name: src.title },
          values: node.values || {},
        });
        applyResult(node, res);
      }
    } catch (e: unknown) {
      node.status = 'failed';
      node.error = e instanceof Error ? e.message : 'Execution error.';
    }
    opts.onNode?.(node);
  }

  const createdCount = nodes.filter((n) => n.status === 'created').length;
  const failedCount = nodes.filter((n) => n.status === 'failed').length;
  const skippedCount = nodes.filter((n) => n.status === 'skipped').length;
  const ok = failedCount === 0 && skippedCount === 0 && createdCount === nodes.length && nodes.length > 0;
  const summary = ok
    ? `Built the full estate — ${createdCount} item${createdCount === 1 ? '' : 's'} created across the chain.`
    : `Created ${createdCount} of ${nodes.length} step${nodes.length === 1 ? '' : 's'}` +
      (failedCount ? `, ${failedCount} failed` : '') +
      (skippedCount ? `, ${skippedCount} skipped` : '') + '.';

  return {
    plan: { ...plan, nodes },
    ok,
    createdCount,
    failedCount,
    skippedCount,
    summary,
  };
}

/** Fold a dispatch result onto a node (created + ids, or failed + error). */
function applyResult(node: EstatePlanNode, res: DispatchResult): void {
  if (res.ok && res.itemId) {
    node.status = 'created';
    node.resultItemId = res.itemId;
    node.resultType = res.itemType || node.itemType;
    node.resultLink = res.link;
    if (res.name) node.title = node.title || res.name;
  } else {
    node.status = 'failed';
    node.error = res.error || 'The backend did not create the item.';
  }
}
