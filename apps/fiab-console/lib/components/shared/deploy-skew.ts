/**
 * deploy-skew — pure helpers for ChunkLoadError / deploy-skew recovery
 * (loom-apex A1; research/page-errors.md finding #1).
 *
 * WHY: Loom rolls new images multiple times a day. A tab opened before a roll
 * keeps the OLD chunk graph; its next client-side navigation requests hashed
 * chunk URLs that no longer exist on the new revision and the dynamic import
 * rejects. Before this module the GlobalErrorBoundary treated that like any
 * render error — its "Try again" button re-rendered, re-requested the same
 * dead chunk URL, and looped forever. The documented recovery for chunk skew
 * is ONE hard reload (replaces the whole chunk graph).
 *
 * These helpers are deliberately pure/DI-friendly (storage passed in) so the
 * classifier and the loop-guard are unit-testable without a browser.
 */

/**
 * Matches every browser's failed-chunk / failed-dynamic-import message shape:
 *  - webpack runtime: "Loading chunk 123 failed." / "Loading CSS chunk 42 failed."
 *  - Chromium ESM:    "Failed to fetch dynamically imported module: <url>"
 *  - Firefox ESM:     "error loading dynamically imported module"
 *  - Safari ESM:      "Importing a module script failed."
 */
const CHUNK_ERROR_RE =
  /Loading chunk [^\s]+ failed|Loading CSS chunk|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i;

/** True when the error is a failed chunk load / failed dynamic import. */
export function isChunkLoadError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const { name, message } = err as { name?: unknown; message?: unknown };
  if (name === 'ChunkLoadError') return true; // webpack's dedicated error name
  return typeof message === 'string' && CHUNK_ERROR_RE.test(message);
}

/** Minimal Storage surface so the guard is testable with a plain fake. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * sessionStorage key for the one-shot reload guard. Keyed by pathname AND the
 * client build id: a successful reload swaps in a new build id (fresh budget),
 * while a reload that did NOT fix the chunk (genuinely broken build, or a CDN
 * still serving the stale shell) keeps the same key and is never retried —
 * so a broken chunk can never reload-loop.
 */
export function reloadGuardKey(pathname: string, buildId: string): string {
  return `loom-skew-reload::${buildId}::${pathname}`;
}

/**
 * Loop guard: returns true exactly ONCE per (pathname, buildId) — marking the
 * attempt — and false on every subsequent call. A storage failure (private
 * mode, quota) returns false: with no way to bound attempts we must not
 * auto-reload at all, or a broken chunk would loop forever.
 */
export function markReloadOnce(storage: StorageLike, pathname: string, buildId: string): boolean {
  const key = reloadGuardKey(pathname, buildId);
  try {
    if (storage.getItem(key) !== null) return false;
    storage.setItem(key, new Date().toISOString());
    return true;
  } catch {
    return false;
  }
}

/**
 * The client bundle's build identity. `process.env.NEXT_DEPLOYMENT_ID` is
 * inlined at build time by Next's define plugin when next.config.mjs sets
 * `deploymentId` (verified against installed next@15.5.18
 * dist/build/define-env.js:84 — value is the config string, or `false` when
 * unset). Falls back to the public version stamp, then 'dev'.
 */
export function clientBuildId(): string {
  return (
    process.env.NEXT_DEPLOYMENT_ID ||
    process.env.NEXT_PUBLIC_LOOM_VERSION ||
    'dev'
  );
}

/**
 * Side-effectful entry point shared by GlobalErrorBoundary and
 * VersionSkewGuard: hard-reload the page at most once per
 * (pathname, client build). Returns true when the reload was initiated,
 * false when the guard (or a missing browser/storage) refused.
 */
export function attemptOneShotReload(pathname: string): boolean {
  if (typeof window === 'undefined') return false;
  let storage: StorageLike;
  try {
    storage = window.sessionStorage;
  } catch {
    return false; // storage blocked → cannot bound attempts → never auto-reload
  }
  if (!markReloadOnce(storage, pathname, clientBuildId())) return false;
  window.location.reload();
  return true;
}
