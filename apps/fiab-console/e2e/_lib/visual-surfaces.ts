/**
 * V2 — visual-regression surface list (loom-next-level, WS-verification).
 * ---------------------------------------------------------------------------
 * SINGLE SOURCE for the ~25 hub surfaces the screenshot-diff harness pins in
 * BOTH themes (mirrors the NAV_PAGES single-source pattern in _lib/uat.ts so
 * the list never drifts between the wide and narrow projects).
 *
 * Per entry:
 *   - ready:   selector that must be visible before capture (settle marker).
 *   - masks:   volatile live-data regions (timestamps, counts, ticking cells)
 *              masked out of the diff.
 *   - narrow:  member of the visual-narrow (900×1200) badge-overlap matrix —
 *              the ux-baseline "narrow-width pass" as an automated gate.
 *   - maxDiffPixelRatio: per-surface tolerance override (canvas surfaces get
 *              0.05 — anti-aliased edges + edge routing wobble).
 *
 * The new-item dialog OPEN state (the exact 07-21 dark-theme bug surface) is
 * captured via /new, which deterministically opens the same NewItemDialog
 * component over the Create page after hydration — no click choreography.
 */

export interface VisualSurface {
  slug: string;
  path: string;
  /** Selector awaited (visible) before the screenshot. */
  ready: string;
  /** Volatile regions masked out of the diff. */
  masks: string[];
  /** Included in the visual-narrow (900×1200) badge-overlap matrix. */
  narrow: boolean;
  /** Per-surface diff tolerance override (default 0.02). */
  maxDiffPixelRatio?: number;
}

/** Live-data regions common to hub pages: relative timestamps + count badges. */
const TIME_MASKS = ['time', '[data-testid="clock"]'];

export const VISUAL_SURFACES: VisualSurface[] = [
  { slug: 'home',                 path: '/',                        ready: 'main',            masks: TIME_MASKS, narrow: false },
  { slug: 'browse',               path: '/browse',                  ready: 'main',            masks: TIME_MASKS, narrow: true },
  { slug: 'workspaces',           path: '/workspaces',              ready: 'main',            masks: TIME_MASKS, narrow: false },
  { slug: 'onelake',              path: '/onelake',                 ready: 'main',            masks: TIME_MASKS, narrow: false },
  { slug: 'catalog',              path: '/catalog',                 ready: 'main',            masks: TIME_MASKS, narrow: true },
  { slug: 'governance',           path: '/governance',              ready: 'main',            masks: TIME_MASKS, narrow: false },
  { slug: 'marketplace',          path: '/marketplace',             ready: 'main',            masks: TIME_MASKS, narrow: true },
  { slug: 'api-marketplace',      path: '/api-marketplace',         ready: 'main',            masks: TIME_MASKS, narrow: true },
  { slug: 'monitor',              path: '/monitor',                 ready: 'main',            masks: TIME_MASKS, narrow: false },
  { slug: 'realtime-hub',         path: '/realtime-hub',            ready: 'main',            masks: TIME_MASKS, narrow: false },
  { slug: 'rti-hub',              path: '/rti-hub',                 ready: 'main',            masks: TIME_MASKS, narrow: false },
  { slug: 'data-agent',           path: '/data-agent',              ready: 'main',            masks: TIME_MASKS, narrow: false },
  { slug: 'copilot',              path: '/copilot',                 ready: 'main',            masks: TIME_MASKS, narrow: false },
  { slug: 'mesh',                 path: '/mesh',                    ready: 'main',            masks: TIME_MASKS, narrow: false, maxDiffPixelRatio: 0.05 },
  { slug: 'workload-hub',         path: '/workload-hub',            ready: 'main',            masks: TIME_MASKS, narrow: false },
  { slug: 'deployment-pipelines', path: '/deployment-pipelines',    ready: 'main',            masks: TIME_MASKS, narrow: false },
  { slug: 'apps',                 path: '/apps',                    ready: 'main',            masks: TIME_MASKS, narrow: false },
  { slug: 'learn',                path: '/learn',                   ready: 'main',            masks: TIME_MASKS, narrow: false },
  { slug: 'estate',               path: '/estate',                  ready: 'main',            masks: TIME_MASKS, narrow: false },
  { slug: 'admin',                path: '/admin',                   ready: 'main',            masks: TIME_MASKS, narrow: true },
  { slug: 'admin-gates',          path: '/admin/gates',             ready: 'main',            masks: TIME_MASKS, narrow: true },
  { slug: 'admin-health',         path: '/admin/health',            ready: 'main',            masks: TIME_MASKS, narrow: true },
  // Canvas editors in create-mode — the dark-theme accent bug class.
  { slug: 'editor-lakehouse',     path: '/items/lakehouse/new',     ready: 'main',            masks: TIME_MASKS, narrow: true,  maxDiffPixelRatio: 0.05 },
  { slug: 'editor-data-pipeline', path: '/items/data-pipeline/new', ready: 'main',            masks: TIME_MASKS, narrow: true,  maxDiffPixelRatio: 0.05 },
  // The new-item dialog OPEN state — /new auto-opens NewItemDialog post-mount.
  { slug: 'new-item-dialog',      path: '/new',                     ready: '[role="dialog"]', masks: TIME_MASKS, narrow: true },
];
