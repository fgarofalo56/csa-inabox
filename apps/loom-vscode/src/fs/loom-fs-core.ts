/**
 * PURE core of the `loom:` FileSystemProvider (no `vscode` import) — the
 * read / write / stat logic over an item-definition transport, unit-testable
 * against a mocked route. The thin `vscode`-facing wrapper (`loom-fs-provider.ts`)
 * adapts these into `vscode.FileSystemProvider` and maps errors to
 * `vscode.FileSystemError`.
 *
 * Concurrency: the ETag from the last GET is cached per canonical URI and echoed
 * as `If-Match` on the next PUT. A 412 surfaces as a typed `conflict` error the
 * Publish command turns into a diff (N5) — never a silent clobber.
 */

import type { LoomRef } from './definition-uri';
import { encodeDefinition, decodeDefinition } from './definition-codec';

/** A definition payload as the transport returns it (GET or PUT). */
export interface DefinitionPayload {
  definition: unknown;
  etag: string;
  schemaVersion: number;
}

/**
 * The per-deployment transport the core drives. `LoomApi` implements this; a
 * test supplies a fake (or a real `LoomApi` over a mocked `fetch`).
 */
export interface DefinitionTransport {
  getDefinition(itemType: string, itemId: string): Promise<DefinitionPayload>;
  putDefinition(
    itemType: string,
    itemId: string,
    definition: unknown,
    ifMatch: string,
  ): Promise<DefinitionPayload>;
}

/** Resolve a deployment id → its authenticated transport (undefined = signed out). */
export type TransportResolver = (deploymentId: string) => Promise<DefinitionTransport | undefined>;

export type LoomFsErrorCode =
  | 'not_signed_in'
  | 'conflict'
  | 'bad_json'
  | 'unsupported'
  | 'not_found'
  | 'network';

/** A typed FS error the provider maps to the right `vscode.FileSystemError`. */
export class LoomFsError extends Error {
  constructor(
    readonly code: LoomFsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LoomFsError';
  }
}

interface CacheEntry {
  bytes: Uint8Array;
  etag: string;
  mtime: number;
}

export interface StatResult {
  size: number;
  mtime: number;
}

export class LoomFsCore {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly resolve: TransportResolver) {}

  /** stat a definition file (always reflects the latest remote). */
  async stat(key: string, ref: LoomRef): Promise<StatResult> {
    if (ref.filename === undefined) {
      throw new LoomFsError('unsupported', 'stat is only supported on a definition file');
    }
    const entry = await this.load(key, ref);
    return { size: entry.bytes.length, mtime: entry.mtime };
  }

  /** Read the definition bytes (reuses the entry a preceding stat cached). */
  async readFile(key: string, ref: LoomRef): Promise<Uint8Array> {
    const cached = this.cache.get(key);
    if (cached) return cached.bytes;
    const entry = await this.load(key, ref);
    return entry.bytes;
  }

  /** Write the edited bytes back with `If-Match`; returns the new ETag. */
  async writeFile(key: string, ref: LoomRef, bytes: Uint8Array): Promise<{ etag: string }> {
    if (ref.filename === undefined) {
      throw new LoomFsError('unsupported', 'writeFile is only supported on a definition file');
    }
    const transport = await this.transportFor(ref);
    let definition: unknown;
    try {
      definition = decodeDefinition(bytes);
    } catch {
      throw new LoomFsError('bad_json', 'The definition is not valid JSON — fix the syntax and save again.');
    }
    const ifMatch = this.cache.get(key)?.etag ?? '*';
    const payload = await transport.putDefinition(ref.itemType, ref.itemId, definition, ifMatch);
    const out = this.encode(payload.definition);
    this.cache.set(key, { bytes: out, etag: payload.etag, mtime: Date.now() });
    return { etag: payload.etag };
  }

  /** Force a re-fetch on the next read (used by the Update command). */
  invalidate(key: string): void {
    this.cache.delete(key);
  }

  /** The cached ETag for a URI (the last GET/PUT), if any. */
  etagFor(key: string): string | undefined {
    return this.cache.get(key)?.etag;
  }

  private async load(key: string, ref: LoomRef): Promise<CacheEntry> {
    const transport = await this.transportFor(ref);
    const payload = await transport.getDefinition(ref.itemType, ref.itemId);
    const entry: CacheEntry = { bytes: this.encode(payload.definition), etag: payload.etag, mtime: Date.now() };
    this.cache.set(key, entry);
    return entry;
  }

  private async transportFor(ref: LoomRef): Promise<DefinitionTransport> {
    const t = await this.resolve(ref.deploymentId);
    if (!t) {
      throw new LoomFsError(
        'not_signed_in',
        `Not signed in to ${ref.deploymentId}. Sign in from the CSA Loom Explorer, then reopen.`,
      );
    }
    return t;
  }

  private encode(definition: unknown): Uint8Array {
    return encodeDefinition(definition);
  }
}
