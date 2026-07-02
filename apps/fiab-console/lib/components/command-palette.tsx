'use client';

/**
 * CommandPalette — Ctrl+K (or Cmd+K on Mac) opens a fuzzy-search modal
 * over every navigable surface and every Fabric item type. Per Phase 6
 * polish goal: "better than Fabric." Powered by the catalog already
 * defined in lib/catalog/fabric-item-types.ts.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Dialog, DialogSurface, DialogBody, DialogContent,
  Input, makeStyles, tokens, Caption1, Body1,
} from '@fluentui/react-components';
import { Search20Regular } from '@fluentui/react-icons';
import { FABRIC_ITEM_TYPES } from '@/lib/catalog/fabric-item-types';
import { NAV_ITEMS } from '@/lib/nav/nav-items';

interface Cmd { id: string; label: string; sub: string; href: string; group: string; }

// Presentation-only one-liner hints per destination. The DESTINATIONS themselves
// (href + label) come from the shared NAV_ITEMS source of truth, so this palette
// can never list fewer surfaces than the left-nav rail (or drift out of sync when
// a destination is added). A missing hint simply falls back to the label — no
// destination is ever dropped. Mirrors left-nav.tsx's ICON_BY_HREF pattern.
const NAV_HINT_BY_HREF: Record<string, string> = {
  '/': 'Hero + quick links',
  '/workspaces': 'Root primitive',
  '/browse': 'Shared with me + recents',
  '/onelake': 'Explore + Govern',
  '/catalog': 'Search + govern all items',
  '/org-reports': 'Organization report library',
  '/semantic-model': 'Tabular models over the lakehouse',
  '/thread': 'Cross-item lineage graph',
  '/marketplace': 'API + Data products',
  '/governance': 'Policies, DLP, sensitivity',
  '/monitor': 'Activities + schedules',
  '/realtime-hub': 'Stream sources',
  '/activator-hub': 'Data-driven alerts',
  '/business-events': 'Event streams + triggers',
  '/rti-hub': 'Real-Time Intelligence catalog',
  '/data-agent': 'Conversational data agents',
  '/experience/data-science/home': 'Notebooks, experiments, models',
  '/experience/warp/home': 'Warp orchestration',
  '/copilot': 'Full-screen Copilot',
  '/workload-hub': 'My + More workloads',
  '/connections': 'Linked services + gateways',
  '/deployment-pipelines': 'Dev → Test → Prod',
  '/admin': 'Tenant settings + more',
  '/setup': 'Loom tenant bootstrap',
};

// Navigation entries are sourced 1:1 from the canonical NAV_ITEMS list so all
// destinations in the left-nav rail are searchable here — no hand-maintained copy.
const NAV_PAGES: Cmd[] = NAV_ITEMS.map((it) => ({
  id: `nav-${it.href}`,
  label: it.label,
  sub: NAV_HINT_BY_HREF[it.href] ?? it.label,
  href: it.href,
  group: 'Navigation',
}));

// Admin subpages (deep links that aren't top-level rail destinations).
const ADMIN_PAGES: Cmd[] = [
  { id: 'a-ten', label: 'Tenant settings', sub: 'Admin · switches', href: '/admin/tenant-settings', group: 'Admin' },
  { id: 'a-cap', label: 'Capacity settings', sub: 'Admin · SKUs', href: '/admin/capacity', group: 'Admin' },
  { id: 'a-dom', label: 'Domains', sub: 'Admin · org', href: '/admin/domains', group: 'Admin' },
  { id: 'a-sec', label: 'Security & governance', sub: 'Admin · DLP / sensitivity', href: '/admin/security', group: 'Admin' },
  { id: 'a-aud', label: 'Audit logs', sub: 'Admin · M365 audit', href: '/admin/audit-logs', group: 'Admin' },
  { id: 'a-use', label: 'Usage metrics', sub: 'Admin · adoption', href: '/admin/usage', group: 'Admin' },
  { id: 'a-usr', label: 'Users & licenses', sub: 'Admin · seats', href: '/admin/users', group: 'Admin' },
  { id: 'a-ws',  label: 'Workspaces (tenant-wide)', sub: 'Admin · inventory', href: '/admin/workspaces', group: 'Admin' },
];

const PAGES: Cmd[] = [...NAV_PAGES, ...ADMIN_PAGES];

const useStyles = makeStyles({
  surface: { maxWidth: '640px', width: '90vw', padding: 0 },
  input: { width: '100%' },
  list: { maxHeight: '60vh', overflowY: 'auto', marginTop: tokens.spacingVerticalS },
  item: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalXXS,
    padding: '8px 12px',
    cursor: 'pointer',
    borderLeft: '3px solid transparent',
  },
  itemActive: {
    backgroundColor: tokens.colorBrandBackground2,
    borderLeftColor: tokens.colorBrandStroke1,
  },
  groupLabel: {
    padding: '6px 12px',
    color: tokens.colorNeutralForeground3,
    fontSize: '11px',
    textTransform: 'uppercase',
  },
  hint: {
    padding: '6px 12px',
    color: tokens.colorNeutralForeground3,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    display: 'flex', gap: tokens.spacingHorizontalM,
  },
});

export function CommandPalette() {
  const s = useStyles();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const [hits, setHits] = useState<Cmd[]>([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced live search against /api/search/items (tenant items + workspaces).
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const qq = q.trim();
    if (!open || qq.length < 2) { setHits([]); return; }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch('/api/search/items', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ q: qq, top: 12 }),
        });
        if (res.ok) {
          const j = await res.json();
          const mapped: Cmd[] = (j.hits || []).map((h: any) => ({
            id: `it-${h.kind}-${h.id}`,
            label: h.name || h.id,
            sub: h.kind === 'workspace'
              ? 'Workspace'
              : `${h.type || 'item'}${h.snippet ? ' · ' + h.snippet.slice(0, 60) : ''}`,
            href: h.kind === 'workspace'
              ? `/workspaces/${h.workspaceId}`
              : `/items/${h.type}/${h.id}`,
            group: h.kind === 'workspace' ? 'Workspaces' : 'Items',
          }));
          setHits(mapped);
        }
      } catch { /* network — swallow, fall back to local */ }
      finally { setSearching(false); }
    }, 180);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [q, open]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
        setQ('');
        setCursor(0);
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    }
    function onOpen(e: Event) {
      const ce = e as CustomEvent<{ prefill?: string }>;
      setOpen(true);
      setQ(ce.detail?.prefill ?? '');
      setCursor(0);
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('csaloom:open-palette', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('csaloom:open-palette', onOpen);
    };
  }, [open]);

  const items: Cmd[] = useMemo(() => {
    const ofTypes: Cmd[] = FABRIC_ITEM_TYPES.map((t) => ({
      id: `new-${t.slug}`,
      label: `New ${t.displayName.toLowerCase()}`,
      sub: t.category,
      href: `/items/${t.slug}/new`,
      group: 'Create',
    }));
    const all = [...PAGES, ...ofTypes];
    const qq = q.trim().toLowerCase();
    const filtered = qq
      ? all.filter((c) =>
          c.label.toLowerCase().includes(qq) ||
          c.sub.toLowerCase().includes(qq) ||
          c.group.toLowerCase().includes(qq),
        )
      : all;
    // Real-data hits land first so users find their own items, not catalog
    // entries with the same name.
    return [...hits, ...filtered];
  }, [q, hits]);

  function go(c: Cmd) {
    setOpen(false);
    router.push(c.href);
  }

  function onInputKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') { setCursor((c) => Math.min(items.length - 1, c + 1)); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { setCursor((c) => Math.max(0, c - 1)); e.preventDefault(); }
    else if (e.key === 'Enter' && items[cursor]) { go(items[cursor]); }
  }

  // Group items by group preserving order
  const groups = items.reduce<Record<string, Cmd[]>>((acc, c) => {
    (acc[c.group] = acc[c.group] || []).push(c);
    return acc;
  }, {});

  let flatIndex = 0;
  return (
    <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
      <DialogSurface className={s.surface}>
        <DialogBody>
          <DialogContent>
            <div style={{ padding: 12, borderBottom: `1px solid ${tokens.colorNeutralStroke2}` }}>
              <Input
                className={s.input}
                contentBefore={<Search20Regular />}
                placeholder={searching ? 'Searching…' : 'Search items, pages, settings…'}
                value={q}
                autoFocus
                onChange={(_, d) => { setQ(d.value); setCursor(0); }}
                onKeyDown={onInputKey}
                aria-label="Command palette search"
              />
            </div>
            <div className={s.list} role="listbox" aria-label="Command results">
              {Object.entries(groups).map(([g, cs]) => (
                <div key={g}>
                  <div className={s.groupLabel}>{g}</div>
                  {cs.map((c) => {
                    const me = flatIndex++;
                    return (
                      <div
                        key={c.id}
                        className={`${s.item} ${me === cursor ? s.itemActive : ''}`}
                        onClick={() => go(c)}
                        onMouseEnter={() => setCursor(me)}
                        role="option"
                        aria-selected={me === cursor}
                      >
                        <Body1>{c.label}</Body1>
                        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{c.sub}</Caption1>
                      </div>
                    );
                  })}
                </div>
              ))}
              {items.length === 0 && <div style={{ padding: 16, color: tokens.colorNeutralForeground3 }}>No matches.</div>}
            </div>
            <div className={s.hint}>
              <Caption1>↑ ↓ navigate</Caption1>
              <Caption1>↵ open</Caption1>
              <Caption1>Esc close</Caption1>
            </div>
          </DialogContent>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
