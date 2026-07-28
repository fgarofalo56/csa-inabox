/**
 * workspace-export — EXP1 (loom-next-level §P2, completeness gap 8): the PURE
 * serializer that turns a Cosmos `Workspace` + its item/folder/permission docs
 * into a portable `.loomws` bundle (metadata-plane portability — WS-DR proves
 * *Azure-service* restorability; this is Loom-level config portability).
 *
 * Pattern provenance: the app-scoped `.loomapp` export
 * (app/api/items/loom-app-runtime/[id]/export) — deterministic JSON, marker
 * field + version, `exportedAt`, and SECRET-SAFE by construction. `.loomws`
 * generalizes that to the whole workspace:
 *
 *   • Items export their full metadata + `state` content — but every state
 *     value whose KEY names a secret (password / connectionString / apiKey /
 *     sasToken / …) is EXCLUDED, and the exact path of every exclusion is
 *     recorded in `manifest.scrubbedPaths`. `…Ref` keys (secretRef /
 *     keyVaultSecretRef …) survive — they are REFERENCE NAMES, never values,
 *     exactly like the `.loomapp` env convention.
 *   • `state.provisioning` (the per-estate Azure backend refs an item's
 *     provisioner recorded) is EXCLUDED and listed in
 *     `manifest.provisioningExcluded`: backend refs are environment-specific,
 *     and a clone sharing its source's provisioning would point two catalog
 *     items at ONE Azure backend (a later cascade-delete of either would
 *     destroy the other's data). Imported items re-provision on demand.
 *   • Workspace-role grants export as an INFORMATIONAL `rolesManifest` only —
 *     import never auto-applies access; the target workspace's owner controls
 *     who gets in.
 *
 * PURE module: no Cosmos / network imports — the server-side collector that
 * feeds it real docs lives in ./workspace-bundle-io.ts. MIG1: each item row
 * carries its `schemaVersion` (absent = 1 by convention) so an importer can
 * run the registered `migrateOnRead` chain if the shape has moved on.
 *
 * Cloud-invariant metadata; the bundle downloads through the caller's session
 * (browser), so IL5 estates keep it in-boundary. No Fabric dependency.
 */

import type { Workspace, WorkspaceItem, WorkspaceFolder } from '@/lib/types/workspace';

/** `.loomws` format marker/version (bump on breaking bundle-shape changes). */
export const LOOMWS_VERSION = 1 as const;

/** The runtime kill-switch id gating the whole EXP1 surface (FLAG0). */
export const WORKSPACE_PORTABILITY_FLAG = 'exp1-workspace-portability';

/** The explicit manifest note shipped in EVERY bundle (spec: secrets excluded
 * with an explicit manifest note). */
export const SECRETS_EXCLUDED_NOTE =
  'Secrets are NEVER exported: state values under secret-named keys (password, connection string, ' +
  'API key, SAS/account key, client secret, token, …) were excluded from this bundle — see ' +
  'manifest.scrubbedPaths for the exact paths. Key Vault secret REFERENCE names (…Ref) are kept: ' +
  'they are pointers, not values, and must be re-pointed at the importing estate\'s own vault. ' +
  'Per-estate provisioning state (Azure backend resource refs) is also excluded — imported items ' +
  're-provision against the target estate on demand (see manifest.provisioningExcluded).';

/** One exported folder (relationship graph preserved via parent). */
export interface LoomWsFolder {
  id: string;
  name: string;
  parent: string | null;
}

/** One exported item: metadata + scrubbed content state. */
export interface LoomWsItem {
  id: string;
  itemType: string;
  displayName: string;
  description?: string;
  folderId: string | null;
  /** MIG1 doc schema version (absent on the doc = 1 by convention). */
  schemaVersion: number;
  state: Record<string, unknown>;
}

/** One informational role grant (NOT auto-applied on import). */
export interface LoomWsRoleGrant {
  upn: string;
  role: string;
  name?: string;
}

/** The explicit exclusions manifest. */
export interface LoomWsManifest {
  itemCount: number;
  folderCount: number;
  roleCount: number;
  /** Always true — the bundle format never carries secret values. */
  secretsExcluded: true;
  secretsNote: string;
  /** `items/<itemId>/state/<dot.path>` for every excluded secret value. */
  scrubbedPaths: string[];
  /** Item ids whose `state.provisioning` backend refs were excluded. */
  provisioningExcluded: string[];
}

/** Non-secret workspace config carried by the bundle. */
export interface LoomWsWorkspaceConfig {
  name: string;
  description?: string;
  capacity?: string;
  domain?: string;
  licenseMode?: string;
  contacts?: string[];
}

/** The portable `.loomws` bundle. */
export interface LoomWsBundle {
  loomws: typeof LOOMWS_VERSION;
  exportedAt: string;
  exportedBy: string;
  source: { workspaceId: string; name: string };
  workspace: LoomWsWorkspaceConfig;
  folders: LoomWsFolder[];
  items: LoomWsItem[];
  /** Informational only — import never applies these grants. */
  rolesManifest: LoomWsRoleGrant[];
  manifest: LoomWsManifest;
}

/**
 * Key names whose STRING values are secret material. Mirrors the DIAG1
 * support-bundle redactor's key family, structured (per-key) instead of
 * text-stream. A key is only scrubbed when it does NOT look like a reference
 * name (see SECRET_REF_KEY_RE) — `secretRef` etc. export verbatim, exactly
 * like the `.loomapp` env convention.
 */
const SECRET_KEY_RE =
  /(secret|password|passwd|credential|accountkey|account_key|apikey|api_key|connectionstring|connection_string|sastoken|sas_token|sharedaccesskey|shared_access_key|primarykey|primary_key|clientsecret|client_secret|accesstoken|access_token|bearertoken|bearer_token|privatekey|private_key)/i;

/** Reference-name keys (pointers into a vault — safe to export). */
const SECRET_REF_KEY_RE = /ref(erence)?(name)?$/i;

/** Recursion bound for pathological state blobs. */
const MAX_SCRUB_DEPTH = 32;

/**
 * Deep-copy `value`, EXCLUDING every property whose key names a secret (and is
 * not a `…Ref` reference name). Excluded paths are appended to `out` as
 * `<prefix>/<dot.path>`. Non-object leaves pass through untouched.
 */
export function scrubSecrets(
  value: unknown,
  pathPrefix: string,
  out: string[],
  depth = 0,
): unknown {
  if (depth > MAX_SCRUB_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((v, i) => scrubSecrets(v, `${pathPrefix}.${i}`, out, depth + 1));
  }
  const src = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (SECRET_KEY_RE.test(k) && !SECRET_REF_KEY_RE.test(k)) {
      out.push(`${pathPrefix}.${k}`);
      continue; // excluded — recorded in the manifest, never carried
    }
    next[k] = scrubSecrets(v, `${pathPrefix}.${k}`, out, depth + 1);
  }
  return next;
}

/** Raw permission row shape (Cosmos `workspace-permissions` docs). */
export interface WorkspacePermissionRow {
  upn: string;
  role: string;
  name?: string;
}

/**
 * PURE bundle builder: `Workspace` + item/folder/permission docs → `.loomws`.
 * Deterministic apart from `exportedAt` (injectable via `opts.now` for tests).
 */
export function buildWorkspaceBundle(
  workspace: Workspace,
  items: WorkspaceItem[],
  folders: WorkspaceFolder[],
  roles: WorkspacePermissionRow[],
  opts: { exportedBy: string; now?: string },
): LoomWsBundle {
  const scrubbedPaths: string[] = [];
  const provisioningExcluded: string[] = [];

  const bundleItems: LoomWsItem[] = items.map((it) => {
    const rawState = (it.state ?? {}) as Record<string, unknown>;
    // Per-estate backend refs never travel (see module doc).
    const { provisioning, ...portableState } = rawState;
    if (provisioning !== undefined) provisioningExcluded.push(it.id);
    const state = scrubSecrets(portableState, `items/${it.id}/state`, scrubbedPaths) as Record<string, unknown>;
    return {
      id: it.id,
      itemType: it.itemType,
      displayName: it.displayName,
      ...(it.description ? { description: it.description } : {}),
      folderId: it.folderId ?? null,
      schemaVersion:
        typeof (it as { schemaVersion?: unknown }).schemaVersion === 'number'
          ? ((it as { schemaVersion?: number }).schemaVersion as number)
          : 1,
      state,
    };
  });

  const bundleFolders: LoomWsFolder[] = folders.map((f) => ({
    id: f.id,
    name: f.name,
    parent: f.parent ?? null,
  }));

  const rolesManifest: LoomWsRoleGrant[] = roles
    .filter((r) => typeof r.upn === 'string' && r.upn && typeof r.role === 'string' && r.role)
    .map((r) => ({ upn: r.upn, role: r.role, ...(r.name ? { name: r.name } : {}) }));

  return {
    loomws: LOOMWS_VERSION,
    exportedAt: opts.now ?? new Date().toISOString(),
    exportedBy: opts.exportedBy,
    source: { workspaceId: workspace.id, name: workspace.name },
    workspace: {
      name: workspace.name,
      ...(workspace.description ? { description: workspace.description } : {}),
      ...(workspace.capacity ? { capacity: workspace.capacity } : {}),
      ...(workspace.domain ? { domain: workspace.domain } : {}),
      ...(workspace.licenseMode ? { licenseMode: workspace.licenseMode } : {}),
      ...(workspace.contacts?.length ? { contacts: [...workspace.contacts] } : {}),
    },
    folders: bundleFolders,
    items: bundleItems,
    rolesManifest,
    manifest: {
      itemCount: bundleItems.length,
      folderCount: bundleFolders.length,
      roleCount: rolesManifest.length,
      secretsExcluded: true,
      secretsNote: SECRETS_EXCLUDED_NOTE,
      scrubbedPaths,
      provisioningExcluded,
    },
  };
}

/** Download filename for a bundle (mirrors the `.loomapp` convention). */
export function loomwsFilename(workspaceName: string): string {
  return `${encodeURIComponent(workspaceName || 'workspace')}.loomws`;
}
