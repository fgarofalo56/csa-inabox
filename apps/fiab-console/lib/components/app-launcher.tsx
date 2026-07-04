'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * AppLauncher — waffle button in the top bar. Opens a drawer listing apps
 * from /api/apps-catalog (curated CSA apps under tenant=session.claims.oid;
 * seeded from GLOBAL on first sign-in). Click an app card → navigates to
 * /apps/[id]. Real BFF data; no vaporware.
 */

import { useEffect, useState } from 'react';
import {
  Button, Tooltip, makeStyles, tokens,
  Drawer, DrawerHeader, DrawerHeaderTitle, DrawerBody,
} from '@fluentui/react-components';
import { Apps24Regular, Dismiss24Regular, Open20Regular } from '@fluentui/react-icons';

interface AppDoc {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  category?: string;
  publisher?: string;
}

const useStyles = makeStyles({
  trigger: {
    color: 'white',
    transition: 'background-color var(--loom-motion-fast) var(--loom-motion-ease)',
    ':hover': { backgroundColor: 'rgba(255,255,255,0.10)' },
    flexShrink: 0,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: 'var(--loom-space-3)',
  },
  card: {
    display: 'flex', flexDirection: 'column',
    gap: 'var(--loom-space-1)',
    padding: 'var(--loom-space-3)',
    borderRadius: 'var(--loom-radius-md)',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    cursor: 'pointer',
    textDecoration: 'none',
    color: tokens.colorNeutralForeground1,
    transition: 'background-color var(--loom-motion-fast) var(--loom-motion-ease)',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  cardName: { fontWeight: 600, fontSize: tokens.fontSizeBase300 },
  cardDesc: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2, lineHeight: 1.4 },
  cardCat: {
    fontSize: '11px', color: tokens.colorNeutralForeground3,
    textTransform: 'uppercase', letterSpacing: '0.04em',
  },
  empty: { color: tokens.colorNeutralForeground2, fontSize: '13px' },
  footer: {
    marginTop: 'var(--loom-space-4)',
    paddingTop: 'var(--loom-space-3)',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    display: 'flex',
    justifyContent: 'flex-end',
  },
});

export function AppLauncher() {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [apps, setApps] = useState<AppDoc[] | null>(null);

  useEffect(() => {
    if (!open || apps !== null) return;
    let cancelled = false;
    clientFetch('/api/apps-catalog').then(r => r.json()).then(d => {
      if (!cancelled) setApps(Array.isArray(d?.apps) ? d.apps : []);
    }).catch(() => { if (!cancelled) setApps([]); });
    return () => { cancelled = true; };
  }, [open, apps]);

  return (
    <>
      <Tooltip content="Apps" relationship="label">
        <Button appearance="transparent" className={styles.trigger}
          icon={<Apps24Regular />} onClick={() => setOpen(true)}
          aria-label="App launcher" />
      </Tooltip>
      <Drawer open={open} onOpenChange={(_, d) => setOpen(d.open)} position="start" size="medium">
        <DrawerHeader>
          <DrawerHeaderTitle action={
            <Button appearance="subtle" icon={<Dismiss24Regular />}
              onClick={() => setOpen(false)} aria-label="Close" />
          }>
            Apps
          </DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody>
          {apps === null && <div className={styles.empty}>Loading…</div>}
          {apps !== null && apps.length === 0 && (
            <div className={styles.empty}>
              No apps installed yet. Curated CSA apps will appear after your tenant is seeded.
            </div>
          )}
          {apps !== null && apps.length > 0 && (
            <div className={styles.grid}>
              {apps.map(a => (
                <a key={a.id} href={`/apps/${a.id}`} className={styles.card}
                   onClick={() => setOpen(false)}>
                  {a.category && <span className={styles.cardCat}>{a.category}</span>}
                  <span className={styles.cardName}>{a.name}</span>
                  {a.description && <span className={styles.cardDesc}>{a.description}</span>}
                </a>
              ))}
            </div>
          )}
          <div className={styles.footer}>
            <Button as="a" href="/apps" appearance="subtle" size="small"
              icon={<Open20Regular />} onClick={() => setOpen(false)}>
              See all apps
            </Button>
          </div>
        </DrawerBody>
      </Drawer>
    </>
  );
}
