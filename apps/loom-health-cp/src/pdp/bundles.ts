// Serves the per-stamp signed Rego bundle to that stamp's OPA (ADR-011, W1-5) and signs what the pipeline
// publishes (#5422). The control plane does not BUILD bundles: apps/loom-health-pdp/tools/build-bundle.sh --unsigned
// does, and the pipeline PUTs the unsigned archive (PUT .../bundle -> CollectionBundleSource). This module SIGNS it
// with the stamp's Key Vault key (bundle-sign.ts) before storing it, then hands the signed archive out. A file dropped
// at <dir>/<stamp>.tar.gz (FileBundleSource, dev, read-only) is served as-is and must already be signed. OPA's own
// signature check against the key the PDP was deployed with is the trust decision (persist:true keeps the last good
// bundle through an outage).

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError, badRequest } from '../http/errors.js';
import type { Collection, Doc } from '../store/types.js';
import { BundleSignError, signBundle, type BundleSigner } from './bundle-sign.js';

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
 * needs no file share. The publisher uploads an UNSIGNED `opa build` archive (its sha256
 * checks the transfer); this source SIGNS it with the stamp's Key Vault key BEFORE storing,
 * so what is served is always signed by the key the PDP was deployed with. With no signer
 * configured a publish is refused (503): an unsigned bundle is never stored, because OPA
 * would refuse it and a quietly unsigned store is a control that watches nothing. OPA's own
 * signature check remains the trust decision.
 */
export class CollectionBundleSource implements BundleSource {
  constructor(
    private readonly docs: Collection<PdpBundleDoc>,
    private readonly now: () => Date = () => new Date(),
    private readonly signer?: BundleSigner,
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
    if (!this.signer) {
      throw new HttpError(503, 'bundle_signing_unconfigured', 'PDP bundle signing is not configured (LOOM_HEALTH_CP_PDP_SIGNING_KEY_ID): nothing was stored');
    }
    let signed: Buffer;
    try {
      signed = await signBundle(bytes, this.signer);
    } catch (e) {
      if (e instanceof BundleSignError) throw badRequest(e.message);
      throw new HttpError(502, 'bundle_signing_failed', 'Key Vault could not sign the bundle; nothing was stored');
    }
    const storedSha = sha256Hex(signed);
    await this.docs.upsert({
      id: stampId,
      revision: input.revision,
      sha256: storedSha,
      bundleBase64: signed.toString('base64'),
      publishedAt: this.now().toISOString(),
      publishedBy: by,
    });
    // sha256 and bytes describe the STORED (signed) archive: that is what the PDP downloads and what a read-back must equal.
    return { stampId, revision: input.revision, sha256: storedSha, bytes: signed.length };
  }
}
