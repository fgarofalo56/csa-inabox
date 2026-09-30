/**
 * LOOM BRAIN — SECURITY EXTRACTION: the runtime half.
 *
 * ── WHY THE ARTIFACT IS A STATIC IMPORT AND NOT A FILE READ ──────────────
 *
 * The obvious implementation is a `fs.readFileSync` of a path handed over in an
 * environment variable. It was rejected for three reasons, in increasing order
 * of importance:
 *
 * (The env var is deliberately not NAMED anywhere in this file. `check-env-sync.mjs`
 * scans console source for `LOOM_*` tokens and requires each to be emitted by
 * bicep, and it does not strip comments — so merely DISCUSSING a rejected env var
 * fails the build. Measured on PR #4022: naming it here cost four guardrail steps.
 * That is the same "a lexical scan cannot tell prose from code" problem this very
 * package solves with `blankNonCode` in source-facts.ts, which is why it is worth
 * recording rather than silently working around.)
 *
 *   1. Next.js file tracing decides what ships in the standalone output. A JSON
 *      file read through a runtime-computed path is not traced, so it would be
 *      absent from the image and the surface would report NOT EVALUATED forever
 *      — the failure would look exactly like the state this lane exists to end.
 *   2. It would need an env var, which `auto-bind-by-default.md` §5 forbids as a
 *      terminal user-facing state: "Set LOOM_X" is a violation, the value must be
 *      produced by the deploy. A static import needs no value at all.
 *   3. CLOUD PARITY, and this is the load-bearing one. A static import resolves
 *      identically in Commercial, GCC, GCC-High, IL5 and DoD because it resolves
 *      at BUILD time, in the image, before any cloud exists. There is no
 *      endpoint, no suffix, no ARM call and no filesystem layout that could
 *      differ per boundary. The artifact is cloud-neutral BY CONSTRUCTION rather
 *      than by testing, which is the only form of parity claim that does not need
 *      a per-cloud receipt to be believed.
 *
 * The ONE file this module does read is the image build date (`build-date.ts`),
 * and reason 1 does not bite it: file tracing never sees it because the
 * Dockerfile's runner stage writes it straight into `/app`, after the traced
 * standalone output is copied in. Its absence outside an image is a reported
 * state; inside one (`build-date.ts#IMAGE_CONTEXT_MARKERS`) it is a refusal.
 *
 * ── THE ONLY CHANGE #3992's SEAM NEEDS ───────────────────────────────────
 *
 * `app/api/admin/brain/_lib/security-source.ts#loadSecurityGraph` currently
 * returns `{ available: false, reason: NO_SECURITY_GRAPH_REASON }` unconditionally.
 * With this module present that becomes:
 *
 *     export function loadSecurityGraph(): SecurityGraphSource {
 *       return loadExtractedSecurityGraph();
 *     }
 *
 * — one line, same return type, every downstream consumer unchanged. That was the
 * shape #3992 asked for and it is deliberately not redesigned here.
 */

import type { SecurityGraphArtifact } from './types';
import { resolveSecurityGraph, type SecurityGraphSource } from './artifact';
import { readImageBuildDate, type ImageBuildDate } from './build-date';
import generated from './__generated__/security-graph.json';

/**
 * The committed artifact, or `null` before any extraction has run.
 *
 * The cast is confined to this one line on purpose. The JSON is produced by this
 * package's own generator from `buildSecurityGraphArtifact()`'s typed output, so
 * the shape is guaranteed at the point of WRITING; what a cast cannot guarantee is
 * that the file on disk was not hand-edited. That is exactly what
 * `resolveSecurityGraph` re-checks — version, provenance, node count and join
 * coverage are all re-validated below rather than trusted from the type.
 */
const ARTIFACT = (generated as { artifact: SecurityGraphArtifact | null }).artifact;

/**
 * The image build date, cached once it is SETTLED. The file is written at image
 * build time and cannot change under a running server, so `present`, `absent`
 * and `missing` hold for the life of the process. `unreadable` is NOT cached: a
 * transient `EMFILE` or `EACCES` would otherwise refuse the graph until restart,
 * so it is re-read on the next load. See `build-date.ts` for why the date is a
 * file in the image and not a field in the artifact.
 */
let imageBuiltAt: ImageBuildDate | undefined;

/** Load the security graph shipped with this build. */
export function loadExtractedSecurityGraph(): SecurityGraphSource {
  const built = imageBuiltAt ?? readImageBuildDate();
  if (built.state !== 'unreadable') imageBuiltAt = built;
  return resolveSecurityGraph(ARTIFACT, { now: new Date(), imageBuiltAt: built });
}

/**
 * The raw artifact, for surfaces that need the JOIN or the SCAN META rather than
 * the graph — the painted/unjoined split, the scan scopes, the skipped subjects.
 *
 * Returns `null` when nothing was generated. A caller must NOT use a non-null
 * return as evidence the graph is usable: that question is
 * {@link loadExtractedSecurityGraph}'s, and it refuses artifacts this getter
 * happily hands back (wrong version, zero nodes).
 */
export function extractedArtifact(): SecurityGraphArtifact | null {
  return ARTIFACT;
}

export type { SecurityGraphSource } from './artifact';
