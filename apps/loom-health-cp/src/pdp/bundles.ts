// Serves the per-stamp signed Rego bundle to that stamp's OPA (ADR-011, W1-5).
// The control plane does NOT sign or build: bundles are produced and ES256-signed
// by apps/loom-health-pdp/tools/build-bundle.sh in the pipeline (the private key
// stays in Key Vault) and dropped at <dir>/<stamp>.tar.gz. This module only reads
// and hands them out, so a bundle OPA cannot verify is the pipeline's defect and
// OPA's own signature check rejects it (persist:true keeps the last good one).

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface BundleSource {
  /** Bytes of the signed bundle for a stamp id, or undefined when none was published. */
  get(stampId: string): Promise<Buffer | undefined>;
}

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
