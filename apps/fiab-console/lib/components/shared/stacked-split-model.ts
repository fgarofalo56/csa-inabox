/**
 * stacked-split-model — pure reflow / collapse / persistence math for
 * StackedSplit. No React, no DOM, no storage: everything here is unit-tested.
 *
 * Sizes are "shares" (flex-grow weights). A pane's rendered extent is
 * share / sum(expanded shares) of the stack, so collapsing a pane never has
 * to touch its share: re-expanding restores the exact prior size.
 */

export type PaneRole = 'canvas' | 'dock';

export interface PaneSpecLite {
  id: string;
  role?: PaneRole;
  minHeight?: number;
  defaultFlex?: number;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
}

export interface StackedSplitPersistedState {
  v: 1;
  shares: Record<string, number>;
  collapsed: Record<string, boolean>;
}

export const STORE_PREFIX = 'loom.stackedsplit.';
export const DEFAULT_CANVAS_MIN = 120;
export const DEFAULT_DOCK_MIN = 80;
/** Double-click fit never takes more than this fraction of the stack. */
export const FIT_MAX_FRACTION = 0.7;

export const paneRole = (p: PaneSpecLite): PaneRole => p.role ?? 'dock';
export const paneMin = (p: PaneSpecLite): number =>
  p.minHeight ?? (paneRole(p) === 'canvas' ? DEFAULT_CANVAS_MIN : DEFAULT_DOCK_MIN);
export const paneCollapsible = (p: PaneSpecLite): boolean =>
  p.collapsible ?? paneRole(p) === 'dock';

/* ------------------------------ reflow ------------------------------ */

export interface ReflowItem { id: string; role: PaneRole; min: number; px: number }

/**
 * Take `amount` px from `donors`, proportional to their current px, never
 * pushing one below its min. A donor that hits its floor drops out and the
 * remainder is re-spread over the rest. Returns px actually taken.
 */
function takeFrom(donors: ReflowItem[], px: Record<string, number>, amount: number): number {
  let remaining = amount;
  let active = donors.filter((d) => px[d.id] - d.min > 1e-9);
  while (remaining > 1e-9 && active.length > 0) {
    const weight = active.reduce((a, d) => a + px[d.id], 0);
    let taken = 0;
    for (const d of active) {
      const room = px[d.id] - d.min;
      const t = Math.min(room, remaining * (px[d.id] / weight));
      px[d.id] -= t;
      taken += t;
    }
    remaining -= taken;
    if (taken <= 1e-9) break;
    active = active.filter((d) => px[d.id] - d.min > 1e-9);
  }
  return amount - Math.max(0, remaining);
}

/**
 * Resize `targetId` toward `desiredPx` and redistribute the difference.
 *
 * GROW: space comes from the other dock panes (proportional to size, down to
 * their floors); only when every dock is at its floor does the canvas give,
 * and never below its own floor. A target that is itself the canvas can only
 * take from docks.
 * SHRINK: the target stops at its floor; freed space goes to `recipientId`
 * (the pane across the divider). With no recipient the shrink is refused.
 *
 * Total px is conserved. Returns new px by id.
 */
export function reflow(
  items: ReflowItem[],
  targetId: string,
  desiredPx: number,
  recipientId: string | null,
): Record<string, number> {
  const px: Record<string, number> = {};
  for (const i of items) px[i.id] = i.px;
  const target = items.find((i) => i.id === targetId);
  if (!target || Number.isNaN(desiredPx)) return px;

  const cur = px[targetId];
  if (desiredPx > cur) {
    const others = items.filter((i) => i.id !== targetId);
    let need = desiredPx - cur;
    // Infinity (the End key) means "as much as the siblings can give".
    if (!Number.isFinite(need)) need = others.reduce((a, o) => a + Math.max(0, px[o.id] - o.min), 0);
    let got = takeFrom(others.filter((o) => o.role === 'dock'), px, need);
    if (need - got > 1e-9) {
      got += takeFrom(others.filter((o) => o.role === 'canvas'), px, need - got);
    }
    px[targetId] = cur + got;
  } else if (desiredPx < cur) {
    const recipient = recipientId ? items.find((i) => i.id === recipientId) : undefined;
    if (!recipient || recipient.id === targetId) return px;
    const next = Math.max(target.min, desiredPx);
    px[targetId] = next;
    px[recipient.id] += cur - next;
  }
  return px;
}

/**
 * Double-click fit: the pane's natural content extent, capped at 70%
 * (FIT_MAX_FRACTION) of the stack's available space so one pane can never fit
 * itself into swallowing the rest, and never below its own floor.
 */
export function fitTarget(contentPx: number, availablePx: number, minPx: number): number {
  return Math.max(minPx, Math.min(contentPx, FIT_MAX_FRACTION * availablePx));
}

/** Convert reflowed px of the EXPANDED panes back to shares, holding their share-sum constant. */
export function pxToShares(
  px: Record<string, number>,
  prevShares: Record<string, number>,
): Record<string, number> {
  const ids = Object.keys(px);
  const sumPx = ids.reduce((a, id) => a + px[id], 0);
  const sumShares = ids.reduce((a, id) => a + prevShares[id], 0);
  const out: Record<string, number> = {};
  if (sumPx <= 0) return out;
  for (const id of ids) out[id] = (px[id] / sumPx) * sumShares;
  return out;
}

/* --------------------------- state / persistence --------------------------- */

export interface ResolvedState {
  state: StackedSplitPersistedState;
  /** Persisted entries for panes not currently present; re-saved verbatim. */
  extras: { shares: Record<string, number>; collapsed: Record<string, boolean> };
}

const isShare = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

export function defaultState(panes: PaneSpecLite[]): StackedSplitPersistedState {
  const shares: Record<string, number> = {};
  const collapsed: Record<string, boolean> = {};
  for (const p of panes) {
    shares[p.id] = isShare(p.defaultFlex) ? p.defaultFlex : 1;
    collapsed[p.id] = paneCollapsible(p) && !!p.defaultCollapsed;
  }
  return { v: 1, shares, collapsed };
}

/** Never throws: corrupt JSON / wrong version / bad values fall back per pane. */
export function resolveState(panes: PaneSpecLite[], raw: string | null | undefined): ResolvedState {
  const state = defaultState(panes);
  const extras = { shares: {} as Record<string, number>, collapsed: {} as Record<string, boolean> };
  if (!raw) return { state, extras };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { state, extras }; }
  if (!parsed || typeof parsed !== 'object' || (parsed as { v?: unknown }).v !== 1) return { state, extras };
  const p = parsed as { shares?: unknown; collapsed?: unknown };
  const shares = p.shares && typeof p.shares === 'object' ? (p.shares as Record<string, unknown>) : {};
  const coll = p.collapsed && typeof p.collapsed === 'object' ? (p.collapsed as Record<string, unknown>) : {};
  const known = new Set(panes.map((x) => x.id));
  for (const spec of panes) {
    if (isShare(shares[spec.id])) state.shares[spec.id] = shares[spec.id] as number;
    if (typeof coll[spec.id] === 'boolean') {
      state.collapsed[spec.id] = paneCollapsible(spec) && (coll[spec.id] as boolean);
    }
  }
  for (const id of Object.keys(shares)) if (!known.has(id) && isShare(shares[id])) extras.shares[id] = shares[id] as number;
  for (const id of Object.keys(coll)) if (!known.has(id) && typeof coll[id] === 'boolean') extras.collapsed[id] = coll[id] as boolean;
  return { state, extras };
}

export function serializeState(state: StackedSplitPersistedState, extras: ResolvedState['extras']): string {
  return JSON.stringify({
    v: 1,
    shares: { ...extras.shares, ...state.shares },
    collapsed: { ...extras.collapsed, ...state.collapsed },
  });
}

/** Collapse / expand. Deliberately leaves `shares` untouched (exact restore). */
export function setCollapsed(
  state: StackedSplitPersistedState,
  id: string,
  collapsed: boolean,
): StackedSplitPersistedState {
  return { ...state, collapsed: { ...state.collapsed, [id]: collapsed } };
}
