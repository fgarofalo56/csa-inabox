/**
 * LOOM BRAIN — WHERE THE SECURITY GRAPH COMES FROM.
 *
 * `lib/brain/security/**` is nine pure detectors of the shape
 * `SecurityGraph -> { findings, population }`. Their INPUT is a graph of the
 * SOURCE — `route-toolkit#withTenantAdmin`, a publication sink in a CI script, a
 * tenant-comparison implementation. The deployed console can read Azure Resource
 * Graph; it cannot read the repository it was built from, so that graph has to be
 * produced at BUILD time and shipped inside the image.
 *
 * ── WHAT THIS FILE USED TO SAY, AND WHY IT NO LONGER DOES ────────────────
 *
 * It carried a measurement — "no producer of their input exists, measured
 * 2026-08-24" — and returned `{ available: false }` unconditionally on the
 * strength of it. That producer landed: `lib/brain/security/extract` walks the
 * tree in `scripts/brain/extract-security-graph.mjs`, commits
 * `extract/__generated__/security-graph.json`, and `runtime.ts` imports it
 * statically so Next.js file tracing ships it. The doc-block claim outlived the
 * fact it described, which is the stale-comment form of the same defect the
 * module was written to avoid — so it is deleted rather than softened.
 *
 * ── WHY THIS IS STILL A WRAPPER TYPE AND NOT A BARE `SecurityGraph` ──────
 *
 * `SecurityGraph.source` has three members — `'modelled' | 'extracted' |
 * 'observed'` — and none of them means "there is no graph". An artifact can be
 * absent, malformed, stale, zero-node, or produced by a different extractor
 * version, and every one of those must render as NOT EVALUATED rather than as a
 * sweep that found nothing: a consumer counting SECURITY findings gets zero
 * either way, and zero is indistinguishable from clean. `resolveSecurityGraph`
 * in `lib/brain/security/extract/artifact.ts` owns every one of those refusals
 * and each is reachable from `extract/__tests__/artifact.test.ts`.
 *
 * ── CLOUD PARITY ─────────────────────────────────────────────────────────
 *
 * The artifact is a static import resolved at BUILD time, in the image, before
 * any cloud exists. There is no endpoint, no suffix, no ARM call and no
 * filesystem layout that could differ between Commercial, GCC, GCC-High, IL5 and
 * DoD — this lane is cloud-neutral by construction rather than by testing.
 */

import { loadExtractedSecurityGraph } from '@/lib/brain/security/extract';
import type { SecurityGraph } from '@/lib/brain/security';

export type SecurityGraphSource =
  | { readonly available: true; readonly graph: SecurityGraph }
  | { readonly available: false; readonly reason: string };

/**
 * The reason quoted when NO artifact shipped at all.
 *
 * Retained as a named export because the risk layer's tests and the surface both
 * quote it, and because it is only ONE of the refusals `resolveSecurityGraph`
 * can return — a caller must read `source.reason`, never assume this string.
 */
export const NO_SECURITY_GRAPH_REASON =
  'No security graph is available to this deployment, so NO risk verdict has been drawn — ' +
  'this is not a clean result. The nine detectors in lib/brain/security run over a graph of ' +
  'the SOURCE (authorizers, verdict calls, publication sinks, predicate implementations), and ' +
  'the console reads Azure Resource Graph, not the repository it was built from, so the ' +
  'extractor is a build-time artifact. When it is missing, stale, or produced by a different ' +
  'extractor version, the risk lane below reports what WOULD have been examined and refuses to ' +
  'report a count of zero as an absence of risk.';

/**
 * Load the security graph for this deployment.
 *
 * Delegates to the extraction package's runtime half, which re-validates the
 * committed artifact — version, provenance, node count, age, join coverage —
 * before handing it over. It never throws: every failure degrades to a refusal
 * carrying its own specific reason, because a 500 here would hide which of the
 * five it was.
 */
export function loadSecurityGraph(): SecurityGraphSource {
  return loadExtractedSecurityGraph();
}
