/**
 * Registers every contributed command with its handler. A command in
 * package.json without a handler here is vaporware (no-vaporware.md) — this file
 * is the single wiring point that guarantees each has one.
 */
import * as vscode from 'vscode';
import type { CommandContext } from './context';
import { signIn } from './sign-in';
import { signOut } from './sign-out';
import { addDeployment } from './add-deployment';
import { createItem } from './create-item';
import { renameItem } from './rename-item';
import { deleteItem } from './delete-item';
import { openInConsole } from './open-in-console';
import { refresh } from './refresh';
import { toggleGroupBy } from './toggle-group-by';
import { removeWorkspace, showAllWorkspaces } from './remove-workspace';
import { openDefinition } from './open-definition';
import { createNotebook } from './create-notebook';
import { setWorkFolder, downloadItem, deleteMirrored } from './mirror';
import { publishItem, updateItem } from './publish-update';
import { runOnSpark, setSparkCompute, viewRecentRuns } from './notebook-run';

export function registerCommands(cx: CommandContext): void {
  const reg = (id: string, handler: (...args: unknown[]) => unknown) =>
    cx.extension.subscriptions.push(vscode.commands.registerCommand(id, handler));

  reg('loom.signIn', (node) => signIn(cx, node as never));
  reg('loom.signOut', (node) => signOut(cx, node as never));
  reg('loom.addDeployment', () => addDeployment(cx));
  reg('loom.createItem', (node) => createItem(cx, node as never));
  reg('loom.renameItem', (node) => renameItem(cx, node as never));
  reg('loom.deleteItem', (node) => deleteItem(cx, node as never));
  reg('loom.openInConsole', (node) => openInConsole(cx, node as never));
  reg('loom.refresh', () => refresh(cx));
  reg('loom.toggleGroupBy', () => toggleGroupBy(cx));
  reg('loom.removeWorkspace', (node) => removeWorkspace(cx, node as never));
  reg('loom.showAllWorkspaces', (node) => showAllWorkspaces(cx, node as never));

  // Phase 2 — definitions, mirror, notebooks.
  reg('loom.openDefinition', (node) => openDefinition(cx, node as never));
  reg('loom.createNotebook', (node) => createNotebook(cx, node as never));
  reg('loom.setWorkFolder', () => setWorkFolder(cx));
  reg('loom.downloadItem', (node) => downloadItem(cx, node as never));
  reg('loom.deleteDownloaded', (node) => deleteMirrored(cx, node as never));
  reg('loom.publish', (node) => publishItem(cx, node as never));
  reg('loom.update', (node) => updateItem(cx, node as never));
  reg('loom.runOnSpark', (node) => runOnSpark(cx, node as never));
  reg('loom.setSparkCompute', (node) => setSparkCompute(cx, node as never));
  reg('loom.viewRecentRuns', () => viewRecentRuns(cx));
}
