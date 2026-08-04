/**
 * Phase-3 data commands — the query editor + results grid over the REAL per-item
 * query/preview routes (the same the SDK `query` resource + M2 `loom-query` MCP
 * call). Nothing is fabricated: every grid row is a real backend row, and an
 * unconfigured backend / rejected statement surfaces as an honest message pane
 * naming the exact remediation.
 *
 *   • loom.queryData  — resolve a SQL/KQL-capable item, open a query editor
 *                       (SQL → `sql`, KQL → plaintext) linked to it. A
 *                       preview-only item runs a bounded preview instead.
 *   • loom.runQuery   — run the ACTIVE linked query editor: read-only parse +
 *                       row/byte/time cap → grid.
 *   • loom.previewData— bounded, sampled preview of a previewable item → grid.
 */
import * as vscode from 'vscode';
import type { CommandContext, ItemNode } from './context';
import type { Deployment } from '../config/deployments';
import { isLoomApiError, type Item, type Workspace, type QueryResult, type LoomApi } from '../api/loom-client';
import { queryCapabilities, isDataReadable, PREVIEW_TYPES, type QueryEngine } from '../query/query-capability';
import {
  assertReadOnlySql,
  assertReadOnlyKql,
  clampLimit,
  capResult,
  QueryCapError,
  QUERY_TIMEOUT_MS,
} from '../query/query-caps';
import { shapeGrid } from '../query/grid-model';
import { ResultGridPanel } from '../query/result-grid-panel';

type Target = { dep: Deployment; item: Item };

/** `CSA Loom: Query data…` — open a query editor (or preview a preview-only item). */
export async function queryData(cx: CommandContext, node?: ItemNode): Promise<void> {
  const target = await resolveTarget(cx, node, (t) => isDataReadable(t));
  if (!target) return;
  const { dep, item } = target;
  const caps = queryCapabilities(item.itemType);

  if (!caps.engine) {
    if (caps.previewable) {
      await runPreview(cx, dep, item);
      return;
    }
    vscode.window.showInformationMessage(
      `"${item.displayName}" (${item.itemType}) has no query surface. Open it in the Console instead.`,
    );
    return;
  }
  await openQueryEditor(cx, dep, item, caps.engine);
}

/** `CSA Loom: Preview data` — a bounded sampled preview of a previewable item. */
export async function previewData(cx: CommandContext, node?: ItemNode): Promise<void> {
  const target = await resolveTarget(cx, node, (t) => PREVIEW_TYPES.has(t) || !!queryCapabilities(t).engine);
  if (!target) return;
  const { dep, item } = target;
  if (!PREVIEW_TYPES.has(item.itemType)) {
    if (queryCapabilities(item.itemType).engine) {
      vscode.window.showInformationMessage(
        `"${item.displayName}" (${item.itemType}) is queried with a statement — use "CSA Loom: Query data…".`,
      );
      return;
    }
    vscode.window.showInformationMessage(`Preview is not available for ${item.itemType}.`);
    return;
  }
  await runPreview(cx, dep, item);
}

/** `CSA Loom: Run query` — execute the active linked query editor into the grid. */
export async function runQuery(cx: CommandContext): Promise<void> {
  const active = cx.queryEditors.activeTarget();
  if (!active) {
    vscode.window.showInformationMessage('Open a query with "CSA Loom: Query data…" first, then run it here.');
    return;
  }
  const { doc, target } = active;
  const text = doc.getText();
  const dep = cx.getDeployments().find((d) => d.id === target.deploymentId);
  if (!dep) {
    vscode.window.showWarningMessage(`Deployment "${target.deploymentId}" is no longer configured.`);
    return;
  }
  const title = `${target.displayName} · ${target.engine.toUpperCase()}`;

  // Read-only parse BEFORE anything leaves the client (naming the rejected class).
  try {
    if (target.engine === 'sql') assertReadOnlySql(text);
    else assertReadOnlyKql(stripKqlComments(text));
  } catch (e) {
    if (e instanceof QueryCapError) {
      ResultGridPanel.showError(cx.extension.extensionUri, title, target.engine, e.message);
      return;
    }
    throw e;
  }
  if (!hasStatement(text, target.engine)) {
    vscode.window.showInformationMessage('Write a query below the header comment, then run it.');
    return;
  }

  const api = await cx.resolveApi(dep.id);
  if (!api) {
    vscode.window.showWarningMessage(`Sign in to ${dep.name} first.`);
    return;
  }

  const limit = clampLimit();
  ResultGridPanel.showLoading(cx.extension.extensionUri, title, target.engine);
  const started = Date.now();
  try {
    const raw = await withTimeout(
      target.engine === 'sql'
        ? api.querySql(target.itemType, target.itemId, text)
        : api.queryKql(target.itemType, target.itemId, text, limit),
      QUERY_TIMEOUT_MS,
    );
    renderResult(cx, title, target.engine, raw, limit, Date.now() - started);
  } catch (e) {
    ResultGridPanel.showError(cx.extension.extensionUri, title, target.engine, honestError(e));
  }
}

// --- internals --------------------------------------------------------------

async function runPreview(cx: CommandContext, dep: Deployment, item: Item): Promise<void> {
  const title = `${item.displayName} · preview`;
  const api = await cx.resolveApi(dep.id);
  if (!api) {
    vscode.window.showWarningMessage(`Sign in to ${dep.name} first.`);
    return;
  }
  const limit = clampLimit();
  ResultGridPanel.showLoading(cx.extension.extensionUri, title, 'preview');
  const started = Date.now();
  try {
    const raw = await withTimeout(api.queryPreview(item.itemType, item.id, limit), QUERY_TIMEOUT_MS);
    // A non-tabular / not-yet-materialized asset is an honest message, not a grid.
    if (raw && (raw as { previewable?: boolean }).previewable === false) {
      const msg =
        (raw as { message?: string; error?: string }).message ||
        (raw as { error?: string }).error ||
        'This asset is not previewable as a table.';
      ResultGridPanel.showError(cx.extension.extensionUri, title, 'preview', msg);
      return;
    }
    renderResult(cx, title, 'preview', raw, limit, Date.now() - started);
  } catch (e) {
    ResultGridPanel.showError(cx.extension.extensionUri, title, 'preview', honestError(e));
  }
}

function renderResult(
  cx: CommandContext,
  title: string,
  engine: string,
  raw: QueryResult,
  limit: number,
  clientMs: number,
): void {
  const capped = capResult(raw, limit);
  const model = shapeGrid({ ...capped.data, ...(capped.cappedBy ? { cappedBy: capped.cappedBy } : {}) });
  // Prefer the engine's own executionMs; fall back to the client round-trip so
  // the status bar always shows a real timing (never a fabricated number).
  if (model.kind === 'grid' && model.elapsedMs == null) model.elapsedMs = clientMs;
  ResultGridPanel.showResult(cx.extension.extensionUri, title, engine, model);
}

async function openQueryEditor(
  cx: CommandContext,
  dep: Deployment,
  item: Item,
  engine: QueryEngine,
): Promise<void> {
  const language = engine === 'sql' ? 'sql' : 'plaintext';
  const commentPrefix = engine === 'sql' ? '--' : '//';
  const header =
    `${commentPrefix} CSA Loom · ${item.displayName} (${item.itemType}) — ${dep.name}\n` +
    `${commentPrefix} Read-only ${engine.toUpperCase()}. Run with the ▶ button or "CSA Loom: Run query".\n\n`;
  const doc = await vscode.workspace.openTextDocument({ content: header, language });
  cx.queryEditors.set(doc.uri, {
    deploymentId: dep.id,
    itemType: item.itemType,
    itemId: item.id,
    displayName: item.displayName,
    engine,
  });
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  // Park the cursor at the end so the user types their statement immediately.
  const end = doc.lineAt(doc.lineCount - 1).range.end;
  editor.selection = new vscode.Selection(end, end);
}

/** Resolve the target item from a tree node, or an interactive deployment→ws→item pick. */
async function resolveTarget(
  cx: CommandContext,
  node: ItemNode | undefined,
  typeFilter: (itemType: string) => boolean,
): Promise<Target | undefined> {
  if (node && node.kind === 'item') return { dep: node.dep, item: node.item };

  const dep = await cx.auth.pickDeployment('Query data in which deployment?');
  if (!dep) return undefined;
  if (!(await cx.auth.isSignedIn(dep.id))) {
    vscode.window.showWarningMessage(`Sign in to ${dep.name} first.`);
    return undefined;
  }
  const api = await cx.resolveApi(dep.id);
  if (!api) return undefined;

  const workspace = await pickWorkspace(api, dep);
  if (!workspace) return undefined;

  let items: Item[];
  try {
    items = await api.listItems(workspace.id);
  } catch (e) {
    vscode.window.showErrorMessage(`Could not list items: ${honestError(e)}`);
    return undefined;
  }
  const readable = items.filter((i) => typeFilter(i.itemType));
  if (readable.length === 0) {
    vscode.window.showInformationMessage(`${workspace.name} has no queryable items.`);
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    readable
      .slice()
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .map((i) => ({ label: i.displayName, description: i.itemType, item: i })),
    { title: 'Query which item?', placeHolder: 'Select a data item', matchOnDescription: true },
  );
  return pick ? { dep, item: pick.item } : undefined;
}

async function pickWorkspace(api: LoomApi, dep: Deployment): Promise<Workspace | undefined> {
  let workspaces: Workspace[];
  try {
    workspaces = await api.listWorkspaces();
  } catch (e) {
    vscode.window.showErrorMessage(`Could not list workspaces: ${honestError(e)}`);
    return undefined;
  }
  if (workspaces.length === 0) {
    vscode.window.showWarningMessage(`${dep.name} has no workspaces.`);
    return undefined;
  }
  if (workspaces.length === 1) return workspaces[0];
  const pick = await vscode.window.showQuickPick(
    workspaces.map((w) => ({ label: w.name, description: w.id, workspace: w })),
    { title: 'In which workspace?', placeHolder: 'Select a workspace' },
  );
  return pick?.workspace;
}

/** KQL `//` line comments — strip for the read-only leading-token check. */
function stripKqlComments(text: string): string {
  return text.replace(/\/\/[^\n\r]*/g, ' ');
}

/** True when there is real (non-comment, non-blank) statement text. */
function hasStatement(text: string, engine: QueryEngine): boolean {
  const stripped =
    engine === 'sql'
      ? text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n\r]*/g, ' ')
      : stripKqlComments(text);
  return stripped.trim().length > 0;
}

/** A LoomApiError carries the route's exact remediation (`hint`) — surface it verbatim. */
function honestError(e: unknown): string {
  if (isLoomApiError(e)) return `${e.message}${e.hint ? ` (${e.hint})` : ''}`;
  return e instanceof Error ? e.message : String(e);
}

/** Client-side statement time cap (belt over the route's own server timeout). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Query exceeded the ${Math.round(ms / 1000)}s client time cap and was abandoned.`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
