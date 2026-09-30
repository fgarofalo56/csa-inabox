/**
 * LOOM BRAIN — SECURITY EXTRACTION: when was THIS IMAGE built (#4798).
 *
 * ── WHY THE AGE SIGNAL LIVES IN THE IMAGE AND NOT IN THE ARTIFACT ────────
 *
 * The committed artifact used to carry `meta.generatedAt`, and `artifact.ts`
 * refused a graph older than 90 days. That timestamp differed on every run, so
 * every pair of PRs that regenerated the artifact conflicted on it (#4798), and
 * it was removed from the committed bytes.
 *
 * The refusal it fed was not redundant. In a sovereign boundary the console
 * cannot reach GitHub, so the deploy-status lane cannot say how far an image
 * trails `main`; an image left running for six months would render a six-month-
 * old security picture of the `.github/**` and `scripts/**` half as current. The
 * age check was the only OFFLINE staleness signal.
 *
 * So the date moves to where it is true and where it cannot conflict: the
 * console `Dockerfile`'s runner stage writes the UTC build time to
 * {@link IMAGE_BUILD_DATE_FILE} beside `server.js`. Every console image build
 * path builds that one Dockerfile: ACR Tasks, the direct image build, the
 * Commercial full deploy, the blue/green roll, the Gov build and roll, and the
 * public GHCR channel. So every cloud gets the file with no per-workflow
 * plumbing, and nothing is committed.
 *
 * ── FOUR STATES, BECAUSE "NO FILE" MEANS TWO THINGS ──────────────────────
 *
 * `absent` is a run that never came from a built image: `next dev`, a test run.
 * It is reported as exactly that and NOT refused, because refusing every local
 * build would teach everyone to ignore the refusal.
 *
 * `missing` is the same missing file in a directory that IS a built image,
 * because it holds an {@link IMAGE_CONTEXT_MARKERS} file. Every console image
 * build writes the date, so a built image without one cannot say how old its
 * graph is, and `artifact.ts` refuses it. Without this state, anything that made
 * the date unfindable in a deployed image would turn the refusal off in every
 * cloud and leave only a caption (round-3 review of #4803).
 *
 * `unreadable` is a file that exists and could not be read. That establishes
 * nothing about the age, so `artifact.ts` refuses it rather than guessing
 * (`deploy-integrity.md` R7).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The file the console Dockerfile writes, relative to the server's working
 * directory (`/app`, where `server.js` runs). `image-build-date.test.ts` lifts
 * this constant and asserts the Dockerfile writes exactly this name.
 */
export const IMAGE_BUILD_DATE_FILE = 'loom-image-built-at.txt';

/**
 * Files that exist beside the date in every image the console Dockerfile builds,
 * and in no checkout, `next dev` or test run:
 *
 * - `server.js` is the Next standalone entry, which the runner's `CMD` starts.
 * - `public/build-marker.txt` is written by the SAME `RUN` instruction that writes
 *   the date.
 *
 * Either one marks the directory as a built image. `image-build-date.test.ts`
 * asserts the Dockerfile produces both.
 */
export const IMAGE_CONTEXT_MARKERS: readonly string[] = Object.freeze(['server.js', 'public/build-marker.txt']);

export type ImageBuildDate =
  /** The file was read. `value` is its trimmed text, NOT yet validated as a date. */
  | { readonly state: 'present'; readonly value: string }
  /** No date, and no image marker beside it: a local or test run. */
  | { readonly state: 'absent' }
  /** No date, in a directory that IS a built image. `markers` names what was found. */
  | { readonly state: 'missing'; readonly markers: readonly string[] }
  /** The file exists but could not be read; `detail` is the error code. */
  | { readonly state: 'unreadable'; readonly detail: string };

/** Read the image build date from `dir` (the server's working directory by default). */
export function readImageBuildDate(dir: string = process.cwd()): ImageBuildDate {
  try {
    return { state: 'present', value: readFileSync(join(dir, IMAGE_BUILD_DATE_FILE), 'utf8').trim() };
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    if (code === 'ENOENT') {
      const markers = IMAGE_CONTEXT_MARKERS.filter((m) => existsSync(join(dir, m)));
      return markers.length > 0 ? { state: 'missing', markers } : { state: 'absent' };
    }
    return { state: 'unreadable', detail: typeof code === 'string' ? code : String(e) };
  }
}
