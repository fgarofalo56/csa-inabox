'use client';

/**
 * TabStrip — multi-tab view like Fabric. Persists to /api/tabs (Cosmos
 * tabs-state container, partitioned by userId; one doc per user).
 *
 * Auto-open policy (Fabric-parity): tabs are ONLY for actual work-in-
 * progress — pages where edits could be lost. That means:
 *   - /items/[type]/[id]              (any item editor — work in progress)
 *   - /workspaces/[id]                (workspace detail / item list)
 *   - /apps/[id]                      (app detail)
 * Navigation surfaces (/workspaces, /apps, /admin, /onelake, /governance,
 * etc.) do NOT auto-open tabs — they're discovery views, not workbenches.
 *
 * Tab lifecycle (v2 — fixes "100+ open tabs" UX):
 *   - Hard cap of MAX_TABS auto-opened tabs. New auto-open evicts LRU
 *     unpinned tab with a restorable Toast.
 *   - Per-tab `lastAccessedAt` (ISO) updated on click / nav.
 *   - Stale auto-prune: unpinned tabs not touched in STALE_AFTER_MS get
 *     dropped on mount with a one-time toast.
 *   - Right-click context menu: pin, close, close others, close all
 *     unpinned, toggle group-by-workspace.
 *   - Group-by-workspace toggle: clusters tabs under their owning ws.
 *
 * Home is always pinned. `loom:open-tab` CustomEvent still lets any
 * component explicitly open a tab.
 *
 * Cache: localStorage key bumped to v2 to carry `lastAccessedAt` + `pinned`.
 * v1 cache is migrated lazily (missing timestamps default to now() so
 * users don't lose tabs on the first load after deploy).
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  makeStyles, tokens, Tooltip, Button,
  Popover, PopoverTrigger, PopoverSurface,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, MenuDivider,
  Toaster, Toast, ToastTitle, ToastBody, useToastController, useId,
} from '@fluentui/react-components';
import {
  Dismiss12Regular, ChevronDown16Regular,
  Pin16Filled, PinOff16Regular, Tabs16Regular,
} from '@fluentui/react-icons';
import { usePathname, useRouter } from 'next/navigation';

interface Tab {
  id: string;
  title: string;
  href: string;
  type?: string;
  pinned?: boolean;
  /** ISO timestamp — last time the user clicked/landed on this tab. */
  lastAccessedAt?: string;
  /** Optional workspace id for grouping. */
  workspaceId?: string;
}

const STATIC_HOME: Tab = {
  id: 'home', title: 'Home', href: '/', pinned: true,
  lastAccessedAt: new Date().toISOString(),
};

/** Cap on total tabs (Home + auto/manual). Fabric uses ~9; we allow 12. */
const MAX_TABS = 12;
/** Auto-prune unpinned tabs idle longer than this on mount. */
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
/** localStorage key. v2 carries lastAccessedAt + pinned. */
const STORAGE_KEY = 'loom.tabs.cache.v2';
const STORAGE_KEY_V1 = 'loom.tabs.cache.v1';
/** Storage key for the "group by workspace" UI toggle. */
const GROUP_PREF_KEY = 'loom.tabs.groupByWorkspace';

/**
 * Decide if a path warrants an auto-opened tab. Only "workbench" surfaces
 * that the user actively edits / runs against get tabs.
 */
function shouldAutoOpenTab(pathname: string): boolean {
  if (!pathname || pathname === '/') return false;
  if (/^\/items\/[^/]+\/[^/]+/.test(pathname)) return true;
  if (/^\/workspaces\/[^/]+/.test(pathname)) return true;
  if (/^\/apps\/[^/]+/.test(pathname)) return true;
  return false;
}

/** Derive a readable title from a workbench path. */
function deriveTitle(pathname: string, hint?: string): string {
  if (hint) return hint;
  const itemMatch = pathname.match(/^\/items\/([^/]+)\/([^/]+)/);
  if (itemMatch) {
    const type = itemMatch[1].replace(/-/g, ' ');
    const id = itemMatch[2];
    const short = id === 'new' ? 'new' : id.slice(0, 8);
    return `${type} · ${short}`;
  }
  const wsMatch = pathname.match(/^\/workspaces\/([^/]+)/);
  if (wsMatch) return `workspace · ${wsMatch[1].slice(0, 8)}`;
  const appMatch = pathname.match(/^\/apps\/([^/]+)/);
  if (appMatch) return appMatch[1].replace(/^app-/, '').replace(/-/g, ' ');
  return pathname.replace(/^\//, '').split('/').pop() || pathname;
}

/**
 * Best-effort: pull a workspace id from common URL shapes so we can
 * group tabs by their owning workspace without a server round-trip.
 *   /workspaces/abc123              → abc123
 *   /workspaces/abc123/items/xxx    → abc123
 *   /items/lakehouse/xyz?ws=abc123  → abc123
 *   /items/lakehouse/xyz            → undefined (unknown ws)
 */
function deriveWorkspaceId(href: string): string | undefined {
  if (!href) return undefined;
  const wsMatch = href.match(/^\/workspaces\/([^/?#]+)/);
  if (wsMatch) return wsMatch[1];
  const qMatch = href.match(/[?&]ws=([^&#]+)/);
  if (qMatch) return decodeURIComponent(qMatch[1]);
  return undefined;
}

const useStyles = makeStyles({
  root: {
    display: 'flex', alignItems: 'flex-end',
    gap: tokens.spacingHorizontalXXS, flex: '1 1 0', minWidth: 0, maxWidth: '100%',
    overflow: 'hidden',
    height: '100%', paddingTop: tokens.spacingVerticalXS,
    position: 'relative',
  },
  scroller: {
    display: 'flex', alignItems: 'flex-end',
    gap: tokens.spacingHorizontalXXS, minWidth: 0, flex: '1 1 0',
    overflow: 'hidden',
  },
  tab: {
    display: 'inline-flex', alignItems: 'center',
    gap: tokens.spacingHorizontalSNudge, padding: '6px 10px 6px 12px',
    backgroundColor: 'rgba(255,255,255,0.08)',
    color: 'rgba(255,255,255,0.78)',
    borderTopLeftRadius: 'var(--loom-radius-md)',
    borderTopRightRadius: 'var(--loom-radius-md)',
    fontSize: tokens.fontSizeBase200, maxWidth: '180px', minWidth: 0,
    flex: '0 1 auto',
    cursor: 'pointer', whiteSpace: 'nowrap',
    border: '1px solid transparent',
    borderBottom: 'none',
    transition: 'background-color var(--loom-motion-fast) var(--loom-motion-ease)',
    ':hover': { backgroundColor: 'rgba(255,255,255,0.14)' },
    textDecoration: 'none',
  },
  pinIcon: {
    fontSize: tokens.fontSizeBase200,
    color: 'rgba(255,255,255,0.85)',
    flex: '0 0 auto',
  },
  pinIconActive: {
    color: 'var(--loom-brand-fg, currentColor)',
  },
  groupHeader: {
    display: 'inline-flex', alignItems: 'center',
    gap: tokens.spacingHorizontalXS, padding: '4px 8px',
    fontSize: '11px', textTransform: 'uppercase',
    letterSpacing: '0.4px', fontWeight: 600,
    color: 'rgba(255,255,255,0.55)',
    flex: '0 0 auto',
    cursor: 'default',
    userSelect: 'none',
  },
  groupCount: {
    display: 'inline-flex', alignItems: 'center',
    justifyContent: 'center',
    minWidth: tokens.spacingHorizontalL, height: '14px', padding: '0 4px',
    borderRadius: '7px', fontSize: tokens.fontSizeBase100,
    backgroundColor: 'rgba(255,255,255,0.18)',
    color: 'rgba(255,255,255,0.85)',
  },
  overflowBtn: {
    color: 'rgba(255,255,255,0.78)',
    marginLeft: tokens.spacingHorizontalXS,
    flex: '0 0 auto',
  },
  groupToggleBtn: {
    color: 'rgba(255,255,255,0.65)',
    flex: '0 0 auto',
  },
  groupToggleActive: {
    color: 'rgba(255,255,255,0.95)',
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  overflowMenu: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalXXS,
    minWidth: '260px', maxHeight: '420px', overflowY: 'auto',
    padding: tokens.spacingHorizontalXS,
  },
  overflowItem: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalSNudge,
    padding: '6px 10px', cursor: 'pointer', borderRadius: tokens.borderRadiusMedium,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
    fontSize: '13px',
  },
  overflowSep: {
    height: '1px', margin: '4px 0',
    backgroundColor: tokens.colorNeutralStroke2,
  },
  overflowDestructive: {
    color: tokens.colorPaletteRedForeground1,
  },
  active: {
    backgroundColor: 'var(--loom-app-bg)',
    color: tokens.colorNeutralForeground1,
    boxShadow: '0 -1px 0 rgba(255,255,255,0.20) inset',
    ':hover': { backgroundColor: 'var(--loom-app-bg)' },
  },
  title: { overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 },
  close: {
    minWidth: '18px', height: '18px', padding: 0,
    color: 'inherit',
  },
});

/** Strip server payloads so we never persist Home (it's static client-side). */
function stripHome(tabs: Tab[]): Tab[] {
  return tabs.filter(t => t.id !== 'home');
}

/** Merge in the static Home tab + ensure every tab has a lastAccessedAt. */
function mergeHome(tabs: Tab[]): Tab[] {
  const now = new Date().toISOString();
  const filtered = stripHome(tabs).map(t => ({
    ...t,
    lastAccessedAt: t.lastAccessedAt || now,
    workspaceId: t.workspaceId ?? deriveWorkspaceId(t.href),
  }));
  return [STATIC_HOME, ...filtered];
}

/** Drop unpinned tabs older than STALE_AFTER_MS. Returns [next, prunedCount]. */
function pruneStale(tabs: Tab[]): { next: Tab[]; pruned: number } {
  const cutoff = Date.now() - STALE_AFTER_MS;
  let pruned = 0;
  const next = tabs.filter(t => {
    if (t.pinned) return true;
    if (t.id === 'home') return true;
    const ts = t.lastAccessedAt ? Date.parse(t.lastAccessedAt) : NaN;
    if (Number.isNaN(ts)) return true; // missing timestamp → keep, treat as fresh
    if (ts < cutoff) { pruned++; return false; }
    return true;
  });
  return { next, pruned };
}

/** Enforce MAX_TABS by evicting the LRU unpinned tab. Returns [next, evicted]. */
function enforceCap(tabs: Tab[]): { next: Tab[]; evicted: Tab | null } {
  if (tabs.length <= MAX_TABS) return { next: tabs, evicted: null };
  // Find oldest unpinned non-home tab.
  let oldestIdx = -1;
  let oldestTs = Infinity;
  tabs.forEach((t, i) => {
    if (t.pinned || t.id === 'home') return;
    const ts = t.lastAccessedAt ? Date.parse(t.lastAccessedAt) : 0;
    if (ts < oldestTs) { oldestTs = ts; oldestIdx = i; }
  });
  if (oldestIdx < 0) return { next: tabs, evicted: null };
  const evicted = tabs[oldestIdx];
  const next = tabs.filter((_, i) => i !== oldestIdx);
  return { next, evicted };
}

export function TabStrip() {
  const styles = useStyles();
  const pathname = usePathname() || '/';
  const router = useRouter();
  const [tabs, setTabs] = useState<Tab[]>([STATIC_HOME]);
  const [loaded, setLoaded] = useState(false);
  // Default ON — user expects Fabric-like grouping; can still toggle off.
  const [groupBy, setGroupBy] = useState(true);
  // Per-workspace name lookup so headers + overflow show "Production"
  // instead of "a3f9c0d2…". Populated on mount + when workspaces change.
  const [wsNames, setWsNames] = useState<Record<string, string>>({});
  const toasterId = useId('tab-strip-toaster');
  const { dispatchToast } = useToastController(toasterId);

  /** Stash for restoring a just-evicted tab from the toast. */
  const lastEvictedRef = useRef<Tab | null>(null);

  // Hydrate from local cache for instant paint, then reconcile with BFF.
  // Then prune stale tabs (one-time per mount).
  useEffect(() => {
    let seeded: Tab[] | null = null;
    try {
      const cached = localStorage.getItem(STORAGE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached) as Tab[];
        if (Array.isArray(parsed) && parsed.length) seeded = parsed;
      } else {
        // Migrate v1 → v2 (no surprise pruning: stamp as fresh).
        const v1 = localStorage.getItem(STORAGE_KEY_V1);
        if (v1) {
          const parsed = JSON.parse(v1) as Tab[];
          if (Array.isArray(parsed) && parsed.length) {
            const nowIso = new Date().toISOString();
            seeded = parsed.map(t => ({ ...t, lastAccessedAt: nowIso }));
          }
        }
      }
    } catch {/* ignore */}

    if (seeded) {
      const merged = mergeHome(seeded);
      // Prune stale on first paint.
      const { next, pruned } = pruneStale(merged);
      setTabs(next);
      if (pruned > 0) {
        // One-time stale notice. Persist the pruned list so the toast
        // accurately reflects what we kept.
        try {
          localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify(stripHome(next)),
          );
        } catch {}
        // Defer toast a tick so the Toaster is mounted.
        setTimeout(() => {
          dispatchToast(
            <Toast>
              <ToastTitle>Tidied up your tab strip</ToastTitle>
              <ToastBody>
                Closed {pruned} tab{pruned === 1 ? '' : 's'} you hadn't used in over a week.
                Pinned tabs were kept.
              </ToastBody>
            </Toast>,
            { intent: 'info', timeout: 6000 },
          );
        }, 250);
      }
    }

    try {
      const groupPref = localStorage.getItem(GROUP_PREF_KEY);
      // Honor a stored '0' to opt OUT of grouping; default is ON.
      if (groupPref === '0') setGroupBy(false);
      else if (groupPref === '1') setGroupBy(true);
    } catch {/* ignore */}

    // Resolve workspace id → name once. Cached in localStorage so the
    // dropdown labels render immediately on subsequent loads (the
    // /api/loom/workspaces fetch can take ~200ms on cold boot).
    try {
      const cached = localStorage.getItem('loom.tabs.wsNames');
      if (cached) setWsNames(JSON.parse(cached));
    } catch {/* ignore */}
    fetch('/api/loom/workspaces')
      .then(r => r.json())
      .then(j => {
        if (!j?.ok || !Array.isArray(j.workspaces)) return;
        const map: Record<string, string> = {};
        for (const w of j.workspaces) {
          if (w?.id && w?.name) map[w.id] = w.name;
        }
        setWsNames(map);
        try { localStorage.setItem('loom.tabs.wsNames', JSON.stringify(map)); } catch {/* ignore */}
      })
      .catch(() => {/* swallow — header falls back to truncated id */});

    fetch('/api/tabs').then(r => r.json()).then(d => {
      if (Array.isArray(d?.tabs) && d.tabs.length) {
        const merged = mergeHome(d.tabs);
        const { next } = pruneStale(merged);
        setTabs(next);
      }
      setLoaded(true);
    }).catch(() => setLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persist = useCallback((next: Tab[]) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stripHome(next)));
    } catch {}
    if (!loaded) return;
    const body = stripHome(next);
    fetch('/api/tabs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tabs: body }),
    }).catch(() => {/* will retry on next change */});
  }, [loaded]);

  /** Persist groupBy preference. */
  useEffect(() => {
    try { localStorage.setItem(GROUP_PREF_KEY, groupBy ? '1' : '0'); } catch {}
  }, [groupBy]);

  // Stamp lastAccessedAt on any tab whose href matches the current pathname.
  // Runs on every nav so LRU eviction stays accurate.
  useEffect(() => {
    if (!loaded) return;
    setTabs(prev => {
      const idx = prev.findIndex(t => t.href === pathname);
      if (idx < 0) return prev;
      const nowIso = new Date().toISOString();
      if (prev[idx].lastAccessedAt === nowIso) return prev;
      const next = prev.slice();
      next[idx] = { ...next[idx], lastAccessedAt: nowIso };
      // Don't persist on every nav — too chatty. Cache-only refresh.
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(stripHome(next)));
      } catch {}
      return next;
    });
  }, [pathname, loaded]);

  /** Restore a tab that was just evicted by the cap. Called by toast action. */
  const restoreEvicted = useCallback(() => {
    const t = lastEvictedRef.current;
    if (!t) return;
    lastEvictedRef.current = null;
    setTabs(prev => {
      if (prev.some(p => p.id === t.id)) return prev;
      // Pin the restored tab so it doesn't get re-evicted immediately.
      const restored: Tab = { ...t, pinned: true, lastAccessedAt: new Date().toISOString() };
      const next = [...prev, restored];
      persist(next);
      return next;
    });
    router.push(t.href);
  }, [persist, router]);

  // Auto-open tab when the user lands on a workbench surface.
  useEffect(() => {
    if (!loaded) return;
    if (!shouldAutoOpenTab(pathname)) return;
    if (tabs.some(t => t.href === pathname)) return;
    const title = deriveTitle(pathname);
    const nowIso = new Date().toISOString();
    const newTab: Tab = {
      id: pathname, title, href: pathname,
      lastAccessedAt: nowIso,
      workspaceId: deriveWorkspaceId(pathname),
    };
    const provisional = [...tabs, newTab];
    const { next, evicted } = enforceCap(provisional);
    setTabs(next);
    persist(next);
    if (evicted) {
      lastEvictedRef.current = evicted;
      dispatchToast(
        <Toast
          style={{ cursor: 'pointer' }}
          onClick={() => restoreEvicted()}
          role="button"
          tabIndex={0}
        >
          <ToastTitle>Closed "{evicted.title}"</ToastTitle>
          <ToastBody>
            Tab strip is capped at {MAX_TABS}. Click to restore (pinned).
          </ToastBody>
        </Toast>,
        { intent: 'info', timeout: 8000 },
      );
    }
  }, [pathname, loaded, tabs, persist, dispatchToast, restoreEvicted]);

  // External components can request a tab open via window event.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        { title: string; href: string; type?: string } | undefined;
      if (!detail?.href || !detail?.title) return;
      setTabs(prev => {
        if (prev.some(t => t.href === detail.href)) return prev;
        const newTab: Tab = {
          id: detail.href, title: detail.title, href: detail.href,
          type: detail.type,
          lastAccessedAt: new Date().toISOString(),
          workspaceId: deriveWorkspaceId(detail.href),
        };
        const provisional = [...prev, newTab];
        const { next, evicted } = enforceCap(provisional);
        persist(next);
        if (evicted) {
          lastEvictedRef.current = evicted;
          dispatchToast(
            <Toast
              style={{ cursor: 'pointer' }}
              onClick={() => restoreEvicted()}
              role="button"
              tabIndex={0}
            >
              <ToastTitle>Closed "{evicted.title}"</ToastTitle>
              <ToastBody>
                Tab strip is capped at {MAX_TABS}. Click to restore (pinned).
              </ToastBody>
            </Toast>,
            { intent: 'info', timeout: 8000 },
          );
        }
        return next;
      });
      router.push(detail.href);
    };
    window.addEventListener('loom:open-tab', handler);
    return () => window.removeEventListener('loom:open-tab', handler);
  }, [router, persist, dispatchToast, restoreEvicted]);

  const close = useCallback((id: string, ev?: React.MouseEvent) => {
    if (ev) { ev.stopPropagation(); ev.preventDefault(); }
    const tab = tabs.find(t => t.id === id);
    if (!tab) return;
    if (tab.pinned && tab.id === 'home') return; // never close Home
    const next = tabs.filter(t => t.id !== id);
    setTabs(next);
    persist(next);
    if (tab.href === pathname) {
      const fallback = next.length ? next[next.length - 1].href : '/';
      router.push(fallback);
    }
  }, [tabs, pathname, persist, router]);

  const togglePin = useCallback((id: string) => {
    if (id === 'home') return;
    setTabs(prev => {
      const next = prev.map(t => t.id === id ? { ...t, pinned: !t.pinned } : t);
      persist(next);
      return next;
    });
  }, [persist]);

  const closeOthers = useCallback((keepId: string) => {
    setTabs(prev => {
      const next = prev.filter(t => t.id === keepId || t.id === 'home' || t.pinned);
      persist(next);
      return next;
    });
  }, [persist]);

  const closeAllUnpinned = useCallback(() => {
    setTabs(prev => {
      const next = prev.filter(t => t.id === 'home' || t.pinned);
      persist(next);
      // If the current path was closed, go Home.
      if (!next.some(t => t.href === pathname)) router.push('/');
      return next;
    });
  }, [persist, pathname, router]);

  // Render list — optionally grouped by workspace.
  // Group shape: pinned + unpinned-no-ws are flat at the front; the rest
  // cluster under a small header chip per workspaceId.
  const renderItems = useMemo(() => {
    if (!groupBy) {
      return tabs.map(t => ({ kind: 'tab' as const, tab: t }));
    }
    const flat: Array<
      | { kind: 'tab'; tab: Tab }
      | { kind: 'header'; key: string; label: string; count: number }
    > = [];
    const ungrouped = tabs.filter(t => !t.workspaceId);
    ungrouped.forEach(t => flat.push({ kind: 'tab', tab: t }));
    // Cluster the rest by workspaceId, preserving insertion order.
    const order: string[] = [];
    const byWs = new Map<string, Tab[]>();
    tabs.forEach(t => {
      if (!t.workspaceId) return;
      if (!byWs.has(t.workspaceId)) { byWs.set(t.workspaceId, []); order.push(t.workspaceId); }
      byWs.get(t.workspaceId)!.push(t);
    });
    order.forEach(wsId => {
      const arr = byWs.get(wsId) || [];
      if (!arr.length) return;
      const name = wsNames[wsId];
      // Show resolved workspace name; fall back to a truncated id only
      // until /api/loom/workspaces resolves (cached so this rarely shows).
      const label = name ? name : `ws · ${wsId.slice(0, 8)}`;
      flat.push({ kind: 'header', key: `hdr-${wsId}`, label, count: arr.length });
      arr.forEach(t => flat.push({ kind: 'tab', tab: t }));
    });
    return flat;
  }, [groupBy, tabs, wsNames]);

  // Track how many items fit in the visible scroller width. Anything past
  // the limit is hidden + accessible via the overflow chevron.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(renderItems.length);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => {
      const avail = el.clientWidth;
      const children = Array.from(el.children) as HTMLElement[];
      let used = 0;
      let count = 0;
      // Reserve ~70px on the right for the group toggle + chevron pill.
      const reserve = 70;
      for (const c of children) {
        if (used + c.offsetWidth > avail - reserve) break;
        used += c.offsetWidth + 2;
        count++;
      }
      setVisibleCount(count || 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [renderItems.length]);

  // Build the overflow list of just tabs (skip headers).
  const hiddenTabs: Tab[] = useMemo(() => {
    const sliced = renderItems.slice(visibleCount);
    return sliced
      .filter(i => i.kind === 'tab')
      .map(i => (i as { kind: 'tab'; tab: Tab }).tab);
  }, [renderItems, visibleCount]);

  // Group the overflow popover's hidden tabs by workspace name so the
  // dropdown nests items under their owning workspace (matches Fabric's
  // "Open items" overlay). When groupBy is off the list stays flat.
  const overflowGroups: Array<
    | { kind: 'tab'; tab: Tab }
    | { kind: 'header'; key: string; label: string; count: number }
  > = useMemo(() => {
    if (!groupBy) return hiddenTabs.map(t => ({ kind: 'tab' as const, tab: t }));
    const out: typeof overflowGroups = [];
    // Tabs without a workspaceId render first (Home, pinned admin pages).
    const orphans = hiddenTabs.filter(t => !t.workspaceId);
    orphans.forEach(t => out.push({ kind: 'tab', tab: t }));
    // Then per-workspace clusters, in first-seen order.
    const seen: string[] = [];
    const byWs = new Map<string, Tab[]>();
    hiddenTabs.forEach(t => {
      if (!t.workspaceId) return;
      if (!byWs.has(t.workspaceId)) { byWs.set(t.workspaceId, []); seen.push(t.workspaceId); }
      byWs.get(t.workspaceId)!.push(t);
    });
    seen.forEach(wsId => {
      const arr = byWs.get(wsId) || [];
      if (!arr.length) return;
      const label = wsNames[wsId] || `ws · ${wsId.slice(0, 8)}`;
      out.push({ kind: 'header', key: `ovf-hdr-${wsId}`, label, count: arr.length });
      arr.forEach(t => out.push({ kind: 'tab', tab: t }));
    });
    return out;
  }, [groupBy, hiddenTabs, wsNames]);

  return (
    <div className={styles.root} role="tablist" aria-label="Open tabs">
      <div className={styles.scroller} ref={scrollerRef}>
        {renderItems.slice(0, visibleCount).map(item => {
          if (item.kind === 'header') {
            return (
              <span
                key={item.key}
                className={styles.groupHeader}
                aria-label={`Workspace group ${item.label}`}
              >
                {item.label}
                <span className={styles.groupCount}>{item.count}</span>
              </span>
            );
          }
          const tab = item.tab;
          const active = tab.href === pathname;
          return (
            <Menu key={tab.id} openOnContext positioning="below-start">
              <MenuTrigger disableButtonEnhancement>
                <Tooltip content={tab.title} relationship="label">
                  <a href={tab.href}
                     role="tab" aria-selected={active}
                     className={`${styles.tab} ${active ? styles.active : ''}`}
                     onClick={(e) => { e.preventDefault(); router.push(tab.href); }}>
                    {tab.pinned && tab.id !== 'home' && (
                      <Pin16Filled
                        className={`${styles.pinIcon} ${active ? styles.pinIconActive : ''}`}
                        aria-label="Pinned"
                      />
                    )}
                    <span className={styles.title}>{tab.title}</span>
                    {!tab.pinned && tab.id !== 'home' && (
                      <Button appearance="transparent" size="small" className={styles.close}
                        icon={<Dismiss12Regular />} onClick={(e) => close(tab.id, e)}
                        aria-label={`Close ${tab.title}`} />
                    )}
                  </a>
                </Tooltip>
              </MenuTrigger>
              <MenuPopover>
                <MenuList>
                  {tab.id !== 'home' && (
                    <MenuItem
                      icon={tab.pinned ? <PinOff16Regular /> : <Pin16Filled />}
                      onClick={() => togglePin(tab.id)}
                    >
                      {tab.pinned ? 'Unpin tab' : 'Pin tab'}
                    </MenuItem>
                  )}
                  {tab.id !== 'home' && !tab.pinned && (
                    <MenuItem
                      icon={<Dismiss12Regular />}
                      onClick={() => close(tab.id)}
                    >
                      Close tab
                    </MenuItem>
                  )}
                  <MenuItem
                    icon={<Dismiss12Regular />}
                    onClick={() => closeOthers(tab.id)}
                  >
                    Close others
                  </MenuItem>
                  <MenuItem
                    icon={<Dismiss12Regular />}
                    onClick={closeAllUnpinned}
                  >
                    Close all unpinned
                  </MenuItem>
                  <MenuDivider />
                  <MenuItem
                    icon={<Tabs16Regular />}
                    onClick={() => setGroupBy(g => !g)}
                  >
                    {groupBy ? 'Ungroup tabs' : 'Group by workspace'}
                  </MenuItem>
                </MenuList>
              </MenuPopover>
            </Menu>
          );
        })}
      </div>

      {/* Right-side controls: group toggle + overflow. */}
      <Tooltip
        content={groupBy ? 'Ungroup tabs' : 'Group by workspace'}
        relationship="label"
      >
        <Button
          appearance="transparent"
          size="small"
          icon={<Tabs16Regular />}
          className={`${styles.groupToggleBtn} ${groupBy ? styles.groupToggleActive : ''}`}
          onClick={() => setGroupBy(g => !g)}
          aria-label={groupBy ? 'Ungroup tabs' : 'Group tabs by workspace'}
          aria-pressed={groupBy}
        />
      </Tooltip>

      {(hiddenTabs.length > 0 || tabs.length > 1) && (
        <Popover withArrow positioning="below-end">
          <PopoverTrigger>
            <Button
              appearance="transparent"
              size="small"
              icon={<ChevronDown16Regular />}
              className={styles.overflowBtn}
              aria-label={
                hiddenTabs.length > 0
                  ? `${hiddenTabs.length} more open tabs`
                  : 'Tab actions'
              }
            >
              {hiddenTabs.length > 0 ? `+${hiddenTabs.length}` : ''}
            </Button>
          </PopoverTrigger>
          <PopoverSurface>
            <div className={styles.overflowMenu} role="menu">
              {overflowGroups.map((item) => {
                if (item.kind === 'header') {
                  return (
                    <div
                      key={item.key}
                      role="presentation"
                      className={styles.overflowItem}
                      style={{
                        fontWeight: 600,
                        opacity: 0.8,
                        textTransform: 'uppercase',
                        fontSize: 11,
                        letterSpacing: 0.5,
                        cursor: 'default',
                        backgroundColor: 'transparent',
                      }}
                    >
                      <span style={{ flex: 1 }}>{item.label}</span>
                      <span style={{ opacity: 0.6, fontWeight: 500 }}>{item.count}</span>
                    </div>
                  );
                }
                const tab = item.tab;
                return (
                  <div
                    key={tab.id}
                    role="menuitem"
                    className={styles.overflowItem}
                    onClick={() => router.push(tab.href)}
                    // Indent grouped (workspace-owned) tabs so they visually
                    // nest under the workspace header above.
                    style={groupBy && tab.workspaceId ? { paddingLeft: 24 } : undefined}
                  >
                    {tab.pinned && tab.id !== 'home' && (
                      <Pin16Filled style={{ fontSize: 12, opacity: 0.7 }} aria-label="Pinned" />
                    )}
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {tab.title}
                    </span>
                    {!tab.pinned && tab.id !== 'home' && (
                      <Button
                        appearance="transparent"
                        size="small"
                        icon={<Dismiss12Regular />}
                        onClick={(e) => close(tab.id, e)}
                        aria-label={`Close ${tab.title}`}
                      />
                    )}
                  </div>
                );
              })}
              {hiddenTabs.length > 0 && <div className={styles.overflowSep} />}
              <div
                role="menuitem"
                className={styles.overflowItem}
                onClick={() => setGroupBy(g => !g)}
              >
                <Tabs16Regular />
                <span style={{ flex: 1 }}>
                  {groupBy ? 'Ungroup tabs' : 'Group by workspace'}
                </span>
              </div>
              <div className={styles.overflowSep} />
              <div
                role="menuitem"
                className={`${styles.overflowItem} ${styles.overflowDestructive}`}
                onClick={closeAllUnpinned}
              >
                <Dismiss12Regular />
                <span style={{ flex: 1 }}>Close all except Home & pinned</span>
              </div>
            </div>
          </PopoverSurface>
        </Popover>
      )}

      <Toaster toasterId={toasterId} position="bottom-end" />
    </div>
  );
}
