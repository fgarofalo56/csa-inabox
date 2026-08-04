/**
 * LoomDecorationProvider — the `vscode`-facing FileDecorationProvider that paints
 * the 4-state M/L/C badges (N7) on both the `loom:` item URIs the Explorer tree
 * carries AND the mirrored local files under the work folder. The state itself
 * comes from {@link MirrorStore.stateForRef} (which uses the PURE
 * `computeMirrorState`); this class only translates a state into a
 * `vscode.FileDecoration`.
 */
import * as vscode from 'vscode';
import { decorationFor } from './decorations';
import { parseLoomRef, buildDefinitionPath } from './definition-uri';
import { LoomFileSystemProvider } from './loom-fs-provider';
import type { MirrorStore } from '../mirror/mirror-store';

export class LoomDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  private readonly sub: vscode.Disposable;

  constructor(private readonly mirror: MirrorStore) {
    // When the mirror changes, re-request decorations for the affected refs —
    // both their `loom:` URI (tree) and their local file URI (explorer).
    this.sub = mirror.onDidChange((refs) => {
      const uris: vscode.Uri[] = [];
      for (const ref of refs) {
        uris.push(vscode.Uri.from({ scheme: LoomFileSystemProvider.scheme, path: buildDefinitionPath(ref) }));
        const entry = mirror.entryForRef(ref);
        if (entry) uris.push(vscode.Uri.file(entry.localPath));
      }
      if (uris.length) this._onDidChange.fire(uris);
    });
  }

  async provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
    const ref = this.refFor(uri);
    if (!ref) return undefined;
    const state = await this.mirror.stateForRef(ref);
    const spec = decorationFor(state);
    if (!spec) return undefined;
    return {
      badge: spec.badge,
      tooltip: spec.tooltip,
      color: new vscode.ThemeColor(spec.colorId),
      propagate: false,
    };
  }

  /** Resolve either a `loom:` URI or a mirrored local file back to its ref. */
  private refFor(uri: vscode.Uri): { deploymentId: string; itemType: string; itemId: string } | undefined {
    if (uri.scheme === LoomFileSystemProvider.scheme) {
      try {
        const r = parseLoomRef(uri.path);
        return { deploymentId: r.deploymentId, itemType: r.itemType, itemId: r.itemId };
      } catch {
        return undefined;
      }
    }
    if (uri.scheme === 'file') {
      const e = this.mirror.entryForPath(uri.fsPath);
      if (e) return { deploymentId: e.deploymentId, itemType: e.itemType, itemId: e.itemId };
    }
    return undefined;
  }

  dispose(): void {
    this.sub.dispose();
    this._onDidChange.dispose();
  }
}
