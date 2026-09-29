/**
 * LOOM BRAIN — SECURITY GRAPH EXTRACTION.
 *
 * The producer for `lib/brain/security`'s nine detectors.
 *
 * Measured on `main` before this landed (2026-08-24, re-verified independently
 * after a correction to the original brief):
 *
 *     $ grep -rn "SecurityGraph" --include=*.ts lib app | grep -v "lib/brain/security/"
 *     lib/brain/__tests__/security/fixtures/corpus.ts:53:  SecurityGraph,
 *     lib/brain/__tests__/security/fixtures/corpus.ts:723:export function cleanBaseline(): SecurityGraph {
 *     lib/brain/__tests__/security/fixtures/corpus.ts:847:): SecurityGraph {
 *
 * Three matches, all in ONE test fixture. A fixture is a `'modelled'` graph by
 * construction — `substrate.ts` carries that provenance in the data precisely so
 * it cannot be mistaken for a measurement. So nothing produced an `'extracted'`
 * graph, the detectors had never run against this repository, and #3992's risk
 * lane shipped permanently NOT EVALUATED. This package is that producer.
 *
 * ── WHY IT MUST BE A BUILD-TIME ARTIFACT ─────────────────────────────────
 *
 * The detectors reason about SOURCE: which function reads an admin claim, whether
 * a caller consumed a verdict as a refusal, which access path reaches a
 * publication sink. The deployed console can read Azure Resource Graph; it has no
 * checkout of the repository it was built from and never will. So the extraction
 * cannot happen at request time, at start-up, or on a schedule in the container.
 *
 * It happens once, at build time, over the real tree, and the result ships INSIDE
 * the image as a committed JSON artifact that the runtime imports statically. See
 * `runtime.ts` for why a static import rather than a file read, and why that is
 * what makes the artifact cloud-neutral by construction.
 *
 * ── ENTRY POINTS ─────────────────────────────────────────────────────────
 *
 *   Build time  `buildSecurityGraphArtifact()`  — pure; the CLI feeds it files.
 *   Run time    `loadExtractedSecurityGraph()`  — returns the seam's
 *                                                 `SecurityGraphSource`, which
 *                                                 can say "not evaluated, here is
 *                                                 why" and frequently must.
 */

export {
  buildSecurityGraphArtifact,
  buildSecurityGraphExtraction,
  GENERATOR_VERSION,
  inputsDigest,
  serializeArtifact,
} from './build';
export { extractRouteNodes, parseAllowlistPrefixes } from './route-nodes';
export { extractPublicationNodes, parseDeclaredSinkCount } from './publications';
export {
  assertJoinCoversGraph,
  buildJoin,
  codeModuleJoinKey,
  DEPLOYABLE_UNITS,
  pathOfNodeId,
} from './join';
export { MAX_ARTIFACT_AGE_DAYS, ageInDays, resolveSecurityGraph } from './artifact';
export { IMAGE_BUILD_DATE_FILE, readImageBuildDate } from './build-date';
export { extractedArtifact, loadExtractedSecurityGraph } from './runtime';
export type { ResolveOptions, SecurityGraphSource } from './artifact';
export type { ImageBuildDate } from './build-date';
export type {
  ExtractionMeta,
  ExtractionRun,
  PaintedNode,
  ScanScopeCount,
  ScanScopeReport,
  SecurityGraphArtifact,
  SecurityGraphExtraction,
  SecurityGraphJoin,
  SkippedSubject,
  SourceFile,
  UnjoinedNode,
} from './types';
