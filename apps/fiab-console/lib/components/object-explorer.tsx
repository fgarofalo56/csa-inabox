'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * ObjectExplorer — cross-workspace object explorer (Fabric-parity, GA Apr 2026).
 *
 * A collapsible, pinnable LEFT side panel that shows a tree of every workspace
 * the caller can reach → the items inside each. It answers Fabric's "object
 * explorer": browse resources across all your open workspaces without page-
 * hopping, then click one to open it as a TAB (reuses the existing TabStrip via
 * the `loom:open-tab` CustomEvent — no new tab plumbing).
 *
 * Real data only (no mocks):
 *   - Workspaces:  GET /api/workspaces?count=true   (ACL-aware, itemCount)
 *   - Items:       GET /api/workspaces/{id}/items    (lazy, on expand)
 * Each workspace is color-coded + numbered (Fabric shows the same) so items are
 * traceable to their owning workspace. Search filters across every LOADED
 * workspace; typing eagerly loads the rest so the filter is complete. A type
 * dropdown narrows to one item type. Full keyboard model matches Fabric's:
 *   →/← expand/collapse a workspace · ↑/↓ move · Enter/Space open.
 *
 * Toggle from the topbar button (openObjectExplorer / toggleObjectExplorer).
 * Open state persists to localStorage so it survives nav + refresh. As a non-
 * modal OverlayDrawer it stays put while you work (the "pinned" default).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  OverlayDrawer, DrawerHeader, DrawerHeaderTitle, DrawerBody,
  Button, Tooltip, Input, Dropdown, Option, Badge, Spinner,
  Caption1, MessageBar, MessageBarBody,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Dismiss20Regular, Search20Regular, Filter16Regular,
  ChevronRight16Regular, ChevronDown16Regular, ArrowClockwise16Regular,
  Building16Regular, Open16Regular, WindowNew16Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import { itemVisual } from '@/lib/components/ui/item-type-visual';
import { FABRIC_ITEM_TYPES } from '@/lib/catalog/fabric-item-types';

const EVT_OPEN = 'loom:open-object-explorer';
const EVT_TOGGLE = 'loom:toggle-object-explorer';
const OPEN_KEY = 'loom.objExplorer.open';

/** Broadcast helpers — the topbar button + command palette call these. */
export function openObjectExplorer() { window.dispatchEvent(new Event(EVT_OPEN)); }
export function toggleObjectExplorer() { window.dispatchEvent(new Event(EVT_TOGGLE)); }

const TYPE_LABEL = new Map(FABRIC_ITEM_TYPES.map((t) => [t.slug, t.displayName]));

/** Fluent Badge colors cycled per workspace so each gets a stable swatch. */
const WS_COLORS = ['brand', 'success', 'informative', 'important', 'severe', 'warning'] as const;

interface Workspace { id: string; name?: string; displayName?: string; itemCount?: number }
interface Item { id: string; itemType: string; displayName?: string; workspaceId?: string }

/** items[wsId]: undefined = not loaded · 'loading' · Item[] · 'error' */
type ItemsState = Record<string, undefined | 'loading' | 'error' | Item[]>;

const useStyles = makeStyles({
  drawer: { width: '340px', maxWidth: '86vw' },
  body: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    minHeight: 0, height: '100%',
  },
  controls: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  filterRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  tree: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
    overflowY: 'auto', flex: '1 1 0', minHeight: 0,
    paddingRight: tokens.spacingHorizontalXXS,
  },
  wsRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium, cursor: 'pointer',
    minHeight: '34px', border: `${tokens.strokeWidthThin} solid transparent`,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
    ':focus-visible': { outline: `${tokens.strokeWidthThick} solid ${tokens.colorStrokeFocus2}`, outlineOffset: '-2px' },
  },
  wsName: {
    flex: '1 1 0', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
    whiteSpace: 'nowrap', fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300,
  },
  chevron: { flexShrink: 0, color: tokens.colorNeutralForeground3, display: 'flex' },
  itemRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    paddingLeft: tokens.spacingHorizontalXXL,
    borderRadius: tokens.borderRadiusMedium, cursor: 'pointer',
    minHeight: '30px', border: `${tokens.strokeWidthThin} solid transparent`,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
    ':focus-visible': { outline: `${tokens.strokeWidthThick} solid ${tokens.colorStrokeFocus2}`, outlineOffset: '-2px' },
  },
  itemIcon: { flexShrink: 0, display: 'flex' },
  itemName: {
    flex: '1 1 0', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
    whiteSpace: 'nowrap', fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground1,
  },
  itemType: { flexShrink: 0, color: tokens.colorNeutralForeground3 },
  loadingRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    paddingLeft: tokens.spacingHorizontalXXL, paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
  },
  emptyChild: {
    paddingLeft: tokens.spacingHorizontalXXL, paddingTop: tokens.spacingVerticalXXS,
    paddingBottom: tokens.spacingVerticalXS, color: tokens.colorNeutralForeground3,
  },
  count: { flexShrink: 0 },
});

export function ObjectExplorer() {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<ItemsState>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const loadedOnce = useRef(false);
  const treeRef = useRef<HTMLDivElement>(null);

  // Restore + persist the open/pinned state.
  useEffect(() => {
    try { if (localStorage.getItem(OPEN_KEY) === '1') setOpen(true); } catch { /* SSR */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch { /* ignore */ }
  }, [open]);

  // Topbar / palette open + toggle events.
  useEffect(() => {
    const onOpen = () => setOpen(true);
    const onToggle = () => setOpen((v) => !v);
    window.addEventListener(EVT_OPEN, onOpen);
    window.addEventListener(EVT_TOGGLE, onToggle);
    return () => {
      window.removeEventListener(EVT_OPEN, onOpen);
      window.removeEventListener(EVT_TOGGLE, onToggle);
    };
  }, []);

  const loadWorkspaces = useCallback(() => {
    setError(null);
    setWorkspaces(null);
    clientFetch('/api/workspaces?count=true')
      .then((r) => r.json())
      .then((j) => {
        const list: Workspace[] = Array.isArray(j) ? j : (j?.workspaces || []);
        setWorkspaces(list);
      })
      .catch((e) => setError(e?.message || 'Failed to load workspaces'));
  }, []);

  // Lazy-load workspaces the first time the pane opens.
  useEffect(() => {
    if (open && !loadedOnce.current) {
      loadedOnce.current = true;
      loadWorkspaces();
    }
  }, [open, loadWorkspaces]);

  const loadItems = useCallback((wsId: string) => {
    setItems((prev) => {
      if (prev[wsId] && prev[wsId] !== 'error') return prev; // already loaded/loading
      return { ...prev, [wsId]: 'loading' };
    });
    clientFetch(`/api/workspaces/${encodeURIComponent(wsId)}/items`)
      .then((r) => r.json())
      .then((j) => {
        const list: Item[] = Array.isArray(j) ? j : (j?.items || j?.data || []);
        setItems((prev) => ({ ...prev, [wsId]: list }));
      })
      .catch(() => setItems((prev) => ({ ...prev, [wsId]: 'error' })));
  }, []);

  const toggleWs = useCallback((wsId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(wsId)) { next.delete(wsId); return next; }
      next.add(wsId);
      return next;
    });
    setItems((prev) => {
      if (!prev[wsId] || prev[wsId] === 'error') { loadItems(wsId); }
      return prev;
    });
  }, [loadItems]);

  // When searching, eagerly load every workspace's items so the filter is
  // complete across the tenant (once). Cheap: one call per workspace, cached.
  useEffect(() => {
    if (!search.trim() || !workspaces) return;
    for (const ws of workspaces) {
      if (!items[ws.id]) loadItems(ws.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, workspaces]);

  const openItemTab = useCallback((it: Item, newBrowserTab = false) => {
    const href = `/items/${it.itemType}/${it.id}`;
    if (newBrowserTab) { window.open(href, '_blank', 'noopener'); return; }
    const title = it.displayName || itemVisual(it.itemType).label;
    window.dispatchEvent(new CustomEvent('loom:open-tab', { detail: { title, href, type: it.itemType } }));
  }, []);

  const wsName = (w: Workspace) => w.name || w.displayName || w.id;
  const searchLc = search.trim().toLowerCase();
  const searching = searchLc.length > 0;

  // Item types present across loaded items → the type dropdown options.
  const typeOptions = useMemo(() => {
    const set = new Set<string>();
    for (const v of Object.values(items)) {
      if (Array.isArray(v)) for (const it of v) set.add(it.itemType);
    }
    return Array.from(set).sort((a, b) => (TYPE_LABEL.get(a) || a).localeCompare(TYPE_LABEL.get(b) || b));
  }, [items]);

  /** Apply search + type filters to a workspace's loaded items. */
  const visibleItems = useCallback((wsId: string): Item[] => {
    const v = items[wsId];
    if (!Array.isArray(v)) return [];
    return v.filter((it) => {
      if (typeFilter !== 'all' && it.itemType !== typeFilter) return false;
      if (searchLc && !(it.displayName || '').toLowerCase().includes(searchLc)
          && !(TYPE_LABEL.get(it.itemType) || it.itemType).toLowerCase().includes(searchLc)) return false;
      return true;
    });
  }, [items, typeFilter, searchLc]);

  // While searching, only show workspaces that have a matching item (or whose
  // name matches). Otherwise show all workspaces.
  const shownWorkspaces = useMemo(() => {
    if (!workspaces) return [];
    if (!searching && typeFilter === 'all') return workspaces;
    return workspaces.filter((w) => {
      if (searching && wsName(w).toLowerCase().includes(searchLc)) return true;
      return visibleItems(w.id).length > 0;
    });
  }, [workspaces, searching, typeFilter, searchLc, visibleItems]);

  // A workspace subtree is force-open while a filter is active (so matches show).
  const isExpanded = (wsId: string) => expanded.has(wsId) || searching || typeFilter !== 'all';

  /** Roving keyboard nav across the flat list of visible rows. */
  const onKeyDown = (e: React.KeyboardEvent, kind: 'ws' | 'item', wsId: string, it?: Item) => {
    const rows = Array.from(treeRef.current?.querySelectorAll<HTMLElement>('[data-oe-row]') || []);
    const idx = rows.indexOf(e.currentTarget as HTMLElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); rows[Math.min(idx + 1, rows.length - 1)]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); rows[Math.max(idx - 1, 0)]?.focus(); }
    else if (e.key === 'ArrowRight' && kind === 'ws') { e.preventDefault(); if (!expanded.has(wsId)) toggleWs(wsId); }
    else if (e.key === 'ArrowLeft' && kind === 'ws') { e.preventDefault(); if (expanded.has(wsId)) toggleWs(wsId); }
    else if ((e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      if (kind === 'ws') toggleWs(wsId);
      else if (it) openItemTab(it);
    }
  };

  return (
    <OverlayDrawer
      as="aside"
      position="start"
      modalType="non-modal"
      open={open}
      onOpenChange={(_, d) => setOpen(d.open)}
      className={styles.drawer}
    >
      <DrawerHeader>
        <DrawerHeaderTitle
          action={
            <div style={{ display: 'flex', gap: tokens.spacingHorizontalXXS }}>
              <Tooltip content="Refresh" relationship="label">
                <Button appearance="subtle" size="small" icon={<ArrowClockwise16Regular />}
                  aria-label="Refresh workspaces" onClick={loadWorkspaces} />
              </Tooltip>
              <Tooltip content="Collapse object explorer" relationship="label">
                <Button appearance="subtle" icon={<Dismiss20Regular />}
                  aria-label="Collapse object explorer" onClick={() => setOpen(false)} />
              </Tooltip>
            </div>
          }
        >
          Object explorer
        </DrawerHeaderTitle>
      </DrawerHeader>

      <DrawerBody className={styles.body}>
        <div className={styles.controls}>
          <Input
            size="small"
            contentBefore={<Search20Regular />}
            placeholder="Search items across workspaces"
            value={search}
            onChange={(_, d) => setSearch(d.value)}
            aria-label="Search items across workspaces"
          />
          <div className={styles.filterRow}>
            <Filter16Regular aria-hidden />
            <Dropdown
              size="small"
              style={{ minWidth: 0, flex: '1 1 0' }}
              value={typeFilter === 'all' ? 'All item types' : (TYPE_LABEL.get(typeFilter) || typeFilter)}
              selectedOptions={[typeFilter]}
              onOptionSelect={(_, d) => setTypeFilter(d.optionValue || 'all')}
              aria-label="Filter by item type"
            >
              <Option value="all">All item types</Option>
              {typeOptions.map((t) => (
                <Option key={t} value={t}>{TYPE_LABEL.get(t) || t}</Option>
              ))}
            </Dropdown>
          </div>
        </div>

        {error && (
          <MessageBar intent="error">
            <MessageBarBody>{error}</MessageBarBody>
          </MessageBar>
        )}

        {!workspaces && !error && <Spinner size="tiny" label="Loading workspaces…" />}

        {workspaces && workspaces.length === 0 && (
          <EmptyState
            icon={<Building16Regular />}
            title="No workspaces yet"
            body="Create a workspace to start organizing lakehouses, notebooks, warehouses, and more."
            primaryAction={{ label: 'Browse workspaces', href: '/workspaces' }}
          />
        )}

        {workspaces && workspaces.length > 0 && (
          <div className={styles.tree} ref={treeRef} role="tree" aria-label="Workspaces and items">
            {shownWorkspaces.length === 0 && (
              <Caption1 className={styles.emptyChild}>No items match “{search}”.</Caption1>
            )}
            {shownWorkspaces.map((w, i) => {
              const openWs = isExpanded(w.id);
              const st = items[w.id];
              const rows = openWs ? visibleItems(w.id) : [];
              const color = WS_COLORS[i % WS_COLORS.length];
              return (
                <div key={w.id} role="treeitem" aria-expanded={openWs}>
                  <div
                    data-oe-row
                    className={styles.wsRow}
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleWs(w.id)}
                    onKeyDown={(e) => onKeyDown(e, 'ws', w.id)}
                    aria-label={`Workspace ${wsName(w)}${typeof w.itemCount === 'number' ? `, ${w.itemCount} items` : ''}`}
                  >
                    <span className={styles.chevron}>
                      {openWs ? <ChevronDown16Regular /> : <ChevronRight16Regular />}
                    </span>
                    <Badge appearance="filled" color={color} size="small" className={styles.count}>{i + 1}</Badge>
                    <span className={styles.wsName}>{wsName(w)}</span>
                    {typeof w.itemCount === 'number' && (
                      <Badge appearance="tint" color="informative" size="small" className={styles.count}>
                        {w.itemCount}
                      </Badge>
                    )}
                  </div>

                  {openWs && st === 'loading' && (
                    <div className={styles.loadingRow}><Spinner size="tiny" label="Loading items…" /></div>
                  )}
                  {openWs && st === 'error' && (
                    <div className={styles.loadingRow}>
                      <Caption1>Could not load items.</Caption1>
                      <Button appearance="transparent" size="small" onClick={() => loadItems(w.id)}>Retry</Button>
                    </div>
                  )}
                  {openWs && Array.isArray(st) && rows.length === 0 && (
                    <Caption1 className={styles.emptyChild}>
                      {searching || typeFilter !== 'all' ? 'No matching items.' : 'No items yet.'}
                    </Caption1>
                  )}
                  {openWs && rows.map((it) => {
                    const v = itemVisual(it.itemType);
                    const Icon = v.icon;
                    return (
                      <Menu key={it.id} openOnContext positioning="below-start">
                        <MenuTrigger disableButtonEnhancement>
                          <div
                            data-oe-row
                            className={styles.itemRow}
                            role="button"
                            tabIndex={0}
                            onClick={() => openItemTab(it)}
                            onKeyDown={(e) => onKeyDown(e, 'item', w.id, it)}
                            aria-label={`${it.displayName || v.label} — ${v.label}. Open in a tab`}
                          >
                            <span className={styles.itemIcon} style={{ color: v.color }}><Icon /></span>
                            <span className={styles.itemName}>{it.displayName || '(unnamed)'}</span>
                            <Caption1 className={styles.itemType}>{v.label}</Caption1>
                          </div>
                        </MenuTrigger>
                        <MenuPopover>
                          <MenuList>
                            <MenuItem icon={<Open16Regular />} onClick={() => openItemTab(it)}>Open</MenuItem>
                            <MenuItem icon={<WindowNew16Regular />} onClick={() => openItemTab(it, true)}>
                              Open in new browser tab
                            </MenuItem>
                          </MenuList>
                        </MenuPopover>
                      </Menu>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </DrawerBody>
    </OverlayDrawer>
  );
}
