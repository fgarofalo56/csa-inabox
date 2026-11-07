/**
 * resize-keyboard — keyboard contract for a resize divider (StackedSplit).
 *
 * Arrow            ±KEY_STEP  (24 px)
 * Shift+Arrow      ±KEY_STEP_LARGE (96 px)
 * PageUp/PageDown  ±KEY_STEP_LARGE (96 px)   (PageUp grows, matching SplitPane)
 * Home / End       jump to the pane's min / max
 *
 * "Grow" is Down (vertical stack) or Right (horizontal stack): the divider
 * moves forward, so the pane BEFORE the divider gets larger.
 *
 * Pure (no DOM) so the mapping is unit-testable. Written fresh for
 * StackedSplit; SplitPane / ResizableCanvas keep their own inline handlers.
 */

/** Pixels moved per Arrow press. */
export const KEY_STEP = 24;
/** Pixels moved per Shift+Arrow / PageUp / PageDown press. */
export const KEY_STEP_LARGE = 96;

export type ResizeKeyAction =
  | { kind: 'delta'; px: number }
  | { kind: 'edge'; edge: 'min' | 'max' };

export interface ResizeKeyEventLike {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}

export function resolveResizeKey(
  e: ResizeKeyEventLike,
  orientation: 'vertical' | 'horizontal',
): ResizeKeyAction | null {
  // Browser / OS chords (Alt+Left = back, Ctrl+Home, ...) are not ours.
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  const grow = orientation === 'vertical' ? 'ArrowDown' : 'ArrowRight';
  const shrink = orientation === 'vertical' ? 'ArrowUp' : 'ArrowLeft';
  const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
  switch (e.key) {
    case grow: return { kind: 'delta', px: step };
    case shrink: return { kind: 'delta', px: -step };
    case 'PageUp': return { kind: 'delta', px: KEY_STEP_LARGE };
    case 'PageDown': return { kind: 'delta', px: -KEY_STEP_LARGE };
    case 'Home': return { kind: 'edge', edge: 'min' };
    case 'End': return { kind: 'edge', edge: 'max' };
    default: return null;
  }
}
