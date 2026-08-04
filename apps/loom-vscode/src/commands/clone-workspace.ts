/**
 * `CSA Loom: Clone workspace repo` (W9) — clone the Git repo bound to a Loom
 * workspace to local disk.
 *
 * Flow: read the workspace's bound repo from the REAL `/api/git-integration/status`
 * route → build the HTTPS clone URL (PURE `clone-model.ts`) → hand it to VS Code's
 * built-in `git.clone` command, which prompts for a target folder and performs
 * the clone + auth with the user's OWN Git credentials. The extension never
 * shells out to `git` and never touches a credential.
 *
 * Honest gates (no-vaporware.md G2): no repo bound / no PAT / no Key Vault → the
 * route's 424 becomes a named remediation (a Fix-it opens the Console Git
 * settings); an unsupported provider or a missing Git extension explains itself
 * and offers to copy the URL — never a silent no-op.
 */
import * as vscode from 'vscode';
import type { CommandContext, WorkspaceNode } from './context';
import type { Deployment } from '../config/deployments';
import type { LoomApi } from '../api/loom-client';
import { GitGateError, isLoomApiError } from '../api/loom-client';
import { describeGitGate } from '../git/git-model';
import { buildCloneUrl } from '../git/clone-model';

interface WorkspaceTarget {
  dep: Deployment;
  workspaceId: string;
  workspaceName: string;
  api: LoomApi;
}

export async function cloneWorkspaceRepo(cx: CommandContext, node?: WorkspaceNode): Promise<void> {
  const t = await resolveWorkspace(cx, node);
  if (!t) return;

  try {
    const status = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Resolving repo for ${t.workspaceName}…` },
      () => t.api.gitStatus(t.workspaceId),
    );
    const built = buildCloneUrl(status.repo.provider, status.repo.repoPath);
    if ('error' in built) {
      const openConsole = 'Open in Console';
      const choice = await vscode.window.showWarningMessage(built.error, openConsole);
      if (choice === openConsole) {
        await vscode.env.openExternal(
          vscode.Uri.parse(`${t.dep.apiUrl}/workspaces/${encodeURIComponent(t.workspaceId)}`),
        );
      }
      return;
    }

    // Prefer VS Code's built-in Git clone (does its own credential prompt).
    if (vscode.extensions.getExtension('vscode.git')) {
      await vscode.commands.executeCommand('git.clone', built.url);
      return;
    }
    // No Git extension — offer the URL so the user can clone however they clone.
    const copy = 'Copy clone URL';
    const choice = await vscode.window.showWarningMessage(
      `VS Code's Git extension isn't available to clone \`${status.repo.repoPath}\`. Copy the URL and clone manually.`,
      copy,
    );
    if (choice === copy) {
      await vscode.env.clipboard.writeText(built.url);
      vscode.window.setStatusBarMessage('$(check) Copied clone URL', 2500);
    }
  } catch (e) {
    if (e instanceof GitGateError) {
      const fix = 'Open workspace Git settings';
      const choice = await vscode.window.showWarningMessage(describeGitGate(e.missing, e.detail), fix);
      if (choice === fix) {
        await vscode.env.openExternal(
          vscode.Uri.parse(`${t.dep.apiUrl}/workspaces/${encodeURIComponent(t.workspaceId)}`),
        );
      }
      return;
    }
    const msg = isLoomApiError(e) ? `${e.message}${e.hint ? ` (${e.hint})` : ''}` : e instanceof Error ? e.message : String(e);
    vscode.window.showErrorMessage(`Clone: ${msg}`);
  }
}

/** Resolve a workspace + its signed-in API from a node, or via a picker. */
async function resolveWorkspace(cx: CommandContext, node?: WorkspaceNode): Promise<WorkspaceTarget | undefined> {
  if (node && node.kind === 'workspace') {
    const api = await cx.resolveApi(node.dep.id);
    if (!api) {
      vscode.window.showWarningMessage(`Sign in to ${node.dep.name} first.`);
      return undefined;
    }
    return { dep: node.dep, workspaceId: node.workspace.id, workspaceName: node.workspace.name, api };
  }
  const deps: Deployment[] = [];
  for (const d of cx.getDeployments()) if (await cx.auth.isSignedIn(d.id)) deps.push(d);
  if (deps.length === 0) {
    vscode.window.showWarningMessage('Sign in to a CSA Loom deployment first.');
    return undefined;
  }
  interface WsPick extends vscode.QuickPickItem {
    dep: Deployment;
    workspaceId: string;
    workspaceName: string;
  }
  const picks: WsPick[] = [];
  for (const dep of deps) {
    const api = await cx.resolveApi(dep.id);
    if (!api) continue;
    try {
      for (const ws of await api.listWorkspaces()) {
        picks.push({
          label: `$(folder) ${ws.name}`,
          description: deps.length > 1 ? dep.name : undefined,
          dep,
          workspaceId: ws.id,
          workspaceName: ws.name,
        });
      }
    } catch {
      /* surfaced on the chosen action */
    }
  }
  if (picks.length === 0) {
    vscode.window.showWarningMessage('No workspaces available to clone.');
    return undefined;
  }
  const chosen = await vscode.window.showQuickPick(picks, { title: 'CSA Loom — clone which workspace repo?' });
  if (!chosen) return undefined;
  const api = await cx.resolveApi(chosen.dep.id);
  if (!api) return undefined;
  return { dep: chosen.dep, workspaceId: chosen.workspaceId, workspaceName: chosen.workspaceName, api };
}
