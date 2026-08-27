/**
 * LOOM BRAIN — SECURITY EXTRACTION: the id-space join.
 *
 * ── THE PROBLEM, MEASURED ────────────────────────────────────────────────
 *
 * The two halves of the Brain do not share an identifier space. The waste side
 * keys on ARM resource ids minted by `lib/brain/graph/node-id.ts`:
 *
 *     azure:/subscriptions/<sub>/resourcegroups/<rg>/providers/…
 *
 * The security side keys on SOURCE coordinates, because that is what its facts
 * are about:
 *
 *     sec:authorizer:apps/fiab-console/app/api/copilot/sessions/[id]/trace/route.ts#GET
 *
 * Nothing maps one to the other, so a security finding cannot be PAINTED onto the
 * estate picture — it can only be listed. #3992 renders both a painted lane and
 * an `unjoined` lane for exactly this reason.
 *
 * ── WHY THE JOIN IS A LOGICAL NAME AND NOT AN ARM ID ─────────────────────
 *
 * The artifact is produced at BUILD time and COMMITTED to a PUBLIC repository.
 * At build time no subscription, resource group or tenant is known — and if one
 * were, writing it here would publish it. So the join records the LOGICAL unit
 * that serves the module (`loom-console` — the name the bicep gives the Container
 * App) and stops there. Resolving `loom-console` to a live
 * `azure:/subscriptions/…` node is the RUNTIME's job, where the estate is known
 * and nothing is published.
 *
 * That split is also what makes the artifact CLOUD-NEUTRAL by construction, which
 * `cloud-parity.md` requires and which this file can actually guarantee rather
 * than hope for: there is no cloud, endpoint, suffix or boundary named anywhere in
 * the join, so the same bytes are equally correct in Commercial, GCC, GCC-High,
 * IL5 and DoD. `__tests__/no-estate-identifiers.test.ts` asserts that as a
 * property of the emitted artifact rather than as a claim in a comment.
 *
 * ── `unjoined` IS A RESULT, NOT A FAILURE ────────────────────────────────
 *
 * A publication sink in `scripts/ci/**` runs inside GitHub Actions. It has no
 * Azure estate presence at all, so painting it onto a Container App would be an
 * INVENTED edge — the graph would assert a relationship that does not exist, and
 * a reader would reasonably conclude the leak is in the product rather than in
 * CI. Those nodes belong in `unjoined`, with the reason recorded.
 *
 * Both buckets are therefore expected to be non-empty, and
 * {@link assertJoinCoversGraph} refuses a join whose two halves do not add up to
 * the graph's node count — the population discipline of `../population.ts`
 * applied to the join itself, so a node cannot vanish between the extractor and
 * the surface.
 */

import type { SecurityNode } from '../substrate';
import type { PaintedNode, SecurityGraphJoin, UnjoinedNode } from './types';
import { canonicalRepoPath } from './source-facts';

/**
 * Repo path prefix -> the logical deployable unit that serves it.
 *
 * Longest prefix wins. Maintained EXPLICITLY: deriving "which app serves this
 * file" from directory names would silently mis-assign the moment an app is
 * renamed, and a wrong join is worse than no join because it paints a finding
 * onto an innocent resource.
 */
export const DEPLOYABLE_UNITS: readonly (readonly [string, string])[] = [
  ['apps/fiab-console/', 'loom-console'],
  ['apps/copilot-maf/', 'loom-copilot-maf'],
  ['apps/fiab-dbt-runner/', 'loom-dbt-runner'],
  ['apps/fiab-direct-lake-shim/', 'loom-direct-lake-shim'],
] as const;

/**
 * Path prefixes that provably have NO estate presence, with the reason.
 *
 * These are not gaps to be closed later — they are correct answers. A guard
 * script executes on a GitHub-hosted runner; there is no Azure resource it could
 * be painted onto.
 *
 * EVERY PREFIX HERE MUST BE LIVE. Until 2026-08-24 this table carried a
 * `.github/workflows/` entry that could never match, because nothing under
 * `.github/` was ever walked — dead code that read, to anyone auditing the join,
 * as coverage of a scope the extractor did not have. `__tests__/join.test.ts`
 * now asserts each prefix matches at least one node in the committed artifact,
 * so an entry added ahead of its scan goes red instead of implying reach.
 */
export const NO_ESTATE_PRESENCE: readonly (readonly [string, string])[] = [
  [
    'scripts/ci/',
    'CI guard script — executes on a GitHub Actions runner, not in any deployed Azure resource. ' +
      'Painting it onto a Container App would assert an edge that does not exist.',
  ],
  [
    '.github/',
    'GitHub Actions surface — a workflow, or a script a workflow invokes. It runs in Actions and ' +
      'has no Azure estate presence to be painted onto. Its publication sinks reach the PUBLIC ' +
      'run log and the issues API, which is why the module is extracted even though it joins to ' +
      'nothing.',
  ],
  [
    'scripts/',
    'repository tooling — run by a developer or by CI, never by a deployed Loom service.',
  ],
] as const;

/** The source path encoded in a `sec:<kind>:<path>#<symbol>` node id. */
export function pathOfNodeId(nodeId: string): string | null {
  const firstColon = nodeId.indexOf(':');
  if (firstColon < 0) return null;
  const secondColon = nodeId.indexOf(':', firstColon + 1);
  if (secondColon < 0) return null;
  const hash = nodeId.lastIndexOf('#');
  const path = nodeId.slice(secondColon + 1, hash < 0 ? undefined : hash);
  return path.length > 0 ? path : null;
}

/**
 * The waste-graph join key for a repo path.
 *
 * MUST be byte-identical to `lib/brain/graph/node-id.ts#codeModuleNodeId`.
 *
 * It is re-implemented here rather than imported, and that is a deliberate
 * trade with a specific cause: this package is compiled and executed by a
 * BUILD-TIME script, and every value import it makes drags another module into
 * that build. Keeping the extractor's non-type imports inside its own directory
 * keeps the build step a two-line `tsc` invocation instead of a bundler.
 *
 * Duplication of a rule is only acceptable when the copies are PROVEN equal, so
 * `__tests__/join.test.ts` imports the real `codeModuleNodeId` and asserts
 * equality over a table of paths including the Windows-backslash and
 * mixed-casing forms that `node-id.ts` exists to normalise. If either
 * implementation drifts, that test fails — the duplication is measured, not
 * assumed.
 */
export function codeModuleJoinKey(repoPath: string): string {
  return `code:${canonicalRepoPath(repoPath)}`;
}

/** Partition every node into painted / unjoined. Total by construction. */
export function buildJoin(nodes: readonly SecurityNode[]): SecurityGraphJoin {
  const painted: PaintedNode[] = [];
  const unjoined: UnjoinedNode[] = [];

  for (const node of nodes) {
    const path = pathOfNodeId(node.id);
    if (path === null) {
      unjoined.push({
        nodeId: node.id,
        codeModuleId: '',
        reason:
          'node id carries no source path, so there is no module to join through. This is an ' +
          'extractor defect if it ever occurs — node ids are minted by securityNodeId().',
      });
      continue;
    }

    const codeModuleId = codeModuleJoinKey(path);

    const unit = [...DEPLOYABLE_UNITS]
      .sort((a, b) => b[0].length - a[0].length)
      .find(([prefix]) => path.startsWith(prefix));

    if (unit) {
      painted.push({ nodeId: node.id, codeModuleId, deployedAs: unit[1] });
      continue;
    }

    const noEstate = [...NO_ESTATE_PRESENCE]
      .sort((a, b) => b[0].length - a[0].length)
      .find(([prefix]) => path.startsWith(prefix));

    unjoined.push({
      nodeId: node.id,
      codeModuleId,
      reason:
        noEstate?.[1] ??
        `no deployable unit is declared for '${path}'. Add a DEPLOYABLE_UNITS entry if a Loom ` +
          'service serves this module; leaving it unjoined is correct if none does.',
    });
  }

  return { painted, unjoined };
}

/**
 * Refuse a join that does not account for every node.
 *
 * `../population.ts` argues at length that this repo's dominant evasion is
 * falling outside the examined population. A security node that is in neither
 * bucket is a finding that renders on no surface — the same failure, one layer
 * further out. Duplicates are refused for the same reason `assertCandidatesMatchCensus`
 * refuses them: a padded list restores the count while narrowing the set.
 */
export function assertJoinCoversGraph(
  join: SecurityGraphJoin,
  nodes: readonly SecurityNode[],
): void {
  const seen = new Set<string>();
  for (const row of [...join.painted, ...join.unjoined]) {
    if (seen.has(row.nodeId)) {
      throw new Error(
        `[security-extract] incoherent join: node '${row.nodeId}' appears twice. A duplicate ` +
          'restores the total while leaving another node unaccounted for.',
      );
    }
    seen.add(row.nodeId);
  }

  const missing = nodes.filter((n) => !seen.has(n.id)).map((n) => n.id);
  if (missing.length > 0) {
    throw new Error(
      `[security-extract] incoherent join: ${missing.length} node(s) are in neither the painted ` +
        `nor the unjoined bucket (${missing.slice(0, 5).join(', ')}). Every node must be either ` +
        'painted onto a deployable unit or explicitly unjoined WITH A REASON.',
    );
  }

  const foreign = [...seen].filter((id) => !nodes.some((n) => n.id === id));
  if (foreign.length > 0) {
    throw new Error(
      `[security-extract] incoherent join: ${foreign.length} joined id(s) are absent from the ` +
        `graph (${foreign.slice(0, 5).join(', ')}).`,
    );
  }
}
