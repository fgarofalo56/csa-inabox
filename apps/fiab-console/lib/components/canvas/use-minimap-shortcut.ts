'use client';

/**
 * useMinimapShortcut — binds the `M` key (canvas-shortcuts.ts `toggle-minimap`)
 * at the DOCUMENT level, so it works on every canvas rendering a `<MiniMap>`
 * without editing that host's own keydown switch statement.
 *
 * Why document-level, not a per-host `onKeyDown` case: only 2 of the 24 real
 * canvas hosts (`pipeline/canvas.tsx`, `logic-app/workflow-designer-canvas.tsx`)
 * have a hand-rolled keydown handler with their own single-letter shortcuts
 * (I/O/F/N) at all — the other 22 have none. Adding `M` consistently would
 * otherwise mean either editing 2 existing switch statements AND inventing one
 * from scratch in 22 more files, or leaving most hosts without the shortcut.
 * One hook, mounted once per host, covers all 24 (plus the 2 that already have
 * a handler — this hook does not touch or conflict with their existing keys).
 *
 * Guard: identical tagName/isContentEditable check already used by
 * `pipeline/canvas.tsx`'s own `handleKeyDown` (INPUT/TEXTAREA/SELECT/
 * contentEditable), so typing `m` in a node label, a Monaco editor (its hidden
 * input is a real `<textarea>`), or any form field never toggles the minimap.
 */

import { useEffect } from 'react';

function isEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' || target.isContentEditable
  );
}

export function useMinimapShortcut(onToggle: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (e.key !== 'm' && e.key !== 'M') return;
      if (isEditingTarget(e.target)) return;
      e.preventDefault();
      onToggle();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onToggle, enabled]);
}
