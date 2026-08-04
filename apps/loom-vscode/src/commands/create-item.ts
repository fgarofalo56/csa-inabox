import * as vscode from 'vscode';
import { ITEM_TYPES } from '@csa-loom/sdk';
import type { CommandContext, WorkspaceNode } from './context';
import { guardWrite } from './context';
import { isLoomApiError, type Workspace } from '../api/loom-client';
import type { Deployment } from '../config/deployments';

/**
 * `Loom: Create item…` (PRP W3). Quick-pick over the SAME item taxonomy the CLI
 * + SDK ship (`ITEM_TYPES`), then `POST /api/cosmos-items/:type` via LoomApi.
 * Invoked from a workspace node (context menu) or resolved interactively.
 */
export async function createItem(cx: CommandContext, node?: WorkspaceNode): Promise<void> {
  const resolved = node ? { dep: node.dep, workspace: node.workspace } : await pickTarget(cx);
  if (!resolved) return;
  const { dep, workspace } = resolved;
  if (!guardWrite(cx, dep)) return;

  const itemType = await vscode.window.showQuickPick([...ITEM_TYPES], {
    title: `Create item in ${workspace.name}`,
    placeHolder: 'Choose an item type',
    matchOnDetail: true,
  });
  if (!itemType) return;

  const displayName = await vscode.window.showInputBox({
    title: `New ${itemType}`,
    prompt: 'Display name',
    ignoreFocusOut: true,
    validateInput: (v) => (v && v.trim() ? undefined : 'A name is required.'),
  });
  if (!displayName) return;

  const description = await vscode.window.showInputBox({
    title: `New ${itemType}`,
    prompt: 'Description (optional)',
    ignoreFocusOut: true,
  });
  if (description === undefined) return;

  const api = await cx.auth.apiFor(dep);
  if (!api) return;
  try {
    const item = await api.createItem(itemType, workspace.id, displayName.trim(), description.trim() || undefined);
    cx.tree.refresh();
    vscode.window.showInformationMessage(`Created ${itemType} "${item.displayName}" in ${workspace.name}.`);
  } catch (e) {
    const msg = isLoomApiError(e) ? `${e.message}${e.hint ? ` (${e.hint})` : ''}` : e instanceof Error ? e.message : String(e);
    vscode.window.showErrorMessage(`Create failed: ${msg}`);
  }
}

async function pickTarget(cx: CommandContext): Promise<{ dep: Deployment; workspace: Workspace } | undefined> {
  const dep = await cx.auth.pickDeployment('Create in which deployment?');
  if (!dep) return undefined;
  if (!(await cx.auth.isSignedIn(dep.id))) {
    vscode.window.showWarningMessage(`Sign in to ${dep.name} first.`);
    return undefined;
  }
  const api = await cx.auth.apiFor(dep);
  if (!api) return undefined;
  let workspaces: Workspace[];
  try {
    workspaces = await api.listWorkspaces();
  } catch (e) {
    vscode.window.showErrorMessage(`Could not list workspaces: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
  if (workspaces.length === 0) {
    vscode.window.showWarningMessage(`${dep.name} has no workspaces. Create one in the Console first.`);
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    workspaces.map((w) => ({ label: w.name, description: w.id, workspace: w })),
    { title: 'Create in which workspace?', placeHolder: 'Select a workspace' },
  );
  return pick ? { dep, workspace: pick.workspace } : undefined;
}
