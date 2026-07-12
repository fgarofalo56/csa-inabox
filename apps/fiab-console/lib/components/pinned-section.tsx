'use client';

/**
 * PinnedSection — renders the user's pinned items in the left nav.
 *
 * Pin state is owned by the shared `pin-store` (single source of truth, real
 * Cosmos-backed persistence via /api/user-prefs?key=pinnedItems). This section
 * reads that store, so it stays in sync the moment a user pins/unpins anywhere
 * else in the product (item tiles, the Browse all-items table). Each entry is a
 * real link to the same href the user navigates to normally, with an inline
 * unpin control.
 *
 * The section header is collapsible + keyboard-accessible, matching the other
 * left-nav groups (nav-collapse), and its open/closed state persists per user.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { makeStyles, tokens, Button, Tooltip } from '@fluentui/react-components';
import { PinOff16Regular, Star16Filled } from '@fluentui/react-icons';
import { usePins, pinItem, type PinnedItem } from './pin-store';
import { useNavCollapse, CollapseChevron } from './nav-collapse';

export type { PinnedItem };
export { pinItem };

const useStyles = makeStyles({
  root: {
    display: 'flex', flexDirection: 'column',
    paddingTop: tokens.spacingVerticalXS, paddingBottom: tokens.spacingVerticalXS,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    marginTop: tokens.spacingVerticalXS,
  },
  header: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalSNudge,
    padding: '8px 16px 4px',
    fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em',
    color: tokens.colorNeutralForeground3, fontWeight: 600,
    // Rendered as a <button> so the whole section collapses on click / keyboard.
    background: 'none', border: 'none', width: '100%', cursor: 'pointer',
    borderRadius: tokens.borderRadiusMedium,
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
    ':focus-visible': {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: '-2px',
    },
  },
  chevron: { display: 'inline-flex', color: tokens.colorNeutralForeground3, flexShrink: 0 },
  headerLabel: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalSNudge },
  item: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    padding: '6px 16px', fontSize: '13px',
    color: tokens.colorNeutralForeground1, textDecoration: 'none',
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  active: {
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
    fontWeight: 600,
  },
  label: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  unpin: { minWidth: tokens.spacingHorizontalXL, height: tokens.spacingVerticalXL, padding: 0, opacity: 0.6, ':hover': { opacity: 1 } },
  empty: {
    padding: '0 16px 8px',
    fontSize: '11px', color: tokens.colorNeutralForeground3,
    fontStyle: 'italic',
  },
});

const COLLAPSE_KEY = 'Pinned';

export function PinnedSection() {
  const styles = useStyles();
  const pathname = usePathname() || '/';
  const { pins, loading, unpin } = usePins();
  const { collapsed: isCollapsed, toggle } = useNavCollapse();

  if (loading) return null; // no flash on initial load
  const items = pins ?? [];
  const collapsed = isCollapsed(COLLAPSE_KEY);

  return (
    <div className={styles.root}>
      <button
        type="button"
        className={styles.header}
        aria-expanded={!collapsed}
        aria-controls="nav-pinned-region"
        onClick={() => toggle(COLLAPSE_KEY)}
      >
        <span className={styles.chevron} aria-hidden>
          <CollapseChevron open={!collapsed} />
        </span>
        <span className={styles.headerLabel}>
          <Star16Filled style={{ color: 'var(--loom-accent-gold)' }} />
          Pinned
        </span>
      </button>
      <div id="nav-pinned-region" role="group" hidden={collapsed}>
        {items.length === 0 ? (
          <div className={styles.empty}>Pin a workspace or item to see it here.</div>
        ) : (
          items.map((p) => {
            const active = p.href === pathname;
            return (
              <div key={p.id} className={`${styles.item} ${active ? styles.active : ''}`}>
                <Link href={p.href} className={styles.label} title={p.label}
                      style={{ color: 'inherit', textDecoration: 'none' }}>
                  {p.label}
                </Link>
                <Tooltip content="Unpin" relationship="label">
                  <Button appearance="transparent" size="small" className={styles.unpin}
                    icon={<PinOff16Regular />} onClick={() => unpin(p.id)}
                    aria-label={`Unpin ${p.label}`} />
                </Tooltip>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
