'use client';

/**
 * PageShell — every Console page must use this so the e2e h1-coverage
 * check (uat-fd.mjs) keeps passing.
 *
 * Compact, breadcrumb-led page header: a single row of
 *   Home › … › <PageTitle (h1)>     <subtitle, inline + truncated>     <actions>
 * The current page name is the (compact) <h1>; the subtitle no longer wraps to
 * a second line, and the whole band is roughly half the height of the old
 * Title2 + Body1 stack — reclaiming vertical real estate above the content /
 * canvas while adding navigational breadcrumbs.
 *
 * Pages can pass an explicit `breadcrumbs` trail for nested surfaces; otherwise
 * a default `Home › <title>` trail is rendered so every page gets navigation
 * for free. The LAST trail entry is always the current page (the <h1>).
 */

import { Fragment, ReactNode } from 'react';
import {
  Title3, Caption1, makeStyles, tokens,
  Breadcrumb, BreadcrumbItem, BreadcrumbButton, BreadcrumbDivider,
} from '@fluentui/react-components';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: 'var(--loom-space-2)' },
  header: {
    display: 'flex',
    alignItems: 'center',
    columnGap: 'var(--loom-space-4)',
    rowGap: '2px',
    flexWrap: 'wrap',
    minHeight: '34px',
    paddingBottom: 'var(--loom-space-1)',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  crumbs: { minWidth: 0, flexShrink: 0 },
  // current page name rendered as the compact <h1> (last crumb)
  current: {
    fontFamily: 'var(--loom-font-display)',
    letterSpacing: '-0.01em',
    lineHeight: 1.2,
    margin: 0,
    fontSize: tokens.fontSizeBase500,
    fontWeight: tokens.fontWeightSemibold,
    whiteSpace: 'nowrap',
    color: tokens.colorNeutralForeground1,
  },
  subtitle: {
    color: tokens.colorNeutralForeground3,
    flex: 1,
    minWidth: '120px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--loom-space-2)',
    flexShrink: 0,
    marginLeft: 'auto',
  },
  body: { flex: 1, minHeight: 0, minWidth: 0, maxWidth: '100%' },
});

export interface Crumb {
  label: string;
  href?: string;
}

interface Props {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  /** Optional nav trail. The last entry is the current page; omit to get `Home › <title>`. */
  breadcrumbs?: Crumb[];
  children: ReactNode;
}

export function PageShell({ title, subtitle, actions, breadcrumbs, children }: Props) {
  const s = useStyles();
  const trail: Crumb[] =
    breadcrumbs && breadcrumbs.length > 0
      ? breadcrumbs
      : [{ label: 'Home', href: '/' }, { label: title }];
  const parents = trail.slice(0, -1);

  return (
    <div className={s.root}>
      <header className={s.header}>
        <Breadcrumb size="small" aria-label="Breadcrumb" className={s.crumbs}>
          {parents.map((c, i) => (
            <Fragment key={`${c.label}-${i}`}>
              <BreadcrumbItem>
                {c.href ? (
                  <BreadcrumbButton as="a" href={c.href}>{c.label}</BreadcrumbButton>
                ) : (
                  <BreadcrumbButton>{c.label}</BreadcrumbButton>
                )}
              </BreadcrumbItem>
              <BreadcrumbDivider />
            </Fragment>
          ))}
          <BreadcrumbItem>
            {/* the page <h1> lives here — keeps semantic heading + the uat h1 check */}
            <Title3 as="h1" className={s.current} aria-current="page">{title}</Title3>
          </BreadcrumbItem>
        </Breadcrumb>
        {subtitle && <Caption1 className={s.subtitle}>{subtitle}</Caption1>}
        {actions && <div className={s.actions}>{actions}</div>}
      </header>
      <div className={s.body}>{children}</div>
    </div>
  );
}
