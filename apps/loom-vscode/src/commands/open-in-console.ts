import * as vscode from 'vscode';
import type { CommandContext, ItemNode } from './context';

/**
 * `Loom: Open in Console` (PRP W7) — opens the item in the browser at
 * `<apiUrl>/items/<type>/<id>` (the Console's item route). No credential leaves
 * the extension; the browser carries its own session.
 */
export async function openInConsole(_cx: CommandContext, node?: ItemNode): Promise<void> {
  if (!node || node.kind !== 'item') {
    vscode.window.showInformationMessage('Open in Console is available from an item in the CSA Loom Explorer.');
    return;
  }
  const url = `${node.dep.apiUrl}/items/${encodeURIComponent(node.item.itemType)}/${encodeURIComponent(node.item.id)}`;
  await vscode.env.openExternal(vscode.Uri.parse(url));
}
