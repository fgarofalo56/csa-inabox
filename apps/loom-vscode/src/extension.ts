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
import type { LoomApi } from './api/loom-client';
import { LoomFileSystemProvider } from './fs/loom-fs-provider';
import { LoomDecorationProvider } from './fs/decoration-provider';
import { MirrorStore } from './mirror/mirror-store';
import { NotebookLinkStore } from './notebook/notebook-link';
import { RunHistory } from './notebook/run-history';
import { SparkNotebookController } from './notebook/spark-controller';
import { QueryEditorStore } from './query/query-editor-store';

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

  // Resolve a deployment id → its authenticated LoomApi (shared by the FS
  // provider, the notebook controller, and the mirror commands).
  const resolveApi = async (deploymentId: string): Promise<LoomApi | undefined> => {
    const dep = getDeployments().find((d) => d.id === deploymentId);
    if (!dep) return undefined;
    return auth.apiFor(dep);
  };

  // Tree.
  const tree = new ExplorerTreeProvider(context, auth, getDeployments);
  const view = vscode.window.createTreeView('loom.explorer', {
    treeDataProvider: tree,
    showCollapseAll: true,
  });
  context.subscriptions.push(view);

  // Status bar.
  const statusBar = new StatusBar(context, auth, getDeployments);

  // Phase 2 — the `loom:` virtual filesystem (P1.5 / W6).
  const fs = new LoomFileSystemProvider(resolveApi);
  context.subscriptions.push(fs);
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(LoomFileSystemProvider.scheme, fs, {
      isCaseSensitive: true,
      isReadonly: false,
    }),
  );

  // Local-work-folder mirror + 4-state decorations (N2/N4/N7).
  const mirror = new MirrorStore(context);
  context.subscriptions.push(mirror);
  const decorations = new LoomDecorationProvider(mirror);
  context.subscriptions.push(decorations);
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(decorations));

  // Notebook execution (N10/N11/N13) — a real "CSA Loom Spark" controller.
  const links = new NotebookLinkStore(context);
  const runs = new RunHistory();
  context.subscriptions.push(runs);
  const controller = new SparkNotebookController(resolveApi, links, runs, context);
  context.subscriptions.push(controller);

  // Phase 3 — query editor ↔ item links (drives the ▶ Run button context key).
  const queryEditors = new QueryEditorStore();
  context.subscriptions.push(queryEditors);

  const syncAuthState = async (): Promise<void> => {
    const deps = getDeployments();
    await vscode.commands.executeCommand('setContext', 'loom.hasDeployments', deps.length > 0);
    await vscode.commands.executeCommand('setContext', 'loom.hasSession', await auth.hasAnySession());
    await statusBar.update();
  };

  const cx: CommandContext = {
    extension: context,
    auth,
    tree,
    statusBar,
    getDeployments,
    syncAuthState,
    resolveApi,
    fs,
    mirror,
    links,
    runs,
    controller,
    queryEditors,
  };
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
