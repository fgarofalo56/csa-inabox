/**
 * LOOM BRAIN — SECURITY EXTRACTION: refusing an artifact that cannot be trusted.
 *
 * ── THE STATE THIS FILE EXISTS TO MAKE REACHABLE ─────────────────────────
 *
 * `SecurityGraph.source` has exactly three members — `'modelled' | 'extracted' |
 * 'observed'` — and NONE of them means "there is no graph". So the type cannot
 * represent absence, and a producer that must nevertheless answer something has
 * only two honest options: return a real graph, or return a refusal in a wrapper
 * type that CAN say no. This file is the second.
 *
 * The failure it prevents is specific and this repo has shipped it: an UNKNOWN
 * reported as a NEGATIVE. A sweep over an empty or wrong-version graph produces zero
 * security findings, and zero findings renders identically to "we looked and the
 * estate is clean". The distinction is invisible downstream unless it is refused
 * HERE, before a detector ever runs.
 *
 * A live instance of exactly that pattern sits one directory away and is worth
 * naming so it is not copied: `lib/brain/live-graph.ts:215` hard-codes
 * `configured.collected: true` regardless of whether the env read actually
 * succeeded, which makes a NOT-EVALUATED state unreachable on that lane. Nothing
 * in this file may be written that way. Every refusal below is reachable, and
 * `__tests__/artifact.test.ts` reaches every one of them — a guard whose refusal
 * branch no test can enter is not a guard.
 *
 * ── WHY A ZERO-NODE GRAPH IS REFUSED RATHER THAN SWEPT ───────────────────
 *
 * Handing an empty graph to the detectors is TEMPTING and is nearly right: all
 * nine would synthesise `POP-population-integrity` findings reading "examined an
 * EMPTY population — green and blind", which is the correct sentiment. It is
 * still refused, because a consumer that filters to SECURITY findings — which
 * `securityFindingsOf()` exists to do, and which any "how many risks?" count will
 * do — gets zero, and zero is indistinguishable from clean. The refusal is not
 * redundant with the detectors' own contract; it covers the reader the detectors'
 * contract cannot reach.
 */

import type { SecurityGraph } from '../substrate';
import type { SecurityGraphArtifact } from './types';
import { GENERATOR_VERSION } from './build';
import { assertJoinCoversGraph } from './join';
import { IMAGE_BUILD_DATE_FILE, type ImageBuildDate } from './build-date';

/**
 * The seam's contract, restated structurally.
 *
 * Byte-compatible with `app/api/admin/brain/_lib/security-source.ts`'s
 * `SecurityGraphSource` (introduced by #3992), so that seam's
 * `loadSecurityGraph()` can `return loadExtractedSecurityGraph();` and change
 * nothing else. It is declared here rather than imported because that file lives
 * on the #3992 branch and not on `main` — importing it would make this package
 * depend on an unmerged PR.
 */
export type SecurityGraphSource =
  | {
      readonly available: true;
      readonly graph: SecurityGraph;
      /**
       * What is known about the graph's age, in the operator's words. Always set
       * by {@link resolveSecurityGraph}; optional only so hand-built test sources
       * need not invent one.
       */
      readonly ageNote?: string;
      /**
       * `false` exactly when the age was NOT checked (a local run with no image
       * build date), so a surface can render that as a warning without parsing
       * the note. Set with `ageNote` by {@link resolveSecurityGraph}.
       */
      readonly ageChecked?: boolean;
    }
  | { readonly available: false; readonly reason: string };

/**
 * How old the IMAGE may be before its graph is refused as stale.
 *
 * The graph is committed and baked into the image, so a graph shipped in an
 * image built N days ago is at least N days old. The refusal is therefore sound:
 * a stale image means a stale graph. The bound runs one way only. A pass does
 * NOT prove the graph is fresh, because a fresh build of an old ref passes. An
 * image left running for six months carries a security picture at least six
 * months old, and rendering that as current is the stale-read defect. 90 days is
 * deliberately generous: this refuses an ABANDONED estate, not a slightly-behind
 * one.
 *
 * WHERE THE DATE COMES FROM (#4798). Not from the committed artifact: its
 * `generatedAt` differed on every run, so every pair of PRs that regenerated the
 * artifact conflicted on it, and it was removed. The console Dockerfile writes
 * the build date into the image instead (`build-date.ts`), where it is true and
 * never committed. In a sovereign boundary the deploy-status lane cannot reach
 * GitHub to say how far an image trails `main`, so this is the only OFFLINE
 * staleness signal for the `.github/**` and `scripts/**` half of the graph.
 *
 * WHAT `--check` DOES AND DOES NOT ESTABLISH. The drift job re-extracts and
 * compares on each PR and again on every push to `main`. Branch protection is
 * `strict: false`, so a PR's check ran against the base it was last updated to,
 * not the tip it merged into: two PRs that each pass can merge cleanly into an
 * artifact that is the extraction of neither tree. The run on `main` goes red on
 * that drift, but it does not gate the console roll (#4807) — so an image built
 * from `main` is NOT guaranteed to carry its own source's extraction.
 */
export const MAX_ARTIFACT_AGE_DAYS = 90;

/** Shared prefix so every refusal reads as the same, deliberate state. */
const NOT_EVALUATED =
  'NOT EVALUATED — no risk verdict has been drawn, and this is NOT a clean result.';

export interface ResolveOptions {
  readonly now: Date;
  /** What `readImageBuildDate()` found. Required, so no caller can skip the age check. */
  readonly imageBuiltAt: ImageBuildDate;
  readonly maxAgeDays?: number;
}

/**
 * How far in the FUTURE a build date may sit before it is treated as wrong
 * rather than as clock skew between the build agent and the console host.
 */
const FUTURE_TOLERANCE_DAYS = 1;

/**
 * Decide whether an artifact may be swept, or why it may not.
 *
 * Never throws: a malformed artifact must degrade to an honest refusal on the
 * surface, not to a 500 that hides the reason.
 */
export function resolveSecurityGraph(
  artifact: SecurityGraphArtifact | null,
  options: ResolveOptions,
): SecurityGraphSource {
  if (artifact === null) {
    return {
      available: false,
      reason:
        `${NOT_EVALUATED} No extracted security graph shipped with this build. The nine ` +
        'detectors in lib/brain/security run over a graph of the SOURCE (authorizers, verdict ' +
        'calls, publication sinks), and the console reads Azure Resource Graph, not the ' +
        'repository it was built from — so the graph has to be produced at build time by ' +
        '`scripts/brain/extract-security-graph.mjs` and committed. It was not, so nothing was ' +
        'examined.',
    };
  }

  // SHAPE CHECK BEFORE ANY FIELD READ.
  //
  // The artifact is a JSON file on disk. A cast at the import boundary says what
  // it SHOULD be, and says nothing about what it IS after a bad merge, a partial
  // write or a hand-edit. Reading `meta.generatorVersion` off a malformed
  // artifact throws, and an exception here becomes a 500 that hides the reason —
  // the opposite of the honest refusal this module exists to produce.
  if (
    typeof artifact !== 'object' ||
    artifact.graph === null ||
    typeof artifact.graph !== 'object' ||
    !Array.isArray(artifact.graph.nodes) ||
    artifact.meta === null ||
    typeof artifact.meta !== 'object' ||
    artifact.join === null ||
    typeof artifact.join !== 'object'
  ) {
    return {
      available: false,
      reason:
        `${NOT_EVALUATED} The shipped artifact is malformed — it does not carry the graph, join ` +
        'and meta an extraction produces. It cannot be swept, and it is refused rather than ' +
        'partially read, because a partial read would report a smaller population as a complete one.',
    };
  }

  if (artifact.meta.generatorVersion !== GENERATOR_VERSION) {
    return {
      available: false,
      reason:
        `${NOT_EVALUATED} The shipped graph was produced by extractor version ` +
        `${artifact.meta.generatorVersion}, and this build expects ${GENERATOR_VERSION}. The ` +
        'extraction semantics changed between them, so the facets this graph carries are not ' +
        "the facts today's detectors read. Re-run the extractor and commit the result.",
    };
  }

  if (artifact.graph.source !== 'extracted') {
    return {
      available: false,
      reason:
        `${NOT_EVALUATED} The shipped graph declares source '${artifact.graph.source}', not ` +
        "'extracted'. A 'modelled' graph is hand-authored from the taxonomy's described shapes " +
        'and is NOT an estate measurement; rendering one as a live verdict is the precise error ' +
        'deploy-integrity R7 forbids.',
    };
  }

  if (artifact.graph.nodes.length === 0) {
    return {
      available: false,
      reason:
        `${NOT_EVALUATED} The shipped graph contains ZERO nodes. A sweep over it would report ` +
        'zero security findings, which is indistinguishable from a clean estate — so it is ' +
        'refused rather than swept. Either the extractor matched no files or its analyzers ' +
        'emitted nothing: run `node scripts/brain/extract-security-graph.mjs --check`, whose ' +
        'output prints the files matched and nodes emitted per scan scope (those counts are ' +
        'printed per run, not committed).',
    };
  }

  const age = resolveAge(options);
  if (!age.ok) return { available: false, reason: `${NOT_EVALUATED} ${age.reason}` };

  try {
    assertJoinCoversGraph(artifact.join, artifact.graph.nodes);
  } catch (e) {
    return {
      available: false,
      reason:
        `${NOT_EVALUATED} The shipped graph's estate join does not account for every node: ` +
        `${e instanceof Error ? e.message : String(e)} A finding on an unaccounted node would ` +
        'render on no surface, so the artifact is refused rather than partially trusted.',
    };
  }

  return { available: true, graph: artifact.graph, ageNote: age.note, ageChecked: age.checked };
}

type AgeVerdict =
  | { readonly ok: true; readonly note: string; readonly checked: boolean }
  | { readonly ok: false; readonly reason: string };

/**
 * The age half of the decision. Every branch names what was, and was not,
 * established. "absent" is reported, not refused, because a local run never came
 * from a built image. A built image with no date ("missing"), or a date that is
 * present but unusable, IS refused: an image that cannot state its build date
 * cannot say how old its graph is.
 */
function resolveAge(options: ResolveOptions): AgeVerdict {
  const built = options.imageBuiltAt;
  const maxAge = options.maxAgeDays ?? MAX_ARTIFACT_AGE_DAYS;
  const where = `\`${IMAGE_BUILD_DATE_FILE}\``;
  const unknownAge =
    "the graph's age cannot be established. An artifact whose age is unknown cannot be " +
    'certified current, and an unknown must not be reported as a negative.';

  if (built.state === 'absent') {
    return {
      ok: true,
      checked: false,
      note:
        `No image build date (${where}) and no built-image marker were found beside this ` +
        "server, so it is treated as a local development run and the graph's age was NOT " +
        'checked. An image built by the console Dockerfile carries the date, and a directory ' +
        'holding such an image without it is refused.',
    };
  }
  if (built.state === 'missing') {
    return {
      ok: false,
      reason:
        `This server's directory carries an image-context marker (found ${built.markers.join(', ')}) ` +
        `but not the image build date ${where}, so ${unknownAge} The console Dockerfile ` +
        'writes the marker and the date together in every image it builds, so either this ' +
        'directory was not populated by it, or the date file was removed afterward.',
    };
  }
  if (built.state === 'unreadable') {
    return {
      ok: false,
      reason: `The image build date ${where} exists but could not be read (${built.detail}), so ${unknownAge}`,
    };
  }

  const age = ageInDays(built.value, options.now);
  if (age === null) {
    return {
      ok: false,
      reason:
        `The image build date in ${where} is unparseable ('${built.value.slice(0, 64)}'; ` +
        `expected the Dockerfile's YYYY-MM-DDTHH:MM:SSZ), so ${unknownAge}`,
    };
  }
  if (age < -FUTURE_TOLERANCE_DAYS) {
    return {
      ok: false,
      reason:
        `The image build date in ${where} (${built.value}) is ${(-age).toFixed(1)} days in the ` +
        "future, so either it or this host's clock is wrong and the graph's age cannot be " +
        'established.',
    };
  }
  if (age > maxAge) {
    return {
      ok: false,
      reason:
        `This image was built ${Math.floor(age)} days ago (${built.value}, ceiling ${maxAge} ` +
        'days). The security graph committed in it is at least that old, so it is reported as ' +
        'STALE rather than rendered as the current state. Rebuild and roll the console image to ' +
        'refresh it.',
    };
  }
  return {
    ok: true,
    checked: true,
    note:
      `Image built ${built.value} (${Math.max(0, Math.floor(age))} of ${maxAge} days); this is ` +
      'the graph committed in that image. This server does not check that the graph matches ' +
      "the image's source: CI's `--check` does, and it does not gate the roll (#4807).",
  };
}

/**
 * The exact shape the console Dockerfile writes (`date -u +%Y-%m-%dT%H:%M:%SZ`).
 * `Date.parse` alone is lenient: `'1'` parses as the year 2001, and a date with no
 * `T` or `Z` is read in LOCAL time. Either would turn a corrupt file into a
 * plausible age, so anything else is unparseable, which refuses.
 */
const IMAGE_BUILD_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** Whole and fractional days between the Dockerfile's timestamp and `now`. `null` if unparseable. */
export function ageInDays(isoTimestamp: string, now: Date): number | null {
  if (!IMAGE_BUILD_DATE_SHAPE.test(isoTimestamp)) return null;
  const then = Date.parse(isoTimestamp);
  if (Number.isNaN(then)) return null;
  return (now.getTime() - then) / 86_400_000;
}
