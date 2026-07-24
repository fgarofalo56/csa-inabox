/**
 * N5 — the ASSET REGISTRY assembler (server-side).
 *
 * Produces the estate's software-defined-asset graph by CONSUMING the lineage
 * Loom already has, then layering the `loom-assets` policy sidecars on top:
 *
 *   1. **Lineage.** `listThreadEdges` gives the tenant's Weave item graph; its
 *      ROOTS (items with no inbound edge) are the focus assets we resolve. For
 *      each root — bounded by ASSET_ROOT_LIMIT — we call WS-L's
 *      `getUnifiedLineage` (Purview/Atlas + Databricks Unity Catalog + Weave,
 *      collapsed on the shared identity, WITH the column facet from
 *      `ThreadEdge.columnMappings`). N5 never collects lineage itself.
 *   2. **N4 model DAGs.** Every `transformation-project` item's already-emitted
 *      `buildTransformDag` node/edge set is folded in via its `TransformAsset`
 *      descriptors — reused, not re-derived.
 *   3. **Derivation.** `lib/assets/asset-graph.ts` turns those graphs into
 *      assets + deps (process contraction, column-mapping deps, identity merge).
 *   4. **Sidecars.** `loom-assets` docs supply the freshness policy, the
 *      materializer binding, and the run/version watermarks.
 *
 * Bounded and cached: one assembly per tenant is memoised for
 * ASSET_GRAPH_TTL_MS through the shared `getOrComputeCached` tier, and the root
 * fan-out is capped, so the canvas's first paint costs one Cosmos query plus a
 * handful of already-cached lineage merges.
 *
 * Honest, never fabricated: when a lineage source is gated its `sources[]` entry
 * is surfaced verbatim (the canvas renders the gate) and the OTHER sources still
 * draw. An empty estate returns an empty graph — never sample assets.
 *
 * Server-only. IL5: every hop (Cosmos, Purview/Atlas-on-AKS, Unity Catalog, the
 * lake) is in-boundary; nothing here reaches a SaaS control plane.
 */

import { getUnifiedLineage, type UnifiedSourceStatus } from '@/lib/azure/unified-lineage';
import { listThreadEdges, type ThreadEdge } from '@/lib/thread/thread-edges';
import { listOwnedItems } from '@/app/api/items/_lib/item-crud';
import { buildTransformDag } from '@/lib/transform/transform-dag';
import { validateTransformProject, type TransformProject } from '@/lib/transform/transform-project-model';
import { getOrComputeCached, invalidateModel } from '@/lib/azure/query-result-cache';
import type { SessionPayload } from '@/lib/auth/session';
import {
  assetsFromTransformDag,
  deriveAssetGraph,
  mergeAssetGraphs,
  upstreamOf,
  type DerivedAsset,
  type DerivedAssetGraph,
} from './asset-graph';
import { evaluateFreshness, type FreshnessEvaluation } from './freshness';
import { indexByAssetKey, listAssetDocs } from './asset-store';
import {
  defaultAssetPolicy,
  normalizeAssetKey,
  type AssetDoc,
  type AssetFreshnessPolicy,
  type AssetMaterializerBinding,
} from '@/lib/azure/asset-registry-model';

/** Max lineage roots resolved per assembly (bounded fan-out). */
export const ASSET_ROOT_LIMIT = 12;
/** Weave hop budget per root — deep enough to cover a normal medallion chain. */
export const ASSET_WEAVE_DEPTH = 6;
/** Assembly cache TTL. Short enough that a Materialize is visible next paint. */
export const ASSET_GRAPH_TTL_MS = 30_000;
const CACHE_MODEL_ID = 'asset-registry';

/** One asset as the API returns it — derived record + sidecar + freshness. */
export interface RegisteredAsset extends DerivedAsset {
  policy: AssetFreshnessPolicy;
  materializer: AssetMaterializerBinding;
  freshness: FreshnessEvaluation;
  /** Upstream asset keys (derived deps) — what the reconciler watches. */
  upstream: string[];
  lastMaterializedAt?: string;
  lastRunOutcome?: AssetDoc['lastRunOutcome'];
  lastRunId?: string;
  lastDetail?: string;
  lastTriggerAt?: string;
  observedVersion?: number;
  materializedVersion?: number;
  consecutiveFailures?: number;
  /** True when the operator has saved a policy for this asset. */
  configured: boolean;
}

export interface AssetRegistrySnapshot {
  assets: RegisteredAsset[];
  deps: DerivedAssetGraph['deps'];
  /** Per-lineage-source status, verbatim from unified-lineage (honest gates). */
  sources: UnifiedSourceStatus[];
  /** How many lineage roots were resolved (and whether the cap bit). */
  roots: { resolved: number; total: number; capped: boolean };
  builtAt: string;
}

/** Roots of the Weave item graph — items with no inbound edge (plus isolates). */
export function lineageRoots(edges: ThreadEdge[]): Array<{ itemId: string; itemType: string }> {
  const nodes = new Map<string, string>();
  const hasInbound = new Set<string>();
  for (const e of edges) {
    if (!nodes.has(e.fromItemId)) nodes.set(e.fromItemId, e.fromType);
    if (!nodes.has(e.toItemId)) nodes.set(e.toItemId, e.toType);
    hasInbound.add(e.toItemId);
  }
  const roots: Array<{ itemId: string; itemType: string }> = [];
  for (const [itemId, itemType] of nodes) {
    if (!hasInbound.has(itemId)) roots.push({ itemId, itemType });
  }
  // A fully-cyclic component has no root; fall back to the lowest id so its
  // assets are still reachable (BFS from any member covers the component).
  if (roots.length === 0 && nodes.size > 0) {
    const [itemId, itemType] = [...nodes.entries()].sort((a, b) => a[0].localeCompare(b[0]))[0];
    roots.push({ itemId, itemType });
  }
  return roots.sort((a, b) => a.itemId.localeCompare(b.itemId));
}

/** Extract the valid TransformProject from a transformation-project item state. */
function projectOf(state: Record<string, unknown> | undefined): TransformProject | null {
  const raw: unknown = state?.project;
  if (!raw || typeof raw !== 'object') return null;
  if (validateTransformProject(raw).length) return null;
  return raw as TransformProject;
}

async function assemble(session: SessionPayload): Promise<AssetRegistrySnapshot> {
  const tenantId = session.claims.oid;

  // ── 1. Lineage roots (Cosmos, no infra gate). ─────────────────────────────
  let edges: ThreadEdge[] = [];
  try {
    edges = await listThreadEdges(session);
  } catch {
    edges = [];
  }
  const allRoots = lineageRoots(edges);
  const roots = allRoots.slice(0, ASSET_ROOT_LIMIT);

  // ── 2. Unified lineage per root (WS-L — never re-derived here). ───────────
  const sourceStatus = new Map<string, UnifiedSourceStatus>();
  const lineageGraphs: DerivedAssetGraph[] = await Promise.all(
    roots.map(async (root) => {
      try {
        const result = await getUnifiedLineage({
          session,
          itemId: root.itemId,
          itemType: root.itemType,
          weaveDepth: ASSET_WEAVE_DEPTH,
          // The column facet is what gives the asset plane column-mapping deps.
          columnLineage: true,
        });
        for (const s of result.sources) {
          const prior = sourceStatus.get(s.source);
          // Keep the WORST outcome per source so a gate is never hidden by a
          // sibling root that happened to succeed, but keep the node counts.
          if (!prior || (prior.ok && !s.ok)) sourceStatus.set(s.source, s);
          else if (prior.ok && s.ok) {
            sourceStatus.set(s.source, { ...prior, nodeCount: prior.nodeCount + s.nodeCount });
          }
        }
        return deriveAssetGraph(result.nodes, result.edges);
      } catch {
        return { assets: [], deps: [] };
      }
    }),
  );

  // ── 3. N4 model DAGs (reuse the emitted asset descriptors). ───────────────
  let transformGraphs: DerivedAssetGraph[] = [];
  try {
    const projects = await listOwnedItems('transformation-project', tenantId, { session });
    transformGraphs = projects
      .map((item) => {
        const project = projectOf(item.state);
        if (!project) return null;
        return assetsFromTransformDag(buildTransformDag(project), {
          itemId: item.id,
          itemHref: `/items/transformation-project/${encodeURIComponent(item.id)}`,
        });
      })
      .filter((g): g is DerivedAssetGraph => g !== null);
  } catch {
    transformGraphs = [];
  }

  const graph = mergeAssetGraphs(...lineageGraphs, ...transformGraphs);

  // ── 4. Sidecars + freshness. ─────────────────────────────────────────────
  let docs: AssetDoc[] = [];
  try {
    docs = await listAssetDocs(session);
  } catch {
    docs = [];
  }
  const byKey = indexByAssetKey(docs);
  const now = Date.now();

  const assets: RegisteredAsset[] = graph.assets.map((a) => {
    // A sidecar may have been written against ANY alias this asset merged on.
    const doc =
      byKey.get(normalizeAssetKey(a.key)) ??
      a.aliases.map((alias) => byKey.get(normalizeAssetKey(alias))).find(Boolean) ??
      null;
    const policy = doc?.policy ?? defaultAssetPolicy();
    return {
      ...a,
      policy,
      materializer: doc?.materializer ?? { kind: 'none' },
      freshness: evaluateFreshness({ policy, lastMaterializedAt: doc?.lastMaterializedAt, now }),
      upstream: upstreamOf(graph, a.key),
      ...(doc?.lastMaterializedAt ? { lastMaterializedAt: doc.lastMaterializedAt } : {}),
      ...(doc?.lastRunOutcome ? { lastRunOutcome: doc.lastRunOutcome } : {}),
      ...(doc?.lastRunId ? { lastRunId: doc.lastRunId } : {}),
      ...(doc?.lastDetail ? { lastDetail: doc.lastDetail } : {}),
      ...(doc?.lastTriggerAt ? { lastTriggerAt: doc.lastTriggerAt } : {}),
      ...(typeof doc?.observedVersion === 'number' ? { observedVersion: doc.observedVersion } : {}),
      ...(typeof doc?.materializedVersion === 'number' ? { materializedVersion: doc.materializedVersion } : {}),
      ...(typeof doc?.consecutiveFailures === 'number' ? { consecutiveFailures: doc.consecutiveFailures } : {}),
      configured: !!doc,
    };
  });

  // Sidecars whose asset no longer appears in lineage (the upstream item was
  // deleted, or the policy predates a lineage change) are surfaced honestly
  // rather than silently dropped — the operator can see and clear them.
  const derivedKeys = new Set(graph.assets.flatMap((a) => [a.key, ...a.aliases]).map(normalizeAssetKey));
  for (const doc of docs) {
    const key = normalizeAssetKey(doc.assetKey);
    if (!key || derivedKeys.has(key)) continue;
    assets.push({
      key,
      aliases: [key],
      name: doc.name || key,
      kind: doc.kind || 'unknown',
      group: doc.group || 'unlinked',
      sources: ['loom'],
      producedBy: [],
      columns: [],
      owners: [],
      tags: [],
      policy: doc.policy,
      materializer: doc.materializer ?? { kind: 'none' },
      freshness: evaluateFreshness({ policy: doc.policy, lastMaterializedAt: doc.lastMaterializedAt, now }),
      upstream: [],
      ...(doc.lastMaterializedAt ? { lastMaterializedAt: doc.lastMaterializedAt } : {}),
      ...(doc.lastRunOutcome ? { lastRunOutcome: doc.lastRunOutcome } : {}),
      configured: true,
    });
  }

  return {
    assets: assets.sort((a, b) => a.key.localeCompare(b.key)),
    deps: graph.deps,
    sources: [...sourceStatus.values()].sort((a, b) => a.source.localeCompare(b.source)),
    roots: { resolved: roots.length, total: allRoots.length, capped: allRoots.length > roots.length },
    builtAt: new Date().toISOString(),
  };
}

/** Raised when a caller asks for a tenant scope its session does not own. */
export class AssetTenantScopeError extends Error {
  constructor() {
    super('asset registry: requested tenant scope does not match the caller session');
    this.name = 'AssetTenantScopeError';
  }
}

/**
 * The tenant's asset-graph snapshot, memoised for {@link ASSET_GRAPH_TTL_MS}.
 * Pass `{ bypass: true }` right after a mutation so the caller sees its own write.
 *
 * `tenantId` is the caller's DECLARED scope (defence in depth): every read below
 * is partitioned by `session.claims.oid`, and a caller that states a different
 * scope is refused rather than silently served the session's own partition — so
 * a future refactor cannot quietly widen the boundary, and the memoised snapshot
 * can never be handed to the wrong tenant.
 */
export async function getAssetRegistry(
  session: SessionPayload,
  opts: { bypass?: boolean; tenantId?: string } = {},
): Promise<AssetRegistrySnapshot> {
  if (opts.tenantId && opts.tenantId !== session.claims.oid) throw new AssetTenantScopeError();
  const { value } = await getOrComputeCached<AssetRegistrySnapshot>(
    `asset-registry:${session.claims.oid}`,
    CACHE_MODEL_ID,
    () => assemble(session),
    { ttlMs: ASSET_GRAPH_TTL_MS, bypass: opts.bypass },
  );
  return value;
}

/** Drop every memoised assembly (called after a policy save / materialize). */
export function invalidateAssetRegistry(): void {
  invalidateModel(CACHE_MODEL_ID);
}

/** Find one asset in a snapshot by key or any alias. */
export function findAsset(snapshot: AssetRegistrySnapshot, assetKey: string): RegisteredAsset | null {
  const key = normalizeAssetKey(assetKey);
  if (!key) return null;
  return (
    snapshot.assets.find((a) => normalizeAssetKey(a.key) === key) ??
    snapshot.assets.find((a) => a.aliases.some((alias) => normalizeAssetKey(alias) === key)) ??
    null
  );
}
