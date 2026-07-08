'use client';

/**
 * canvas-shortcuts — the SINGLE source of truth for every canvas keyboard
 * shortcut. Both the "?" cheat-sheet overlay (W20) and the command-palette
 * coverage (W21) read this one registry, so the two surfaces can never drift
 * from each other or from the keys `canvas.tsx` actually binds.
 *
 * `id` doubles as the canonical action id a command-palette entry invokes; the
 * host maps each id to its real canvas action (undo, redo, duplicate, align…).
 * Adding a shortcut here surfaces it in BOTH the overlay and the palette.
 */

export type CanvasShortcutGroup = 'History' | 'Clipboard' | 'Arrange' | 'View' | 'Navigate';

export interface CanvasShortcut {
  /** Canonical action id — also the command-palette command id. */
  id: string;
  /** Human key hint, e.g. "Ctrl+Z", "Shift+Arrows". */
  keys: string[];
  /** What the action does (imperative). */
  label: string;
  group: CanvasShortcutGroup;
  /**
   * Whether this shortcut is also exposed as an invokable command-palette
   * action (W21). Pure-pan/navigation keys that need live pointer context are
   * key-only. Defaults to true.
   */
  palette?: boolean;
}

/**
 * The canvas shortcut map. Ordered by group for the overlay. The first five
 * groups are the new W1/W2/W3 power layer; View/Navigate document the shortcuts
 * `canvas.tsx` already bound (I/O/F/A/N/Shift-arrows/Backspace) that were
 * previously discoverable only in code comments.
 */
export const CANVAS_SHORTCUTS: CanvasShortcut[] = [
  // --- History (W1) ---
  { id: 'undo', keys: ['Ctrl+Z'], label: 'Undo the last change', group: 'History' },
  { id: 'redo', keys: ['Ctrl+Shift+Z', 'Ctrl+Y'], label: 'Redo the last undone change', group: 'History' },
  // --- Clipboard (W2) ---
  { id: 'copy', keys: ['Ctrl+C'], label: 'Copy the selected node(s)', group: 'Clipboard' },
  { id: 'paste', keys: ['Ctrl+V'], label: 'Paste copied node(s) with an offset', group: 'Clipboard' },
  { id: 'duplicate', keys: ['Ctrl+D'], label: 'Duplicate the selected node(s) in place', group: 'Clipboard' },
  // --- Arrange (W3) ---
  { id: 'align-left', keys: ['Alt+A then L'], label: 'Align selection: left edges', group: 'Arrange' },
  { id: 'align-center-h', keys: ['Alt+A then C'], label: 'Align selection: horizontal centers', group: 'Arrange' },
  { id: 'align-right', keys: ['Alt+A then R'], label: 'Align selection: right edges', group: 'Arrange' },
  { id: 'align-top', keys: ['Alt+A then T'], label: 'Align selection: top edges', group: 'Arrange' },
  { id: 'align-middle', keys: ['Alt+A then M'], label: 'Align selection: vertical middles', group: 'Arrange' },
  { id: 'align-bottom', keys: ['Alt+A then B'], label: 'Align selection: bottom edges', group: 'Arrange' },
  { id: 'distribute-h', keys: ['Alt+A then H'], label: 'Distribute selection horizontally', group: 'Arrange' },
  { id: 'distribute-v', keys: ['Alt+A then V'], label: 'Distribute selection vertically', group: 'Arrange' },
  { id: 'auto-align', keys: ['A'], label: 'Auto-align the whole graph (ELK layout)', group: 'Arrange' },
  // --- View (already bound) ---
  { id: 'zoom-in', keys: ['I'], label: 'Zoom in', group: 'View' },
  { id: 'zoom-out', keys: ['O'], label: 'Zoom out', group: 'View' },
  { id: 'fit-view', keys: ['F'], label: 'Zoom to fit', group: 'View' },
  { id: 'toggle-nested', keys: ['N'], label: 'Toggle nested-activity preview', group: 'View', palette: true },
  { id: 'show-shortcuts', keys: ['?'], label: 'Show this keyboard shortcut list', group: 'View' },
  // --- Navigate (key-only; need pointer/canvas focus) ---
  { id: 'pan', keys: ['Shift+Arrows'], label: 'Pan the canvas', group: 'Navigate', palette: false },
  { id: 'drill-back', keys: ['Backspace'], label: 'Return to the previous (parent) canvas', group: 'Navigate' },
];

/** Groups in overlay display order. */
export const CANVAS_SHORTCUT_GROUPS: CanvasShortcutGroup[] = [
  'History', 'Clipboard', 'Arrange', 'View', 'Navigate',
];

/** Shortcuts eligible to appear as invokable command-palette actions (W21). */
export function paletteShortcuts(): CanvasShortcut[] {
  return CANVAS_SHORTCUTS.filter((sc) => sc.palette !== false);
}
