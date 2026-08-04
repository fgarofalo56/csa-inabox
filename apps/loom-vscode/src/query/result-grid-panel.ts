/**
 * ResultGridPanel — the single Phase-3 webview: a type-badged results grid with
 * a timing status bar, rendered with the host theme's tokens (web3-ui in the
 * editor idiom: VS Code theme variables + a Loom accent, never ad-hoc colors).
 *
 * Boundary rule (PRP §2.3): the webview NEVER sees a credential. The extension
 * host fetches + authorizes + shapes the data, then posts ONLY column/row/meta
 * across via {@link buildGridMessage}. `enableScripts` is on with a strict CSP
 * (nonce'd script, `localResourceRoots` pinned to `media/`), so nothing else can
 * run and no remote asset can load.
 *
 * States, all designed (no-vaporware): a skeleton while the query runs, the grid
 * on success, and an honest message pane for a DDL/empty result or an error /
 * infra-gate (the route's exact remediation text, verbatim).
 */
import * as vscode from 'vscode';
import { buildGridMessage, type GridModel } from './grid-model';

type OutMessage =
  | { type: 'loading'; title: string; engine: string }
  | ReturnType<typeof buildGridMessage>
  | { type: 'message'; title: string; engine: string; message: string; isError: boolean };

export class ResultGridPanel {
  private static current: ResultGridPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private ready = false;
  private pending: OutMessage | undefined;
  private disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (m: { type?: string }) => {
        if (m?.type === 'ready') {
          this.ready = true;
          if (this.pending) {
            void this.panel.webview.postMessage(this.pending);
            this.pending = undefined;
          }
        }
      },
      null,
      this.disposables,
    );
  }

  /** Reuse the open panel (a real results grid updates in place per run). */
  private static ensure(extensionUri: vscode.Uri): ResultGridPanel {
    if (ResultGridPanel.current) {
      ResultGridPanel.current.panel.reveal(vscode.ViewColumn.Beside, true);
      return ResultGridPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'loom.resultGrid',
      'CSA Loom · Results',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      },
    );
    ResultGridPanel.current = new ResultGridPanel(panel, extensionUri);
    return ResultGridPanel.current;
  }

  /** Show a determinate "running" skeleton for a query about to run. */
  static showLoading(extensionUri: vscode.Uri, title: string, engine: string): void {
    const p = ResultGridPanel.ensure(extensionUri);
    p.panel.title = `CSA Loom · ${title}`;
    p.post({ type: 'loading', title, engine });
  }

  /** Render a shaped grid (or an honest message pane for DDL/empty). */
  static showResult(extensionUri: vscode.Uri, title: string, engine: string, model: GridModel): void {
    const p = ResultGridPanel.ensure(extensionUri);
    p.panel.title = `CSA Loom · ${title}`;
    if (model.kind === 'grid') {
      p.post(buildGridMessage(title, engine, model));
    } else {
      p.post({ type: 'message', title, engine, message: model.message, isError: model.isError });
    }
  }

  /** Render an honest error / infra-gate pane (the route's exact remediation). */
  static showError(extensionUri: vscode.Uri, title: string, engine: string, message: string): void {
    const p = ResultGridPanel.ensure(extensionUri);
    p.panel.title = `CSA Loom · ${title}`;
    p.post({ type: 'message', title, engine, message, isError: true });
  }

  private post(m: OutMessage): void {
    if (this.ready) {
      void this.panel.webview.postMessage(m);
    } else {
      this.pending = m; // sent when the webview signals 'ready'
    }
  }

  private html(): string {
    const webview = this.panel.webview;
    const nonce = makeNonce();
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'result-grid.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'result-grid.js'));
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource}`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${cssUri}" rel="stylesheet" />
  <title>CSA Loom Results</title>
</head>
<body>
  <div id="statusbar" class="statusbar" role="status" aria-live="polite"></div>
  <div id="content" class="content"></div>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    ResultGridPanel.current = undefined;
    this.panel.dispose();
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}

/** CSP nonce — crypto if available, else a Math.random fallback (webview-only). */
function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}
