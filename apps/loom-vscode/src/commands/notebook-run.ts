import * as vscode from 'vscode';
import type { CommandContext, ItemNode } from './context';
import { slugForName } from '../fs/definition-uri';
import type { NotebookLink } from '../notebook/notebook-link';
import type { NotebookRun } from '../notebook/run-history';

/** A minimal, valid Jupyter notebook (one Python cell) for a fresh Loom notebook. */
function starterIpynb(displayName: string): Uint8Array {
  const nb = {
    cells: [
      {
        cell_type: 'code',
        source: [`# ${displayName} — runs on remote CSA Loom Spark (Synapse Livy / Databricks)\n`, 'print("hello from CSA Loom")\n'],
        metadata: {},
        outputs: [],
        execution_count: null,
      },
    ],
    metadata: {
      kernelspec: { name: 'python3', display_name: 'Python 3' },
      language_info: { name: 'python' },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
  return new TextEncoder().encode(JSON.stringify(nb, null, 1));
}

/**
 * `CSA Loom: Run on Spark` (N10) — open a linked `.ipynb` for a notebook item and
 * select the "CSA Loom Spark" controller so cells execute on the real remote
 * Spark routes. Materializes a starter notebook the first time; the link lets the
 * controller resolve the Loom item id.
 */
export async function runOnSpark(cx: CommandContext, node?: ItemNode): Promise<void> {
  if (!node || node.kind !== 'item') {
    vscode.window.showInformationMessage('Run on Spark is available from a notebook item in the CSA Loom Explorer.');
    return;
  }
  if (node.item.itemType !== 'notebook') {
    vscode.window.showWarningMessage('Run on Spark is only available for notebook items.');
    return;
  }
  const root = cx.mirror.getWorkFolder();
  if (!root) {
    const choice = await vscode.window.showWarningMessage(
      'Set a local work folder to hold the runnable notebook file first.',
      'Set work folder',
    );
    if (choice) await vscode.commands.executeCommand('loom.setWorkFolder');
    if (!cx.mirror.getWorkFolder()) return;
  }
  const folder = cx.mirror.getWorkFolder()!;
  const name = `${slugForName(node.item.displayName)}-${node.item.id.slice(0, 8)}.ipynb`;
  const uri = vscode.Uri.joinPath(folder, node.dep.id, node.item.itemType, name);

  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
    await vscode.workspace.fs.writeFile(uri, starterIpynb(node.item.displayName));
  }

  const link: NotebookLink = { deploymentId: node.dep.id, itemId: node.item.id, displayName: node.item.displayName };
  await cx.links.set(uri, link);

  const doc = await vscode.workspace.openNotebookDocument(uri);
  await vscode.window.showNotebookDocument(doc);
  vscode.window.showInformationMessage(
    `Opened "${node.item.displayName}". Select the "CSA Loom Spark" kernel to run cells on remote Spark.`,
  );
}

/** `CSA Loom: Set Spark compute` — (re)choose the pool/cluster for a notebook. */
export async function setSparkCompute(cx: CommandContext, node?: ItemNode): Promise<void> {
  const link = await resolveLink(cx, node);
  if (!link) return;
  await cx.controller.setCompute(link);
}

/**
 * `CSA Loom: View recent runs` (N13) — the in-session run log; a running run can
 * be cancelled (→ `DELETE …/session`). Real runs only (no synthetic rows).
 */
export async function viewRecentRuns(cx: CommandContext): Promise<void> {
  const runs = cx.runs.list();
  if (runs.length === 0) {
    vscode.window.showInformationMessage('No notebook cells have been run yet this session.');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    runs.map((r) => ({
      label: `${stateIcon(r)} ${r.displayName} · ${r.language}`,
      description: r.compute ? `${r.backend ?? ''} ${r.compute}` : r.backend ?? '',
      detail: `${new Date(r.startedAt).toLocaleTimeString()} — ${r.codePreview}${r.error ? ` · ${r.error}` : ''}`,
      run: r,
    })),
    { title: 'CSA Loom — recent notebook runs', placeHolder: 'Select a run (running runs can be cancelled)' },
  );
  if (!pick) return;
  const r = pick.run;
  if (r.state === 'running') {
    const cancel = await vscode.window.showWarningMessage(`Cancel the running "${r.displayName}" statement?`, 'Cancel job');
    if (cancel) {
      await cx.controller.stopSession({ deploymentId: r.deploymentId, itemId: r.itemId, displayName: r.displayName });
      cx.runs.update(r.id, { state: 'cancelled', endedAt: Date.now() });
      vscode.window.showInformationMessage('Requested cancellation — the Spark session was stopped.');
    }
  }
}

function stateIcon(r: NotebookRun): string {
  switch (r.state) {
    case 'running':
      return '$(sync~spin)';
    case 'succeeded':
      return '$(pass)';
    case 'failed':
      return '$(error)';
    case 'cancelled':
      return '$(circle-slash)';
  }
}

/** Resolve a link from an item node, or from the active notebook editor. */
async function resolveLink(cx: CommandContext, node?: ItemNode): Promise<NotebookLink | undefined> {
  if (node && node.kind === 'item' && node.item.itemType === 'notebook') {
    return { deploymentId: node.dep.id, itemId: node.item.id, displayName: node.item.displayName };
  }
  const active = vscode.window.activeNotebookEditor?.notebook.uri;
  if (active) {
    const link = cx.links.get(active);
    if (link) return link;
  }
  vscode.window.showInformationMessage('Open a CSA Loom notebook with "Run on Spark" first.');
  return undefined;
}
