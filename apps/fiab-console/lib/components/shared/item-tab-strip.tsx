'use client';

/**
 * ItemTabStrip + ToolbarCrossLinks (SC-8) — one-for-one with the Fabric
 * Eventhouse/KQL "item-level tab strip" + RTI toolbar cross-links captured in
 * PRPs/active/next-waves/fabric-ux-observations.md §"Eventhouse / KQL Database":
 *
 *   Item-level tab strip: Eventhouse | Database (two related editors in one
 *   item chrome). Toolbar cross-links EVERY RTI surface: Live view, New, Get
 *   data, Query with code, KQL Queryset, Notebook, Real-Time Dashboard, Data
 *   Agent, Operations Agent, Data policies, OneLake.
 *
 * <ItemTabStrip> is an item-level tab switcher (e.g. Eventhouse | Database,
 * Home | Materialized lake views). <ToolbarCrossLinks> is a horizontal button
 * group linking sibling surfaces. Both are ROUTING-ONLY — they navigate to
 * EXISTING routes or fire caller callbacks; they never call a backend, so there
 * is no Fabric dependency here (see .claude/rules/no-fabric-dependency.md).
 *
 * Fluent v9 + Loom tokens only; no raw px/hex. Theme-aware (light + dark).
 */

import { ReactElement, ReactNode, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  makeStyles, tokens, mergeClasses,
  Tab, TabList, Button, Tooltip, Badge,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
} from '@fluentui/react-components';
import { MoreHorizontal20Regular } from '@fluentui/react-icons';

/** One item-level tab (e.g. "Eventhouse", "Database"). */
export interface ItemTab {
  key: string;
  label: string;
  icon?: ReactElement;
  /** Optional route to push on select (routing-only). */
  href?: string;
  /** Optional badge, e.g. a child count. */
  badge?: ReactNode;
  disabled?: boolean;
}

export interface ItemTabStripProps {
  tabs: ItemTab[];
  selectedKey: string;
  /**
   * Called with the selected tab key. If the tab carries an `href`, the strip
   * also router.push-es it (routing-only cross-editor navigation). Callers that
   * switch an in-page view pass a state setter here and omit `href`.
   */
  onSelect?: (key: string) => void;
  ariaLabel?: string;
  className?: string;
}

/** One toolbar cross-link to a sibling surface. */
export interface CrossLink {
  key: string;
  label: string;
  icon?: ReactElement;
  /** Route to navigate to (routing-only). Mutually usable with onClick. */
  href?: string;
  onClick?: () => void;
  /** When set, render as a primary CTA (e.g. the "Analyze data with" action). */
  primary?: boolean;
  disabled?: boolean;
  /** Tooltip / honest-gate reason when disabled. */
  tooltip?: string;
  /** Open href in a new browser tab. */
  newTab?: boolean;
}

export interface ToolbarCrossLinksProps {
  links: CrossLink[];
  ariaLabel?: string;
  /**
   * Links beyond this count collapse into a "More" overflow menu (Fabric packs
   * ~11 RTI links into the toolbar; the overflow keeps narrow viewports clean).
   * Default 6. Pass 0 to disable overflow.
   */
  maxInline?: number;
  className?: string;
}

const useStyles = makeStyles({
  strip: {
    display: 'flex',
    alignItems: 'center',
    minWidth: 0,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  tabBadge: { marginLeft: tokens.spacingHorizontalXS },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    flexWrap: 'wrap',
    minWidth: 0,
  },
  divider: {
    width: '1px',
    alignSelf: 'stretch',
    marginTop: tokens.spacingVerticalXXS,
    marginBottom: tokens.spacingVerticalXXS,
    marginLeft: tokens.spacingHorizontalXS,
    marginRight: tokens.spacingHorizontalXS,
    backgroundColor: tokens.colorNeutralStroke2,
  },
});

/**
 * Item-level tab strip. Uses Fluent TabList for a11y (roving tabindex, arrow
 * keys). Selecting a tab fires onSelect and, when the tab has an href, routes.
 */
export function ItemTabStrip({ tabs, selectedKey, onSelect, ariaLabel, className }: ItemTabStripProps) {
  const s = useStyles();
  const router = useRouter();

  const handle = useCallback((key: string) => {
    const tab = tabs.find((t) => t.key === key);
    if (!tab || tab.disabled) return;
    onSelect?.(key);
    if (tab.href) router.push(tab.href);
  }, [tabs, onSelect, router]);

  return (
    <div className={mergeClasses(s.strip, className)}>
      <TabList
        selectedValue={selectedKey}
        onTabSelect={(_, d) => handle(d.value as string)}
        aria-label={ariaLabel ?? 'Item views'}
      >
        {tabs.map((t) => (
          <Tab key={t.key} value={t.key} icon={t.icon} disabled={t.disabled}>
            {t.label}
            {t.badge != null && (
              <Badge className={s.tabBadge} appearance="tint" size="small" color="informative">
                {t.badge}
              </Badge>
            )}
          </Tab>
        ))}
      </TabList>
    </div>
  );
}

/** Render a single cross-link as a button or an anchor-button (routing-only). */
function CrossLinkButton({ link }: { link: CrossLink }) {
  const router = useRouter();
  const onClick = useCallback(() => {
    if (link.disabled) return;
    link.onClick?.();
    if (link.href && !link.newTab) router.push(link.href);
  }, [link, router]);

  const btn = link.href && link.newTab ? (
    <Button
      as="a"
      size="small"
      appearance={link.primary ? 'primary' : 'subtle'}
      icon={link.icon}
      disabled={link.disabled}
      {...{ href: link.href, target: '_blank', rel: 'noreferrer' }}
      aria-label={link.label}
    >
      {link.label}
    </Button>
  ) : (
    <Button
      size="small"
      appearance={link.primary ? 'primary' : 'subtle'}
      icon={link.icon}
      onClick={onClick}
      disabled={link.disabled}
      aria-label={link.label}
    >
      {link.label}
    </Button>
  );

  if (link.tooltip) {
    return <Tooltip content={link.tooltip} relationship="label">{btn}</Tooltip>;
  }
  return btn;
}

/**
 * Toolbar cross-links to sibling surfaces (RTI family, warehouse ⇄ SQL
 * endpoint, lakehouse endpoints…). Overflow beyond `maxInline` collapses into a
 * "More" menu so narrow viewports never wrap awkwardly.
 */
export function ToolbarCrossLinks({ links, ariaLabel, maxInline = 6, className }: ToolbarCrossLinksProps) {
  const s = useStyles();
  const router = useRouter();

  const overflow = maxInline > 0 && links.length > maxInline;
  // Keep any primary CTA inline even when it sorts past the cut.
  const inline = overflow ? links.filter((l) => l.primary).concat(links.filter((l) => !l.primary)).slice(0, maxInline) : links;
  const inlineKeys = new Set(inline.map((l) => l.key));
  const hidden = overflow ? links.filter((l) => !inlineKeys.has(l.key)) : [];

  const activate = useCallback((link: CrossLink) => {
    if (link.disabled) return;
    link.onClick?.();
    if (link.href) {
      if (link.newTab) window.open(link.href, '_blank', 'noreferrer');
      else router.push(link.href);
    }
  }, [router]);

  return (
    <div className={mergeClasses(s.toolbar, className)} role="toolbar" aria-label={ariaLabel ?? 'Related surfaces'}>
      {inline.map((l) => <CrossLinkButton key={l.key} link={l} />)}
      {hidden.length > 0 && (
        <>
          <span className={s.divider} aria-hidden />
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Button size="small" appearance="subtle" icon={<MoreHorizontal20Regular />} aria-label="More related surfaces">
                More
              </Button>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                {hidden.map((l) => (
                  <MenuItem key={l.key} icon={l.icon} disabled={l.disabled} onClick={() => activate(l)}>
                    {l.label}
                  </MenuItem>
                ))}
              </MenuList>
            </MenuPopover>
          </Menu>
        </>
      )}
    </div>
  );
}

export default ItemTabStrip;
