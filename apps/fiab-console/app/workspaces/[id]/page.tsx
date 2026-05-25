'use client';

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Title2,
  Body1,
  Card,
  CardHeader,
  Button,
  Combobox,
  Option,
  Input,
  Field,
  Dialog,
  DialogTrigger,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  makeStyles,
  tokens,
  Spinner,
  MessageBar,
  MessageBarBody,
  Subtitle2,
} from '@fluentui/react-components';
import { Add24Regular, ArrowLeft24Regular } from '@fluentui/react-icons';
import Link from 'next/link';
import { PageShell } from '@/lib/components/page-shell';
import {
  getWorkspace,
  listItems,
  createItem,
  type Workspace,
  type WorkspaceItem,
} from '@/lib/api/workspaces';
import { FABRIC_ITEM_TYPES, findItemType } from '@/lib/catalog/fabric-item-types';

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
  formCol: { display: 'flex', flexDirection: 'column', gap: '12px' },
});

function NewItemForWorkspaceDialog({ workspaceId }: { workspaceId: string }) {
  const styles = useStyles();
  const router = useRouter();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [itemType, setItemType] = useState<string>('');
  const [displayName, setDisplayName] = useState('');

  const sorted = useMemo(
    () => [...FABRIC_ITEM_TYPES].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [],
  );

  const mut = useMutation({
    mutationFn: () => createItem(workspaceId, { itemType, displayName }),
    onSuccess: (item) => {
      qc.invalidateQueries({ queryKey: ['items', workspaceId] });
      setOpen(false);
      setItemType('');
      setDisplayName('');
      router.push(`/items/${item.itemType}/${item.id}`);
    },
  });

  return (
    <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
      <DialogTrigger disableButtonEnhancement>
        <Button appearance="primary" icon={<Add24Regular />}>New item</Button>
      </DialogTrigger>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>New item</DialogTitle>
          <DialogContent>
            <div className={styles.formCol}>
              <Field label="Item type" required>
                <Combobox
                  placeholder="Pick an item type"
                  value={itemType ? (findItemType(itemType)?.displayName ?? itemType) : ''}
                  selectedOptions={itemType ? [itemType] : []}
                  onOptionSelect={(_, d) => setItemType(d.optionValue ?? '')}
                >
                  {sorted.map((t) => (
                    <Option key={t.slug} value={t.slug} text={t.displayName}>
                      {t.displayName} <span style={{ color: tokens.colorNeutralForeground3, marginLeft: 8 }}>({t.category})</span>
                    </Option>
                  ))}
                </Combobox>
              </Field>
              <Field label="Name" required>
                <Input
                  value={displayName}
                  onChange={(_, d) => setDisplayName(d.value)}
                  placeholder="My new item"
                />
              </Field>
              {mut.error && (
                <MessageBar intent="error">
                  <MessageBarBody>{(mut.error as Error).message}</MessageBarBody>
                </MessageBar>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary">Cancel</Button>
            </DialogTrigger>
            <Button
              appearance="primary"
              disabled={!itemType || !displayName.trim() || mut.isPending}
              onClick={() => mut.mutate()}
            >
              {mut.isPending ? 'Creating…' : 'Create'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

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
      actions={ws ? <NewItemForWorkspaceDialog workspaceId={ws.id} /> : undefined}
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
