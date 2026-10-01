/**
 * Lakehouse "Shortcuts" registry — Azure-native parity with Microsoft Fabric
 * OneLake shortcuts, with NO Fabric dependency.
 *
 * A shortcut is a named, zero-copy pointer that surfaces external data as a
 * folder under `Files` or a table under `Tables` in the Loom lakehouse, without
 * copying bytes. The registry (this module) is the source of truth — it lives
 * in the Cosmos `lakehouse-shortcuts` container (PK `/lakehouseId`). Engine
 * objects (Synapse Serverless external tables, Databricks UC external tables)
 * are derived from a registry row and idempotently re-creatable on redeploy.
 *
 * Design: docs/fiab/design/lakehouse-shortcuts.md.
 *
 * Auth: Console UAMI via cosmos-client.ts (Cosmos DB Built-in Data Contributor).
 * Per .claude/rules/no-vaporware.md — real Cosmos reads/writes, no mock arrays.
 */

import { lakehouseShortcutsContainer } from './cosmos-client';
import { trimSlashes } from '@/lib/util/trim';
import { redactErrorText } from './shortcut-error-hygiene';

export type ShortcutTargetType = 'adls' | 'internal' | 's3' | 'gcs' | 'dataverse' | 'delta_sharing' | 'sharepoint';
export type ShortcutKind = 'files' | 'tables';
export type ShortcutEngine = 'databricks' | 'synapse' | 'none';
export type ShortcutStatus = 'active' | 'pending' | 'error';

export interface ShortcutCredentialRef {
  kind: 'uami' | 'sas' | 'accountKey' | 'servicePrincipal' | 'awsKeys' | 'gcsServiceAccount' | 'deltaSharing';
  /** Key Vault secret name holding the secret payload (non-UAMI credentials). */
  keyVaultSecret?: string;
  /** Pre-provisioned UC STORAGE CREDENTIAL name, if any. */
  storageCredentialName?: string;
}

export interface LakehouseShortcut {
  /** Deterministic id `${lakehouseId}:${kind}:${parentPath}:${name}` — re-creating the same shortcut upserts. */
  id: string;
  /** Partition key — the Loom lakehouse (container or item id). */
  lakehouseId: string;
  /** Tenant id for isolation in cross-lakehouse queries. */
  tenantId?: string;
  /** Display name (leaf shown in the Explorer). */
  name: string;
  /** Section the shortcut hangs under. */
  kind: ShortcutKind;
  /** Sub-folder under the section, '' for top-level. */
  parentPath: string;
  /** `${kind}/${parentPath}/${name}` — Explorer path. */
  fullPath: string;
  targetType: ShortcutTargetType;
  /** abfss://… | s3://… | gs://… | internal lakehouse ref. */
  targetUri: string;
  /** Resolved abfss read address for Spark / UC / Synapse (ADLS + internal). */
  abfssUri?: string;
  /** null/undefined ⇒ UAMI passthrough. */
  credentialRef?: ShortcutCredentialRef;
  /** Which engine backs Tables reads. */
  engine?: ShortcutEngine;
  /** e.g. 'shortcuts.partner_products' (Synapse) or 'loom.bronze.partner_products' (UC). */
  engineObject?: string;
  format?: 'delta' | 'parquet' | 'csv' | 'json';
  status: ShortcutStatus;
  /** Last engine error when status='error'. */
  statusDetail?: string;
  /**
   * UPN of the principal who created the row. Since the shortcut-secret
   * resolver, also WHO THE ROW'S CREDENTIAL IS RESOLVED FOR — so it is reset
   * whenever a re-create changes `credentialRef.keyVaultSecret` (see
   * {@link createShortcut}).
   */
  createdBy: string;
  /** Entra object id of `createdBy`, when the creating session carried one. */
  createdByOid?: string;
  createdAt: string;
  updatedAt: string;
}

/** Definition the BFF passes in when creating a shortcut (server fills derived + audit fields). */
export interface ShortcutDef {
  lakehouseId: string;
  tenantId?: string;
  name: string;
  kind: ShortcutKind;
  parentPath?: string;
  targetType: ShortcutTargetType;
  targetUri: string;
  abfssUri?: string;
  credentialRef?: ShortcutCredentialRef;
  engine?: ShortcutEngine;
  engineObject?: string;
  format?: LakehouseShortcut['format'];
  status?: ShortcutStatus;
  statusDetail?: string;
  createdBy: string;
  createdByOid?: string;
}

/** Sanitise a name/path segment for use in the deterministic id. */
function seg(s: string): string {
  return (s || '').replace(/[/\\#?\s]+/g, '_').replace(/^_+|_+$/g, '');
}

/** Deterministic shortcut id — re-creating the same (lakehouse, kind, path, name) upserts. */
export function shortcutId(lakehouseId: string, kind: ShortcutKind, parentPath: string, name: string): string {
  return `${seg(lakehouseId)}:${kind}:${seg(parentPath)}:${seg(name)}`;
}

/** Explorer path for a shortcut. `kind` maps to the Fabric section (Files/Tables). */
export function shortcutFullPath(kind: ShortcutKind, parentPath: string, name: string): string {
  const section = kind === 'tables' ? 'Tables' : 'Files';
  const mid = trimSlashes((parentPath || ''));
  return [section, mid, name].filter(Boolean).join('/');
}

/**
 * Rows written before `statusDetail` was redacted on write still hold the raw
 * text, so every read path redacts it again before a row leaves this module.
 */
function redactStoredDetail(row: LakehouseShortcut): LakehouseShortcut {
  return typeof row.statusDetail === 'string' ? { ...row, statusDetail: redactErrorText(row.statusDetail) } : row;
}

/** List all shortcuts for a lakehouse (single-partition query). `statusDetail` is redacted on read. */
export async function listShortcuts(lakehouseId: string): Promise<LakehouseShortcut[]> {
  const c = await lakehouseShortcutsContainer();
  const { resources } = await c.items
    .query<LakehouseShortcut>(
      {
        query: 'SELECT * FROM c WHERE c.lakehouseId = @lh ORDER BY c.createdAt DESC',
        parameters: [{ name: '@lh', value: lakehouseId }],
      },
      { partitionKey: lakehouseId },
    )
    .fetchAll();
  return resources.map(redactStoredDetail);
}

/** Read a single shortcut by id within a lakehouse. Returns null if absent. `statusDetail` is redacted on read. */
export async function getShortcut(lakehouseId: string, id: string): Promise<LakehouseShortcut | null> {
  const c = await lakehouseShortcutsContainer();
  try {
    const { resource } = await c.item(id, lakehouseId).read<LakehouseShortcut>();
    return resource ? redactStoredDetail(resource) : null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

/** A registry row that references a Key Vault secret, reduced to the fields that record who bound it. */
export interface ShortcutSecretBinding {
  lakehouseId: string;
  id: string;
  createdBy: string;
  createdByOid?: string;
  createdAt: string;
}

/**
 * Every registry row, in ANY lakehouse, whose `credentialRef.keyVaultSecret`
 * names `secretName` (Key Vault names are case-insensitive, so the comparison
 * is too). Cross-partition by design: the question is "who else has bound this
 * credential", and the answer must not depend on which lakehouse is asking.
 *
 * Returns only ownership fields — never the credentialRef or target.
 */
export async function listShortcutSecretBindings(secretName: string): Promise<ShortcutSecretBinding[]> {
  const n = (secretName || '').trim().toLowerCase();
  if (!n) return [];
  const c = await lakehouseShortcutsContainer();
  const { resources } = await c.items
    .query<ShortcutSecretBinding>({
      query:
        'SELECT c.lakehouseId, c.id, c.createdBy, c.createdByOid, c.createdAt FROM c ' +
        'WHERE IS_STRING(c.credentialRef.keyVaultSecret) AND LOWER(TRIM(c.credentialRef.keyVaultSecret)) = @n',
      parameters: [{ name: '@n', value: n }],
    })
    .fetchAll();
  return resources;
}

/** The credential name a row binds, normalised for comparison. */
function boundSecret(ref: ShortcutCredentialRef | undefined): string {
  return (ref?.keyVaultSecret || '').trim().toLowerCase();
}

/**
 * Create (upsert) a shortcut from a definition. Fills derived + audit fields.
 *
 * Row ids are deterministic, so a re-create lands on the existing row. When it
 * changes which credential the row binds, the row's creator becomes the caller
 * (`createdBy` / `createdByOid` / `createdAt` reset): the creator is who the
 * row's credential is resolved for, and keeping the previous creator would
 * resolve the new credential for someone who never saved it. The same holds
 * when the target changes (type or URI): the caller chose the new target, so
 * the row is theirs. Only a re-create that keeps both the credential and the
 * target keeps the original creator.
 *
 * `statusDetail` passes through {@link redactErrorText} before it is stored.
 */
export async function createShortcut(def: ShortcutDef): Promise<LakehouseShortcut> {
  const parentPath = trimSlashes((def.parentPath || ''));
  const id = shortcutId(def.lakehouseId, def.kind, parentPath, def.name);
  const now = new Date().toISOString();
  const existing = await getShortcut(def.lakehouseId, id);
  const keepCreator = !!existing
    && boundSecret(existing.credentialRef) === boundSecret(def.credentialRef)
    && existing.targetType === def.targetType
    && (existing.targetUri || '') === (def.targetUri || '');
  const doc: LakehouseShortcut = {
    id,
    lakehouseId: def.lakehouseId,
    tenantId: def.tenantId,
    name: def.name,
    kind: def.kind,
    parentPath,
    fullPath: shortcutFullPath(def.kind, parentPath, def.name),
    targetType: def.targetType,
    targetUri: def.targetUri,
    abfssUri: def.abfssUri,
    credentialRef: def.credentialRef,
    engine: def.engine ?? 'none',
    engineObject: def.engineObject,
    format: def.format,
    status: def.status ?? 'active',
    statusDetail: def.statusDetail === undefined ? undefined : redactErrorText(def.statusDetail),
    createdBy: keepCreator ? existing!.createdBy : def.createdBy,
    createdByOid: keepCreator ? existing!.createdByOid : def.createdByOid,
    createdAt: keepCreator ? existing!.createdAt : now,
    updatedAt: now,
  };
  const c = await lakehouseShortcutsContainer();
  const { resource } = await c.items.upsert<LakehouseShortcut>(doc);
  return resource ?? doc;
}

/** Patch a shortcut's status/statusDetail (used by the Test action). `statusDetail` is redacted before it is stored. */
export async function updateShortcutStatus(
  lakehouseId: string,
  id: string,
  status: ShortcutStatus,
  statusDetail?: string,
): Promise<LakehouseShortcut | null> {
  const existing = await getShortcut(lakehouseId, id);
  if (!existing) return null;
  const updated: LakehouseShortcut = {
    ...existing,
    status,
    statusDetail: statusDetail === undefined ? undefined : redactErrorText(statusDetail),
    updatedAt: new Date().toISOString(),
  };
  const c = await lakehouseShortcutsContainer();
  const { resource } = await c.items.upsert<LakehouseShortcut>(updated);
  return resource ?? updated;
}

/** Delete a shortcut row. NEVER touches the underlying source bytes (UC/Fabric semantics). */
export async function deleteShortcut(lakehouseId: string, id: string): Promise<{ ok: true }> {
  const c = await lakehouseShortcutsContainer();
  try {
    await c.item(id, lakehouseId).delete();
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
  return { ok: true };
}
