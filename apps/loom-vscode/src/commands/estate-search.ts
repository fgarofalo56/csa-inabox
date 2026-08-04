/**
 * `CSA Loom: Find item (estate search)` (W14 / P3.6) — a quick-pick that
 * searches the catalog across the SELECTED deployment(s) via `/api/catalog/find`
 * (the `loom find` backend, ACL/tenant-scoped server-side) and opens the chosen
 * item. Real results only: every entry is a real, accessible item; a deployment
 * that errors or is signed out is surfaced honestly, never hidden behind a fake
 * result.
 *
 * Multi-deployment IS the tenancy model (PRP A2/W11): with a Commercial and a
 * Government deployment both signed in, one search spans both and the chosen hit
 * opens against the deployment it belongs to.
 */
import * as vscode from 'vscode';
import type { CommandContext } from './context';
import type { Deployment } from '../config/deployments';
import { isLoomApiError } from '../api/loom-client';
import { mapFindResponse, rankEstateHits, type EstateHit } from '../query/search-model';
import { iconIdForItemType } from '../tree/icons';

const MERGE_LIMIT = 100;
const PER_DEPLOYMENT_LIMIT = 50;

interface HitPick extends vscode.QuickPickItem {
  hit: EstateHit;
}

export async function findItem(cx: CommandContext): Promise<void> {
  // Which deployments to search: every signed-in one (the P1 multi-deployment
  // model). A single signed-in deployment is used directly; none → guide.
  const signedIn: Deployment[] = [];
  for (const d of cx.getDeployments()) {
    if (await cx.auth.isSignedIn(d.id)) signedIn.push(d);
  }
  if (signedIn.length === 0) {
    vscode.window.showWarningMessage('Sign in to a CSA Loom deployment first, then search.');
    return;
  }
  const multi = signedIn.length > 1;

  const qp = vscode.window.createQuickPick<HitPick>();
  qp.title = multi ? `Find item · ${signedIn.length} deployments` : `Find item · ${signedIn[0].name}`;
  qp.placeholder = 'Search items across your accessible workspaces (name, type, tag)…';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;

  let seq = 0;
  const runSearch = async (query: string): Promise<void> => {
    const mySeq = ++seq;
    qp.busy = true;
    try {
      const groups: EstateHit[][] = [];
      const errors: string[] = [];
      await Promise.all(
        signedIn.map(async (dep) => {
          const api = await cx.resolveApi(dep.id);
          if (!api) {
            errors.push(`${dep.name}: not signed in`);
            return;
          }
          try {
            const res = await api.catalogFind(query, { limit: PER_DEPLOYMENT_LIMIT });
            groups.push(mapFindResponse(dep.id, dep.name, res, multi));
          } catch (e) {
            errors.push(`${dep.name}: ${isLoomApiError(e) ? e.message : e instanceof Error ? e.message : String(e)}`);
          }
        }),
      );
      if (mySeq !== seq) return; // a newer keystroke superseded this search

      const hits = rankEstateHits(groups, MERGE_LIMIT);
      qp.items = hits.map((hit) => toPick(hit));
      // Honest failure surfacing — never silently drop a deployment.
      qp.title = errors.length
        ? `Find item · ${hits.length} result(s) · ${errors.length} deployment(s) unavailable`
        : multi
          ? `Find item · ${hits.length} result(s) across ${signedIn.length} deployments`
          : `Find item · ${hits.length} result(s) in ${signedIn[0].name}`;
      if (errors.length) qp.items = qp.items.length ? qp.items : [];
    } finally {
      if (mySeq === seq) qp.busy = false;
    }
  };

  qp.onDidChangeValue((v) => void runSearch(v.trim()));
  qp.onDidAccept(() => {
    const picked = qp.selectedItems[0];
    if (picked) {
      qp.hide();
      void openHit(cx, picked.hit);
    }
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
  // Browse mode: an empty query returns the most-recently-updated items.
  void runSearch('');
}

function toPick(hit: EstateHit): HitPick {
  const parts: string[] = [hit.itemType];
  if (hit.workspaceName) parts.push(hit.workspaceName);
  if (hit.multiDeployment) parts.push(hit.deploymentName);
  return {
    label: `$(${iconIdForItemType(hit.itemType)}) ${hit.displayName}`,
    description: parts.join(' · '),
    detail: hit.description || undefined,
    hit,
  };
}

/**
 * Open a chosen hit: the item's definition over the `loom:` FS when we can build
 * that URI (a real, editable surface), else the Console item page. Both are real
 * — never a placeholder.
 */
async function openHit(cx: CommandContext, hit: EstateHit): Promise<void> {
  const dep = cx.getDeployments().find((d) => d.id === hit.deploymentId);
  if (!dep) {
    vscode.window.showWarningMessage(`Deployment "${hit.deploymentName}" is no longer configured.`);
    return;
  }
  const choice = await vscode.window.showQuickPick(
    [
      { label: '$(go-to-file) Open definition', action: 'definition' as const },
      { label: '$(link-external) Open in Console', action: 'console' as const },
    ],
    { title: `${hit.displayName} (${hit.itemType})`, placeHolder: 'Open how?' },
  );
  if (!choice) return;

  if (choice.action === 'console') {
    const url = `${dep.apiUrl}/items/${encodeURIComponent(hit.itemType)}/${encodeURIComponent(hit.id)}`;
    await vscode.env.openExternal(vscode.Uri.parse(url));
    return;
  }
  // Reuse the P1/P2 openDefinition path via the item context menu command by
  // constructing an ItemNode-shaped argument.
  await vscode.commands.executeCommand('loom.openDefinition', {
    kind: 'item',
    dep,
    workspace: { id: hit.workspaceId, name: hit.workspaceName },
    item: { id: hit.id, workspaceId: hit.workspaceId, itemType: hit.itemType, displayName: hit.displayName },
  });
}
