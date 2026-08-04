/**
 * QueryEditorStore — links an open, untitled query document to the CSA Loom item
 * it runs against (the analogue of NotebookLinkStore for the SQL/KQL editor). A
 * `CSA Loom: Query data…` opens such a doc; `CSA Loom: Run query` reads the
 * active editor's text and its link to know which per-item route to call.
 *
 * The link is in-memory (untitled docs do not survive a reload) and keyed by the
 * document URI string. The store also drives the `loom.queryDocActive` context
 * key so the editor/title ▶ Run button shows only on a linked query doc.
 */
import * as vscode from 'vscode';
import type { QueryEngine } from './query-capability';

export interface QueryTarget {
  deploymentId: string;
  itemType: string;
  itemId: string;
  displayName: string;
  engine: QueryEngine;
}

export class QueryEditorStore {
  private readonly links = new Map<string, QueryTarget>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => void this.syncContext()),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        this.links.delete(doc.uri.toString());
      }),
    );
  }

  set(uri: vscode.Uri, target: QueryTarget): void {
    this.links.set(uri.toString(), target);
    void this.syncContext();
  }

  get(uri: vscode.Uri): QueryTarget | undefined {
    return this.links.get(uri.toString());
  }

  /** The target for the active editor's document, if it is a linked query doc. */
  activeTarget(): { doc: vscode.TextDocument; target: QueryTarget } | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    const target = this.get(editor.document.uri);
    return target ? { doc: editor.document, target } : undefined;
  }

  private async syncContext(): Promise<void> {
    const active = !!this.activeTarget();
    await vscode.commands.executeCommand('setContext', 'loom.queryDocActive', active);
  }

  dispose(): void {
    for (const d of this.disposables.splice(0)) d.dispose();
    this.links.clear();
  }
}
