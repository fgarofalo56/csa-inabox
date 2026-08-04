import * as vscode from 'vscode';
import type { CommandContext, ItemNode } from './context';
import { guardWrite } from './context';
import { encodeDefinition } from '../fs/definition-codec';
import type { LoomRef } from '../fs/definition-uri';
import { isLoomApiError } from '../api/loom-client';

function refFor(node: ItemNode): LoomRef {
  return { deploymentId: node.dep.id, itemType: node.item.itemType, itemId: node.item.id };
}

/** `CSA Loom: Set local work folder` (N2) — pick the mirror root. */
export async function setWorkFolder(cx: CommandContext): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Set as CSA Loom work folder',
    title: 'Choose the local work folder for downloaded CSA Loom items',
  });
  if (!picked || picked.length === 0) return;
  await cx.mirror.setWorkFolder(picked[0]);
  vscode.window.showInformationMessage(`CSA Loom work folder set to ${picked[0].fsPath}.`);
}

/**
 * `CSA Loom: Download` (N2) — mirror an item's definition into the local work
 * folder and open it. Records the baseline so the M/L/C decorations (N7) and
 * Publish/Update (N5/N6) can compare against it.
 */
export async function downloadItem(cx: CommandContext, node?: ItemNode): Promise<void> {
  if (!node || node.kind !== 'item') {
    vscode.window.showInformationMessage('Download is available from an item in the CSA Loom Explorer.');
    return;
  }
  if (!cx.mirror.getWorkFolder()) {
    const choice = await vscode.window.showWarningMessage(
      'No local work folder is set. Set one now?',
      'Set work folder',
    );
    if (choice) await setWorkFolder(cx);
    if (!cx.mirror.getWorkFolder()) return;
  }
  const api = await cx.resolveApi(node.dep.id);
  if (!api) {
    vscode.window.showWarningMessage(`Sign in to ${node.dep.name} first.`);
    return;
  }
  try {
    const payload = await api.getDefinition(node.item.itemType, node.item.id);
    const bytes = encodeDefinition(payload.definition);
    const uri = await cx.mirror.download(refFor(node), node.item.displayName, bytes, payload.etag);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
    vscode.window.showInformationMessage(`Downloaded "${node.item.displayName}" to the local work folder.`);
  } catch (e) {
    const msg = isLoomApiError(e) ? `${e.message}${e.hint ? ` (${e.hint})` : ''}` : e instanceof Error ? e.message : String(e);
    vscode.window.showErrorMessage(`Download failed: ${msg}`);
  }
}

/**
 * `CSA Loom: Delete downloaded copy` (N4) — for a mirrored item, prompt
 * "Local only" vs "Local + workspace". Closes the editor first (Fabric's docs
 * warn to close it to avoid failure — we do it for the user).
 */
export async function deleteMirrored(cx: CommandContext, node?: ItemNode): Promise<void> {
  if (!node || node.kind !== 'item') return;
  const ref = refFor(node);
  const entry = cx.mirror.entryForRef(ref);
  if (!entry) {
    vscode.window.showInformationMessage(`"${node.item.displayName}" has no local copy to delete.`);
    return;
  }
  const localOnly = 'Delete local copy only';
  const both = 'Delete local + workspace';
  const choice = await vscode.window.showWarningMessage(
    `Delete "${node.item.displayName}"?`,
    { modal: true, detail: 'Choose whether to remove only the downloaded copy, or also delete the item from the workspace.' },
    localOnly,
    both,
  );
  if (!choice) return;

  // Close any editor open on the local file so the delete cannot fail.
  await closeEditorsFor(vscode.Uri.file(entry.localPath));

  if (choice === both) {
    if (!guardWrite(cx, node.dep)) return;
    const api = await cx.resolveApi(node.dep.id);
    if (!api) {
      vscode.window.showWarningMessage(`Sign in to ${node.dep.name} first.`);
      return;
    }
    try {
      await api.deleteItem(node.item.itemType, node.item.id);
    } catch (e) {
      const msg = isLoomApiError(e) ? e.message : e instanceof Error ? e.message : String(e);
      vscode.window.showErrorMessage(`Workspace delete failed (local copy kept): ${msg}`);
      return;
    }
  }
  await cx.mirror.removeLocal(ref);
  cx.tree.refresh();
  vscode.window.showInformationMessage(
    choice === both
      ? `Deleted "${node.item.displayName}" locally and from the workspace.`
      : `Removed the local copy of "${node.item.displayName}".`,
  );
}

async function closeEditorsFor(uri: vscode.Uri): Promise<void> {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input as { uri?: vscode.Uri } | undefined;
      if (input?.uri && input.uri.toString() === uri.toString()) {
        try {
          await vscode.window.tabGroups.close(tab);
        } catch {
          /* best-effort */
        }
      }
    }
  }
}
