/**
 * NotebookLinkStore — associates an open `.ipynb` document with the CSA Loom
 * notebook item it should execute against. The link is recorded when the user
 * opens a notebook for execution from the Explorer; the NotebookController reads
 * it to know which `/api/notebook/[id]/…` routes to call. Persisted in
 * `globalState` (keyed by the document URI) so it survives a reload.
 */
import * as vscode from 'vscode';

const LINK_KEY = 'loom.notebookLinks';

export interface NotebookLink {
  deploymentId: string;
  itemId: string;
  displayName: string;
}

type LinkMap = Record<string, NotebookLink>;

export class NotebookLinkStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  private map(): LinkMap {
    return this.context.globalState.get<LinkMap>(LINK_KEY, {});
  }

  get(uri: vscode.Uri): NotebookLink | undefined {
    return this.map()[uri.toString()];
  }

  async set(uri: vscode.Uri, link: NotebookLink): Promise<void> {
    const m = this.map();
    m[uri.toString()] = link;
    await this.context.globalState.update(LINK_KEY, m);
  }
}
