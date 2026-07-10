/**
 * workspace-image-store — persistence for the Power BI-style workspace image.
 *
 * Where the bytes live: a SIDECAR document in the `tenant-settings` Cosmos
 * container, id=`wsimage:<workspaceId>`, partitioned by the workspace owner's
 * oid (the same partition key the workspaces container uses as `tenantId`). It
 * is DELIBERATELY not stored in the workspaces container, nor inline on the
 * workspace doc, because the workspace LIST paths issue bare `SELECT * FROM c`
 * (lib/auth/workspace-access + lib/clients/workspaces-client) — a sidecar there
 * would pollute the list, and an inline data URI would bloat every list row.
 * The tenant-settings container is only ever point-read by id, so a `wsimage:`
 * doc is invisible to those queries.
 *
 * No new Azure infrastructure and NO Fabric dependency: Cosmos is always present
 * (it is the authoritative workspace store). The workspace doc keeps only a
 * small `image` metadata pointer (lib/types/workspace WorkspaceImageMeta); the
 * bytes are served by GET /api/workspaces/[id]/image.
 *
 * Format safety: only raster image types are accepted (png/jpeg/gif/webp). SVG
 * is intentionally rejected — a stored SVG is an XSS vector when later rendered,
 * and Power BI's own workspace image accepts raster formats. Size is capped at
 * 1 MiB of raw bytes, well under the Cosmos 2 MB document limit even after
 * base64 inflation.
 */
import { tenantSettingsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceImageMeta } from '@/lib/types/workspace';

/** Max raw (decoded) image size accepted, in bytes. */
export const WORKSPACE_IMAGE_MAX_BYTES = 1024 * 1024; // 1 MiB

/** Accepted MIME types — raster only (SVG excluded for stored-XSS safety). */
export const WORKSPACE_IMAGE_CONTENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

export type WorkspaceImageContentType = (typeof WORKSPACE_IMAGE_CONTENT_TYPES)[number];

interface WorkspaceImageDoc {
  id: string;
  /** Partition key — the workspace owner's oid (workspace.tenantId). */
  tenantId: string;
  kind: 'workspace-image';
  workspaceId: string;
  contentType: WorkspaceImageContentType;
  /** Raw image bytes, base64-encoded (no `data:` prefix). */
  dataBase64: string;
  size: number;
  updatedAt: string;
  updatedBy: string;
}

function docId(workspaceId: string): string {
  return `wsimage:${workspaceId}`;
}

/** Type-guard: is a MIME string one we accept? */
export function isAllowedWorkspaceImageType(ct: string): ct is WorkspaceImageContentType {
  return (WORKSPACE_IMAGE_CONTENT_TYPES as readonly string[]).includes(ct);
}

export class WorkspaceImageError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'WorkspaceImageError';
  }
}

/**
 * Validate + persist a workspace image. `ownerOid` is the workspace's partition
 * key (workspace.tenantId). Throws WorkspaceImageError(400) on an unsupported
 * type or an over-cap payload. Returns the metadata pointer to stamp on the
 * workspace doc.
 */
export async function putWorkspaceImage(
  ownerOid: string,
  workspaceId: string,
  contentType: string,
  bytes: Buffer,
  who: string,
): Promise<WorkspaceImageMeta> {
  if (!isAllowedWorkspaceImageType(contentType)) {
    throw new WorkspaceImageError(
      `Unsupported image type "${contentType}". Allowed: ${WORKSPACE_IMAGE_CONTENT_TYPES.join(', ')} (SVG is not accepted).`,
      400,
    );
  }
  if (!bytes.length) {
    throw new WorkspaceImageError('Empty image payload.', 400);
  }
  if (bytes.length > WORKSPACE_IMAGE_MAX_BYTES) {
    throw new WorkspaceImageError(
      `Image is ${(bytes.length / 1024).toFixed(0)} KiB; the maximum is ${WORKSPACE_IMAGE_MAX_BYTES / 1024} KiB.`,
      400,
    );
  }
  const now = new Date().toISOString();
  const doc: WorkspaceImageDoc = {
    id: docId(workspaceId),
    tenantId: ownerOid,
    kind: 'workspace-image',
    workspaceId,
    contentType,
    dataBase64: bytes.toString('base64'),
    size: bytes.length,
    updatedAt: now,
    updatedBy: who,
  };
  const c = await tenantSettingsContainer();
  await c.items.upsert(doc);
  return { contentType, size: bytes.length, updatedAt: now, updatedBy: who };
}

/** Read the stored image bytes, or null when none is set. */
export async function getWorkspaceImage(
  ownerOid: string,
  workspaceId: string,
): Promise<{ contentType: string; bytes: Buffer; meta: WorkspaceImageMeta } | null> {
  const c = await tenantSettingsContainer();
  try {
    const { resource } = await c.item(docId(workspaceId), ownerOid).read<WorkspaceImageDoc>();
    if (!resource) return null;
    return {
      contentType: resource.contentType,
      bytes: Buffer.from(resource.dataBase64, 'base64'),
      meta: {
        contentType: resource.contentType,
        size: resource.size,
        updatedAt: resource.updatedAt,
        updatedBy: resource.updatedBy,
      },
    };
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

/** Remove the stored image (idempotent — a missing doc is treated as success). */
export async function deleteWorkspaceImage(ownerOid: string, workspaceId: string): Promise<void> {
  const c = await tenantSettingsContainer();
  try {
    await c.item(docId(workspaceId), ownerOid).delete();
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
}

/**
 * Decode a `data:<mime>;base64,<payload>` URI into { contentType, bytes }.
 * Throws WorkspaceImageError(400) on a malformed URI. Used by the upload route
 * for the JSON body path (multipart uploads bypass this).
 */
export function parseDataUri(dataUri: string): { contentType: string; bytes: Buffer } {
  const m = /^data:([a-z0-9.+/-]+);base64,(.*)$/is.exec(dataUri.trim());
  if (!m) {
    throw new WorkspaceImageError('Expected a base64 data URI: data:<mime>;base64,<payload>.', 400);
  }
  const contentType = m[1].toLowerCase();
  const bytes = Buffer.from(m[2], 'base64');
  return { contentType, bytes };
}
