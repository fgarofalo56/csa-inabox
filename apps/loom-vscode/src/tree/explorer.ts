/**
 * ExplorerTreeProvider — the CSA Loom tree (PRP W1/W2/W11/W12).
 *
 *   Deployment (signed in)  →  Workspace  →  [Type group]  →  Item
 *
 * • Multiple deployments AND multiple workspaces render simultaneously (W11):
 *   a Commercial root and a Government root can be expanded side by side.
 * • Group-by-type toggle (W2) flips workspace children between type groups and
 *   a flat item list. Groups come from the live item taxonomy.
 * • Per-deployment workspace filter (W1) + "remove workspace" = hide-only,
 *   disconnect-only, nothing deleted remotely (W12).
 *
 * Offline / empty honesty (PRP §2.6, no-vaporware.md): the tree NEVER returns a
 * silent empty array dressed as data. A signed-out deployment shows a Sign-in
 * node; a fetch failure shows the last-known cached rows tagged "offline — last
 * synced <t>" PLUS an error node naming the reason, or (no cache) just the error
 * node; a genuinely empty workspace shows a guided "create an item" node.
 */
import * as vscode from 'vscode';
import type { Deployment } from '../config/deployments';
import { cloudLabel } from '../config/deployments';
import type { LoomAuthenticationProvider } from '../auth/loom-auth-provider';
import { iconIdForItemType } from './icons';
import { buildDefinitionPath } from '../fs/definition-uri';
import { LoomFileSystemProvider } from '../fs/loom-fs-provider';
import {
  isLoomApiError,
  type Workspace,
  type Item,
  type LakehouseTable,
  type LakehousePathEntry,
} from '../api/loom-client';
import {
  fileAbfss,
  filesPrefix,
  humanSize,
  tableAbfss,
  tableRelativePath,
  relativeToRoot,
  basename,
} from './lakehouse-nodes';
import { logError } from '../logger';

const GROUP_BY_KEY = 'loom.groupByType';
const HIDDEN_KEY = 'loom.hiddenWorkspaces';
const wsCacheKey = (depId: string) => `loom.cache.ws.${depId}`;
const itemsCacheKey = (depId: string, wsId: string) => `loom.cache.items.${depId}.${wsId}`;

interface Cache<T> {
  data: T;
  syncedAt: number;
}

export interface DeploymentNode {
  kind: 'deployment';
  dep: Deployment;
}
export interface WorkspaceNode {
  kind: 'workspace';
  dep: Deployment;
  workspace: Workspace;
}
export interface TypeGroupNode {
  kind: 'typegroup';
  dep: Deployment;
  workspace: Workspace;
  itemType: string;
  items: Item[];
}
export interface ItemNode {
  kind: 'item';
  dep: Deployment;
  workspace: Workspace;
  item: Item;
}
/**
 * A "Tables" / "Files" section under an expanded lakehouse item (L1). Carries the
 * BFF-resolved ADLS root so its children never re-resolve the per-cloud suffix.
 */
export interface LakehouseSectionNode {
  kind: 'lh-section';
  dep: Deployment;
  workspace: Workspace;
  item: Item;
  section: 'tables' | 'files';
  abfssRoot: string;
  container: string;
  root: string;
}
/** One Delta/Parquet table under a lakehouse's `Tables/` root. */
export interface LakehouseTableNode {
  kind: 'lh-table';
  dep: Deployment;
  table: LakehouseTable;
  /** Full ABFS URI (L4 copy). */
  abfss: string;
  /** Path relative to the lakehouse root, e.g. `Tables/sales` (L4 copy). */
  relative: string;
}
/** One file or directory under a lakehouse's `Files/` root. */
export interface LakehousePathNode {
  kind: 'lh-path';
  dep: Deployment;
  container: string;
  abfssRoot: string;
  root: string;
  entry: LakehousePathEntry;
  /** Full ABFS URI (L4 copy). */
  abfss: string;
  /** Path relative to the lakehouse root (L4 copy). */
  relative: string;
}
export interface MessageNode {
  kind: 'message';
  label: string;
  icon?: string;
  tooltip?: string;
  command?: vscode.Command;
}
export type LoomNode =
  | DeploymentNode
  | WorkspaceNode
  | TypeGroupNode
  | ItemNode
  | LakehouseSectionNode
  | LakehouseTableNode
  | LakehousePathNode
  | MessageNode;

export class ExplorerTreeProvider implements vscode.TreeDataProvider<LoomNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<LoomNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private groupByType: boolean;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly auth: LoomAuthenticationProvider,
    private readonly getDeployments: () => Deployment[],
  ) {
    this.groupByType = context.workspaceState.get<boolean>(GROUP_BY_KEY, false);
    void vscode.commands.executeCommand('setContext', 'loom.groupByType', this.groupByType);
  }

  refresh(node?: LoomNode): void {
    this._onDidChangeTreeData.fire(node);
  }

  get isGroupByType(): boolean {
    return this.groupByType;
  }

  async toggleGroupBy(): Promise<void> {
    this.groupByType = !this.groupByType;
    await this.context.workspaceState.update(GROUP_BY_KEY, this.groupByType);
    await vscode.commands.executeCommand('setContext', 'loom.groupByType', this.groupByType);
    this.refresh();
  }

  // --- workspace hide filter (W1 / W12) ------------------------------------

  private hiddenMap(): Record<string, string[]> {
    return this.context.workspaceState.get<Record<string, string[]>>(HIDDEN_KEY, {});
  }

  async hideWorkspace(depId: string, wsId: string): Promise<void> {
    const map = this.hiddenMap();
    const set = new Set(map[depId] ?? []);
    set.add(wsId);
    map[depId] = [...set];
    await this.context.workspaceState.update(HIDDEN_KEY, map);
    this.refresh();
  }

  async showAllWorkspaces(depId: string): Promise<void> {
    const map = this.hiddenMap();
    delete map[depId];
    await this.context.workspaceState.update(HIDDEN_KEY, map);
    this.refresh();
  }

  private isHidden(depId: string, wsId: string): boolean {
    return (this.hiddenMap()[depId] ?? []).includes(wsId);
  }

  // --- TreeDataProvider ----------------------------------------------------

  getTreeItem(node: LoomNode): vscode.TreeItem {
    switch (node.kind) {
      case 'deployment':
        return this.deploymentTreeItem(node);
      case 'workspace':
        return this.workspaceTreeItem(node);
      case 'typegroup':
        return this.typeGroupTreeItem(node);
      case 'item':
        return this.itemTreeItem(node);
      case 'lh-section':
        return this.lakehouseSectionTreeItem(node);
      case 'lh-table':
        return this.lakehouseTableTreeItem(node);
      case 'lh-path':
        return this.lakehousePathTreeItem(node);
      case 'message':
        return this.messageTreeItem(node);
    }
  }

  async getChildren(node?: LoomNode): Promise<LoomNode[]> {
    if (!node) return this.getDeployments().map((dep) => ({ kind: 'deployment', dep }) as DeploymentNode);
    if (node.kind === 'deployment') return this.deploymentChildren(node);
    if (node.kind === 'workspace') return this.workspaceChildren(node);
    if (node.kind === 'typegroup') return node.items.map((item) => this.itemNode(node, item));
    if (node.kind === 'item' && node.item.itemType === 'lakehouse') return this.lakehouseChildren(node);
    if (node.kind === 'lh-section') return this.lakehouseSectionChildren(node);
    if (node.kind === 'lh-path' && node.entry.isDirectory) return this.lakehouseDirChildren(node);
    return [];
  }

  // --- children resolvers --------------------------------------------------

  private async deploymentChildren(node: DeploymentNode): Promise<LoomNode[]> {
    const { dep } = node;
    if (!(await this.auth.isSignedIn(dep.id))) {
      return [
        {
          kind: 'message',
          label: `Sign in to ${dep.name}`,
          icon: 'sign-in',
          tooltip: dep.apiUrl,
          command: { command: 'loom.signIn', title: 'Sign in', arguments: [node] },
        },
      ];
    }
    const api = await this.auth.apiFor(dep);
    if (!api) return [this.errorNode('Could not load credentials for this deployment.')];

    try {
      const workspaces = await api.listWorkspaces();
      await this.writeCache(wsCacheKey(dep.id), workspaces);
      return this.workspaceNodesFrom(dep, workspaces);
    } catch (e) {
      logError(`listWorkspaces(${dep.id})`, e);
      const cached = this.readCache<Workspace[]>(wsCacheKey(dep.id));
      const reason = this.reasonFor(e, dep);
      if (cached) {
        return [this.offlineNode(cached.syncedAt, reason), ...this.workspaceNodesFrom(dep, cached.data)];
      }
      return [this.errorNode(reason)];
    }
  }

  private workspaceNodesFrom(dep: Deployment, workspaces: Workspace[]): LoomNode[] {
    const visible = workspaces.filter((w) => !this.isHidden(dep.id, w.id));
    if (visible.length === 0) {
      if (workspaces.length > 0) {
        return [
          {
            kind: 'message',
            label: 'All workspaces are hidden',
            icon: 'eye',
            command: { command: 'loom.showAllWorkspaces', title: 'Show all', arguments: [{ kind: 'deployment', dep }] },
          },
        ];
      }
      return [
        {
          kind: 'message',
          label: 'No workspaces yet',
          icon: 'info',
          tooltip: 'Create a workspace in the Loom Console, then refresh.',
        },
      ];
    }
    return visible
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((workspace) => ({ kind: 'workspace', dep, workspace }) as WorkspaceNode);
  }

  private async workspaceChildren(node: WorkspaceNode): Promise<LoomNode[]> {
    const { dep, workspace } = node;
    const api = await this.auth.apiFor(dep);
    if (!api) return [this.errorNode('Could not load credentials for this deployment.')];
    try {
      const items = await api.listItems(workspace.id);
      await this.writeCache(itemsCacheKey(dep.id, workspace.id), items);
      return this.itemChildrenFrom(node, items);
    } catch (e) {
      logError(`listItems(${workspace.id})`, e);
      const cached = this.readCache<Item[]>(itemsCacheKey(dep.id, workspace.id));
      const reason = this.reasonFor(e, dep);
      if (cached) {
        return [this.offlineNode(cached.syncedAt, reason), ...this.itemChildrenFrom(node, cached.data)];
      }
      return [this.errorNode(reason)];
    }
  }

  private itemChildrenFrom(node: WorkspaceNode, items: Item[]): LoomNode[] {
    if (items.length === 0) {
      return [
        {
          kind: 'message',
          label: 'No items — create one',
          icon: 'add',
          tooltip: `Create an item in ${node.workspace.name}`,
          command: { command: 'loom.createItem', title: 'Create item', arguments: [node] },
        },
      ];
    }
    if (this.groupByType) {
      const byType = new Map<string, Item[]>();
      for (const item of items) {
        const arr = byType.get(item.itemType) ?? [];
        arr.push(item);
        byType.set(item.itemType, arr);
      }
      return [...byType.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(
          ([itemType, groupItems]) =>
            ({
              kind: 'typegroup',
              dep: node.dep,
              workspace: node.workspace,
              itemType,
              items: groupItems.slice().sort((a, b) => a.displayName.localeCompare(b.displayName)),
            }) as TypeGroupNode,
        );
    }
    return items
      .slice()
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .map((item) => this.itemNode(node, item));
  }

  private itemNode(parent: { dep: Deployment; workspace: Workspace }, item: Item): ItemNode {
    return { kind: 'item', dep: parent.dep, workspace: parent.workspace, item };
  }

  // --- lakehouse Tables/Files explorer (Phase 6, L1/L3/L4) ------------------

  /**
   * Children of an expanded lakehouse item: resolve its ADLS root once, then show
   * a "Tables" and a "Files" section. An unconfigured storage backend is an
   * HONEST GATE (a guided node naming the exact env vars), never two empty
   * sections and never a fabricated row (no-vaporware.md / no-fabric-dependency.md).
   */
  private async lakehouseChildren(node: ItemNode): Promise<LoomNode[]> {
    const { dep, workspace, item } = node;
    const api = await this.auth.apiFor(dep);
    if (!api) return [this.errorNode('Could not load credentials for this deployment.')];
    try {
      const resolved = await api.lakehouseAbfss(item.id, workspace.id);
      if (!resolved.resolved || !resolved.abfss || !resolved.container) {
        return [this.gateNode(resolved.hint || 'This lakehouse has no ADLS Gen2 storage resolved yet.')];
      }
      const ctx = { abfssRoot: resolved.abfss, container: resolved.container, root: resolved.root ?? '' };
      return [
        { kind: 'lh-section', dep, workspace, item, section: 'tables', ...ctx },
        { kind: 'lh-section', dep, workspace, item, section: 'files', ...ctx },
      ];
    } catch (e) {
      logError(`lakehouseAbfss(${item.id})`, e);
      return [this.errorNode(this.reasonFor(e, dep))];
    }
  }

  /** Children of a Tables / Files section. */
  private async lakehouseSectionChildren(node: LakehouseSectionNode): Promise<LoomNode[]> {
    const api = await this.auth.apiFor(node.dep);
    if (!api) return [this.errorNode('Could not load credentials for this deployment.')];
    if (node.section === 'tables') {
      try {
        const res = await api.lakehouseTables(node.item.id, node.workspace.id);
        if (res.gate) return [this.gateNode(res.gate)];
        if (!res.tables.length) {
          return [{ kind: 'message', label: 'No tables yet', icon: 'info', tooltip: 'Create a Delta table under Tables/.' }];
        }
        return res.tables
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(
            (table) =>
              ({
                kind: 'lh-table',
                dep: node.dep,
                table,
                abfss: tableAbfss(node.abfssRoot, table.name),
                relative: tableRelativePath(table.name),
              }) as LakehouseTableNode,
          );
      } catch (e) {
        logError(`lakehouseTables(${node.item.id})`, e);
        return [this.errorNode(this.reasonFor(e, node.dep))];
      }
    }
    // Files section — list the lakehouse's `Files/` directory.
    return this.listLakehousePaths(api, node, filesPrefix(node.root));
  }

  /** Children of an expanded Files directory node. */
  private async lakehouseDirChildren(node: LakehousePathNode): Promise<LoomNode[]> {
    const api = await this.auth.apiFor(node.dep);
    if (!api) return [this.errorNode('Could not load credentials for this deployment.')];
    return this.listLakehousePaths(
      api,
      { dep: node.dep, container: node.container, abfssRoot: node.abfssRoot, root: node.root },
      node.entry.name,
    );
  }

  /** Shared ADLS path listing → path nodes (dirs first, then files, A→Z). */
  private async listLakehousePaths(
    api: NonNullable<Awaited<ReturnType<LoomAuthenticationProvider['apiFor']>>>,
    ctx: { dep: Deployment; container: string; abfssRoot: string; root: string },
    prefix: string,
  ): Promise<LoomNode[]> {
    try {
      const res = await api.lakehousePaths(ctx.container, prefix);
      if (!res.paths.length) {
        return [{ kind: 'message', label: 'Empty', icon: 'info', tooltip: `No entries under ${prefix}` }];
      }
      return res.paths
        .slice()
        .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || basename(a.name).localeCompare(basename(b.name)))
        .map(
          (entry) =>
            ({
              kind: 'lh-path',
              dep: ctx.dep,
              container: ctx.container,
              abfssRoot: ctx.abfssRoot,
              root: ctx.root,
              entry,
              abfss: fileAbfss(ctx.abfssRoot, ctx.root, entry.name),
              relative: relativeToRoot(entry.name, ctx.root),
            }) as LakehousePathNode,
        );
    } catch (e) {
      logError(`lakehousePaths(${ctx.container}/${prefix})`, e);
      return [this.errorNode(this.reasonFor(e, ctx.dep))];
    }
  }

  // --- TreeItem builders ---------------------------------------------------

  private deploymentTreeItem(node: DeploymentNode): vscode.TreeItem {
    const { dep } = node;
    const meta = this.auth.getMeta(dep.id);
    const signedIn = !!meta;
    const ti = new vscode.TreeItem(dep.name, vscode.TreeItemCollapsibleState.Collapsed);
    ti.contextValue = signedIn ? 'deployment-signedin' : 'deployment-signedout';
    ti.iconPath = new vscode.ThemeIcon(signedIn ? 'cloud' : 'cloud-offline');
    const scopeSuffix = meta?.scope ? ` · ${meta.scope}` : '';
    ti.description = signedIn ? `${meta?.accountLabel}${scopeSuffix}` : `${cloudLabel(dep.cloud)} · signed out`;
    ti.tooltip = new vscode.MarkdownString(
      [
        `**${dep.name}** — ${cloudLabel(dep.cloud)}`,
        '',
        `\`${dep.apiUrl}\``,
        signedIn ? `Signed in as ${meta?.accountLabel}${scopeSuffix}` : '_Not signed in_',
      ].join('\n'),
    );
    return ti;
  }

  private workspaceTreeItem(node: WorkspaceNode): vscode.TreeItem {
    const { workspace } = node;
    const ti = new vscode.TreeItem(workspace.name, vscode.TreeItemCollapsibleState.Collapsed);
    ti.contextValue = 'workspace';
    ti.iconPath = new vscode.ThemeIcon('folder');
    if (typeof workspace.itemCount === 'number') ti.description = `${workspace.itemCount} item${workspace.itemCount === 1 ? '' : 's'}`;
    ti.tooltip = new vscode.MarkdownString(
      [`**${workspace.name}**`, workspace.description ?? '', '', `id: \`${workspace.id}\``].join('\n'),
    );
    return ti;
  }

  private typeGroupTreeItem(node: TypeGroupNode): vscode.TreeItem {
    const ti = new vscode.TreeItem(node.itemType, vscode.TreeItemCollapsibleState.Collapsed);
    ti.contextValue = 'typegroup';
    ti.iconPath = new vscode.ThemeIcon(iconIdForItemType(node.itemType));
    ti.description = `${node.items.length}`;
    return ti;
  }

  private itemTreeItem(node: ItemNode): vscode.TreeItem {
    const { item } = node;
    // A lakehouse expands to its Tables/Files explorer (L1); other items are leaves.
    const isLakehouse = item.itemType === 'lakehouse';
    const ti = new vscode.TreeItem(
      item.displayName,
      isLakehouse ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    // A notebook / spark-job / lakehouse gets an extra tag so type-only menus
    // match; `viewItem =~ /^item/` still matches all so the generic item menus
    // persist.
    ti.contextValue =
      item.itemType === 'notebook'
        ? 'item-notebook'
        : item.itemType === 'spark-job-definition'
          ? 'item-spark-job-definition'
          : isLakehouse
            ? 'item-lakehouse'
            : 'item';
    ti.iconPath = new vscode.ThemeIcon(iconIdForItemType(item.itemType));
    // The `loom:` definition URI drives the M/L/C mirror decoration (N7). The
    // explicit label above keeps the display name (a resourceUri would otherwise
    // title the row by basename).
    ti.resourceUri = vscode.Uri.from({
      scheme: LoomFileSystemProvider.scheme,
      path: buildDefinitionPath({
        deploymentId: node.dep.id,
        itemType: item.itemType,
        itemId: item.id,
        displayName: item.displayName,
      }),
    });
    ti.description = this.groupByType ? undefined : item.itemType;
    ti.command = {
      command: 'loom.openDefinition',
      title: 'Open definition',
      arguments: [node],
    };
    ti.tooltip = new vscode.MarkdownString(
      [`**${item.displayName}**`, `type: \`${item.itemType}\``, item.description ?? '', '', `id: \`${item.id}\``].join('\n'),
    );
    return ti;
  }

  private lakehouseSectionTreeItem(node: LakehouseSectionNode): vscode.TreeItem {
    const isTables = node.section === 'tables';
    const ti = new vscode.TreeItem(isTables ? 'Tables' : 'Files', vscode.TreeItemCollapsibleState.Collapsed);
    ti.contextValue = `lh-section-${node.section}`;
    ti.iconPath = new vscode.ThemeIcon(isTables ? 'list-flat' : 'folder');
    ti.tooltip = new vscode.MarkdownString(
      isTables
        ? 'Delta / Parquet tables under this lakehouse (ADLS Gen2 + Delta — no OneLake).'
        : `Files under \`${node.container}\` — ADLS Gen2.`,
    );
    return ti;
  }

  private lakehouseTableTreeItem(node: LakehouseTableNode): vscode.TreeItem {
    const { table } = node;
    const ti = new vscode.TreeItem(table.name, vscode.TreeItemCollapsibleState.None);
    ti.contextValue = 'lh-table';
    ti.iconPath = new vscode.ThemeIcon(table.status === 'broken' ? 'warning' : 'table');
    const bits: string[] = [table.format];
    if (typeof table.rowCount === 'number') bits.push(`${table.rowCount.toLocaleString()} rows`);
    if (typeof table.latestVersion === 'number') bits.push(`v${table.latestVersion}`);
    ti.description = bits.join(' · ');
    ti.tooltip = new vscode.MarkdownString(
      [
        `**${table.name}** — ${table.format} table (${table.status})`,
        '',
        `ABFS: \`${node.abfss}\``,
        `Relative: \`${node.relative}\``,
        typeof table.sizeBytes === 'number' ? `Size: ${humanSize(table.sizeBytes)}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
    return ti;
  }

  private lakehousePathTreeItem(node: LakehousePathNode): vscode.TreeItem {
    const { entry } = node;
    const label = basename(entry.name);
    const isDir = entry.isDirectory;
    const ti = new vscode.TreeItem(
      label,
      isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    ti.contextValue = isDir ? 'lh-dir' : 'lh-file';
    ti.iconPath = new vscode.ThemeIcon(isDir ? 'folder' : 'file');
    if (!isDir) ti.description = humanSize(entry.size);
    ti.tooltip = new vscode.MarkdownString(
      [
        `**${label}**${isDir ? ' — folder' : ''}`,
        '',
        `ABFS: \`${node.abfss}\``,
        `Relative: \`${node.relative}\``,
        !isDir && entry.lastModified ? `Modified: ${entry.lastModified}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
    return ti;
  }

  private messageTreeItem(node: MessageNode): vscode.TreeItem {
    const ti = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    ti.contextValue = 'message';
    if (node.icon) ti.iconPath = new vscode.ThemeIcon(node.icon);
    if (node.tooltip) ti.tooltip = node.tooltip;
    if (node.command) ti.command = node.command;
    return ti;
  }

  // --- helpers -------------------------------------------------------------

  private errorNode(reason: string): MessageNode {
    return { kind: 'message', label: reason, icon: 'error', tooltip: reason };
  }

  /**
   * An HONEST gate node (no-vaporware.md / no-fabric-dependency.md): the backend
   * is reachable but not configured yet. Renders the exact remediation the route
   * returned (env vars / role grant), never a fabricated row.
   */
  private gateNode(hint: string): MessageNode {
    return { kind: 'message', label: 'Not configured — see details', icon: 'warning', tooltip: hint };
  }

  private offlineNode(syncedAt: number, reason: string): MessageNode {
    const when = new Date(syncedAt).toLocaleString();
    return {
      kind: 'message',
      label: `Offline — showing cached data (synced ${when})`,
      icon: 'cloud-offline',
      tooltip: reason,
    };
  }

  private reasonFor(e: unknown, dep: Deployment): string {
    if (isLoomApiError(e)) {
      if (e.status === 401) return `Session for ${dep.name} expired or invalid — sign in again.`;
      if (e.status === 0) {
        return dep.cloud === 'commercial'
          ? `${dep.name} unreachable (network error).`
          : `${dep.name} unreachable — if this is a Government deployment, confirm the admin VPN is connected.`;
      }
      return `${dep.name}: ${e.message}${e.hint ? ` (${e.hint})` : ''}`;
    }
    return e instanceof Error ? e.message : String(e);
  }

  private readCache<T>(key: string): Cache<T> | undefined {
    return this.context.globalState.get<Cache<T>>(key);
  }

  private async writeCache<T>(key: string, data: T): Promise<void> {
    await this.context.globalState.update(key, { data, syncedAt: Date.now() } satisfies Cache<T>);
  }
}
