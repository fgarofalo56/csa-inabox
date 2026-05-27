'use client';

/**
 * TabStrip — multi-tab view like Fabric. Persists to /api/tabs (Cosmos
 * tabs-state container, partitioned by userId; one doc per user).
 *
 * Auto-open policy (Fabric-parity): tabs are ONLY for actual work-in-
 * progress — pages where edits could be lost. That means:
 *   - /items/[type]/[id]              (any item editor — work in progress)
 *   - /workspaces/[id]                (workspace detail / item list)
 * Navigation surfaces (/workspaces, /apps, /admin, /onelake, /governance,
 * etc.) do NOT auto-open tabs — they're discovery views, not workbenches.
 *
 * Home is pinned. Tabs are dismissible via X. `loom:open-tab` CustomEvent
 * still lets any component explicitly open a tab (e.g. Open in notebook).
 */

import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import {
  makeStyles, tokens, Tooltip, Button,
  Popover, PopoverTrigger, PopoverSurface,
} from '@fluentui/react-components';
import { Dismiss12Regular, ChevronDown16Regular } from '@fluentui/react-icons';
import { usePathname, useRouter } from 'next/navigation';

interface Tab {
  id: string;
  title: string;
  href: string;
  type?: string;
  pinned?: boolean;
}

const STATIC_HOME: Tab = { id: 'home', title: 'Home', href: '/', pinned: true };

/**
 * Decide if a path warrants an auto-opened tab. Only "workbench" surfaces
 * that the user actively edits / runs against get tabs.
 */
function shouldAutoOpenTab(pathname: string): boolean {
  if (!pathname || pathname === '/') return false;
  // Item editors: /items/[type]/[id]
  if (/^\/items\/[^/]+\/[^/]+/.test(pathname)) return true;
  // Workspace detail: /workspaces/[id] but NOT the list /workspaces
  if (/^\/workspaces\/[^/]+/.test(pathname)) return true;
  // App detail: /apps/[id] but NOT the list /apps
  if (/^\/apps\/[^/]+/.test(pathname)) return true;
  return false;
}

/** Derive a readable title from a workbench path. */
function deriveTitle(pathname: string, hint?: string): string {
  if (hint) return hint;
  // /items/lakehouse/abc123 → "lakehouse · abc12345"
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

const useStyles = makeStyles({
  root: {
    // Hard width clamp + no scroll. When tabs would overflow, the
    // overflow chevron at the right opens a Popover with the rest.
    display: 'flex', alignItems: 'flex-end',
    gap: 2, flex: '1 1 0', minWidth: 0, maxWidth: '100%',
    overflow: 'hidden',
    height: '100%', paddingTop: 4,
    position: 'relative',
  },
  scroller: {
    display: 'flex', alignItems: 'flex-end',
    gap: 2, minWidth: 0, flex: '1 1 0',
    overflow: 'hidden',
  },
  tab: {
    display: 'inline-flex', alignItems: 'center',
    gap: 6, padding: '6px 10px 6px 12px',
    backgroundColor: 'rgba(255,255,255,0.08)',
    color: 'rgba(255,255,255,0.78)',
    borderTopLeftRadius: 'var(--loom-radius-md)',
    borderTopRightRadius: 'var(--loom-radius-md)',
    fontSize: 12, maxWidth: 180, minWidth: 0,
    flex: '0 1 auto',
    cursor: 'pointer', whiteSpace: 'nowrap',
    border: '1px solid transparent',
    borderBottom: 'none',
    transition: 'background-color var(--loom-motion-fast) var(--loom-motion-ease)',
    ':hover': { backgroundColor: 'rgba(255,255,255,0.14)' },
  },
  overflowBtn: {
    color: 'rgba(255,255,255,0.78)',
    marginLeft: 4,
    flex: '0 0 auto',
  },
  overflowMenu: {
    display: 'flex', flexDirection: 'column', gap: 2,
    minWidth: 240, maxHeight: 360, overflowY: 'auto',
    padding: 4,
  },
  overflowItem: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '6px 10px', cursor: 'pointer', borderRadius: 4,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
    fontSize: 13,
  },
  active: {
    backgroundColor: 'var(--loom-app-bg)',
    color: tokens.colorNeutralForeground1,
    boxShadow: '0 -1px 0 rgba(255,255,255,0.20) inset',
    ':hover': { backgroundColor: 'var(--loom-app-bg)' },
  },
  title: { overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 },
  close: {
    minWidth: 18, height: 18, padding: 0,
    color: 'inherit',
  },
});

const STORAGE_KEY = 'loom.tabs.cache.v1';

export function TabStrip() {
  const styles = useStyles();
  const pathname = usePathname() || '/';
  const router = useRouter();
  const [tabs, setTabs] = useState<Tab[]>([STATIC_HOME]);
  const [loaded, setLoaded] = useState(false);

  // Hydrate from local cache for instant paint, then reconcile with BFF.
  useEffect(() => {
    try {
      const cached = localStorage.getItem(STORAGE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached) as Tab[];
        if (Array.isArray(parsed) && parsed.length) setTabs(mergeHome(parsed));
      }
    } catch {/* ignore */}
    fetch('/api/tabs').then(r => r.json()).then(d => {
      if (Array.isArray(d?.tabs) && d.tabs.length) setTabs(mergeHome(d.tabs));
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);

  const persist = useCallback((next: Tab[]) => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch {}
    if (!loaded) return;
    // Persist the non-static tabs (Home is always pinned client-side).
    const body = next.filter(t => t.id !== 'home');
    fetch('/api/tabs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tabs: body }),
    }).catch(() => {/* will retry on next change */});
  }, [loaded]);

  // Auto-open tab only when the user lands on a workbench surface
  // (item editor, workspace detail, app detail). Navigation surfaces
  // like /workspaces, /apps, /admin do NOT open tabs — they're
  // discovery views, not work-in-progress.
  useEffect(() => {
    if (!loaded) return;
    if (!shouldAutoOpenTab(pathname)) return;
    if (tabs.some(t => t.href === pathname)) return;
    const title = deriveTitle(pathname);
    const next: Tab[] = [...tabs, { id: pathname, title, href: pathname }];
    setTabs(next);
    persist(next);
  }, [pathname, loaded, tabs, persist]);

  // External components can request a tab open via window event.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { title: string; href: string; type?: string } | undefined;
      if (!detail?.href || !detail?.title) return;
      setTabs(prev => {
        if (prev.some(t => t.href === detail.href)) return prev;
        const next = [...prev, { id: detail.href, title: detail.title, href: detail.href, type: detail.type }];
        persist(next);
        return next;
      });
      router.push(detail.href);
    };
    window.addEventListener('loom:open-tab', handler);
    return () => window.removeEventListener('loom:open-tab', handler);
  }, [router, persist]);

  const close = (id: string, ev: React.MouseEvent) => {
    ev.stopPropagation();
    ev.preventDefault();
    const tab = tabs.find(t => t.id === id);
    if (!tab || tab.pinned) return;
    const next = tabs.filter(t => t.id !== id);
    setTabs(next);
    persist(next);
    if (tab.href === pathname) {
      const fallback = next.length ? next[next.length - 1].href : '/';
      router.push(fallback);
    }
  };

  // Track how many tabs fit in the visible scroller width. Anything past
  // the limit is hidden + accessible via the overflow chevron.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(tabs.length);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => {
      const avail = el.clientWidth;
      const children = Array.from(el.children) as HTMLElement[];
      let used = 0;
      let count = 0;
      for (const c of children) {
        // 4px reserve for the overflow chevron pill.
        if (used + c.offsetWidth > avail - 32) break;
        used += c.offsetWidth + 2;
        count++;
      }
      setVisibleCount(count || 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tabs.length]);

  const hidden = tabs.slice(visibleCount);

  return (
    <div className={styles.root} role="tablist" aria-label="Open tabs">
      <div className={styles.scroller} ref={scrollerRef}>
        {tabs.map(tab => {
          const active = tab.href === pathname;
          return (
            <Tooltip key={tab.id} content={tab.title} relationship="label">
              <a href={tab.href}
                 role="tab" aria-selected={active}
                 className={`${styles.tab} ${active ? styles.active : ''}`}
                 onClick={(e) => { e.preventDefault(); router.push(tab.href); }}>
                <span className={styles.title}>{tab.title}</span>
                {!tab.pinned && (
                  <Button appearance="transparent" size="small" className={styles.close}
                    icon={<Dismiss12Regular />} onClick={(e) => close(tab.id, e)}
                    aria-label={`Close ${tab.title}`} />
                )}
              </a>
            </Tooltip>
          );
        })}
      </div>
      {hidden.length > 0 && (
        <Popover withArrow positioning="below-end">
          <PopoverTrigger>
            <Button
              appearance="transparent"
              size="small"
              icon={<ChevronDown16Regular />}
              className={styles.overflowBtn}
              aria-label={`${hidden.length} more open tabs`}
            >
              +{hidden.length}
            </Button>
          </PopoverTrigger>
          <PopoverSurface>
            <div className={styles.overflowMenu} role="menu">
              {hidden.map((tab) => (
                <div
                  key={tab.id}
                  role="menuitem"
                  className={styles.overflowItem}
                  onClick={() => router.push(tab.href)}
                >
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {tab.title}
                  </span>
                  {!tab.pinned && (
                    <Button
                      appearance="transparent"
                      size="small"
                      icon={<Dismiss12Regular />}
                      onClick={(e) => close(tab.id, e)}
                      aria-label={`Close ${tab.title}`}
                    />
                  )}
                </div>
              ))}
            </div>
          </PopoverSurface>
        </Popover>
      )}
    </div>
  );
}

function mergeHome(tabs: Tab[]): Tab[] {
  const filtered = tabs.filter(t => t.id !== 'home');
  return [STATIC_HOME, ...filtered];
}
