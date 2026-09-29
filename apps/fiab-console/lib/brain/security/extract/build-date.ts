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
 * path (ACR Tasks, the Commercial full deploy, the blue/green roll, the Gov build
 * and roll, the public GHCR channel) builds that one Dockerfile, so every cloud
 * gets the file with no per-workflow plumbing, and nothing is committed.
 *
 * ── THREE STATES, BECAUSE "I COULD NOT READ IT" IS NOT "IT IS NOT THERE" ──
 *
 * `absent` is a build that never ran the Dockerfile — `next dev`, a test run.
 * It is reported as exactly that and NOT refused: refusing every local build
 * would teach everyone to ignore the refusal. `unreadable` is a file that exists
 * and could not be read; that establishes nothing about the age, so
 * `artifact.ts` refuses it rather than guessing (`deploy-integrity.md` R7).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The file the console Dockerfile writes, relative to the server's working
 * directory (`/app`, where `server.js` runs). `image-build-date.test.ts` lifts
 * this constant and asserts the Dockerfile writes exactly this name.
 */
export const IMAGE_BUILD_DATE_FILE = 'loom-image-built-at.txt';

export type ImageBuildDate =
  /** The file was read. `value` is its trimmed text, NOT yet validated as a date. */
  | { readonly state: 'present'; readonly value: string }
  /** No such file: this process was not started from an image the Dockerfile built. */
  | { readonly state: 'absent' }
  /** The file exists but could not be read; `detail` is the error code. */
  | { readonly state: 'unreadable'; readonly detail: string };

/** Read the image build date from `dir` (the server's working directory by default). */
export function readImageBuildDate(dir: string = process.cwd()): ImageBuildDate {
  try {
    return { state: 'present', value: readFileSync(join(dir, IMAGE_BUILD_DATE_FILE), 'utf8').trim() };
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    if (code === 'ENOENT') return { state: 'absent' };
    return { state: 'unreadable', detail: typeof code === 'string' ? code : String(e) };
  }
}
