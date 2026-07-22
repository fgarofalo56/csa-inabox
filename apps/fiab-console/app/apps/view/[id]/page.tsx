'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * /apps/view/[id] — consumer view of a published Loom org app.
 *
 * DISTINCT from /apps/[id] (the installable apps-catalog detail page). This
 * route resolves the org-app manifest (nav filtered to the caller's audience
 * membership, display names refreshed from the live items) via
 * GET /api/items/loom-app/[id]/render and renders the navigation. Each tile
 * deep-links to the real item under the consumer's own identity + governance.
 * Azure-native — no Fabric or Power BI (.claude/rules/no-fabric-dependency.md).
 */

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Subtitle2, Body1, Caption1, Badge, Spinner,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Open20Regular, LockClosed24Regular } from '@fluentui/react-icons';
import { PageShell } from '@/lib/components/page-shell';
import { EmptyState } from '@/lib/components/empty-state';
import { getItemTypeIcon } from '@/lib/components/item-type-icon';
import { findItemType } from '@/lib/catalog/fabric-item-types';

interface NavItem { itemId: string; itemType: string; displayName: string; section: string; href: string }
interface NavGroup { section: string; items: NavItem[] }
interface AppManifest {
  id: string; displayName: string; description: string;
  published: boolean; publishedAt: string | null; version: number;
  audiences: string[]; itemCount: number; nav: NavGroup[];
}

const useStyles = makeStyles({
  meta: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', marginBottom: tokens.spacingVerticalL },
  group: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, marginBottom: tokens.spacingVerticalXL },
  tile: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}`,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1, cursor: 'pointer', textAlign: 'left', width: '100%',
    // Native <button>: without an explicit color, text inherits UA ButtonText (black-on-dark).
    color: tokens.colorNeutralForeground1,
    boxShadow: tokens.shadow2,
    transitionDuration: tokens.durationNormal,
    transitionTimingFunction: tokens.curveEasyEase,
    transitionProperty: 'box-shadow, border-color',
    ':hover': { boxShadow: tokens.shadow8, border: `1px solid ${tokens.colorBrandStroke1}` },
  },
  tileName: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  grow: { flexGrow: 1 },
  center: { display: 'flex', justifyContent: 'center', padding: tokens.spacingVerticalXXL },
});

export default function LoomAppConsumerPage(props: { params: Promise<{ id: string }> }) {
  const { id } = use(props.params);
  const s = useStyles();
  const router = useRouter();
  const [app, setApp] = useState<AppManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ status: number; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    clientFetch(`/api/items/loom-app/${encodeURIComponent(id)}/render`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!j?.ok) { setError({ status: r.status, text: j?.error || `HTTP ${r.status}` }); return; }
        setApp(j.app as AppManifest);
      })
      .catch((e) => { if (!cancelled) setError({ status: 0, text: String(e?.message || e) }); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  const title = app?.displayName || 'App';

  return (
    <PageShell title={title} subtitle={app?.description || undefined}
      breadcrumbs={[{ label: 'Home', href: '/' }, { label: 'Loom Apps', href: '/workload-hub/fabric-apps' }, { label: title }]}>
      {loading ? (
        <div className={s.center}><Spinner label="Opening app…" labelPosition="after" /></div>
      ) : error ? (
        error.status === 403 ? (
          <EmptyState icon={<LockClosed24Regular />} title="You don't have access to this app"
            body="You're not a member of any audience for this app. Ask the app owner to add you to an audience." />
        ) : error.status === 404 ? (
          <EmptyState title="App not found" body="This app doesn't exist or you don't have access to its workspace." />
        ) : (
          <MessageBar intent="error"><MessageBarBody>{error.text}</MessageBarBody></MessageBar>
        )
      ) : app ? (
        <>
          <div className={s.meta}>
            {app.published
              ? <Badge appearance="tint" color="success">Published v{app.version}</Badge>
              : <Badge appearance="tint" color="warning">Draft (owner preview)</Badge>}
            <Badge appearance="tint" color="informative">{app.itemCount} item{app.itemCount === 1 ? '' : 's'}</Badge>
            {app.audiences.map((a) => <Badge key={a} appearance="outline" color="brand">{a}</Badge>)}
          </div>

          {!app.published && (
            <MessageBar intent="warning"><MessageBarBody>
              <MessageBarTitle>Not published yet</MessageBarTitle>
              This app hasn&apos;t been published. Consumers can&apos;t open it until the owner publishes it.
            </MessageBarBody></MessageBar>
          )}

          {app.nav.length === 0 ? (
            <EmptyState title="Nothing to show" body="No content is visible to you in this app." />
          ) : app.nav.map((g, gi) => (
            <div key={g.section || `g${gi}`} className={s.group}>
              <Subtitle2>{g.section || 'Content'}</Subtitle2>
              {g.items.map((it) => (
                <button key={it.itemId} type="button" className={s.tile} onClick={() => router.push(it.href)}>
                  <span className={s.tileName}>{getItemTypeIcon(it.itemType)}<Body1>{it.displayName}</Body1></span>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{findItemType(it.itemType)?.displayName || it.itemType}</Caption1>
                  <span className={s.grow} />
                  <Open20Regular />
                </button>
              ))}
            </div>
          ))}
        </>
      ) : null}
    </PageShell>
  );
}
