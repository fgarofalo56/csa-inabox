'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Title2,
  Body1,
  Card,
  CardHeader,
  Button,
  makeStyles,
  tokens,
  Spinner,
  MessageBar,
  MessageBarBody,
  Subtitle2,
} from '@fluentui/react-components';
import { ArrowLeft24Regular } from '@fluentui/react-icons';
import Link from 'next/link';
import { PageShell } from '@/lib/components/page-shell';
import { NewItemDialog } from '@/lib/components/new-item-dialog';
import {
  getWorkspace,
  listItems,
  type Workspace,
  type WorkspaceItem,
} from '@/lib/api/workspaces';
import { findItemType } from '@/lib/catalog/fabric-item-types';

const useStyles = makeStyles({
  back: { marginBottom: '12px' },
  header: { display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '24px' },
  spacer: { flex: 1 },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
    gap: '12px',
  },
  card: {
    cursor: 'pointer',
    transition: 'transform 0.15s, box-shadow 0.15s',
    ':hover': { transform: 'translateY(-2px)', boxShadow: tokens.shadow8 },
  },
  meta: { fontSize: '12px', color: tokens.colorNeutralForeground3 },
  empty: {
    padding: '40px',
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    borderRadius: '8px',
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
      actions={ws ? <NewItemDialog workspaceId={ws.id} /> : undefined}
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
                    style={{ textDecoration: 'none' }}
                  >
                    <Card className={styles.card}>
                      <CardHeader
                        header={<Subtitle2>{it.displayName}</Subtitle2>}
                        description={
                          <div>
                            <div className={styles.meta}>{meta?.displayName ?? it.itemType}</div>
                            {it.description && <Body1>{it.description}</Body1>}
                            <div className={styles.meta}>
                              Updated {new Date(it.updatedAt).toLocaleDateString()}
                            </div>
                          </div>
                        }
                      />
                    </Card>
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
