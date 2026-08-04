/**
 * `CSA Loom: Select active deployment` — chooses which deployment the MCP servers
 * and the `@loom` chat participant act against (the tree stays multi-deployment).
 */
import * as vscode from 'vscode';
import type { CommandContext } from './context';

export async function selectActiveDeployment(cx: CommandContext): Promise<void> {
  const deps = cx.getDeployments();
  if (deps.length === 0) {
    void vscode.window.showWarningMessage('No CSA Loom deployments configured. Run "CSA Loom: Add deployment…" first.');
    return;
  }
  const active = cx.activeDeployment.get();
  const pick = await vscode.window.showQuickPick(
    deps.map((d) => ({
      label: d.name,
      description: d.apiUrl,
      detail: `cloud: ${d.cloud}${d.id === active?.id ? ' · active' : ''}`,
      id: d.id,
    })),
    { title: 'Active deployment for MCP servers + @loom', placeHolder: 'Select a deployment' },
  );
  if (!pick) return;
  await cx.activeDeployment.set(pick.id);
  void vscode.window.showInformationMessage(`CSA Loom: "${pick.label}" is now the active deployment for MCP + @loom.`);
}
