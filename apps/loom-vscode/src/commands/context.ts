/**
 * Shared context handed to every command handler, plus a write-guard.
 */
import * as vscode from 'vscode';
import type { LoomAuthenticationProvider } from '../auth/loom-auth-provider';
import type { ExplorerTreeProvider, DeploymentNode, WorkspaceNode, ItemNode } from '../tree/explorer';
import type { StatusBar } from '../status-bar';
import type { Deployment } from '../config/deployments';
import type { LoomApi } from '../api/loom-client';
import type { LoomFileSystemProvider } from '../fs/loom-fs-provider';
import type { MirrorStore } from '../mirror/mirror-store';
import type { NotebookLinkStore } from '../notebook/notebook-link';
import type { RunHistory } from '../notebook/run-history';
import type { SparkNotebookController } from '../notebook/spark-controller';
import type { QueryEditorStore } from '../query/query-editor-store';
import { LoomFileSystemProvider as LoomFs } from '../fs/loom-fs-provider';
import { buildDefinitionPath } from '../fs/definition-uri';

export interface CommandContext {
  extension: vscode.ExtensionContext;
  auth: LoomAuthenticationProvider;
  tree: ExplorerTreeProvider;
  statusBar: StatusBar;
  getDeployments: () => Deployment[];
  /** Recompute the `loom.hasSession` context key + status bar after auth changes. */
  syncAuthState: () => Promise<void>;
  /** Resolve a deployment id → its authenticated LoomApi (undefined = signed out). */
  resolveApi: (deploymentId: string) => Promise<LoomApi | undefined>;
  /** The `loom:` virtual filesystem (P1.5 / W6). */
  fs: LoomFileSystemProvider;
  /** The local-work-folder mirror + 4-state tracking (N2/N4/N7). */
  mirror: MirrorStore;
  /** Open-`.ipynb` → Loom-item links for the Spark controller (N10). */
  links: NotebookLinkStore;
  /** In-session notebook run log (N13). */
  runs: RunHistory;
  /** The "CSA Loom Spark" NotebookController (N10/N11). */
  controller: SparkNotebookController;
  /** Untitled-query-doc → target-item links for the SQL/KQL editor (Phase 3). */
  queryEditors: QueryEditorStore;
}

export type { DeploymentNode, WorkspaceNode, ItemNode };

/** Build the `loom:` definition-file URI for an item node. */
export function loomUriForItem(node: ItemNode): vscode.Uri {
  return vscode.Uri.from({
    scheme: LoomFs.scheme,
    path: buildDefinitionPath({
      deploymentId: node.dep.id,
      itemType: node.item.itemType,
      itemId: node.item.id,
      displayName: node.item.displayName,
    }),
  });
}

/**
 * Block a write on a read-only deployment BEFORE any network call (PRP A3):
 * a clear reason, not a 403 after the click. Returns true when the write may
 * proceed.
 */
export function guardWrite(cx: CommandContext, dep: Deployment): boolean {
  if (cx.auth.isReadOnly(dep.id)) {
    void vscode.window.showWarningMessage(
      `${dep.name} is signed in with a read-only token. Sign in again with a read-write PAT (or your account) to make changes.`,
    );
    return false;
  }
  return true;
}
