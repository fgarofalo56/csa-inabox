'use client';

/**
 * PageShell — every Console page must use this so the e2e h1-coverage
 * check (uat-fd.mjs) keeps passing. Renders a Fabric-style page header
 * (h1 + optional subtitle + right-aligned actions slot) and a content
 * region.
 */

import { ReactNode } from 'react';
import { Title2, Body1, makeStyles, tokens } from '@fluentui/react-components';

const useStyles = makeStyles({
  // Tighter header: less gap + a smaller title so the page header stops
  // eating vertical real estate above the content / canvas.
  root: { display: 'flex', flexDirection: 'column', gap: 'var(--loom-space-3)' },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--loom-space-4)',
    paddingBottom: 'var(--loom-space-2)',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  titleCol: { display: 'flex', flexDirection: 'column', gap: '2px', flex: 1, minWidth: 0 },
  title: { fontFamily: 'var(--loom-font-display)', letterSpacing: '-0.01em', lineHeight: 1.2 },
  subtitle: { color: tokens.colorNeutralForeground2, maxWidth: '900px', fontSize: '13px' },
  actions: { display: 'flex', alignItems: 'center', gap: 'var(--loom-space-2)' },
  body: { flex: 1, minHeight: 0 },
});

interface Props {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}

export function PageShell({ title, subtitle, actions, children }: Props) {
  const styles = useStyles();
  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div className={styles.titleCol}>
          <Title2 as="h1" className={styles.title}>{title}</Title2>
          {subtitle && <Body1 className={styles.subtitle}>{subtitle}</Body1>}
        </div>
        {actions && <div className={styles.actions}>{actions}</div>}
      </header>
      <div className={styles.body}>{children}</div>
    </div>
  );
}
