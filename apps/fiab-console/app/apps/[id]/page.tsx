'use client';

/**
 * /apps/[id] — App detail page. Reads /api/apps-catalog and finds the
 * matching app, then renders its description + bundled item templates.
 *
 * **Install** button opens the shared InstallAppDialog wizard, which picks a
 * workspace and POSTs /api/apps/[id]/install — creating every bundled item in
 * the chosen workspace via the shared createOwnedItem helper, then running the
 * real Azure-native provisioners. Idempotent — items with the same
 * displayName + itemType already in the workspace are skipped. The provisioning
 * report renders inside the dialog (same wizard the /learn use-case card uses).
 */

import { clientFetch } from '@/lib/client-fetch';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  Spinner, makeStyles, tokens, Button, Badge, Text,
  MessageBar, MessageBarBody,
} from '@fluentui/react-components';
import { ArrowLeft24Regular, AppGeneric24Regular, Open16Regular } from '@fluentui/react-icons';
import { PageShell } from '@/lib/components/page-shell';
import { Section } from '@/lib/components/ui/section';
import { itemVisual } from '@/lib/components/ui/item-type-visual';
import { InstallAppDialog } from '@/lib/components/apps/install-app-dialog';

interface AppItemRef { type: string; template?: string; displayName?: string; }
interface AppDoc {
  id: string; name: string; description?: string;
  category?: string; publisher?: string;
  items?: AppItemRef[];
}

const useStyles = makeStyles({
  meta: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    alignItems: 'center',
    flexWrap: 'wrap',
    marginBottom: tokens.spacingVerticalM,
  },
  desc: {
    lineHeight: 1.6,
    marginBottom: tokens.spacingVerticalXXL,
    color: tokens.colorNeutralForeground2,
    maxWidth: '76ch',
  },
  items: {
    display: 'grid',
    gap: tokens.spacingHorizontalM,
    gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
  },
  itemCard: {
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2,
    textDecorationLine: 'none',
    color: tokens.colorNeutralForeground1,
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    minWidth: 0,
    transitionDuration: tokens.durationNormal,
    transitionTimingFunction: tokens.curveEasyEase,
    transitionProperty: 'box-shadow, transform, border-color',
    ':hover': {
      boxShadow: tokens.shadow8,
      transform: 'translateY(-2px)',
      border: `1px solid ${tokens.colorBrandStroke1}`,
    },
  },
  itemChip: {
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '40px',
    height: '40px',
    borderRadius: tokens.borderRadiusLarge,
  },
  itemMain: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: 1 },
  itemType: {
    fontWeight: tokens.fontWeightSemibold,
    textTransform: 'capitalize',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  itemTpl: {
    color: tokens.colorNeutralForeground3,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  itemOpen: { flexShrink: 0, color: tokens.colorNeutralForeground4 },
  empty: {
    padding: tokens.spacingVerticalXXL,
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
});

export default function AppDetailPage() {
  const styles = useStyles();
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [app, setApp] = useState<AppDoc | null | 'notfound'>(null);
  const [installOpen, setInstallOpen] = useState(false);

  useEffect(() => {
    clientFetch('/api/apps-catalog').then(r => r.json()).then(d => {
      const a = (d?.apps ?? []).find((x: AppDoc) => x.id === params.id);
      setApp(a ?? 'notfound');
    }).catch(() => setApp('notfound'));
  }, [params.id]);

  if (app === null) {
    return (
      <PageShell title="App">
        <div style={{ display: 'flex', justifyContent: 'center', padding: tokens.spacingVerticalXXL }}>
          <Spinner label="Loading app…" />
        </div>
      </PageShell>
    );
  }
  if (app === 'notfound') {
    return (
      <PageShell title="App not found">
        <MessageBar intent="warning">
          <MessageBarBody>No app with id <code>{params.id}</code> in this tenant.</MessageBarBody>
        </MessageBar>
        <div style={{ marginTop: tokens.spacingVerticalL }}>
          <Button icon={<ArrowLeft24Regular />} onClick={() => router.push('/apps')}>
            Back to Apps
          </Button>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell title={app.name}
      actions={
        <div style={{ display: 'flex', gap: 8 }}>
          <Button icon={<ArrowLeft24Regular />} appearance="subtle" onClick={() => router.push('/apps')}>
            All apps
          </Button>
          <Button appearance="primary" icon={<AppGeneric24Regular />}
            onClick={() => setInstallOpen(true)}
            disabled={!app.items?.length}>
            Install into workspace
          </Button>
        </div>}>
      <div className={styles.meta}>
        {app.category && <Badge appearance="outline">{app.category}</Badge>}
        {app.publisher && <Badge appearance="outline" color="brand">by {app.publisher}</Badge>}
      </div>
      {app.description && <Text as="p" size={300} className={styles.desc}>{app.description}</Text>}

      <Section title={`Bundled items (${app.items?.length ?? 0})`} bare>
        {(!app.items || app.items.length === 0) ? (
          <div className={styles.empty}>
            <Text size={300}>This app doesn&apos;t bundle any items yet.</Text>
          </div>
        ) : (
          <div className={styles.items}>
            {app.items.map((it, i) => {
              const visual = itemVisual(it.type);
              const Icon = visual.icon;
              return (
                // v2 validator finding: prefetch={false} kills the RSC payload
                // bursts that the validator caught as "URL auto-rotator" —
                // Next 14 Link prefetches every visible item card on mount,
                // which against /items/<type>/new flooded the network panel
                // and made the page look like it was navigating itself.
                <Link
                  key={`${it.type}-${i}`}
                  href={`/items/${it.type}/new`}
                  className={styles.itemCard}
                  prefetch={false}
                >
                  <span
                    className={styles.itemChip}
                    style={{ backgroundColor: `${visual.color}1f`, color: visual.color }}
                    aria-hidden
                  >
                    <Icon style={{ width: 22, height: 22, color: visual.color }} />
                  </span>
                  <span className={styles.itemMain}>
                    <Text size={300} className={styles.itemType}>
                      {it.displayName || it.type.replace(/-/g, ' ')}
                    </Text>
                    <Text size={200} className={styles.itemTpl}>
                      {it.template ? `template: ${it.template}` : visual.label}
                    </Text>
                  </span>
                  <Open16Regular className={styles.itemOpen} />
                </Link>
              );
            })}
          </div>
        )}
      </Section>

      <InstallAppDialog
        appId={app.id}
        appName={app.name}
        itemCount={app.items?.length ?? 0}
        open={installOpen}
        onOpenChange={setInstallOpen}
      />
    </PageShell>
  );
}
