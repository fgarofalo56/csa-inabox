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
  AvatarGroup, AvatarGroupItem, AvatarGroupPopover, partitionAvatarGroupItems,
  Tooltip,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { clientFetch } from '@/lib/client-fetch';
import {
  ArrowLeft24Regular, Folder20Regular, Flowchart20Regular,
  Folder24Regular, Flowchart24Regular,
} from '@fluentui/react-icons';
import Link from 'next/link';
import { PageShell } from '@/lib/components/page-shell';
import { WorkspaceAvatar } from '@/lib/components/workspace-avatar';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';
import { NewItemDialog } from '@/lib/components/new-item-dialog';
import { WorkspaceSettingsDrawer } from '@/lib/components/workspace-settings-drawer';
import { ManageAccessPane } from '@/lib/panes/manage-access-pane';
import { FoldersPane } from '@/lib/panes/folders';
import { TaskFlowsPane } from '@/lib/panes/task-flows';
import { getWorkspace, type Workspace } from '@/lib/api/workspaces';
import { getItemTypeColor } from '@/lib/components/item-type-icon';

const useStyles = makeStyles({
  back: { marginBottom: tokens.spacingVerticalM },
  identity: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, marginBottom: tokens.spacingVerticalM, minWidth: 0, flexWrap: 'wrap' },
  identitySpacer: { flex: 1 },
  identityText: { display: 'flex', flexDirection: 'column', minWidth: 0 },
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

/** One workspace member row from GET /api/workspaces/[id]/permissions. */
interface MemberRow { upn: string; name?: string; role: string; implicit?: boolean }

/**
 * WorkspaceMembers — the Fabric workspace-header member avatars. Reads the
 * REAL permissions store (Cosmos via the permissions BFF route); the route is
 * owner-scoped, so for non-owners (404/401) the strip simply doesn't render —
 * an honest absence, not a mock.
 */
function WorkspaceMembers({ workspaceId }: { workspaceId: string }) {
  const q = useQuery<MemberRow[]>({
    queryKey: ['workspace-members', workspaceId],
    queryFn: async () => {
      const r = await clientFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/permissions`);
      if (!r.ok) return [];
      const j = await r.json().catch(() => ({}));
      return j?.ok && Array.isArray(j.permissions) ? j.permissions : [];
    },
  });
  const members = q.data ?? [];
  if (members.length === 0) return null;

  const names = members.map((m) => m.name || m.upn).filter(Boolean);
  const { inlineItems, overflowItems } = partitionAvatarGroupItems({ items: names, maxInlineItems: 5 });
  return (
    <Tooltip
      content={`${members.length} member${members.length === 1 ? '' : 's'} — manage via Manage access`}
      relationship="description"
    >
      <AvatarGroup size={28} aria-label={`Workspace members (${members.length})`}>
        {inlineItems.map((name, i) => (
          <AvatarGroupItem key={`${name}-${i}`} name={name} />
        ))}
        {overflowItems && (
          <AvatarGroupPopover>
            {overflowItems.map((name, i) => (
              <AvatarGroupItem key={`${name}-${i}`} name={name} />
            ))}
          </AvatarGroupPopover>
        )}
      </AvatarGroup>
    </Tooltip>
  );
}

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
          <div className={s.identity}>
            <WorkspaceAvatar workspaceId={ws.id} name={ws.name} image={ws.image} size={44} />
            <div className={s.identityText}>
              <Title3>{ws.name}</Title3>
              {ws.description && <Caption1 className={s.hint}>{ws.description}</Caption1>}
            </div>
            <div className={s.identitySpacer} />
            <WorkspaceMembers workspaceId={ws.id} />
          </div>
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

          {tab === 'items' ? (
            <TeachingBanner
              surfaceKey="workspace-items"
              title="Organize items into folders"
              message="Create folders and drag items between them to structure this workspace — the same nesting you get in a Fabric workspace. Use New item to add a notebook, pipeline, or dataset; right-click a folder to rename, move, or delete it."
              learnMoreHref="https://learn.microsoft.com/fabric/get-started/workspaces"
            />
          ) : (
            <TeachingBanner
              surfaceKey="workspace-task-flows"
              title="Map how your work connects"
              message="A task flow is a visual map of the steps that move data through this workspace. Drag steps onto the canvas, connect them, and attach the real items each step runs — a shared, at-a-glance view of the end-to-end process."
              learnMoreHref="https://learn.microsoft.com/fabric/get-started/task-flow-overview"
            />
          )}
          {tab === 'items' && <FoldersPane workspaceId={ws.id} />}
          {tab === 'task-flows' && <TaskFlowsPane workspaceId={ws.id} />}
        </>
      )}
    </PageShell>
  );
}

// Retained for downstream imports that referenced this helper from the page.
export { getItemTypeColor };
