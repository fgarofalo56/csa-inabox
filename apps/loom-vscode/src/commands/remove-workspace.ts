import * as vscode from 'vscode';
import type { CommandContext, WorkspaceNode, DeploymentNode } from './context';

/**
 * `Loom: Remove workspace from Explorer` (PRP W12) — disconnect-only. Hides the
 * workspace from this window; NOTHING is deleted remotely, and the dialog says
 * so. A companion `loom.showAllWorkspaces` clears the per-deployment filter.
 */
export async function removeWorkspace(cx: CommandContext, node?: WorkspaceNode): Promise<void> {
  if (!node || node.kind !== 'workspace') {
    vscode.window.showInformationMessage('Remove is available from a workspace in the CSA Loom Explorer.');
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Remove "${node.workspace.name}" from the Explorer? This only hides it here — nothing is deleted in Loom, and you can show it again anytime.`,
    { modal: true },
    'Remove from Explorer',
  );
  if (confirm !== 'Remove from Explorer') return;
  await cx.tree.hideWorkspace(node.dep.id, node.workspace.id);
}

/** Clear the per-deployment workspace hide filter. */
export async function showAllWorkspaces(cx: CommandContext, node?: DeploymentNode): Promise<void> {
  if (node?.dep) {
    await cx.tree.showAllWorkspaces(node.dep.id);
    return;
  }
  const dep = await cx.auth.pickDeployment('Show all workspaces for which deployment?');
  if (dep) await cx.tree.showAllWorkspaces(dep.id);
}
