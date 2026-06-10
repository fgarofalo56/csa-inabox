/**
 * Shared loader for the git-integration BFF routes: validates the session,
 * asserts the caller owns the workspace, loads the Cosmos git config, and
 * resolves the PAT from Key Vault. Returns either a ready-to-use context or a
 * NextResponse carrying the honest gate (424 no repo / 503 no KV / 424 no PAT).
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { workspacesContainer, workspaceGitContainer, itemsContainer } from '@/lib/azure/cosmos-client';
import { listAllOwnedItems } from '@/app/api/items/_lib/item-crud';
import {
  gitConfigGate,
  getPat,
  GitIntegrationError,
  type GitRepoConfig,
  type GitSerializableItem,
} from '@/lib/azure/git-integration-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export interface GitCtx {
  tenantId: string;
  upn: string;
  name: string;
  email: string;
  workspaceId: string;
  config: GitRepoConfig;
  pat: string;
}

export async function loadGitCtx(
  workspaceId: string,
): Promise<{ ctx: GitCtx } | { error: NextResponse }> {
  const s = getSession();
  if (!s) return { error: NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 }) };
  if (!workspaceId) return { error: NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 }) };

  // Ownership.
  const ws = await workspacesContainer();
  let owned = false;
  try {
    const { resource } = await ws.item(workspaceId, s.claims.oid).read<any>();
    owned = !!resource && resource.tenantId === s.claims.oid;
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
  if (!owned) return { error: NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 }) };

  // Git config.
  const gc = await workspaceGitContainer();
  let config: GitRepoConfig | null = null;
  try {
    const { resource } = await gc.item(workspaceId, workspaceId).read<GitRepoConfig>();
    config = resource || null;
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
  const gate = gitConfigGate(config);
  if (gate || !config) {
    return {
      error: NextResponse.json(
        { ok: false, gated: true, missing: gate?.missing || 'no_repo_bound', detail: gate?.detail },
        { status: 424 },
      ),
    };
  }

  // PAT from Key Vault — surfaces an honest gate if absent.
  let pat: string;
  try {
    pat = await getPat(config);
  } catch (e: any) {
    if (e instanceof GitIntegrationError) {
      return {
        error: NextResponse.json({ ok: false, gated: true, missing: e.code, detail: e.message }, { status: e.status }),
      };
    }
    throw e;
  }

  return {
    ctx: {
      tenantId: s.claims.oid,
      upn: s.claims.upn,
      name: (s.claims as any).name || s.claims.upn,
      email: (s.claims as any).email || s.claims.upn,
      workspaceId,
      config,
      pat,
    },
  };
}

/** Load the owned workspace items (optionally filtered to specific ids). */
export async function loadWorkspaceItems(
  tenantId: string,
  workspaceId: string,
  itemIds?: string[],
): Promise<GitSerializableItem[]> {
  const all: WorkspaceItem[] = await listAllOwnedItems(tenantId, workspaceId);
  const filtered = itemIds && itemIds.length > 0 ? all.filter((i) => itemIds.includes(i.id)) : all;
  return filtered.map((i) => ({
    id: i.id,
    itemType: i.itemType,
    displayName: i.displayName,
    state: i.state as any,
  }));
}

/** Persist lastSyncedSha back to the workspace-git doc (best-effort). */
export async function recordSyncSha(workspaceId: string, sha: string | null): Promise<void> {
  if (!sha) return;
  try {
    const gc = await workspaceGitContainer();
    const { resource } = await gc.item(workspaceId, workspaceId).read<any>();
    if (resource) {
      resource.lastSyncedSha = sha;
      await gc.item(workspaceId, workspaceId).replace(resource);
    }
  } catch {
    /* best-effort */
  }
}

/** Apply pulled content back to the items container (replace state.content). */
export async function applyPulledContent(
  entries: { cosmosItemId?: string; newContent: unknown }[],
  workspaceId: string,
): Promise<number> {
  if (entries.length === 0) return 0;
  const items = await itemsContainer();
  let applied = 0;
  for (const e of entries) {
    if (!e.cosmosItemId) continue;
    try {
      const { resource } = await items.item(e.cosmosItemId, workspaceId).read<WorkspaceItem>();
      if (!resource) continue;
      resource.state = { ...(resource.state || {}), content: e.newContent };
      resource.updatedAt = new Date().toISOString();
      await items.item(e.cosmosItemId, workspaceId).replace(resource);
      applied++;
    } catch {
      /* skip un-applicable item */
    }
  }
  return applied;
}

/** Map a GitIntegrationError to a structured NextResponse. */
export function gitError(e: unknown): NextResponse {
  if (e instanceof GitIntegrationError) {
    return NextResponse.json({ ok: false, gated: e.code !== 'git_error', missing: e.code, error: e.message, detail: e.message }, { status: e.status });
  }
  const msg = (e as any)?.message || String(e);
  return NextResponse.json({ ok: false, error: msg }, { status: 502 });
}
