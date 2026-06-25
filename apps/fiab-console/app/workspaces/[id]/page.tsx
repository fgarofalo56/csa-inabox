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
  Title3, Caption1, Body1, Button, Spinner,
  TabList, Tab,
  MessageBar, MessageBarBody,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowLeft24Regular, Folder20Regular, Flowchart20Regular,
  Folder24Regular, Flowchart24Regular,
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
  back: { marginBottom: tokens.spacingVerticalM },
  header: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: tokens.spacingHorizontalL, marginBottom: tokens.spacingVerticalS },
  // section heading: leading accent icon + title/hint stack, matching the
  // polished section-header pattern used across the Console.
  heading: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, minWidth: 0 },
  headingIcon: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: tokens.colorNeutralForegroundOnBrand,
    backgroundImage: `linear-gradient(135deg, ${tokens.colorBrandBackground2}, ${tokens.colorBrandBackground})`,
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow4,
    width: '40px',
    height: '40px',
    flexShrink: 0,
  },
  headingText: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  hint: { color: tokens.colorNeutralForeground3 },
  spacer: { flex: 1 },
  meta: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3, overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 },
  tabs: { marginBottom: tokens.spacingVerticalM },
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
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS }}>
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
            <div className={s.heading}>
              <div className={s.headingIcon} aria-hidden>
                {tab === 'items' ? <Folder24Regular /> : <Flowchart24Regular />}
              </div>
              <div className={s.headingText}>
                <Title3>{tab === 'items' ? 'Items' : 'Task flows'}</Title3>
                <Caption1 className={s.hint}>
                  {tab === 'items'
                    ? 'Organize notebooks, pipelines, and datasets into folders.'
                    : 'Map and orchestrate the steps that connect this workspace.'}
                </Caption1>
              </div>
            </div>
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
