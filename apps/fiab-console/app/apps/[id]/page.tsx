'use client';

/**
 * /apps/[id] — App detail page. Reads /api/apps-catalog and finds the
 * matching app, then renders its description + bundled item templates.
 * Each item link routes to /items/[type]/new so users can instantiate
 * the app's components into a workspace.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Spinner, makeStyles, tokens, Button, Badge, MessageBar, MessageBarBody } from '@fluentui/react-components';
import { ArrowLeft24Regular } from '@fluentui/react-icons';
import { PageShell } from '@/lib/components/page-shell';

interface AppItemRef { type: string; template?: string; }
interface AppDoc {
  id: string; name: string; description?: string;
  category?: string; publisher?: string;
  items?: AppItemRef[];
}

const useStyles = makeStyles({
  back: { marginBottom: 12 },
  meta: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 },
  desc: { fontSize: 14, lineHeight: 1.6, marginBottom: 16, color: tokens.colorNeutralForeground2 },
  items: { display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' },
  itemCard: {
    padding: 12, borderRadius: 8,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    textDecoration: 'none', color: tokens.colorNeutralForeground1,
    ':hover': { borderColor: tokens.colorBrandStroke1 },
  },
  itemType: { fontSize: 13, fontWeight: 600 },
  itemTpl: { fontSize: 11, color: tokens.colorNeutralForeground3, marginTop: 2 },
});

export default function AppDetailPage() {
  const styles = useStyles();
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [app, setApp] = useState<AppDoc | null | 'notfound'>(null);

  useEffect(() => {
    fetch('/api/apps-catalog').then(r => r.json()).then(d => {
      const a = (d?.apps ?? []).find((x: AppDoc) => x.id === params.id);
      setApp(a ?? 'notfound');
    }).catch(() => setApp('notfound'));
  }, [params.id]);

  if (app === null) return <Spinner label="Loading…" />;
  if (app === 'notfound') {
    return (
      <PageShell title="App not found">
        <MessageBar intent="warning">
          <MessageBarBody>No app with id <code>{params.id}</code> in this tenant.</MessageBarBody>
        </MessageBar>
        <Button className={styles.back} icon={<ArrowLeft24Regular />} onClick={() => router.push('/apps')}>
          Back to Apps
        </Button>
      </PageShell>
    );
  }

  return (
    <PageShell title={app.name}
      actions={
        <Button icon={<ArrowLeft24Regular />} appearance="subtle" onClick={() => router.push('/apps')}>
          All apps
        </Button>}>
      <div className={styles.meta}>
        {app.category && <Badge appearance="outline">{app.category}</Badge>}
        {app.publisher && <Badge appearance="outline" color="brand">by {app.publisher}</Badge>}
      </div>
      {app.description && <div className={styles.desc}>{app.description}</div>}

      <h3 style={{ marginBottom: 8 }}>Bundled items</h3>
      {(!app.items || app.items.length === 0) ? (
        <div style={{ color: tokens.colorNeutralForeground3, fontSize: 13 }}>
          This app doesn't bundle any items yet.
        </div>
      ) : (
        <div className={styles.items}>
          {app.items.map((it, i) => (
            <Link key={`${it.type}-${i}`} href={`/items/${it.type}/new`} className={styles.itemCard}>
              <div className={styles.itemType}>{it.type.replace(/-/g, ' ')}</div>
              {it.template && <div className={styles.itemTpl}>template: {it.template}</div>}
            </Link>
          ))}
        </div>
      )}
    </PageShell>
  );
}
