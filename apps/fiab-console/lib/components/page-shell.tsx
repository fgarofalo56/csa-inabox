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
  root: { display: 'flex', flexDirection: 'column', gap: '16px' },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    paddingBottom: '12px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  titleCol: { display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, minWidth: 0 },
  subtitle: { color: tokens.colorNeutralForeground3 },
  actions: { display: 'flex', alignItems: 'center', gap: '8px' },
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
          <Title2 as="h1">{title}</Title2>
          {subtitle && <Body1 className={styles.subtitle}>{subtitle}</Body1>}
        </div>
        {actions && <div className={styles.actions}>{actions}</div>}
      </header>
      <div className={styles.body}>{children}</div>
    </div>
  );
}
