import * as vscode from 'vscode';
import type { CommandContext, ItemNode } from './context';
import { guardWrite } from './context';
import { isLoomApiError } from '../api/loom-client';

/** `Loom: Rename…` (PRP W4) — PATCH /api/cosmos-items/:type/:id displayName. */
export async function renameItem(cx: CommandContext, node?: ItemNode): Promise<void> {
  if (!node || node.kind !== 'item') {
    vscode.window.showInformationMessage('Rename is available from an item in the CSA Loom Explorer.');
    return;
  }
  if (!guardWrite(cx, node.dep)) return;

  const next = await vscode.window.showInputBox({
    title: `Rename "${node.item.displayName}"`,
    prompt: 'New display name',
    value: node.item.displayName,
    ignoreFocusOut: true,
    validateInput: (v) => (v && v.trim() ? undefined : 'A name is required.'),
  });
  if (!next || next.trim() === node.item.displayName) return;

  const api = await cx.auth.apiFor(node.dep);
  if (!api) return;
  try {
    await api.renameItem(node.item.itemType, node.item.id, next.trim());
    cx.tree.refresh();
    vscode.window.showInformationMessage(`Renamed to "${next.trim()}".`);
  } catch (e) {
    const msg = isLoomApiError(e) ? e.message : e instanceof Error ? e.message : String(e);
    vscode.window.showErrorMessage(`Rename failed: ${msg}`);
  }
}
