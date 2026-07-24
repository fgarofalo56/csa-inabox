'use client';

/**
 * canvas-fullscreen — U9: full-screen (maximize) mode as a shared canvas-kit
 * feature. Neither ADF nor Fabric offers a true full-screen authoring canvas;
 * one implementation here puts EVERY Loom xyflow canvas ahead at once.
 *
 * Anatomy:
 *   • `CanvasFullscreenHost` — the provider + overlay. Wraps a canvas host
 *     (ResizableCanvasRegion embeds it automatically; hosts without the region
 *     wrap their canvas shell in it once). Inactive it renders
 *     `display: contents` so it is 100% layout-neutral; active it becomes a
 *     `position: fixed` inset-0 overlay (app chrome covered), flex column so
 *     the canvas child fills the viewport.
 *   • `useCanvasFullscreen()` — context read. `CanvasRightRail` consumes it to
 *     show the maximize/restore button on every rail inside a host — zero
 *     per-canvas wiring beyond the host wrap.
 *
 * Behaviour (per ws-ui-excellence.md U9):
 *   • Esc or F11 exits (and the rail button toggles) — the document-level
 *     listener respects `defaultPrevented` so dialogs/menus that consume Esc
 *     win first.
 *   • Focus management: focus moves into the maximized region on enter, Tab is
 *     trapped inside it, and focus RESTORES to the triggering element on exit.
 *   • Keyboard-announced: a visually-hidden `role="status"` live region
 *     announces enter ("… Press Escape to exit.") and exit.
 *   • Undo/redo, palette, rails, and all canvas state are preserved — the
 *     canvas subtree is NOT remounted; only the host's positioning changes.
 *   • Session-scoped BY DESIGN: nothing persists (unlike the resize grip).
 *
 * Kill-switch: the rail button is gated by the `u9-canvas-fullscreen` runtime
 * flag (FLAG0, default-ON fail-open); an already-maximized canvas always keeps
 * its Esc/F11 exit path regardless of the flag.
 *
 * Token discipline (web3-ui): colours/spacing/radii/shadows are Fluent
 * `tokens.*`. The only raw values are inherent stacking/geometry no token
 * expresses — the overlay z-index and the 1px visually-hidden announcer box —
 * each documented inline.
 *
 * This file has NO default export.
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import { Button, Tooltip, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { ArrowMaximize20Regular, ArrowMinimize20Regular } from '@fluentui/react-icons';
import { useRuntimeFlag } from '@/lib/components/ui/use-runtime-flag';

/** FLAG0 runtime kill-switch id (registered in lib/admin/runtime-flags.ts). */
export const U9_FULLSCREEN_FLAG_ID = 'u9-canvas-fullscreen';

/**
 * FLAG0 read, fail-open. `useRuntimeFlag` needs the app's QueryClientProvider
 * (always present under app/providers.tsx at runtime); bare jsdom mounts of an
 * adopting canvas have none and the hook throws synchronously. Provider
 * presence is fixed for the lifetime of a mount tree, so catching here is
 * hook-order-stable — and default-ON matches the kill-switch contract (the
 * flag subsystem can never take a surface down). Same pattern as U6's
 * `useDividerFlag` (editor-results-split.tsx).
 */
export function useCanvasFullscreenFlag(): boolean {
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useRuntimeFlag(U9_FULLSCREEN_FLAG_ID);
  } catch {
    return true;
  }
}

export interface CanvasFullscreenContextValue {
  /** True while the canvas host is maximized to the viewport. */
  isFullscreen: boolean;
  enter: () => void;
  exit: () => void;
  toggle: () => void;
}

const CanvasFullscreenContext = createContext<CanvasFullscreenContextValue | null>(null);

/**
 * Read the enclosing full-screen host. Returns `null` outside a
 * `CanvasFullscreenHost` — consumers (the rail) hide their control then.
 */
export function useCanvasFullscreen(): CanvasFullscreenContextValue | null {
  return useContext(CanvasFullscreenContext);
}

/** Tabbable-descendant query for the focus trap. */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), ' +
  'select:not([disabled]), [tabindex]:not([tabindex="-1"])';

const useStyles = makeStyles({
  // Layout-neutral while inactive: children participate in the parent's flex
  // layout exactly as if the host div did not exist (no new flex item, so the
  // region's flexShrink:0 contract with item-editor-chrome is untouched).
  inactive: {
    display: 'contents',
  },
  active: {
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    // Inherent stacking (no token): above the app shell chrome (zIndex 10) and
    // page content, below the docked Copilot pane (1000) and Fluent portal
    // surfaces (dialogs/menus/tooltips) so in-canvas dialogs + per-surface
    // Copilot stay usable while maximized.
    zIndex: 950,
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: tokens.colorNeutralBackground2,
    padding: tokens.spacingHorizontalS,
    boxShadow: tokens.shadow64,
  },
  // The maximized canvas child fills the viewport. The announcer below is
  // position:absolute (out of flow) so this only stretches the real canvas.
  activeChildFill: {
    '& > *': {
      flexGrow: 1,
      minHeight: 0,
      minWidth: 0,
    },
  },
  // Visually-hidden live region (standard SR-only box — 1px is the inherent
  // "present but invisible" geometry, not a themable dimension).
  announcer: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
  },
});

export interface CanvasFullscreenHostProps {
  /** Accessible name for the maximized region (e.g. "Pipeline canvas"). */
  ariaLabel?: string;
  children: React.ReactNode;
}

/**
 * Provider + overlay for canvas full-screen mode. Wrap ONE per canvas host.
 * `ResizableCanvasRegion` embeds it, so every region adopter (eventstream,
 * estate, lineage, assets, domain designer, …) inherits full-screen with zero
 * wiring; hosts without the region (the pipeline canvas) wrap their shell.
 */
export function CanvasFullscreenHost({ ariaLabel, children }: CanvasFullscreenHostProps) {
  const styles = useStyles();
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const hostRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  // Render-synced mirror so enter/exit/toggle stay referentially stable while
  // still reading the live state (same pattern as resizable-canvas's refs).
  const isFullscreenRef = useRef(isFullscreen);
  isFullscreenRef.current = isFullscreen;

  const enter = useCallback(() => {
    if (isFullscreenRef.current) return;
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setIsFullscreen(true);
    setAnnouncement('Canvas is full screen. Press Escape to exit.');
  }, []);

  const exit = useCallback(() => {
    if (!isFullscreenRef.current) return;
    setIsFullscreen(false);
    setAnnouncement('Exited canvas full screen.');
  }, []);

  const toggle = useCallback(() => {
    // Route through enter/exit so focus bookkeeping + announcements stay
    // consistent no matter which control flips the state.
    if (isFullscreenRef.current) exit(); else enter();
  }, [enter, exit]);

  // While maximized: Esc/F11 exit (document-level, dialogs win via
  // defaultPrevented), body scroll locked, focus moved into the region;
  // cleanup restores scroll and returns focus to the triggering element.
  useEffect(() => {
    if (!isFullscreen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === 'Escape' || e.key === 'F11') {
        e.preventDefault();
        exit();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    hostRef.current?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
      restoreFocusRef.current?.focus({ preventScroll: true });
      restoreFocusRef.current = null;
    };
  }, [isFullscreen, exit]);

  // Focus trap: Tab wraps within the maximized host.
  const onTrapKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!isFullscreen || e.key !== 'Tab') return;
    const root = hostRef.current;
    if (!root) return;
    const focusables = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      .filter((el) =>
        el.getAttribute('aria-hidden') !== 'true' &&
        // Visible check (jsdom reports all-zero geometry — keep every candidate there).
        (typeof el.getClientRects !== 'function' || el.getClientRects().length > 0 ||
          el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement),
      );
    if (focusables.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === root)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }, [isFullscreen]);

  const ctx = useMemo<CanvasFullscreenContextValue>(
    () => ({ isFullscreen, enter, exit, toggle }),
    [isFullscreen, enter, exit, toggle],
  );

  return (
    <CanvasFullscreenContext.Provider value={ctx}>
      <div
        ref={hostRef}
        className={isFullscreen
          ? mergeClasses(styles.active, styles.activeChildFill)
          : styles.inactive}
        data-canvas-fullscreen={isFullscreen ? 'true' : 'false'}
        role={isFullscreen ? 'region' : undefined}
        aria-label={isFullscreen ? (ariaLabel ?? 'Canvas full screen') : undefined}
        tabIndex={isFullscreen ? -1 : undefined}
        onKeyDown={onTrapKeyDown}
      >
        {children}
        <div aria-live="polite" role="status" className={styles.announcer}>
          {announcement}
        </div>
      </div>
    </CanvasFullscreenContext.Provider>
  );
}

export interface CanvasFullscreenRailButtonProps {
  /** True when rendered inside the rail's collapsed state. */
  collapsed?: boolean;
}

/**
 * The maximize/restore rail button — rendered by `CanvasRightRail` so every
 * canvas inside a `CanvasFullscreenHost` carries the control automatically.
 * Renders nothing outside a host. The FLAG0 kill-switch hides the ENTER
 * affordance only: a canvas ALREADY maximized always keeps its exit button
 * (+ Esc/F11) so nobody is stranded. In the collapsed rail only the exit
 * state shows (the enter affordance lives in the expanded rail).
 */
export function CanvasFullscreenRailButton({ collapsed }: CanvasFullscreenRailButtonProps) {
  const fullscreen = useCanvasFullscreen();
  const flagOn = useCanvasFullscreenFlag();
  if (!fullscreen) return null;
  const { isFullscreen, toggle } = fullscreen;
  if (!isFullscreen && (!flagOn || collapsed)) return null;
  return (
    <Tooltip content={isFullscreen ? 'Exit full screen (Esc)' : 'Full screen'} relationship="label">
      <Button
        size="small"
        appearance="subtle"
        icon={isFullscreen ? <ArrowMinimize20Regular /> : <ArrowMaximize20Regular />}
        aria-label={isFullscreen ? 'Exit full screen' : 'Full screen'}
        aria-pressed={isFullscreen}
        data-canvas-fullscreen-toggle=""
        onClick={toggle}
      />
    </Tooltip>
  );
}
