'use client';

/**
 * useInViewport — the shared "is this element on screen yet?" hook.
 *
 * WHY: a grid cell that kicks off its own network read from a mount effect
 * costs one request PER ROW the moment the table paints, whether or not the
 * user can see that row. On /admin/capacity that was ~2 Azure calls per
 * inventory row (Cost Management + Azure Monitor) fired at mount, serialized
 * behind small concurrency limiters (the Cost Management QPU quota is 12/10s),
 * which pushed the page's mount past 40s and kept the network permanently busy
 * (never `networkidle`).
 *
 * This hook is the deferral primitive: a cell renders its loading affordance
 * immediately and only ISSUES its request once it actually scrolls into view.
 * It complements — it does not replace — `LoomDataTable`'s row windowing
 * (`virtualizeRows`, U10): windowing stops rows above the
 * `VIRTUALIZATION_CUTOFF` from mounting at all; this stops the rows that DO
 * mount but sit below the fold from fetching.
 *
 * Semantics:
 *  • LATCHING — once an element has been seen, `inViewport` stays true and the
 *    observer disconnects. Data already loaded is never thrown away, so
 *    scrolling back is free (and the callers cache anyway).
 *  • `rootMargin` defaults to a generous pre-load band so a row starts loading
 *    just BEFORE it reaches the viewport (no visible pop-in on scroll).
 *  • PROGRESSIVE ENHANCEMENT — where `IntersectionObserver` does not exist
 *    (older engines, some SSR-hydration shims), the hook reports `true`
 *    immediately so the surface behaves exactly as it did before deferral.
 *    Never leave real data unloaded because an optimization is unavailable.
 *
 * Usage:
 *   const { ref, inViewport } = useInViewport<HTMLSpanElement>();
 *   return <span ref={ref}>{inViewport ? <Value/> : <Skeleton/>}</span>;
 */

import * as React from 'react';

export interface UseInViewportOptions {
  /**
   * Pre-load band around the viewport. A row within this distance of the
   * viewport counts as visible, so its request is already in flight by the
   * time it scrolls in. Default '300px'.
   */
  rootMargin?: string;
  /** IntersectionObserver threshold. Default 0 (any pixel visible). */
  threshold?: number;
  /**
   * When false the hook never reports visible — used to hold a cell back for
   * reasons other than position (e.g. an access gate). Default true.
   */
  enabled?: boolean;
  /**
   * Force-report visible without waiting for intersection — used by an explicit
   * "load everything" user action. Default false.
   */
  eager?: boolean;
}

export interface UseInViewportResult<T extends Element> {
  /** Attach to the element whose visibility gates the work. */
  ref: (node: T | null) => void;
  /** True once the element has entered (or is within `rootMargin` of) the viewport. */
  inViewport: boolean;
}

export function useInViewport<T extends Element = HTMLElement>(
  options: UseInViewportOptions = {},
): UseInViewportResult<T> {
  const { rootMargin = '300px', threshold = 0, enabled = true, eager = false } = options;

  // The observed node lives in state (not a ref) so attaching it re-runs the
  // effect — a ref callback alone would not trigger observation on mount.
  const [node, setNode] = React.useState<T | null>(null);
  const [seen, setSeen] = React.useState(false);

  React.useEffect(() => {
    if (!enabled || seen) return;
    // Unsupported engine → behave as before deferral (load immediately).
    if (typeof IntersectionObserver !== 'function') {
      setSeen(true);
      return;
    }
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          observer.disconnect();
        }
      },
      { rootMargin, threshold },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, enabled, seen, rootMargin, threshold]);

  return { ref: setNode, inViewport: enabled && (eager || seen) };
}

export default useInViewport;
