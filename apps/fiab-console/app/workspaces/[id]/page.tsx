'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Title2,
  Body1,
  Button,
  makeStyles,
  tokens,
  Spinner,
  MessageBar,
  MessageBarBody,
} from '@fluentui/react-components';
import { ArrowLeft24Regular } from '@fluentui/react-icons';
import Link from 'next/link';
import { PageShell } from '@/lib/components/page-shell';
import { NewItemDialog } from '@/lib/components/new-item-dialog';
import { WorkspaceSettingsDrawer } from '@/lib/components/workspace-settings-drawer';
import {
  getWorkspace,
  listItems,
  type Workspace,
  type WorkspaceItem,
} from '@/lib/api/workspaces';
import { findItemType } from '@/lib/catalog/fabric-item-types';

const useStyles = makeStyles({
  back: { marginBottom: '12px' },
  header: { display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '20px' },
  spacer: { flex: 1 },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: '16px',
  },
  card: {
    paddingTop: '18px', paddingRight: '18px', paddingBottom: '18px', paddingLeft: '18px',
    borderRadius: '10px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    textDecoration: 'none',
    display: 'flex', flexDirection: 'column',
    minHeight: '120px',
    cursor: 'pointer',
    transition: 'transform 0.15s, box-shadow 0.15s, border-color 0.15s',
    ':hover': {
      transform: 'translateY(-2px)',
      boxShadow: tokens.shadow8,
      borderColor: tokens.colorBrandStroke1,
    },
  },
  cardType: {
    fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em',
    color: tokens.colorNeutralForeground3, fontWeight: 600, marginBottom: '6px',
  },
  cardName: { fontSize: '15px', fontWeight: 600, lineHeight: 1.3, marginBottom: '6px' },
  cardDesc: { fontSize: '13px', color: tokens.colorNeutralForeground2, lineHeight: 1.45, marginBottom: '8px' },
  meta: { fontSize: '11px', color: tokens.colorNeutralForeground3, marginTop: 'auto' },
  empty: {
    paddingTop: '32px', paddingRight: '32px', paddingBottom: '32px', paddingLeft: '32px',
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    borderRadius: '12px', lineHeight: 1.6,
  },
});

export default function WorkspaceDetailPage({ params }: { params: { id: string } }) {
  const styles = useStyles();
  const wsQ = useQuery<Workspace>({
    queryKey: ['workspace', params.id],
    queryFn: () => getWorkspace(params.id),
  });
  const itemsQ = useQuery<WorkspaceItem[]>({
    queryKey: ['items', params.id],
    queryFn: () => listItems(params.id),
    enabled: !!wsQ.data,
  });

  const ws = wsQ.data;
  const items = itemsQ.data;

  return (
    <PageShell
      title={ws?.name ?? 'Workspace'}
      subtitle={ws?.description}
      actions={ws ? (
        <div style={{ display: 'flex', gap: 4 }}>
          <WorkspaceSettingsDrawer workspace={ws} />
          <NewItemDialog workspaceId={ws.id} />
        </div>
      ) : undefined}
    >
      <div className={styles.back}>
        <Link href="/workspaces">
          <Button appearance="subtle" icon={<ArrowLeft24Regular />}>All workspaces</Button>
        </Link>
      </div>

      {wsQ.isLoading && <Spinner label="Loading workspace…" />}
      {wsQ.error && (
        <MessageBar intent="error">
          <MessageBarBody>Failed to load workspace: {(wsQ.error as Error).message}</MessageBarBody>
        </MessageBar>
      )}

      {ws && (
        <>
          <div className={styles.header}>
            <Title2>Items</Title2>
            <div className={styles.spacer} />
            <Body1 className={styles.meta}>
              {ws.capacity ? `Capacity ${ws.capacity}` : 'No capacity'}{ws.domain ? ` · ${ws.domain}` : ''}
            </Body1>
          </div>

          {itemsQ.isLoading && <Spinner label="Loading items…" />}
          {itemsQ.error && (
            <MessageBar intent="error">
              <MessageBarBody>Failed to load items: {(itemsQ.error as Error).message}</MessageBarBody>
            </MessageBar>
          )}

          {items && items.length === 0 && (
            <div className={styles.empty}>
              <Body1>No items in this workspace yet. Click "New item" to add one.</Body1>
            </div>
          )}

          {items && items.length > 0 && (
            <div className={styles.grid}>
              {items.map((it) => {
                const meta = findItemType(it.itemType);
                return (
                  <Link
                    key={it.id}
                    href={`/items/${it.itemType}/${it.id}`}
                    className={styles.card}
                  >
                    <div className={styles.cardType}>{meta?.displayName ?? it.itemType.replace(/-/g, ' ')}</div>
                    <div className={styles.cardName}>{it.displayName}</div>
                    {it.description && <div className={styles.cardDesc}>{it.description}</div>}
                    <div className={styles.meta}>
                      Updated {new Date(it.updatedAt).toLocaleDateString()}
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </>
      )}
    </PageShell>
  );
}
