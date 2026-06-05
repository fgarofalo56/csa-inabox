'use client';

/**
 * Section + Toolbar — spacing primitives so page content never butts edges.
 *
 * <Section> = an optional heading row (title + actions) above a padded,
 * rounded content card. Stack multiple Sections on a page and they keep a
 * consistent gap; content inside always has breathing room.
 *
 * <Toolbar> = a filter bar row: a constrained-width SearchBox (NOT full
 * width) on the left, optional actions on the right.
 *
 *   <Section title="Workspace items" actions={<Button>+ New</Button>}>
 *     <Toolbar search={query} onSearch={setQuery} actions={<ViewToggle .../>} />
 *     <LoomDataTable .../>
 *   </Section>
 */

import * as React from 'react';
import {
  Title3,
  SearchBox,
  makeStyles,
  tokens,
  mergeClasses,
} from '@fluentui/react-components';

const useStyles = makeStyles({
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    // outer breathing room between stacked sections
    marginBottom: tokens.spacingVerticalXXL,
  },
  headRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
    minHeight: '32px',
    flexWrap: 'wrap',
  },
  title: {
    margin: 0,
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flexShrink: 0,
  },
  card: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    // generous, consistent inner padding so nothing touches the border
    padding: tokens.spacingVerticalL,
    boxShadow: tokens.shadow2,
    minWidth: 0,
  },
  bare: {
    // when the child manages its own surface (e.g. a full-bleed grid)
    padding: 0,
    border: 'none',
    boxShadow: 'none',
    backgroundColor: 'transparent',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
    marginBottom: tokens.spacingVerticalM,
    flexWrap: 'wrap',
  },
  // SearchBox is intentionally NOT full width
  search: {
    width: '100%',
    maxWidth: '360px',
    minWidth: '200px',
  },
  toolbarActions: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flexShrink: 0,
  },
});

export interface SectionProps {
  title?: React.ReactNode;
  /** Right-aligned header actions (buttons, toggles). */
  actions?: React.ReactNode;
  /** When true, render children without the padded card chrome. */
  bare?: boolean;
  children: React.ReactNode;
  className?: string;
}

export function Section({
  title,
  actions,
  bare = false,
  children,
  className,
}: SectionProps): React.ReactElement {
  const styles = useStyles();
  return (
    <section className={mergeClasses(styles.section, className)}>
      {(title != null || actions != null) && (
        <div className={styles.headRow}>
          {title != null ? <Title3 className={styles.title}>{title}</Title3> : <span />}
          {actions != null && <div className={styles.actions}>{actions}</div>}
        </div>
      )}
      <div className={mergeClasses(styles.card, bare ? styles.bare : undefined)}>
        {children}
      </div>
    </section>
  );
}

export interface ToolbarProps {
  /** Controlled search value. When provided, the SearchBox renders. */
  search?: string;
  onSearch?: (value: string) => void;
  searchPlaceholder?: string;
  /** Right-aligned controls (ViewToggle, filters, etc.). */
  actions?: React.ReactNode;
  /** Extra left-aligned controls placed after the search box. */
  children?: React.ReactNode;
  className?: string;
}

export function Toolbar({
  search,
  onSearch,
  searchPlaceholder = 'Search…',
  actions,
  children,
  className,
}: ToolbarProps): React.ReactElement {
  const styles = useStyles();
  return (
    <div className={mergeClasses(styles.toolbar, className)}>
      <div className={styles.toolbarActions} style={{ flex: '1 1 auto', minWidth: 0 }}>
        {onSearch != null && (
          <SearchBox
            className={styles.search}
            value={search ?? ''}
            placeholder={searchPlaceholder}
            onChange={(_e, data) => onSearch(data.value)}
          />
        )}
        {children}
      </div>
      {actions != null && <div className={styles.toolbarActions}>{actions}</div>}
    </div>
  );
}

export default Section;
