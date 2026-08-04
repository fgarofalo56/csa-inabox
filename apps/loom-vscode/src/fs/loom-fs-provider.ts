/**
 * LoomFileSystemProvider — the `vscode`-facing adapter for the `loom:` virtual
 * filesystem (W6 / P1.6). It parses `loom:` URIs, delegates read/write/stat to
 * the PURE {@link LoomFsCore}, and maps the core's typed errors to the right
 * `vscode.FileSystemError`. "Open definition" opens a `loom:` document; saving
 * it writes through to `PUT …/definition` (direct mode). A concurrent-edit 412
 * surfaces as a save error naming the remedy — the mirror-mode Publish/Update
 * commands are where the full diff/merge flow lives (N5/N6).
 */
import * as vscode from 'vscode';
import { LoomFsCore, LoomFsError, type DefinitionTransport } from './loom-fs-core';
import { parseLoomRef, type LoomRef } from './definition-uri';
import { isLoomApiError } from '../api/loom-client';

export class LoomFileSystemProvider implements vscode.FileSystemProvider {
  static readonly scheme = 'loom';

  private readonly core: LoomFsCore;
  private readonly _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._onDidChangeFile.event;

  constructor(resolveApi: (deploymentId: string) => Promise<DefinitionTransport | undefined>) {
    this.core = new LoomFsCore(resolveApi);
  }

  watch(): vscode.Disposable {
    // Definitions change server-side; refresh is explicit (Refresh / Update).
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const ref = this.parse(uri);
    if (ref.filename === undefined) {
      return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    }
    try {
      const s = await this.core.stat(uri.toString(), ref);
      return { type: vscode.FileType.File, ctime: s.mtime, mtime: s.mtime, size: s.size };
    } catch (e) {
      throw this.mapError(e, uri);
    }
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const ref = this.parse(uri);
    try {
      return await this.core.readFile(uri.toString(), ref);
    } catch (e) {
      throw this.mapError(e, uri);
    }
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const ref = this.parse(uri);
    try {
      await this.core.writeFile(uri.toString(), ref, content);
      this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    } catch (e) {
      throw this.mapError(e, uri);
    }
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const ref = this.parse(uri);
    if (ref.filename !== undefined) throw vscode.FileSystemError.FileNotADirectory(uri);
    // Items are browsed via the CSA Loom Explorer tree, not by walking `loom:`.
    return [];
  }

  createDirectory(): void {
    /* directories are implicit */
  }

  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(
      `Delete "${uri.path}" from the CSA Loom Explorer, not the filesystem.`,
    );
  }

  rename(oldUri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(
      `Rename "${oldUri.path}" from the CSA Loom Explorer, not the filesystem.`,
    );
  }

  /** Force the next read of `uri` to re-fetch from the server. */
  invalidate(uri: vscode.Uri): void {
    this.core.invalidate(uri.toString());
  }

  /** The cached ETag for a `loom:` uri (last GET/PUT). */
  etagFor(uri: vscode.Uri): string | undefined {
    return this.core.etagFor(uri.toString());
  }

  dispose(): void {
    this._onDidChangeFile.dispose();
  }

  private parse(uri: vscode.Uri): LoomRef {
    try {
      return parseLoomRef(uri.path);
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }

  private mapError(e: unknown, uri: vscode.Uri): Error {
    if (e instanceof LoomFsError) {
      switch (e.code) {
        case 'not_found':
          return vscode.FileSystemError.FileNotFound(uri);
        case 'not_signed_in':
        case 'unsupported':
        case 'bad_json':
        case 'conflict':
          return vscode.FileSystemError.NoPermissions(e.message);
        default:
          return e;
      }
    }
    if (isLoomApiError(e)) {
      if (e.status === 404) return vscode.FileSystemError.FileNotFound(uri);
      if (e.status === 412) {
        return vscode.FileSystemError.NoPermissions(
          'This definition changed on the server since you opened it. Run "CSA Loom: Update from workspace" to reconcile, then save again.',
        );
      }
      return vscode.FileSystemError.NoPermissions(`${e.message}${e.hint ? ` (${e.hint})` : ''}`);
    }
    return e instanceof Error ? e : new Error(String(e));
  }
}
