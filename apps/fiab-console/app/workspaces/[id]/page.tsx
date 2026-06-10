'use client';

/**
 * Workspace detail — Fabric-parity workspace view.
 *
 * Two surfaces, switched by a Fluent TabList mirroring the Fabric workspace:
 *   - "Items" — the nested folder hierarchy (create / rename / move / delete +
 *     HTML5 drag-and-drop), rendered by the reusable FoldersPane (F10).
 *   - "Task flows" — the visual task-flow step canvas on @xyflow/react,
 *     rendered by TaskFlowsPane (F11).
 *
 * Both panes own their own queries + mutations against the real Cosmos-backed
 * BFF routes — no Fabric dependency.
 */

import { useState, use } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Title2, Body1, Button, Spinner,
  TabList, Tab,
  MessageBar, MessageBarBody,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowLeft24Regular, Folder20Regular, Flowchart20Regular,
} from '@fluentui/react-icons';
import Link from 'next/link';
import { PageShell } from '@/lib/components/page-shell';
import { NewItemDialog } from '@/lib/components/new-item-dialog';
import { WorkspaceSettingsDrawer } from '@/lib/components/workspace-settings-drawer';
import { ManageAccessPane } from '@/lib/panes/manage-access-pane';
import { FoldersPane } from '@/lib/panes/folders';
import { TaskFlowsPane } from '@/lib/panes/task-flows';
import { getWorkspace, type Workspace } from '@/lib/api/workspaces';
import { getItemTypeColor } from '@/lib/components/item-type-icon';

const useStyles = makeStyles({
  back: { marginBottom: '12px' },
  header: { display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '8px' },
  spacer: { flex: 1 },
  meta: { fontSize: '11px', color: tokens.colorNeutralForeground3 },
  tabs: { marginBottom: '12px' },
});

export default function WorkspaceDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = use(props.params);
  const s = useStyles();
  const [tab, setTab] = useState<'items' | 'task-flows'>('items');

  const wsQ = useQuery<Workspace>({
    queryKey: ['workspace', params.id],
    queryFn: () => getWorkspace(params.id),
  });
  const ws = wsQ.data;

  return (
    <PageShell
      title={ws?.name ?? 'Workspace'}
      subtitle={ws?.description}
      actions={ws ? (
        <div style={{ display: 'flex', gap: 4 }}>
          <ManageAccessPane workspaceId={ws.id} />
          <WorkspaceSettingsDrawer workspace={ws} />
          <NewItemDialog workspaceId={ws.id} />
        </div>
      ) : undefined}
    >
      <div className={s.back}>
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
          <div className={s.header}>
            <Title2>{tab === 'items' ? 'Items' : 'Task flows'}</Title2>
            <div className={s.spacer} />
            <Body1 className={s.meta}>
              {ws.capacity ? `Capacity ${ws.capacity}` : 'No capacity'}
              {ws.domain ? ` · ${ws.domain}` : ''}
            </Body1>
          </div>

          <TabList
            className={s.tabs}
            selectedValue={tab}
            onTabSelect={(_e, d) => setTab(d.value as 'items' | 'task-flows')}
          >
            <Tab value="items" icon={<Folder20Regular />}>Items</Tab>
            <Tab value="task-flows" icon={<Flowchart20Regular />}>Task flows</Tab>
          </TabList>

          {tab === 'items' && <FoldersPane workspaceId={ws.id} />}
          {tab === 'task-flows' && <TaskFlowsPane workspaceId={ws.id} />}
        </>
      )}
    </PageShell>
  );
}

// Retained for downstream imports that referenced this helper from the page.
export { getItemTypeColor };
