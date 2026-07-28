/**
 * Ambient types for `tutorial-merge.mjs`.
 *
 * The helper is plain ESM (it is imported by `tools/uat-report.mjs`, which runs
 * under node with no build step), but `__tests__/tutorial-merge.test.ts` is a
 * strict `.ts` file. The console's base tsconfig sets `allowJs: false` and
 * includes `**\/*.ts`, so that import resolved to an untyped module and raised
 * TS7016 — invisible in CI, which typechecks with `tsconfig.build.json`
 * (tests excluded), but a real error in the editor and for anything using the
 * base config.
 *
 * Declaring the surface here keeps the runtime helper as ESM while giving the
 * spec real types. Keep these signatures in step with the JSDoc on the .mjs.
 */

/** Marker closing the auto-generated block of a tutorial file. */
export const END_MARKER: string;

export interface TutorialMergeResult {
  /**
   * `new`       — no file on disk yet.
   * `generated` — file has the end marker; the block above it is regenerated
   *               and everything after it is preserved.
   * `authored`  — file has NO end marker, i.e. fully hand-written; never
   *               overwritten.
   */
  mode: 'new' | 'generated' | 'authored';
  action: 'write' | 'skip';
  /** Text to write, or `null` when `action` is `skip`. */
  content: string | null;
  /** Hand-authored text found after the end marker (`''` when there is none). */
  tail: string;
}

/**
 * Decide what to write for one tutorial.
 *
 * @param generated The freshly generated block (ends with `END_MARKER`).
 * @param existing  Current file contents, or `null`/`undefined` when absent.
 */
export function mergeTutorial(
  generated: string,
  existing: string | null | undefined,
): TutorialMergeResult;
