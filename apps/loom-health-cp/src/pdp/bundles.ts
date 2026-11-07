// Serves the per-stamp signed Rego bundle to that stamp's OPA (ADR-011, W1-5).
// The control plane does NOT sign or build: bundles are produced and ES256-signed
// by apps/loom-health-pdp/tools/build-bundle.sh in the pipeline (the private key
// stays in Key Vault) and published here (PUT .../bundle -> CollectionBundleSource,
// or a file dropped at <dir>/<stamp>.tar.gz). This module only stores and hands them
// out, so a bundle OPA cannot verify is the pipeline's defect and OPA's own
// signature check rejects it (persist:true keeps the last good one).

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError, badRequest } from '../http/errors.js';
import type { Collection, Doc } from '../store/types.js';

export interface PublishedBundle {
  stampId: string;
  revision: string;
  sha256: string;
  bytes: number;
}

export interface PublishInput {
  revision: string;
  /** Lowercase hex sha256 the publisher computed over the tarball bytes. */
  sha256: string;
  bundleBase64: string;
}

export interface BundleSource {
  /** Bytes of the signed bundle for a stamp id, or undefined when none was published. */
  get(stampId: string): Promise<Buffer | undefined>;
  /** Publish a pipeline-built bundle. Absent on read-only sources (the file dir). */
  put?(stampId: string, input: PublishInput, by: string): Promise<PublishedBundle>;
}

/** One document per stamp in health-pdp-bundles. A signed bundle is ~10 KB; Cosmos allows 2 MB. */
export interface PdpBundleDoc extends Doc {
  revision: string;
  sha256: string;
  bundleBase64: string;
  publishedAt: string;
  publishedBy: string;
}

/** Cap on the tarball. The HTTP body limit (64 KiB; base64 inflates by 4/3) is the real bound. */
export const MAX_BUNDLE_BYTES = 40 * 1024;
const REVISION = /^[A-Za-z0-9._-]{1,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

const STAMP_ID = /^[a-z0-9-]{2,40}$/;

export class FileBundleSource implements BundleSource {
  constructor(private readonly dir: string) {}
  async get(stampId: string): Promise<Buffer | undefined> {
    if (!STAMP_ID.test(stampId)) return undefined; // never builds a path from unvetted text
    try {
      return await readFile(join(this.dir, `${stampId}.tar.gz`));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
  }
}

export const isGzip = (b: Buffer): boolean => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

export const bundleEtag = (b: Buffer): string => `"${createHash('sha256').update(b).digest('hex')}"`;

const sha256Hex = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/**
 * Bundles published through the control plane, stored in Cosmos so a deployed stamp
 * needs no file share. It checks the bytes are the gzip tarball the publisher hashed;
 * OPA's own signature check, against the key the PDP was deployed with, decides
 * whether the bundle is trusted.
 */
export class CollectionBundleSource implements BundleSource {
  constructor(
    private readonly docs: Collection<PdpBundleDoc>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(stampId: string): Promise<Buffer | undefined> {
    const doc = await this.docs.get(stampId);
    if (!doc) return undefined;
    const bytes = Buffer.from(doc.bundleBase64, 'base64');
    // Re-checked on every read: a damaged document is never handed to OPA.
    if (sha256Hex(bytes) !== doc.sha256) {
      throw new HttpError(502, 'bundle_invalid', 'stored bundle does not match its recorded sha256');
    }
    return bytes;
  }

  async put(stampId: string, input: PublishInput, by: string): Promise<PublishedBundle> {
    if (!REVISION.test(input.revision)) throw badRequest('revision must be 1-64 chars of A-Z a-z 0-9 . _ -');
    if (!SHA256.test(input.sha256)) throw badRequest('sha256 must be 64 lowercase hex chars');
    const bytes = Buffer.from(input.bundleBase64, 'base64');
    if (bytes.length === 0) throw badRequest('bundleBase64 is empty or not base64');
    if (bytes.length > MAX_BUNDLE_BYTES) throw badRequest(`bundle is ${bytes.length} bytes; the limit is ${MAX_BUNDLE_BYTES}`);
    if (!isGzip(bytes)) throw badRequest('bundle is not a gzip tarball');
    const actual = sha256Hex(bytes);
    if (actual !== input.sha256) throw badRequest('sha256 does not match the bundle bytes');
    await this.docs.upsert({
      id: stampId,
      revision: input.revision,
      sha256: actual,
      bundleBase64: input.bundleBase64,
      publishedAt: this.now().toISOString(),
      publishedBy: by,
    });
    return { stampId, revision: input.revision, sha256: actual, bytes: bytes.length };
  }
}
