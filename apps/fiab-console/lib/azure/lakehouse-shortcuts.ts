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

export type ShortcutTargetType = 'adls' | 'internal' | 's3' | 'gcs' | 'dataverse' | 'delta_sharing';
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
  createdBy: string;
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
  const mid = (parentPath || '').replace(/^\/+|\/+$/g, '');
  return [section, mid, name].filter(Boolean).join('/');
}

/** List all shortcuts for a lakehouse (single-partition query). */
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
  return resources;
}

/** Read a single shortcut by id within a lakehouse. Returns null if absent. */
export async function getShortcut(lakehouseId: string, id: string): Promise<LakehouseShortcut | null> {
  const c = await lakehouseShortcutsContainer();
  try {
    const { resource } = await c.item(id, lakehouseId).read<LakehouseShortcut>();
    return resource ?? null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

/** Create (upsert) a shortcut from a definition. Fills derived + audit fields. */
export async function createShortcut(def: ShortcutDef): Promise<LakehouseShortcut> {
  const parentPath = (def.parentPath || '').replace(/^\/+|\/+$/g, '');
  const id = shortcutId(def.lakehouseId, def.kind, parentPath, def.name);
  const now = new Date().toISOString();
  const existing = await getShortcut(def.lakehouseId, id);
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
    statusDetail: def.statusDetail,
    createdBy: existing?.createdBy ?? def.createdBy,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const c = await lakehouseShortcutsContainer();
  const { resource } = await c.items.upsert<LakehouseShortcut>(doc);
  return resource ?? doc;
}

/** Patch a shortcut's status/statusDetail (used by the Test action). */
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
    statusDetail: statusDetail,
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
