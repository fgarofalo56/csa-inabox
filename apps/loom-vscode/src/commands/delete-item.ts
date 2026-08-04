import * as vscode from 'vscode';
import type { CommandContext, ItemNode } from './context';
import { guardWrite } from './context';
import { isLoomApiError } from '../api/loom-client';

/**
 * `Loom: Delete…` (PRP W5) — DELETE /api/cosmos-items/:type/:id behind a modal
 * confirm that NAMES the item and warns on the known cascade (deleting a
 * lakehouse also drops its auto-paired SQL analytics endpoint, per the BFF).
 */
export async function deleteItem(cx: CommandContext, node?: ItemNode): Promise<void> {
  if (!node || node.kind !== 'item') {
    vscode.window.showInformationMessage('Delete is available from an item in the CSA Loom Explorer.');
    return;
  }
  if (!guardWrite(cx, node.dep)) return;

  const cascade =
    node.item.itemType === 'lakehouse'
      ? '\n\nThis also deletes its auto-paired SQL analytics endpoint.'
      : '';
  const confirm = await vscode.window.showWarningMessage(
    `Delete ${node.item.itemType} "${node.item.displayName}" from ${node.workspace.name}? This cannot be undone.${cascade}`,
    { modal: true },
    'Delete',
  );
  if (confirm !== 'Delete') return;

  const api = await cx.auth.apiFor(node.dep);
  if (!api) return;
  try {
    await api.deleteItem(node.item.itemType, node.item.id);
    cx.tree.refresh();
    vscode.window.showInformationMessage(`Deleted "${node.item.displayName}".`);
  } catch (e) {
    const msg = isLoomApiError(e) ? e.message : e instanceof Error ? e.message : String(e);
    vscode.window.showErrorMessage(`Delete failed: ${msg}`);
  }
}
