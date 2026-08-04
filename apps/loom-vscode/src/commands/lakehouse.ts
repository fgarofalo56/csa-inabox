/**
 * Lakehouse Tables/Files explorer commands (Phase 6, L3/L4) — the right-click
 * actions on a lakehouse table / file / folder node:
 *
 *   • loom.copyAbfsPath      (L4) — copy the sovereign-correct `abfss://…` URI.
 *   • loom.copyRelativePath  (L4) — copy the path relative to the lakehouse root.
 *   • loom.downloadLakehouseFile (L3) — stream a file's bytes THROUGH the BFF
 *     (the client never holds a storage credential) to a user-chosen location.
 *
 * The copy paths are already resolved on the node (the per-cloud DFS suffix came
 * from the BFF's `abfss` route), so copy is offline + instant. Download is the
 * only networked action and it reuses `GET /api/lakehouse/download` — the SAME
 * route the Console lakehouse explorer's Download uses.
 */
import * as vscode from 'vscode';
import type { CommandContext } from './context';
import type { LakehouseTableNode, LakehousePathNode } from '../tree/explorer';
import { basename } from '../tree/lakehouse-nodes';
import { isLoomApiError } from '../api/loom-client';

type CopyableNode = LakehouseTableNode | LakehousePathNode;

/** `CSA Loom: Copy ABFS path` (L4). */
export async function copyAbfsPath(_cx: CommandContext, node?: CopyableNode): Promise<void> {
  if (!isCopyable(node)) {
    vscode.window.showInformationMessage('Copy ABFS path is available from a table or file in a lakehouse.');
    return;
  }
  await vscode.env.clipboard.writeText(node.abfss);
  vscode.window.setStatusBarMessage(`$(check) Copied ABFS path`, 2500);
}

/** `CSA Loom: Copy relative path` (L4). */
export async function copyRelativePath(_cx: CommandContext, node?: CopyableNode): Promise<void> {
  if (!isCopyable(node)) {
    vscode.window.showInformationMessage('Copy relative path is available from a table or file in a lakehouse.');
    return;
  }
  await vscode.env.clipboard.writeText(node.relative);
  vscode.window.setStatusBarMessage(`$(check) Copied relative path`, 2500);
}

/** `CSA Loom: Download file` (L3) — stream bytes through the BFF to disk. */
export async function downloadLakehouseFile(cx: CommandContext, node?: LakehousePathNode): Promise<void> {
  if (!node || node.kind !== 'lh-path' || node.entry.isDirectory) {
    vscode.window.showInformationMessage('Download is available from a file in a lakehouse Files list.');
    return;
  }
  const api = await cx.resolveApi(node.dep.id);
  if (!api) {
    vscode.window.showWarningMessage(`Sign in to ${node.dep.name} first.`);
    return;
  }
  const suggested = basename(node.entry.name) || 'download.bin';
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(suggested),
    saveLabel: 'Download',
    title: `Download ${suggested}`,
  });
  if (!target) return;

  try {
    const file = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Downloading ${suggested}…` },
      () => api.downloadLakehouseFile(node.container, node.entry.name),
    );
    await vscode.workspace.fs.writeFile(target, file.bytes);
    const open = 'Open';
    const choice = await vscode.window.showInformationMessage(
      `Downloaded ${file.filename} (${file.bytes.length.toLocaleString()} bytes).`,
      open,
    );
    if (choice === open) await vscode.commands.executeCommand('vscode.open', target);
  } catch (e) {
    const msg = isLoomApiError(e)
      ? `${e.message}${e.hint ? ` (${e.hint})` : ''}`
      : e instanceof Error
        ? e.message
        : String(e);
    vscode.window.showErrorMessage(`Download failed: ${msg}`);
  }
}

function isCopyable(node: unknown): node is CopyableNode {
  return (
    !!node &&
    typeof node === 'object' &&
    ((node as { kind?: unknown }).kind === 'lh-table' || (node as { kind?: unknown }).kind === 'lh-path') &&
    typeof (node as { abfss?: unknown }).abfss === 'string' &&
    typeof (node as { relative?: unknown }).relative === 'string'
  );
}
