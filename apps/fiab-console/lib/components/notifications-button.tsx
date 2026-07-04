'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * NotificationsButton — bell icon with unread badge. Reads /api/notifications
 * (Cosmos notifications container, partitioned by userId). PATCH marks read.
 * Polls every 60s to pick up server-side mentions/alerts.
 */

import { useEffect, useState } from 'react';
import {
  Button, Tooltip, makeStyles, tokens,
  Popover, PopoverTrigger, PopoverSurface,
} from '@fluentui/react-components';
import { Alert24Regular } from '@fluentui/react-icons';

interface Notification {
  id: string;
  title: string;
  body?: string;
  severity?: 'info' | 'success' | 'warning' | 'error';
  read?: boolean;
  link?: string;
  createdAt: string;
}

const useStyles = makeStyles({
  trigger: {
    color: 'white',
    transition: 'background-color var(--loom-motion-fast) var(--loom-motion-ease)',
    ':hover': { backgroundColor: 'rgba(255,255,255,0.10)' },
    flexShrink: 0,
    position: 'relative',
  },
  badge: {
    position: 'absolute', top: tokens.spacingVerticalXS, right: tokens.spacingHorizontalXS,
    minWidth: tokens.spacingHorizontalL, height: tokens.spacingVerticalL, padding: '0 4px',
    borderRadius: 'var(--loom-radius-full)',
    backgroundColor: '#E63946',
    color: 'white',
    fontSize: tokens.fontSizeBase100, fontWeight: 700,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    border: '1px solid var(--loom-topbar-bg)',
  },
  surface: {
    width: '360px', maxHeight: '460px', padding: 0,
    display: 'flex', flexDirection: 'column',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: 'var(--loom-space-3)',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    fontWeight: 600,
  },
  list: { flex: 1, overflow: 'auto' },
  item: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalXS,
    padding: 'var(--loom-space-3)',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    textDecoration: 'none', color: tokens.colorNeutralForeground1,
    cursor: 'pointer',
    transition: 'background-color var(--loom-motion-fast) var(--loom-motion-ease)',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  unread: { backgroundColor: tokens.colorBrandBackground2 },
  itemTitle: { fontSize: '13px', fontWeight: 600 },
  itemBody: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2, lineHeight: 1.4 },
  itemMeta: { fontSize: '11px', color: tokens.colorNeutralForeground3 },
  empty: { padding: 'var(--loom-space-5)', textAlign: 'center', color: tokens.colorNeutralForeground2, fontSize: '13px' },
});

export function NotificationsButton() {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);

  const load = () => {
    clientFetch('/api/notifications').then(r => r.json()).then(d => {
      if (Array.isArray(d?.notifications)) {
        setItems(d.notifications);
        setUnread(Number(d.unreadCount) || 0);
      }
    }).catch(() => {/* silent */});
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  const markAllRead = async () => {
    const ids = items.filter(i => !i.read).map(i => i.id);
    if (!ids.length) return;
    await clientFetch('/api/notifications', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    }).catch(() => {});
    setItems(items.map(i => ({ ...i, read: true })));
    setUnread(0);
  };

  const markOneRead = async (id: string) => {
    const target = items.find(i => i.id === id);
    if (!target || target.read) return;
    await clientFetch('/api/notifications', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [id] }),
    }).catch(() => {});
    setItems(prev => prev.map(i => (i.id === id ? { ...i, read: true } : i)));
    setUnread(u => Math.max(0, u - 1));
  };

  return (
    <Popover open={open} onOpenChange={(_, d) => { setOpen(d.open); if (d.open) load(); }}>
      <PopoverTrigger disableButtonEnhancement>
        <Tooltip content="Notifications" relationship="label">
          <Button appearance="transparent" className={styles.trigger}
            icon={<Alert24Regular />} aria-label={`Notifications${unread ? ` (${unread} unread)` : ''}`}>
            {unread > 0 && <span className={styles.badge}>{unread > 99 ? '99+' : unread}</span>}
          </Button>
        </Tooltip>
      </PopoverTrigger>
      <PopoverSurface className={styles.surface}>
        <div className={styles.header}>
          <span>Notifications</span>
          <Button appearance="subtle" size="small" onClick={markAllRead} disabled={unread === 0}>
            Mark all read
          </Button>
        </div>
        <div className={styles.list}>
          {items.length === 0 && (
            <div className={styles.empty}>
              You're all caught up. New mentions, share invites, and job alerts will appear here.
            </div>
          )}
          {items.map(n => {
            // Don't render a dead `<a href="#">` — page-jumps to top and
            // looks like a broken link. Notifications without a link are
            // informational only; clicking just marks read and closes.
            // NB: `key` is passed explicitly on each returned element below —
            // React 19 does not accept a `key` spread from a props object.
            const common = {
              className: `${styles.item} ${!n.read ? styles.unread : ''}`,
            };
            const body = (
              <>
                <span className={styles.itemTitle}>{n.title}</span>
                {n.body && <span className={styles.itemBody}>{n.body}</span>}
                <span className={styles.itemMeta}>{new Date(n.createdAt).toLocaleString()}</span>
              </>
            );
            if (n.link) {
              return (
                <a
                  key={n.id}
                  {...common}
                  href={n.link}
                  onClick={() => {
                    markOneRead(n.id);
                    setOpen(false);
                  }}
                >
                  {body}
                </a>
              );
            }
            return (
              <div
                key={n.id}
                {...common}
                role="button"
                tabIndex={0}
                onClick={() => markOneRead(n.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    markOneRead(n.id);
                  }
                }}
              >
                {body}
              </div>
            );
          })}
        </div>
      </PopoverSurface>
    </Popover>
  );
}
