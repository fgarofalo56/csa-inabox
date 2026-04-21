/**
 * useKeyboardShortcuts — global keyboard shortcut hook (CSA-0124(5)).
 *
 * Implements a small, predictable set of application-wide shortcuts:
 *   - `?`     Open the `/help` shortcut reference page.
 *   - `g d`   Go to Dashboard (`/`).
 *   - `g s`   Go to Sources.
 *   - `g p`   Go to Pipelines.
 *   - `g m`   Go to Marketplace.
 *   - `g a`   Go to Access Requests.
 *
 * Rules:
 *   - Shortcuts are ignored when focus is inside a form control
 *     (`<input>`, `<textarea>`, `<select>`, or `contenteditable`) so
 *     typing into a search box doesn't teleport the user.
 *   - The `g` prefix is a one-shot leader — it is armed by pressing `g`
 *     and disarmed after 1.5s of inactivity or after the next key.
 *   - All shortcuts are documented at `/help` and this hook is the
 *     single source of truth for their mapping.
 *
 * The hook returns the active leader key (or `null`) so UI can surface
 * a small indicator; consumers that don't need it can ignore the return.
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';

/**
 * Canonical list of shortcuts, exported so the `/help` page and any
 * future command palette can render a single source of truth.
 */
export interface ShortcutDefinition {
  keys: string;
  description: string;
  target?: string;
}

export const SHORTCUTS: readonly ShortcutDefinition[] = [
  { keys: '?', description: 'Open this keyboard shortcut reference', target: '/help' },
  { keys: 'g d', description: 'Go to Dashboard', target: '/dashboard' },
  { keys: 'g s', description: 'Go to Sources', target: '/sources' },
  { keys: 'g p', description: 'Go to Pipelines', target: '/pipelines' },
  { keys: 'g m', description: 'Go to Marketplace', target: '/marketplace' },
  { keys: 'g a', description: 'Go to Access Requests', target: '/access' },
  { keys: 'Esc', description: 'Close open modal or mobile sidebar' },
] as const;

const LEADER_TIMEOUT_MS = 1500;

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

/**
 * Install global keyboard shortcut listeners for the duration of the
 * consumer component's lifecycle. Returns the current leader key.
 *
 * `enabled` gates the whole mechanism so tests / SSR can disable it.
 */
export function useKeyboardShortcuts(enabled = true): string | null {
  const router = useRouter();
  const [leader, setLeader] = useState<string | null>(null);
  const leaderTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;

    const clearLeader = () => {
      if (leaderTimer.current) {
        clearTimeout(leaderTimer.current);
        leaderTimer.current = null;
      }
      setLeader(null);
    };

    const armLeader = (key: string) => {
      setLeader(key);
      if (leaderTimer.current) clearTimeout(leaderTimer.current);
      leaderTimer.current = setTimeout(() => setLeader(null), LEADER_TIMEOUT_MS);
    };

    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isEditableTarget(e.target)) return;

      // `?` (Shift + /) — open help.
      if (e.key === '?') {
        e.preventDefault();
        clearLeader();
        void router.push('/help');
        return;
      }

      // Leader-based "go to" shortcuts.
      if (leader === 'g') {
        const map: Record<string, string> = {
          d: '/dashboard',
          s: '/sources',
          p: '/pipelines',
          m: '/marketplace',
          a: '/access',
        };
        const destination = map[e.key.toLowerCase()];
        if (destination) {
          e.preventDefault();
          void router.push(destination);
        }
        clearLeader();
        return;
      }

      if (e.key.toLowerCase() === 'g') {
        armLeader('g');
      }
    };

    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
      if (leaderTimer.current) clearTimeout(leaderTimer.current);
    };
  }, [enabled, leader, router]);

  return leader;
}

export default useKeyboardShortcuts;
