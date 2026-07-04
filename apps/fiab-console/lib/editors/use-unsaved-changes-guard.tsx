'use client';

/**
 * useUnsavedChangesGuard — shared "you have unsaved changes, leave anyway?"
 * guard for every editor. Wired once in ItemEditorChrome so every per-type
 * editor that threads a `dirty` signal gets it for free (rel-T70).
 *
 * Two navigation paths are covered:
 *
 *   1. Hard navigation — tab close, reload, typing a new URL, or following a
 *      link to another origin. Handled with a `beforeunload` listener, which
 *      makes the browser show its native "Leave site? Changes you made may not
 *      be saved." prompt. This is the only prompt the platform allows for hard
 *      navigation; the copy is fixed by the browser.
 *
 *   2. Soft navigation — an in-app Next.js App Router transition triggered by
 *      clicking an internal `<Link>` (rendered as an `<a href="/…">`). The
 *      App Router has NO built-in "abort this route change" API (unlike the
 *      Pages Router's `routeChangeStart` + `router.events`), so we intercept
 *      the click in the capture phase before Next's Link handler runs. If the
 *      editor is dirty we swallow the click and show a themed confirm dialog;
 *      on confirm we replay the navigation with `router.push`.
 *
 * KNOWN LIMITATION (documented, pragmatic): the click interceptor only covers
 * navigations that originate from an anchor element. Programmatic
 * `router.push()/replace()/back()` calls fired from editor code, and the
 * browser Back/Forward buttons (App Router does not surface a cancellable
 * popstate for these), are NOT intercepted by the soft-nav guard. `beforeunload`
 * does not fire on soft navigation either. In practice nearly all editor-exit
 * paths in Loom are anchor clicks (topbar, sidebar, breadcrumbs, tiles), so
 * this covers the overwhelming majority; the Next 15 App Router's experimental
 * `Link onNavigate` is not yet reliable across every transition and is avoided.
 *
 * Returns a ReactNode (the confirm dialog, or null). The caller renders it in
 * its tree — a hook can't mount JSX on its own.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Dialog, DialogSurface, DialogTitle, DialogContent, DialogActions, DialogBody, Button, tokens,
} from '@fluentui/react-components';
import { Warning24Regular } from '@fluentui/react-icons';

export function useUnsavedChangesGuard(dirty: boolean): React.ReactNode {
  const router = useRouter();
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  // Mirror `dirty` in a ref so the (once-registered) click listener always
  // reads the current value without re-subscribing on every keystroke.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // (1) Hard navigation — native browser prompt while dirty.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Chrome requires returnValue to be set for the prompt to appear.
      e.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // (2) Soft navigation — capture-phase click interceptor on internal links.
  useEffect(() => {
    const onClickCapture = (e: MouseEvent) => {
      if (!dirtyRef.current) return;
      // Let modified clicks (open-in-new-tab / middle-click) and already-handled
      // events through untouched.
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

      const anchor = (e.target as HTMLElement | null)?.closest('a');
      if (!anchor) return;

      const href = anchor.getAttribute('href');
      if (!href) return;
      // Only guard internal, same-tab, non-download navigations.
      if (anchor.target && anchor.target !== '_self') return;
      if (anchor.hasAttribute('download')) return;
      if (!href.startsWith('/') || href.startsWith('//')) return; // internal-only

      let dest: URL;
      try { dest = new URL(href, window.location.origin); } catch { return; }
      // No-op navigation to the current URL — don't prompt.
      if (dest.pathname === window.location.pathname && dest.search === window.location.search) return;

      // Swallow the click before Next's Link handler runs and open the dialog.
      e.preventDefault();
      e.stopPropagation();
      setPendingHref(href);
    };
    document.addEventListener('click', onClickCapture, true);
    return () => document.removeEventListener('click', onClickCapture, true);
  }, []);

  const confirmLeave = useCallback(() => {
    const href = pendingHref;
    setPendingHref(null);
    if (href) router.push(href);
  }, [pendingHref, router]);

  const cancelLeave = useCallback(() => setPendingHref(null), []);

  const dialog = pendingHref ? (
    <Dialog open modalType="alert" onOpenChange={(_, d) => { if (!d.open) cancelLeave(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
              <Warning24Regular style={{ color: tokens.colorStatusWarningForeground1 }} />
              Leave without saving?
            </span>
          </DialogTitle>
          <DialogContent>
            You have unsaved changes in this editor. If you leave now, those changes will be lost.
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={cancelLeave}>Stay on page</Button>
            <Button appearance="primary" onClick={confirmLeave}>Leave without saving</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  ) : null;

  return dialog;
}
