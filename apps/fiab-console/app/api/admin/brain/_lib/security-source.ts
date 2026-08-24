/**
 * LOOM BRAIN — WHERE THE SECURITY GRAPH COMES FROM, AND WHY IT DOES NOT YET.
 *
 * `lib/brain/security/**` is nine pure detectors of the shape
 * `SecurityGraph -> { findings, population }`. They are complete, tested, and
 * inert. What does not exist anywhere in this repo is a producer of their INPUT:
 *
 *     $ grep -rn "SecurityGraph" apps/fiab-console --include=*.ts \
 *         | grep -v "lib/brain/security/"
 *     (no matches, measured 2026-08-24)
 *
 * A `SecurityGraph` node is `route-toolkit#withTenantAdmin`, a publication sink
 * in a CI script, a tenant-comparison implementation — i.e. facts about SOURCE.
 * The deployed console can read Azure Resource Graph; it cannot read the
 * repository it was built from. So the extractor is a build-time or CI-time
 * artifact, and building one is a different work item than rendering its output
 * (this one, #3934, explicitly "renders, does not re-derive").
 *
 * ── WHY THIS FILE RETURNS "UNAVAILABLE" INSTEAD OF AN EMPTY GRAPH ─────────
 *
 * An empty `SecurityGraph` is constructible and it is TEMPTING, because the
 * detectors handle it beautifully: every one of the nine would synthesise a
 * `POP-population-integrity` finding reading "examined an EMPTY population —
 * green and blind", which is exactly the right sentiment.
 *
 * It is still refused, on R7 grounds. `SecurityGraph.source` has three members —
 * `'modelled' | 'extracted' | 'observed'` — and an empty graph is none of them.
 * Claiming `'extracted'` asserts an extraction that never ran; claiming
 * `'modelled'` asserts a model nobody authored. The type has no member for "there
 * is no graph", so the honest answer is to not produce one, and to say so in the
 * layer above where "not evaluated" IS a representable state.
 *
 * ── WHAT MUST LAND FOR THIS TO GO LIVE ───────────────────────────────────
 *
 * One producer, anywhere, that emits a `SecurityGraph` with `source:
 * 'extracted'`. The natural home is a CI job that walks the repo and publishes
 * the graph as a build artifact the console reads at start-up. When it exists,
 * the ONLY change here is that {@link loadSecurityGraph} returns it — every
 * consumer downstream (`buildRiskLayer`, the route, the whole synapse view)
 * already handles the `available: true` branch and is tested against a real
 * sweep over a real graph.
 */

import type { SecurityGraph } from '@/lib/brain/security';

export type SecurityGraphSource =
  | { readonly available: true; readonly graph: SecurityGraph }
  | { readonly available: false; readonly reason: string };

/**
 * The reason, as one string, so the route, the UI and the tests all quote the
 * same sentence rather than three paraphrases that drift.
 */
export const NO_SECURITY_GRAPH_REASON =
  'No security graph is available to this deployment, so NO risk verdict has been drawn — ' +
  'this is not a clean result. The nine detectors in lib/brain/security run over a graph of ' +
  'the SOURCE (authorizers, verdict calls, publication sinks, predicate implementations), and ' +
  'nothing in this repository produces one yet: the console reads Azure Resource Graph, not the ' +
  'repository it was built from, so the extractor has to be a build-time artifact. Until it ' +
  'lands, the risk lane below reports what WOULD have been examined and refuses to report a ' +
  'count of zero as an absence of risk.';

/**
 * Load the security graph for this deployment.
 *
 * Always unavailable today — see the module doc-block for the measurement and
 * for the single change that makes it live.
 */
export function loadSecurityGraph(): SecurityGraphSource {
  return { available: false, reason: NO_SECURITY_GRAPH_REASON };
}
