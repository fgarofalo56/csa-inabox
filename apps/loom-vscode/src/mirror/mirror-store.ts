/**
 * MirrorStore — the local-work-folder mirror + 4-state tracking behind the
 * decorations (N2/N4/N7). One local work folder (Fabric's "Set Local Work
 * Folder"); items download beneath it as `<deployment>/<type>/<slug>.definition.json`.
 *
 * For each downloaded item we persist a manifest row in `globalState`:
 *   { deploymentId, itemType, itemId, localPath, baseHash, etag, remoteHash }
 * — `baseHash` = the remote content hash at download time, `remoteHash` = the
 * latest known remote hash (advanced by an Update/refresh). The decoration state
 * is derived from (baseHash, current-local-file-hash, remoteHash) via the PURE
 * `computeMirrorState`, so the badge logic itself stays unit-tested.
 *
 * `vscode`-facing (uses `workspace.fs`, `Uri`, `globalState`, `node:crypto`).
 */
import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { computeMirrorState, type MirrorState } from '../fs/decorations';
import { slugForName, DEFINITION_SUFFIX, type LoomRef } from '../fs/definition-uri';

const WORK_FOLDER_KEY = 'loom.workFolder';
const MANIFEST_KEY = 'loom.mirrorManifest';

export interface MirrorEntry {
  deploymentId: string;
  itemType: string;
  itemId: string;
  /** Absolute fs path of the local copy. */
  localPath: string;
  /** Remote content hash captured at download time. */
  baseHash: string;
  /** ETag captured at download time (for Publish's If-Match). */
  etag: string;
  /** Latest known remote hash (== baseHash until an Update/refresh advances it). */
  remoteHash: string;
}

type Manifest = Record<string, MirrorEntry>;

function refKey(ref: { deploymentId: string; itemType: string; itemId: string }): string {
  return `${ref.deploymentId}::${ref.itemType}::${ref.itemId}`;
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export class MirrorStore {
  private readonly _onDidChange = new vscode.EventEmitter<LoomRef[]>();
  /** Fires with the refs whose decoration should be recomputed. */
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  // --- work folder ---------------------------------------------------------

  getWorkFolder(): vscode.Uri | undefined {
    const p = this.context.globalState.get<string>(WORK_FOLDER_KEY);
    return p ? vscode.Uri.file(p) : undefined;
  }

  async setWorkFolder(uri: vscode.Uri): Promise<void> {
    await this.context.globalState.update(WORK_FOLDER_KEY, uri.fsPath);
  }

  // --- manifest ------------------------------------------------------------

  private manifest(): Manifest {
    return this.context.globalState.get<Manifest>(MANIFEST_KEY, {});
  }

  private async writeManifest(m: Manifest): Promise<void> {
    await this.context.globalState.update(MANIFEST_KEY, m);
  }

  entryForRef(ref: { deploymentId: string; itemType: string; itemId: string }): MirrorEntry | undefined {
    return this.manifest()[refKey(ref)];
  }

  entryForPath(fsPath: string): MirrorEntry | undefined {
    const norm = fsPath.replace(/\\/g, '/').toLowerCase();
    return Object.values(this.manifest()).find((e) => e.localPath.replace(/\\/g, '/').toLowerCase() === norm);
  }

  /** The local file URI an item would download to (whether or not it exists yet). */
  localUriFor(ref: LoomRef, displayName: string): vscode.Uri {
    const root = this.getWorkFolder();
    if (!root) throw new Error('No local work folder is set. Run "CSA Loom: Set local work folder" first.');
    const name = `${slugForName(displayName)}-${ref.itemId.slice(0, 8)}${DEFINITION_SUFFIX}`;
    return vscode.Uri.joinPath(root, ref.deploymentId, ref.itemType, name);
  }

  // --- lifecycle -----------------------------------------------------------

  /** Write a downloaded definition to the mirror and record its baseline. */
  async download(ref: LoomRef, displayName: string, bytes: Uint8Array, etag: string): Promise<vscode.Uri> {
    const uri = this.localUriFor(ref, displayName);
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
    await vscode.workspace.fs.writeFile(uri, bytes);
    const h = hashBytes(bytes);
    const m = this.manifest();
    m[refKey(ref)] = {
      deploymentId: ref.deploymentId,
      itemType: ref.itemType,
      itemId: ref.itemId,
      localPath: uri.fsPath,
      baseHash: h,
      etag,
      remoteHash: h,
    };
    await this.writeManifest(m);
    this._onDidChange.fire([ref]);
    return uri;
  }

  /** After a successful Publish: the local copy is the new baseline + remote. */
  async markPublished(ref: LoomRef, bytes: Uint8Array, etag: string): Promise<void> {
    const m = this.manifest();
    const e = m[refKey(ref)];
    if (!e) return;
    const h = hashBytes(bytes);
    e.baseHash = h;
    e.remoteHash = h;
    e.etag = etag;
    await this.writeManifest(m);
    this._onDidChange.fire([ref]);
  }

  /** After an Update/refresh: record the latest remote hash + ETag. */
  async setRemote(ref: LoomRef, remoteBytes: Uint8Array, etag: string): Promise<void> {
    const m = this.manifest();
    const e = m[refKey(ref)];
    if (!e) return;
    e.remoteHash = hashBytes(remoteBytes);
    e.etag = etag;
    await this.writeManifest(m);
    this._onDidChange.fire([ref]);
  }

  /** Remove the local copy + manifest row (N4 "local only"). */
  async removeLocal(ref: LoomRef): Promise<void> {
    const m = this.manifest();
    const e = m[refKey(ref)];
    if (!e) return;
    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(e.localPath));
    } catch {
      /* already gone */
    }
    delete m[refKey(ref)];
    await this.writeManifest(m);
    this._onDidChange.fire([ref]);
  }

  // --- state ---------------------------------------------------------------

  /** Current 4-state for an item (async — reads the local file to hash it). */
  async stateForRef(ref: { deploymentId: string; itemType: string; itemId: string }): Promise<MirrorState> {
    const e = this.entryForRef(ref);
    if (!e) return 'remote';
    let localHash: string | undefined;
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(e.localPath));
      localHash = hashBytes(bytes);
    } catch {
      localHash = undefined; // file deleted out from under us → treat as remote-only
    }
    return computeMirrorState({ base: e.baseHash, local: localHash, remote: e.remoteHash });
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
