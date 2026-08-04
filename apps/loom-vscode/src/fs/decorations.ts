/**
 * PURE 4-state mirror decoration model (no `vscode` import) — the state machine
 * behind the tree/file decorations (N7), unit-testable in isolation.
 *
 * The four states Fabric's own extension uses (we copy the model — it is good):
 *   • `remote`   — remote-only, no local copy      → no badge (default)
 *   • `local`    — downloaded, identical to remote  → **L**, green
 *   • `modified` — edited locally, not published    → **M**, yellow
 *   • `conflict` — diverged from remote             → **C**, red
 *
 * States are derived from three content hashes:
 *   • `base`   — the remote hash captured at download time
 *   • `local`  — the current local file hash (undefined ⇒ not downloaded)
 *   • `remote` — the current remote hash (undefined ⇒ not refreshed ⇒ == base)
 *
 * `conflict` covers BOTH "you edited and remote also moved" and "remote moved
 * while your copy is clean" — in every conflict case the resolution is the same
 * user action (Update / Publish opens a diff), and Publish's `If-Match` makes a
 * silent clobber impossible regardless. `modified` is reserved for the case
 * where only the local side has changed, so **M** always means "you have edits
 * to publish".
 */

export type MirrorState = 'remote' | 'local' | 'modified' | 'conflict';

export interface MirrorHashes {
  /** Remote hash at download time. */
  base?: string;
  /** Current local file hash — undefined when there is no local copy. */
  local?: string;
  /** Current remote hash — undefined until refreshed (then defaults to `base`). */
  remote?: string;
}

/** Derive the mirror state from the three hashes. Total + deterministic. */
export function computeMirrorState({ base, local, remote }: MirrorHashes): MirrorState {
  if (local === undefined) return 'remote';
  const rem = remote ?? base;
  if (rem !== undefined && local === rem) return 'local';
  const localEdited = base !== undefined && local !== base;
  const remoteMoved = base !== undefined && rem !== undefined && rem !== base;
  if (localEdited && remoteMoved) return 'conflict';
  if (localEdited && !remoteMoved) return 'modified';
  if (!localEdited && remoteMoved) return 'conflict'; // remote advanced under a clean copy → reconcile via Update
  // base unknown but local != remote → treat as an unpublished edit
  return 'modified';
}

/** The presentation of a decoration state — a badge letter, colour id, tooltip. */
export interface DecorationSpec {
  /** One-letter badge (VS Code caps FileDecoration badges at 2 chars). */
  badge: string;
  /** A `vscode.ThemeColor` id (the provider wraps it). */
  colorId: string;
  tooltip: string;
}

/**
 * The decoration for a state, or `undefined` for `remote` (no badge). Colour ids
 * are built-in theme colours so the M/yellow, L/green, C/red intent holds across
 * light + dark themes without contributing custom colours.
 */
export function decorationFor(state: MirrorState): DecorationSpec | undefined {
  switch (state) {
    case 'remote':
      return undefined;
    case 'local':
      return {
        badge: 'L',
        colorId: 'gitDecoration.addedResourceForeground', // green
        tooltip: 'Downloaded — identical to the workspace copy',
      };
    case 'modified':
      return {
        badge: 'M',
        colorId: 'gitDecoration.modifiedResourceForeground', // yellow/amber
        tooltip: 'Edited locally — not yet published',
      };
    case 'conflict':
      return {
        badge: 'C',
        colorId: 'gitDecoration.conflictingResourceForeground', // red
        tooltip: 'Conflict — the workspace copy changed; use Update to reconcile',
      };
  }
}
