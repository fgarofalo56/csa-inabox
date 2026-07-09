'use client';

/**
 * ExplorerTree (SC-7) — the shared typed-icon explorer tree with right-click
 * context menus + lazy child loading, lifted out of the ADF
 * `FactoryResourcesTree`. It gives every Loom navigator (Synapse workspace tree,
 * Lakehouse explorer, KQL tree, Cosmos container explorer, AI-Search index tree)
 * the same Fabric/ADF-Studio parity model:
 *
 *   - per-kind icon (via `iconFor`) on every branch + leaf,
 *   - a "Filter resources by name" box that prunes the forest,
 *   - a RIGHT-CLICK CONTEXT MENU per node (`actionsFor` → `onAction`),
 *   - optional INLINE action buttons on a row (Open / Delete / Start / Stop),
 *   - controlled expand state + LAZY child loading (`loadChildren`) on expand,
 *   - a header slot (`headerActions`) for the "Add new resource" menu + Refresh,
 *   - an honest infra-gate slot (`gate`) rendered in place of the tree.
 *
 * The component is purely presentational over nodes the consumer builds from its
 * OWN real REST list calls — no mock data (no-vaporware.md), no Fabric
 * dependency. The pure filter / branch logic lives in `explorer-tree-model.ts`.
 */

import { Fragment, useCallback, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import {
  Tree, TreeItem, TreeItemLayout, type TreeOpenChangeData, type TreeItemValue,
  Button, Input, Field, Caption1, Badge, Spinner, Tooltip,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, MenuDivider,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync16Regular, Search20Regular, MoreHorizontal20Regular } from '@fluentui/react-icons';
import {
  filterExplorerNodes, isBranch,
  type ExplorerNode, type ExplorerAction,
} from './explorer-tree-model';

export type { ExplorerNode, ExplorerAction } from './explorer-tree-model';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalS, padding: tokens.spacingHorizontalS, height: '100%', minWidth: '240px' },
  header: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, justifyContent: 'space-between' },
  title: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase300 },
  headerActions: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS, flexShrink: 0 },
  row: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, width: '100%', minWidth: 0 },
  actions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS, flexShrink: 0 },
  nameText: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '1 1 auto' },
  scroll: { overflow: 'auto', flex: 1 },
});

export interface ExplorerTreeProps {
  /** Root nodes — branches (with `children` or `hasChildren`) + leaves. */
  nodes: ExplorerNode[];
  /** Map a node's `kind` to its icon. */
  iconFor?: (node: ExplorerNode) => ReactElement;
  /** Ordered actions for a node's right-click menu (+ inline buttons when `inline`). */
  actionsFor?: (node: ExplorerNode) => ExplorerAction[];
  /** Dispatch a chosen action. */
  onAction?: (actionKey: string, node: ExplorerNode) => void;
  /** Activate a node (click / Enter on its label). */
  onOpen?: (node: ExplorerNode) => void;
  /** Lazily load a branch's children on first expand (branch has `hasChildren`). */
  loadChildren?: (node: ExplorerNode) => Promise<ExplorerNode[]>;
  /** Header title (left). */
  title?: string;
  /** Header action slot (right) — e.g. an "Add new resource" menu + Refresh. */
  headerActions?: ReactNode;
  /** Show the built-in Refresh button in the header. */
  onRefresh?: () => void;
  loading?: boolean;
  error?: string | null;
  /** Honest infra-gate content — rendered instead of the tree when present. */
  gate?: ReactNode;
  filterable?: boolean;
  filterPlaceholder?: string;
  ariaLabel?: string;
  emptyLabel?: string;
  /** Branch ids expanded by default. */
  defaultOpenIds?: string[];
}

interface LazyState { status: 'loading' | 'ok' | 'error'; children?: ExplorerNode[]; error?: string }

/** Wrap a row in a right-click (context) menu built from the node's actions. */
function NodeContextMenu({
  actions, onPick, children,
}: {
  actions: ExplorerAction[];
  onPick: (key: string) => void;
  children: ReactElement;
}) {
  if (!actions.length) return children;
  return (
    <Menu openOnContext>
      <MenuTrigger disableButtonEnhancement>{children}</MenuTrigger>
      <MenuPopover>
        <MenuList>
          {actions.map((a, i) => (
            <Fragment key={a.key}>
              {a.destructive && i > 0 && <MenuDivider />}
              <MenuItem icon={a.icon} disabled={a.disabled} onClick={() => onPick(a.key)}>{a.label}</MenuItem>
            </Fragment>
          ))}
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}

export function ExplorerTree(props: ExplorerTreeProps) {
  const {
    nodes, iconFor, actionsFor, onAction, onOpen, loadChildren,
    title, headerActions, onRefresh, loading, error, gate,
    filterable = true, filterPlaceholder = 'Filter resources by name',
    ariaLabel = 'Explorer', emptyLabel = 'No items', defaultOpenIds = [],
  } = props;
  const s = useStyles();

  const [filter, setFilter] = useState('');
  const [openItems, setOpenItems] = useState<TreeItemValue[]>(defaultOpenIds);
  const [lazy, setLazy] = useState<Record<string, LazyState>>({});

  const filtered = useMemo(() => filterExplorerNodes(nodes, filter), [nodes, filter]);

  const onOpenChange = useCallback((_e: unknown, data: TreeOpenChangeData) => {
    const next = Array.from(data.openItems);
    setOpenItems(next);
    // On newly-expanded lazy branches (hasChildren + no preloaded children), load.
    if (loadChildren) {
      const opened = next.find((v) => !openItems.includes(v));
      if (opened != null) {
        const node = findNode(nodes, String(opened));
        if (node && node.hasChildren && !node.children && !lazy[node.id]) {
          setLazy((prev) => ({ ...prev, [node.id]: { status: 'loading' } }));
          void loadChildren(node)
            .then((kids) => setLazy((prev) => ({ ...prev, [node.id]: { status: 'ok', children: kids } })))
            .catch((e: unknown) => setLazy((prev) => ({ ...prev, [node.id]: { status: 'error', error: e instanceof Error ? e.message : String(e) } })));
        }
      }
    }
  }, [nodes, openItems, loadChildren, lazy]);

  // Reset stale lazy caches if the node set identity changes wholesale.
  useEffect(() => { setLazy((prev) => (Object.keys(prev).length ? {} : prev)); }, [nodes]);

  const pick = useCallback((key: string, node: ExplorerNode) => onAction?.(key, node), [onAction]);

  const renderLeaf = (node: ExplorerNode): ReactElement => {
    const actions = actionsFor?.(node) ?? [];
    const inline = actions.filter((a) => a.inline);
    const openable = !!onOpen;
    const nameEl = (
      <span
        className={s.nameText}
        title={node.label}
        role={openable ? 'button' : undefined}
        tabIndex={openable ? 0 : undefined}
        style={{ cursor: openable ? 'pointer' : undefined, fontWeight: node.emphasized ? tokens.fontWeightSemibold : undefined }}
        onClick={openable ? () => onOpen?.(node) : undefined}
        onKeyDown={openable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen?.(node); } } : undefined}
      >
        {node.label}{node.emphasized ? ' ·' : ''}
      </span>
    );
    return (
      <TreeItem key={node.id} itemType="leaf" value={node.id}>
        <TreeItemLayout iconBefore={iconFor?.(node)}>
          <NodeContextMenu actions={actions} onPick={(k) => pick(k, node)}>
            <span className={s.row}>
              {nameEl}
              <span className={s.actions} onClick={(e) => e.stopPropagation()}>
                {node.meta && <Caption1>{node.meta}</Caption1>}
                {node.badge && <Badge size="small" appearance={node.badge.appearance ?? 'filled'} color={node.badge.color}>{node.badge.text}</Badge>}
                {inline.map((a) => (
                  <Tooltip key={a.key} content={a.label} relationship="label">
                    <Button size="small" appearance="subtle" icon={a.icon} disabled={a.disabled} onClick={() => pick(a.key, node)} aria-label={`${a.label} ${node.label}`} />
                  </Tooltip>
                ))}
                {actions.length > 0 && (
                  <Menu>
                    <MenuTrigger disableButtonEnhancement>
                      <Tooltip content="More actions" relationship="label">
                        <Button size="small" appearance="subtle" icon={<MoreHorizontal20Regular />} aria-label={`Actions for ${node.label}`} />
                      </Tooltip>
                    </MenuTrigger>
                    <MenuPopover>
                      <MenuList>
                        {actions.map((a, i) => (
                          <Fragment key={a.key}>
                            {a.destructive && i > 0 && <MenuDivider />}
                            <MenuItem icon={a.icon} disabled={a.disabled} onClick={() => pick(a.key, node)}>{a.label}</MenuItem>
                          </Fragment>
                        ))}
                      </MenuList>
                    </MenuPopover>
                  </Menu>
                )}
              </span>
            </span>
          </NodeContextMenu>
        </TreeItemLayout>
      </TreeItem>
    );
  };

  const renderBranch = (node: ExplorerNode): ReactElement => {
    const actions = actionsFor?.(node) ?? [];
    const inline = actions.filter((a) => a.inline);
    const lazyState = lazy[node.id];
    const kids = node.children ?? lazyState?.children ?? [];
    return (
      <TreeItem key={node.id} itemType="branch" value={node.id}>
        <TreeItemLayout iconBefore={iconFor?.(node)}>
          <NodeContextMenu actions={actions} onPick={(k) => pick(k, node)}>
            <span className={s.row}>
              <span className={s.nameText} title={node.label}>{node.label}{node.meta ? ` (${node.meta})` : ''}</span>
              <span className={s.actions} onClick={(e) => e.stopPropagation()}>
                {node.badge && <Badge size="small" appearance={node.badge.appearance ?? 'tint'} color={node.badge.color}>{node.badge.text}</Badge>}
                {inline.map((a) => (
                  <Tooltip key={a.key} content={a.label} relationship="label">
                    <Button size="small" appearance="subtle" icon={a.icon} disabled={a.disabled} onClick={() => pick(a.key, node)} aria-label={`${a.label} ${node.label}`} />
                  </Tooltip>
                ))}
              </span>
            </span>
          </NodeContextMenu>
        </TreeItemLayout>
        <Tree>
          {lazyState?.status === 'loading' && (
            <TreeItem itemType="leaf" value={`${node.id}::loading`}>
              <TreeItemLayout><Spinner size="tiny" label="Loading…" /></TreeItemLayout>
            </TreeItem>
          )}
          {lazyState?.status === 'error' && (
            <TreeItem itemType="leaf" value={`${node.id}::error`}>
              <TreeItemLayout><Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{lazyState.error}</Caption1></TreeItemLayout>
            </TreeItem>
          )}
          {kids.length === 0 && lazyState?.status !== 'loading' && (
            <TreeItem itemType="leaf" value={`${node.id}::empty`}>
              <TreeItemLayout><Caption1>{filter ? 'No matches' : emptyLabel}</Caption1></TreeItemLayout>
            </TreeItem>
          )}
          {kids.map((child) => (isBranch(child) ? renderBranch(child) : renderLeaf(child)))}
        </Tree>
      </TreeItem>
    );
  };

  if (gate) {
    return (
      <div className={s.root}>
        {title && <div className={s.header}><span className={s.title}>{title}</span></div>}
        {gate}
      </div>
    );
  }

  return (
    <div className={s.root}>
      {(title || headerActions || onRefresh) && (
        <div className={s.header}>
          <span className={s.title}>{title}</span>
          <span className={s.headerActions}>
            {headerActions}
            {onRefresh && (
              <Tooltip content="Refresh" relationship="label">
                <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} onClick={onRefresh} disabled={loading} aria-label="Refresh" />
              </Tooltip>
            )}
          </span>
        </div>
      )}

      {filterable && (
        <Field>
          <Input
            size="small"
            contentBefore={<Search20Regular />}
            placeholder={filterPlaceholder}
            value={filter}
            onChange={(_, d) => setFilter(d.value)}
          />
        </Field>
      )}

      {loading && <div style={{ padding: tokens.spacingVerticalS }}><Spinner size="tiny" label="Loading…" /></div>}
      {error && (
        <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Error</MessageBarTitle>{error}</MessageBarBody></MessageBar>
      )}

      <div className={s.scroll}>
        <Tree aria-label={ariaLabel} openItems={openItems} onOpenChange={onOpenChange}>
          {filtered.length === 0 && (
            <TreeItem itemType="leaf" value="__empty">
              <TreeItemLayout><Caption1>{filter ? 'No matches' : emptyLabel}</Caption1></TreeItemLayout>
            </TreeItem>
          )}
          {filtered.map((node) => (isBranch(node) ? renderBranch(node) : renderLeaf(node)))}
        </Tree>
      </div>
    </div>
  );
}

/** Depth-first lookup of a node by id across a forest (loaded children only). */
function findNode(nodes: ExplorerNode[], id: string): ExplorerNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.children) {
      const hit = findNode(node.children, id);
      if (hit) return hit;
    }
  }
  return null;
}
