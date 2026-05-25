'use client';

/**
 * CommandPalette — Ctrl+K (or Cmd+K on Mac) opens a fuzzy-search modal
 * over every navigable surface and every Fabric item type. Per Phase 6
 * polish goal: "better than Fabric." Powered by the catalog already
 * defined in lib/catalog/fabric-item-types.ts.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Dialog, DialogSurface, DialogBody, DialogContent,
  Input, makeStyles, tokens, Caption1, Body1,
} from '@fluentui/react-components';
import { Search20Regular } from '@fluentui/react-icons';
import { FABRIC_ITEM_TYPES } from '@/lib/catalog/fabric-item-types';

interface Cmd { id: string; label: string; sub: string; href: string; group: string; }

const PAGES: Cmd[] = [
  { id: 'home', label: 'Home', sub: 'Hero + quick links', href: '/', group: 'Navigation' },
  { id: 'workspaces', label: 'Workspaces', sub: 'Root primitive', href: '/workspaces', group: 'Navigation' },
  { id: 'browse', label: 'Browse', sub: 'Shared with me + recents', href: '/browse', group: 'Navigation' },
  { id: 'onelake', label: 'OneLake catalog', sub: 'Explore + Govern', href: '/onelake', group: 'Navigation' },
  { id: 'monitor', label: 'Monitor', sub: 'Activities + schedules', href: '/monitor', group: 'Navigation' },
  { id: 'realtime', label: 'Real-Time hub', sub: 'Stream sources', href: '/realtime-hub', group: 'Navigation' },
  { id: 'copilot', label: 'Copilot', sub: 'Full-screen Copilot', href: '/copilot', group: 'Navigation' },
  { id: 'workload-hub', label: 'Workload hub', sub: 'My + More workloads', href: '/workload-hub', group: 'Navigation' },
  { id: 'deploy', label: 'Deployment pipelines', sub: 'Dev → Test → Prod', href: '/deployment-pipelines', group: 'Navigation' },
  { id: 'admin', label: 'Admin portal', sub: 'Tenant settings + 7 more', href: '/admin', group: 'Navigation' },
  { id: 'setup', label: 'Setup wizard', sub: 'Loom tenant bootstrap', href: '/setup', group: 'Navigation' },
  // Admin subpages
  { id: 'a-ten', label: 'Tenant settings', sub: 'Admin · switches', href: '/admin/tenant-settings', group: 'Admin' },
  { id: 'a-cap', label: 'Capacity settings', sub: 'Admin · SKUs', href: '/admin/capacity', group: 'Admin' },
  { id: 'a-dom', label: 'Domains', sub: 'Admin · org', href: '/admin/domains', group: 'Admin' },
  { id: 'a-sec', label: 'Security & governance', sub: 'Admin · DLP / sensitivity', href: '/admin/security', group: 'Admin' },
  { id: 'a-aud', label: 'Audit logs', sub: 'Admin · M365 audit', href: '/admin/audit-logs', group: 'Admin' },
  { id: 'a-use', label: 'Usage metrics', sub: 'Admin · adoption', href: '/admin/usage', group: 'Admin' },
  { id: 'a-usr', label: 'Users & licenses', sub: 'Admin · seats', href: '/admin/users', group: 'Admin' },
  { id: 'a-ws',  label: 'Workspaces (tenant-wide)', sub: 'Admin · inventory', href: '/admin/workspaces', group: 'Admin' },
];

const useStyles = makeStyles({
  surface: { maxWidth: 640, width: '90vw', padding: 0 },
  input: { width: '100%' },
  list: { maxHeight: '60vh', overflowY: 'auto', marginTop: 8 },
  item: {
    display: 'flex', flexDirection: 'column', gap: 2,
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
    fontSize: 11,
    textTransform: 'uppercase',
  },
  hint: {
    padding: '6px 12px',
    color: tokens.colorNeutralForeground3,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    display: 'flex', gap: 12,
  },
});

export function CommandPalette() {
  const s = useStyles();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);

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
    if (!qq) return all;
    return all.filter((c) =>
      c.label.toLowerCase().includes(qq) ||
      c.sub.toLowerCase().includes(qq) ||
      c.group.toLowerCase().includes(qq),
    );
  }, [q]);

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
                placeholder="Search pages, item types, settings…"
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
