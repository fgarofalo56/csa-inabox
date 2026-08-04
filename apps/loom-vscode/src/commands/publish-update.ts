import * as vscode from 'vscode';
import type { CommandContext, ItemNode } from './context';
import { guardWrite } from './context';
import { encodeDefinition, decodeDefinition } from '../fs/definition-codec';
import { hashBytes, type MirrorEntry } from '../mirror/mirror-store';
import { buildDefinitionPath, slugForName, type LoomRef } from '../fs/definition-uri';
import { LoomFileSystemProvider } from '../fs/loom-fs-provider';
import { DefinitionConflictError, isLoomApiError } from '../api/loom-client';

interface Target {
  ref: LoomRef;
  entry: MirrorEntry;
  displayName: string;
  depName: string;
  localUri: vscode.Uri;
  loomUri: vscode.Uri;
}

/** Resolve the mirror target from an item node OR the active editor's file. */
function resolveTarget(cx: CommandContext, node?: ItemNode): Target | undefined {
  let entry: MirrorEntry | undefined;
  let displayName = '';
  let depName = '';
  if (node && node.kind === 'item') {
    entry = cx.mirror.entryForRef({ deploymentId: node.dep.id, itemType: node.item.itemType, itemId: node.item.id });
    displayName = node.item.displayName;
    depName = node.dep.name;
  } else {
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active && active.scheme === 'file') entry = cx.mirror.entryForPath(active.fsPath);
    displayName = entry ? entry.itemId : '';
    depName = entry?.deploymentId ?? '';
  }
  if (!entry) return undefined;
  const ref: LoomRef = { deploymentId: entry.deploymentId, itemType: entry.itemType, itemId: entry.itemId };
  const loomUri = vscode.Uri.from({
    scheme: LoomFileSystemProvider.scheme,
    path: buildDefinitionPath({ ...ref, displayName: displayName || slugForName(ref.itemId) }),
  });
  return {
    ref,
    entry,
    displayName: displayName || ref.itemId,
    depName: depName || ref.deploymentId,
    localUri: vscode.Uri.file(entry.localPath),
    loomUri,
  };
}

/**
 * `CSA Loom: Publish` (N5) — write the local copy back with the item's cached
 * ETag. A 412 opens a diff (workspace ↔ local) instead of clobbering; on success
 * the local baseline advances so the decoration flips to **L**.
 */
export async function publishItem(cx: CommandContext, node?: ItemNode): Promise<void> {
  const t = resolveTarget(cx, node);
  if (!t) {
    vscode.window.showInformationMessage('Publish works on a downloaded CSA Loom item — Download it first.');
    return;
  }
  const dep = cx.getDeployments().find((d) => d.id === t.ref.deploymentId);
  if (dep && !guardWrite(cx, dep)) return;

  const api = await cx.resolveApi(t.ref.deploymentId);
  if (!api) {
    vscode.window.showWarningMessage(`Sign in to ${t.depName} first.`);
    return;
  }
  // Persist the editor's unsaved changes first.
  await saveIfDirty(t.localUri);

  let bytes: Uint8Array;
  let definition: unknown;
  try {
    bytes = await vscode.workspace.fs.readFile(t.localUri);
    definition = decodeDefinition(bytes);
  } catch {
    vscode.window.showErrorMessage('The local definition is not valid JSON — fix it and Publish again.');
    return;
  }

  try {
    const res = await api.putDefinition(t.ref.itemType, t.ref.itemId, definition, t.entry.etag || '*');
    // Canonicalize the local copy to the server shape so local === workspace.
    const canon = encodeDefinition(res.definition);
    await vscode.workspace.fs.writeFile(t.localUri, canon);
    await cx.mirror.markPublished(t.ref, canon, res.etag);
    cx.tree.refresh();
    vscode.window.showInformationMessage(`Published "${t.displayName}" to the workspace.`);
  } catch (e) {
    if (e instanceof DefinitionConflictError) {
      await openConflictDiff(cx, api, t, 'Someone changed this in the workspace. Merge the changes, then Publish again.');
      return;
    }
    const msg = isLoomApiError(e) ? `${e.message}${e.hint ? ` (${e.hint})` : ''}` : e instanceof Error ? e.message : String(e);
    vscode.window.showErrorMessage(`Publish failed: ${msg}`);
  }
}

/**
 * `CSA Loom: Update from workspace` (N6) — pull the workspace version. A clean
 * local copy fast-forwards; a locally-edited copy opens a diff (workspace ↔
 * local) for a manual merge (the copy stays Conflict until resolved + published).
 */
export async function updateItem(cx: CommandContext, node?: ItemNode): Promise<void> {
  const t = resolveTarget(cx, node);
  if (!t) {
    vscode.window.showInformationMessage('Update works on a downloaded CSA Loom item — Download it first.');
    return;
  }
  const api = await cx.resolveApi(t.ref.deploymentId);
  if (!api) {
    vscode.window.showWarningMessage(`Sign in to ${t.depName} first.`);
    return;
  }
  await saveIfDirty(t.localUri);

  try {
    const remote = await api.getDefinition(t.ref.itemType, t.ref.itemId);
    const remoteBytes = encodeDefinition(remote.definition);
    const remoteHash = hashBytes(remoteBytes);
    let localBytes: Uint8Array | undefined;
    try {
      localBytes = await vscode.workspace.fs.readFile(t.localUri);
    } catch {
      localBytes = undefined;
    }
    const localHash = localBytes ? hashBytes(localBytes) : undefined;

    if (localHash === remoteHash) {
      await cx.mirror.setRemote(t.ref, remoteBytes, remote.etag);
      vscode.window.showInformationMessage(`"${t.displayName}" is already up to date with the workspace.`);
      return;
    }
    if (localHash === t.entry.baseHash) {
      // Clean local copy, remote advanced → fast-forward.
      await vscode.workspace.fs.writeFile(t.localUri, remoteBytes);
      await cx.mirror.markPublished(t.ref, remoteBytes, remote.etag);
      cx.tree.refresh();
      vscode.window.showInformationMessage(`Updated "${t.displayName}" to the workspace version.`);
      return;
    }
    // Both sides changed → conflict: record the remote hash + open a merge diff.
    await cx.mirror.setRemote(t.ref, remoteBytes, remote.etag);
    await openConflictDiff(cx, api, t, 'Conflict — merge the workspace changes into your local copy, then Publish.');
    cx.tree.refresh();
  } catch (e) {
    const msg = isLoomApiError(e) ? `${e.message}${e.hint ? ` (${e.hint})` : ''}` : e instanceof Error ? e.message : String(e);
    vscode.window.showErrorMessage(`Update failed: ${msg}`);
  }
}

/** Open a diff of the live workspace definition (left) vs the local copy (right). */
async function openConflictDiff(
  cx: CommandContext,
  _api: unknown,
  t: Target,
  message: string,
): Promise<void> {
  cx.fs.invalidate(t.loomUri); // force the loom: side to re-fetch the current remote
  await vscode.commands.executeCommand(
    'vscode.diff',
    t.loomUri,
    t.localUri,
    `${t.displayName}: workspace ↔ local`,
  );
  vscode.window.showWarningMessage(message);
}

async function saveIfDirty(uri: vscode.Uri): Promise<void> {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (doc && doc.isDirty) await doc.save();
}
