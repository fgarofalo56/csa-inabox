/**
 * Shared context handed to every command handler, plus a write-guard.
 */
import * as vscode from 'vscode';
import type { LoomAuthenticationProvider } from '../auth/loom-auth-provider';
import type { ExplorerTreeProvider, DeploymentNode, WorkspaceNode, ItemNode } from '../tree/explorer';
import type { StatusBar } from '../status-bar';
import type { Deployment } from '../config/deployments';

export interface CommandContext {
  extension: vscode.ExtensionContext;
  auth: LoomAuthenticationProvider;
  tree: ExplorerTreeProvider;
  statusBar: StatusBar;
  getDeployments: () => Deployment[];
  /** Recompute the `loom.hasSession` context key + status bar after auth changes. */
  syncAuthState: () => Promise<void>;
}

export type { DeploymentNode, WorkspaceNode, ItemNode };

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
