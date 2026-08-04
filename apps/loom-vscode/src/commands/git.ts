/**
 * Git / ALM commands (Phase 5, W9/W10) — commit, pull, status and per-item
 * conflict resolution over the REAL workspace-scoped `/api/git-integration/*`
 * routes (Azure-native ADO / GitHub). Every honest gate (no repo bound / no PAT
 * / no Key Vault → 424) becomes a named remediation + a Fix-it that opens the
 * Console workspace Git settings — never a fabricated status (no-vaporware.md G2).
 */
import * as vscode from 'vscode';
import type { CommandContext, WorkspaceNode, ItemNode } from './context';
import { guardWrite } from './context';
import type { Deployment } from '../config/deployments';
import type { LoomApi } from '../api/loom-client';
import { GitGateError, isLoomApiError } from '../api/loom-client';
import { changeIcon, describeGitGate, summarizeChanges, type GitStatusEntry } from '../git/git-model';
import { iconIdForItemType } from '../tree/icons';

interface WorkspaceTarget {
  dep: Deployment;
  workspaceId: string;
  workspaceName: string;
  api: LoomApi;
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
  // Palette invocation — pick a workspace across signed-in deployments.
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
    vscode.window.showWarningMessage('No workspaces available to run Git actions against.');
    return undefined;
  }
  const chosen = await vscode.window.showQuickPick(picks, { title: 'CSA Loom Git — choose a workspace' });
  if (!chosen) return undefined;
  const api = await cx.resolveApi(chosen.dep.id);
  if (!api) return undefined;
  return { dep: chosen.dep, workspaceId: chosen.workspaceId, workspaceName: chosen.workspaceName, api };
}

/** Turn any git failure into an honest message; the gate gets a Fix-it link. */
async function handleGitError(t: WorkspaceTarget, e: unknown): Promise<void> {
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
  vscode.window.showErrorMessage(`Git: ${msg}`);
}

/** `CSA Loom: Git status` (W10) — repo + changed items for a workspace (read). */
export async function gitStatus(cx: CommandContext, node?: WorkspaceNode): Promise<void> {
  const t = await resolveWorkspace(cx, node);
  if (!t) return;
  try {
    const status = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Git status — ${t.workspaceName}…` },
      () => t.api.gitStatus(t.workspaceId),
    );
    const { changed, repo, headSha } = status;
    const sum = summarizeChanges(changed);
    if (sum.total === 0) {
      vscode.window.showInformationMessage(
        `${t.workspaceName} is in sync with ${repo.provider} \`${repo.repoPath}\` (${repo.branch}) — no changes.`,
      );
      return;
    }
    const picks = changed.map((c) => statusPick(c));
    await vscode.window.showQuickPick(picks, {
      title: `Git · ${repo.repoPath} (${repo.branch})${headSha ? ` · ${String(headSha).slice(0, 7)}` : ''}`,
      placeHolder: `${sum.total} changed — ${sum.added} added, ${sum.modified} modified, ${sum.removed} removed`,
    });
  } catch (e) {
    await handleGitError(t, e);
  }
}

/** `CSA Loom: Git commit` (W10) — pick changed items, message, commit (write). */
export async function gitCommit(cx: CommandContext, node?: WorkspaceNode): Promise<void> {
  const t = await resolveWorkspace(cx, node);
  if (!t) return;
  if (!guardWrite(cx, t.dep)) return;
  try {
    const status = await t.api.gitStatus(t.workspaceId);
    const committable = status.changed.filter((c) => c.itemId && c.status !== 'removed');
    if (committable.length === 0) {
      vscode.window.showInformationMessage(`Nothing to commit in ${t.workspaceName}.`);
      return;
    }
    const picks = committable.map((c) => ({ ...statusPick(c), entry: c, picked: true }));
    const chosen = await vscode.window.showQuickPick(picks, {
      title: `Commit to ${status.repo.repoPath} (${status.repo.branch})`,
      placeHolder: 'Select the items to commit',
      canPickMany: true,
    });
    if (!chosen || chosen.length === 0) return;
    const message = await vscode.window.showInputBox({
      title: 'Commit message',
      prompt: `Commit ${chosen.length} item(s) to ${status.repo.branch}`,
      value: `Loom: update ${chosen.length} item(s)`,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'A commit message is required.'),
    });
    if (!message) return;
    const itemIds = chosen.map((c) => c.entry.itemId!).filter(Boolean);
    const res = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Committing to ${status.repo.branch}…` },
      () => t.api.gitCommit(t.workspaceId, itemIds, message),
    );
    cx.tree.refresh();
    const open = 'Open commit';
    const choice = await vscode.window.showInformationMessage(
      `Committed ${res.files} file(s) as ${String(res.commitSha).slice(0, 7)}.`,
      ...(res.url ? [open] : []),
    );
    if (choice === open && res.url) await vscode.env.openExternal(vscode.Uri.parse(res.url));
  } catch (e) {
    await handleGitError(t, e);
  }
}

/** `CSA Loom: Git pull` (W10) — pull the repo → apply to items (write). */
export async function gitPull(cx: CommandContext, node?: WorkspaceNode): Promise<void> {
  const t = await resolveWorkspace(cx, node);
  if (!t) return;
  if (!guardWrite(cx, t.dep)) return;
  const ok = await vscode.window.showWarningMessage(
    `Pull the connected repo into ${t.workspaceName}? Repo versions overwrite the matching Loom items.`,
    { modal: true },
    'Pull',
  );
  if (ok !== 'Pull') return;
  try {
    const res = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Pulling into ${t.workspaceName}…` },
      () => t.api.gitPull(t.workspaceId),
    );
    cx.tree.refresh();
    vscode.window.showInformationMessage(
      `Pulled ${res.headSha ? String(res.headSha).slice(0, 7) : 'HEAD'} — applied ${res.applied} item(s).`,
    );
  } catch (e) {
    await handleGitError(t, e);
  }
}

/** `CSA Loom: Git resolve` (W10) — resolve one item's conflict (write). */
export async function gitResolve(cx: CommandContext, node?: ItemNode): Promise<void> {
  if (!node || node.kind !== 'item') {
    vscode.window.showInformationMessage('Resolve a conflict from an item in the CSA Loom Explorer.');
    return;
  }
  const api = await cx.resolveApi(node.dep.id);
  if (!api) {
    vscode.window.showWarningMessage(`Sign in to ${node.dep.name} first.`);
    return;
  }
  const t: WorkspaceTarget = { dep: node.dep, workspaceId: node.workspace.id, workspaceName: node.workspace.name, api };
  if (!guardWrite(cx, t.dep)) return;
  const pick = await vscode.window.showQuickPick(
    [
      { label: '$(cloud-upload) Keep local — overwrite the repo', resolution: 'local' as const },
      { label: '$(cloud-download) Keep remote — overwrite the Loom item', resolution: 'remote' as const },
    ],
    { title: `Resolve conflict — ${node.item.displayName}`, placeHolder: 'Which side wins?' },
  );
  if (!pick) return;
  try {
    const res = await t.api.gitResolve(t.workspaceId, node.item.id, pick.resolution);
    cx.tree.refresh();
    if (res.resolution === 'local') {
      vscode.window.showInformationMessage(`Kept local — committed ${res.commitSha ? String(res.commitSha).slice(0, 7) : ''}.`);
    } else {
      vscode.window.showInformationMessage(`Kept remote — applied ${res.applied ?? 0} item(s).`);
    }
  } catch (e) {
    await handleGitError(t, e);
  }
}

/** A quick-pick row for a changed item, icon by change status. */
function statusPick(c: GitStatusEntry): vscode.QuickPickItem {
  const badge = c.status === 'added' ? 'A' : c.status === 'removed' ? 'D' : 'M';
  return {
    label: `$(${changeIcon(c.status)}) ${c.displayName}`,
    description: `${badge} · $(${iconIdForItemType(c.itemType)}) ${c.itemType}`,
  };
}
