/**
 * Merge policy for the per-editor tutorials `tools/uat-report.mjs` generates
 * into `docs/fiab/tutorials/`.
 *
 * The generator emits a block that ends with `END_MARKER`. Historically it then
 * did a full `writeFileSync`, which destroyed every hand-written word in the
 * file while the emitted banner claimed those words were preserved. This module
 * is the single place that decides what survives a regeneration, so the claim in
 * the banner and the behaviour on disk cannot drift apart again.
 *
 * Three states a tutorial file can be in:
 *
 * - **new** — no file on disk. Write the generated doc.
 * - **generated** — the file carries `END_MARKER`. Everything above/inside the
 *   marker is regenerated from the catalog `learnContent`; everything below it
 *   is the author's and is re-appended verbatim.
 * - **authored** — the file exists but has NO marker, i.e. an author replaced
 *   the generated doc wholesale (58 of the 124 indexed tutorials carry the
 *   marker; the other 66 are fully hand-written). Overwriting one destroys the
 *   entire guide, so the generator SKIPS it and warns instead. This is the case
 *   the first version of the "preservation" fix silently failed open on.
 *
 * The marker is located with `indexOf`, not `lastIndexOf`: the generated block
 * emits exactly one marker and it is always the first occurrence, so an authored
 * tail that quotes the marker (e.g. a section documenting this very contract)
 * no longer truncates the tail at its own mention.
 */

export const END_MARKER = '<!-- end auto-generated -->';

/**
 * Decide what to write for one tutorial.
 *
 * @param {string} generated  The freshly generated block (ends with END_MARKER).
 * @param {string|null|undefined} existing  Current file contents, or null/undefined
 *   when the file does not exist.
 * @returns {{ mode: 'new'|'generated'|'authored', action: 'write'|'skip',
 *             content: string|null, tail: string }}
 */
export function mergeTutorial(generated, existing) {
  if (existing === null || existing === undefined) {
    return { mode: 'new', action: 'write', content: generated, tail: '' };
  }
  const i = existing.indexOf(END_MARKER);
  if (i === -1) {
    // 100% hand-authored — regenerating would delete the whole guide.
    return { mode: 'authored', action: 'skip', content: null, tail: '' };
  }
  const tail = existing.slice(i + END_MARKER.length).replace(/^\s*\n/, '');
  return {
    mode: 'generated',
    action: 'write',
    content: tail ? `${generated}\n\n${tail}` : generated,
    tail,
  };
}
