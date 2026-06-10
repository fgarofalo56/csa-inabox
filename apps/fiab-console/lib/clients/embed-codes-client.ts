/**
 * F22 — Embed codes client (server-side).
 *
 * Azure-native equivalent of Fabric's Admin "Embed codes". An embed code is a
 * read-only USER-DELEGATION SAS URL (signed with the Console UAMI's Microsoft
 * Entra credentials — never the account key) over a small Loom embed-manifest
 * blob in the DLZ `org-visuals` Blob container. Creating a code writes the
 * manifest + mints a real, loadable signed URL; revoking DELETES the manifest
 * blob (so the URL immediately 404s) and flips the Cosmos status to `revoked`.
 *
 * No Fabric / Power BI workspace dependency. Gated only on the Azure-side
 * `LOOM_ORG_VISUALS_URL` env var (the org-visuals Blob container URL).
 */

import { randomUUID } from 'node:crypto';
import {
  uploadBlob,
  generateReadSasUrl,
  deletePath,
} from '../azure/adls-client';
import { embedCodesContainer } from '../azure/cosmos-client';
import type { EmbedCodeDoc } from '../types/embed-codes';

export const ORG_VISUALS_CONTAINER = 'org-visuals';
const SAS_TTL_HOURS = 7 * 24; // Azure user-delegation SAS max.
/** Re-mint the SAS when fewer than this many hours of validity remain. */
const REFRESH_WINDOW_HOURS = 24;

export class NotConfiguredError extends Error {
  constructor(public missingEnvVar: string) {
    super(`${missingEnvVar} is not configured`);
    this.name = 'NotConfiguredError';
  }
}

/** Parse the storage account name from LOOM_ORG_VISUALS_URL. Throws (gate) if unset. */
export function orgVisualsAccount(): string {
  const url = process.env.LOOM_ORG_VISUALS_URL;
  if (!url) throw new NotConfiguredError('LOOM_ORG_VISUALS_URL');
  const m = url.match(/^https:\/\/([^.]+)\./i);
  if (!m) throw new Error(`LOOM_ORG_VISUALS_URL is malformed: ${url}`);
  return m[1];
}

/** True when the org-visuals Blob backing is wired (env var present). */
export function isConfigured(): boolean {
  return !!process.env.LOOM_ORG_VISUALS_URL;
}

function manifestPath(tenantId: string, embedCodeId: string): string {
  return `embed-manifests/${tenantId}/${embedCodeId}.json`;
}

export async function listEmbedCodes(tenantId: string): Promise<EmbedCodeDoc[]> {
  const c = await embedCodesContainer();
  const { resources } = await c.items
    .query<EmbedCodeDoc>({
      query: 'SELECT * FROM c WHERE c.tenantId = @t ORDER BY c.createdAt DESC',
      parameters: [{ name: '@t', value: tenantId }],
    })
    .fetchAll();
  return resources || [];
}

/**
 * Create an embed code: write a real Loom embed-manifest blob, mint a loadable
 * read-only user-delegation SAS over it, and persist the record.
 */
export async function createEmbedCode(
  tenantId: string,
  who: string,
  report: string,
): Promise<EmbedCodeDoc> {
  const account = orgVisualsAccount();
  const id = randomUUID();
  const blobPath = manifestPath(tenantId, id);
  const now = new Date().toISOString();

  // The manifest is what the signed URL actually serves — real, loadable JSON
  // an embed host reads to render the named report/visual.
  const manifest = {
    kind: 'loom-embed',
    embedCodeId: id,
    tenantId,
    report,
    createdBy: who,
    createdAt: now,
  };
  await uploadBlob(
    ORG_VISUALS_CONTAINER,
    blobPath,
    Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'),
    'application/json',
    account,
  );

  const sas = await generateReadSasUrl(ORG_VISUALS_CONTAINER, blobPath, SAS_TTL_HOURS, account);

  const doc: EmbedCodeDoc = {
    id,
    tenantId,
    report,
    blobPath,
    status: 'active',
    signedUrl: sas.url,
    expiresAt: sas.expiresAt,
    createdAt: now,
    createdBy: who,
  };
  const c = await embedCodesContainer();
  await c.items.upsert(doc);
  return doc;
}

/**
 * Revoke an embed code: delete the backing manifest blob (the SAS URL then
 * 404s — real revocation) and flip Cosmos status to `revoked`.
 */
export async function revokeEmbedCode(
  tenantId: string,
  embedCodeId: string,
  who: string,
): Promise<EmbedCodeDoc> {
  const c = await embedCodesContainer();
  const { resource } = await c.item(embedCodeId, tenantId).read<EmbedCodeDoc>();
  if (!resource || resource.tenantId !== tenantId) {
    throw new Error('embed code not found');
  }
  if (resource.status === 'revoked') return resource;

  // Delete the backing blob so the signed URL stops resolving. Best-effort:
  // even if the blob is already gone, the status flip is authoritative.
  if (isConfigured()) {
    try {
      await deletePath(ORG_VISUALS_CONTAINER, resource.blobPath);
    } catch {
      /* blob already gone / transient — status flip below is the source of truth */
    }
  }

  const updated: EmbedCodeDoc = {
    ...resource,
    status: 'revoked',
    signedUrl: '',
    revokedAt: new Date().toISOString(),
    revokedBy: who,
  };
  await c.item(embedCodeId, tenantId).replace(updated);
  return updated;
}

/**
 * Lazily re-mint the SAS for any active code whose validity is within the
 * refresh window. User-delegation SAS lifetime is capped at 7 days, so a
 * long-lived embed code is kept fresh on read. Returns the (possibly updated)
 * list; persists any re-mint.
 */
export async function refreshExpiringSas(tenantId: string, codes: EmbedCodeDoc[]): Promise<EmbedCodeDoc[]> {
  if (!isConfigured()) return codes;
  const account = orgVisualsAccount();
  const c = await embedCodesContainer();
  const cutoff = Date.now() + REFRESH_WINDOW_HOURS * 60 * 60 * 1000;
  const out: EmbedCodeDoc[] = [];
  for (const code of codes) {
    if (code.status !== 'active') { out.push(code); continue; }
    const exp = Date.parse(code.expiresAt || '');
    if (Number.isFinite(exp) && exp > cutoff) { out.push(code); continue; }
    try {
      const sas = await generateReadSasUrl(ORG_VISUALS_CONTAINER, code.blobPath, SAS_TTL_HOURS, account);
      const refreshed: EmbedCodeDoc = { ...code, signedUrl: sas.url, expiresAt: sas.expiresAt };
      await c.item(code.id, tenantId).replace(refreshed);
      out.push(refreshed);
    } catch {
      out.push(code);
    }
  }
  return out;
}
