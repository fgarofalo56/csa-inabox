/**
 * CSA Loom — VS Code extension entry point (Phase 1).
 *
 * activate() wires, with NO top-level await and no network dependency at
 * startup (PRP §2.6):
 *   • the `loom` AuthenticationProvider (device-code + PAT, SecretStorage);
 *   • the Explorer tree (deployments → workspaces → items);
 *   • the status bar (identity + scope);
 *   • every contributed command;
 *   • reactive context keys for the welcome views + toolbar toggle.
 *
 * One extension, one sign-in, one tree — versus Fabric's five artifacts and two
 * non-shared sign-ins (PRP S1/S2).
 */
import * as vscode from 'vscode';
import { initLogger, log } from './logger';
import { parseDeployments, type Deployment } from './config/deployments';
import { LoomAuthenticationProvider } from './auth/loom-auth-provider';
import { ExplorerTreeProvider } from './tree/explorer';
import { StatusBar } from './status-bar';
import { registerCommands } from './commands';
import type { CommandContext } from './commands/context';

export function activate(context: vscode.ExtensionContext): void {
  initLogger(context);
  log('CSA Loom activating');

  const getDeployments = (): Deployment[] =>
    parseDeployments(vscode.workspace.getConfiguration('loom').get('deployments'));

  // Auth provider (id `loom`) — one sign-in for every Loom surface.
  const auth = new LoomAuthenticationProvider(context, getDeployments);
  context.subscriptions.push(auth);
  context.subscriptions.push(
    vscode.authentication.registerAuthenticationProvider('loom', 'CSA Loom', auth, {
      supportsMultipleAccounts: true,
    }),
  );

  // Tree.
  const tree = new ExplorerTreeProvider(context, auth, getDeployments);
  const view = vscode.window.createTreeView('loom.explorer', {
    treeDataProvider: tree,
    showCollapseAll: true,
  });
  context.subscriptions.push(view);

  // Status bar.
  const statusBar = new StatusBar(context, auth, getDeployments);

  const syncAuthState = async (): Promise<void> => {
    const deps = getDeployments();
    await vscode.commands.executeCommand('setContext', 'loom.hasDeployments', deps.length > 0);
    await vscode.commands.executeCommand('setContext', 'loom.hasSession', await auth.hasAnySession());
    await statusBar.update();
  };

  const cx: CommandContext = { extension: context, auth, tree, statusBar, getDeployments, syncAuthState };
  registerCommands(cx);

  // React to session + configuration changes.
  context.subscriptions.push(
    auth.onDidChangeSessions(() => {
      void syncAuthState();
      tree.refresh();
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('loom.deployments')) {
        void syncAuthState();
        tree.refresh();
      }
    }),
  );

  void syncAuthState();
  log('CSA Loom activated');
}

export function deactivate(): void {
  // Disposables registered on context.subscriptions are cleaned up by VS Code.
}
