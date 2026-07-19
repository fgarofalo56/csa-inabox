/**
 * Loom App Runtime — per-item persistence (DBX-1).
 *
 * The app's runtime config (chosen template / git source / port / env bindings),
 * the deployed Container App name + URL, and the build/deploy history are stored
 * on the loom-app-runtime item's `state.appRuntime` in Cosmos (partition =
 * workspaceId). This is the single source of truth the editor + lifecycle routes
 * read/write. All writes go through resolveItemAccessByOid at the route layer, so
 * only a caller with write access to the item can mutate it.
 */

import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import type { LoomAppEnvVar } from '@/lib/azure/loom-apps-runtime-templates';
import type { AppResource } from '@/lib/apps/app-resources';

export const LOOM_APP_RUNTIME_TYPE = 'loom-app-runtime';

export interface AppBuildRecord {
  runId: string;
  image: string;
  imageName: string;
  status: string;
  source: 'template' | 'git';
  at: string;
  by?: string;
}

export interface AppRuntimeState {
  /** Source configuration. */
  templateId?: string;
  gitSource?: string;
  /** Private-git auth (APP-W4 S3): the PAT lives in Key Vault — this holds ONLY the reference. */
  gitAuth?: { provider: string; secretName: string; setAt: string };
  /** Commit SHA the last git build was triggered from (APP-W4 S4 redeploy-on-push reconciler). */
  lastBuiltSha?: string;
  /** True to auto-build when the reconciler sees a new commit (opt-in). */
  autoRedeploy?: boolean;
  port?: number;
  /** Structured env bindings (names allowlisted at the client). */
  env?: LoomAppEnvVar[];
  /** Attached resources (APPS-W2) — each carries its grant status + env names. */
  resources?: AppResource[];
  /** Persisted user source edits (path → content). */
  userFiles?: Record<string, string>;
  /** Deployed Container App name (stable across redeploys). */
  containerAppName?: string;
  /** Last successfully built image ref. */
  image?: string;
  /** Last deployed URL. */
  url?: string;
  /** True when the Entra Easy-Auth wrapper was configured on the last deploy. */
  authConfigured?: boolean;
  /** Per-app admin disable — Stop was invoked / admin flipped it off. */
  disabled?: boolean;
  /** Build history (newest first, capped). */
  builds?: AppBuildRecord[];
  lastDeployAt?: string;
  updatedAt?: string;
  /** APIM API this app was published as (APP-W5 S3 publish-as-API). */
  publishedApiId?: string;
  publishedApiPath?: string;
}

const MAX_BUILDS = 20;

/** Read the app-runtime slice off an item (empty object when never configured). */
export function readAppRuntime(item: WorkspaceItem): AppRuntimeState {
  const s = (item.state as any)?.appRuntime;
  return (s && typeof s === 'object') ? (s as AppRuntimeState) : {};
}

/**
 * Merge a patch into the item's state.appRuntime and persist. Caps the build
 * history. Returns the updated item. The caller MUST have already authorized
 * write access (resolveItemAccessByOid → canWrite).
 */
export async function saveAppRuntime(item: WorkspaceItem, patch: Partial<AppRuntimeState>): Promise<WorkspaceItem> {
  const current = readAppRuntime(item);
  const merged: AppRuntimeState = { ...current, ...patch, updatedAt: new Date().toISOString() };
  if (merged.builds && merged.builds.length > MAX_BUILDS) merged.builds = merged.builds.slice(0, MAX_BUILDS);
  const next: WorkspaceItem = {
    ...item,
    state: { ...(item.state || {}), appRuntime: merged },
    updatedAt: new Date().toISOString(),
  };
  const items = await itemsContainer();
  const { resource } = await items.item(item.id, item.workspaceId).replace<WorkspaceItem>(next);
  return resource ?? next;
}

/** Prepend a build record to the item's history (capped). */
export async function recordBuild(item: WorkspaceItem, rec: AppBuildRecord): Promise<WorkspaceItem> {
  const current = readAppRuntime(item);
  const builds = [rec, ...(current.builds || [])].slice(0, MAX_BUILDS);
  return saveAppRuntime(item, { builds });
}
