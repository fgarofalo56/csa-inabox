import * as vscode from 'vscode';
import type { CommandContext, ItemNode } from './context';
import { loomUriForItem } from './context';

/**
 * `CSA Loom: Open definition` (W6 / P1.6) — open an item's editable definition
 * over the `loom:` virtual filesystem. Saving the document writes through to
 * `PUT …/definition` (direct mode); a concurrent-edit 412 surfaces as a save
 * error naming the remedy (the mirror-mode Publish/Update flow owns the diff).
 */
export async function openDefinition(cx: CommandContext, node?: ItemNode): Promise<void> {
  if (!node || node.kind !== 'item') {
    vscode.window.showInformationMessage('Open definition is available from an item in the CSA Loom Explorer.');
    return;
  }
  const uri = loomUriForItem(node);
  try {
    // Fresh read — never serve a stale cached body when the user explicitly opens.
    cx.fs.invalidate(uri);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(doc, 'json');
    await vscode.window.showTextDocument(doc, { preview: false });
  } catch (e) {
    vscode.window.showErrorMessage(`Could not open the definition: ${e instanceof Error ? e.message : String(e)}`);
  }
}
