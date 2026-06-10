/**
 * git-binding-store — Cosmos-backed F12 Git-integration binding for a workspace.
 *
 * One doc per workspace in the `workspace-git` container (PK `/workspaceId`,
 * point-read by id = workspaceId). The PAT / SPN secret is NEVER stored here — it
 * lives in Key Vault and the doc keeps only the KV `secretRef` (same shape as
 * connections-store.ts). Reads return a `GitBindingView` with the secretRef
 * stripped (just `hasSecret: boolean`).
 *
 * This extends the legacy `/scm` binding shape (provider/branch/folder) with the
 * fields the real ADO / GitHub REST clients need (adoOrg/adoProject/repoId,
 * githubOwner/githubRepo, authMethod, secretRef, lastSync*).
 */

import {
  putKeyVaultSecret,
  deleteKeyVaultSecret,
  getKeyVaultSecretValue,
  kvSecretsConfigGate,
} from '@/lib/azure/kv-secrets-client';
import { workspaceGitContainer } from '@/lib/azure/cosmos-client';

export type GitProvider = 'ado' | 'github';
export type GitAuthMethod = 'pat' | 'spn';

export interface GitBinding {
  /** = workspaceId (point-read PK). */
  id: string;
  workspaceId: string;
  provider: GitProvider;
  // ADO
  adoOrg?: string;
  adoProject?: string;
  repoId?: string;
  repoName?: string;
  // GitHub
  githubOwner?: string;
  githubRepo?: string;
  /**
   * GitHub Enterprise host. Blank = public github.com. A `<sub>.ghe.com` value
   * targets a GitHub Enterprise Cloud data-residency tenant; any other host is
   * treated as a self-hosted GitHub Enterprise Server (REST at /api/v3).
   */
  githubHost?: string;
  // shared
  branch: string;
  folder: string;
  authMethod: GitAuthMethod;
  /** KV secret name holding the PAT or SPN client secret. Never returned to UI. */
  secretRef?: string;
  // SPN (ADO-only alternative to PAT)
  spnTenantId?: string;
  spnClientId?: string;
  status: 'connected' | 'error';
  statusDetail?: string;
  connectedBy: string;
  connectedAt: string;
  lastSyncAt?: string;
  lastSyncCommitId?: string;
  lastSyncFileCount?: number;
  lastSyncError?: string;
}

/** Public (no-secret) view for the UI. */
export type GitBindingView = Omit<GitBinding, 'secretRef'> & { hasSecret: boolean };

export function toView(b: GitBinding): GitBindingView {
  const { secretRef, ...rest } = b;
  return { ...rest, hasSecret: !!secretRef };
}

/** Internal: read the full binding (incl. secretRef) for server-side use. */
export async function loadBinding(workspaceId: string): Promise<GitBinding | null> {
  const c = await workspaceGitContainer();
  try {
    const { resource } = await c.item(workspaceId, workspaceId).read<GitBinding>();
    return resource || null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

/** Resolve the PAT/SPN secret for a binding from Key Vault. */
export async function resolveSecret(b: GitBinding): Promise<string> {
  if (!b.secretRef) throw Object.assign(new Error('No credential stored for this Git binding. Reconnect and supply a PAT.'), { status: 400 });
  return getKeyVaultSecretValue(b.secretRef);
}

export interface ConnectInput {
  workspaceId: string;
  provider: GitProvider;
  adoOrg?: string;
  adoProject?: string;
  repoId?: string;
  repoName?: string;
  githubOwner?: string;
  githubRepo?: string;
  /** GitHub Enterprise host (`<sub>.ghe.com` or GHES host). Blank = public github.com. */
  githubHost?: string;
  branch: string;
  folder?: string;
  authMethod: GitAuthMethod;
  spnTenantId?: string;
  spnClientId?: string;
  /** The PAT / SPN client secret — written to KV, never stored in Cosmos. */
  secret: string;
  connectedBy: string;
}

/**
 * Persist the binding: write the credential to Key Vault, then upsert the Cosmos
 * doc with only the KV secretRef. Fires the KV honest-gate (503) when no vault is
 * configured. The caller is expected to have already validated connectivity.
 */
export async function saveBinding(input: ConnectInput): Promise<GitBindingView> {
  const gate = kvSecretsConfigGate();
  if (gate) {
    const e: any = new Error(gate.detail);
    e.status = 503;
    e.code = 'kv_not_configured';
    e.missing = gate.missing;
    throw e;
  }
  const secretName = `loom-git-${input.workspaceId}-${input.authMethod}`;
  const { name } = await putKeyVaultSecret(secretName, input.secret);

  const now = new Date().toISOString();
  const doc: GitBinding = {
    id: input.workspaceId,
    workspaceId: input.workspaceId,
    provider: input.provider,
    adoOrg: input.adoOrg?.trim() || undefined,
    adoProject: input.adoProject?.trim() || undefined,
    repoId: input.repoId?.trim() || undefined,
    repoName: input.repoName?.trim() || undefined,
    githubOwner: input.githubOwner?.trim() || undefined,
    githubRepo: input.githubRepo?.trim() || undefined,
    githubHost: input.githubHost?.trim() || undefined,
    branch: (input.branch || 'main').trim(),
    folder: (input.folder || 'loom-workspace').trim(),
    authMethod: input.authMethod,
    secretRef: name,
    spnTenantId: input.spnTenantId?.trim() || undefined,
    spnClientId: input.spnClientId?.trim() || undefined,
    status: 'connected',
    connectedBy: input.connectedBy,
    connectedAt: now,
  };
  const c = await workspaceGitContainer();
  const { resource } = await c.items.upsert<GitBinding>(doc);
  return toView((resource as GitBinding) ?? doc);
}

/** Patch sync results onto the binding doc. */
export async function recordSync(
  workspaceId: string,
  patch: Partial<Pick<GitBinding, 'lastSyncAt' | 'lastSyncCommitId' | 'lastSyncFileCount' | 'lastSyncError' | 'status' | 'statusDetail'>>,
): Promise<void> {
  const existing = await loadBinding(workspaceId);
  if (!existing) return;
  const c = await workspaceGitContainer();
  await c.items.upsert<GitBinding>({ ...existing, ...patch });
}

/** Disconnect: soft-delete the KV secret + remove the Cosmos doc. */
export async function deleteBinding(workspaceId: string): Promise<void> {
  const existing = await loadBinding(workspaceId);
  if (existing?.secretRef) await deleteKeyVaultSecret(existing.secretRef);
  const c = await workspaceGitContainer();
  try {
    await c.item(workspaceId, workspaceId).delete();
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
}
