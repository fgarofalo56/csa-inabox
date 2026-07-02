/**
 * git-integration-client — F12 Git integration, Azure-native parity with the
 * Fabric workspace "Git integration" experience.
 *
 * Pure REST client for **Azure DevOps** (dev.azure.com) and **GitHub**
 * (api.github.com). No Azure SDK, no Cosmos, no Key Vault import — the caller
 * resolves the PAT from Key Vault (via kv-secrets-client) and passes it in, so
 * every function here is unit-testable without the credential chain (mirrors the
 * no-SDK fetch pattern used by kv-secrets-client.ts).
 *
 * Per .claude/rules/no-vaporware.md every function calls the REAL service REST.
 * Per .claude/rules/no-fabric-dependency.md this is 100% Azure-native: ADO is the
 * default control surface in every cloud; GitHub is offered in Commercial/GCC and
 * honestly gated off in GCC-High/IL5 (no FedRAMP-High authorization) via
 * githubCloudGate(). No Fabric / Power BI / OneLake host is ever contacted.
 *
 * Connecting workspace items to source control:
 *   - "Sync" serializes every WorkspaceItem to a deterministic `*.item.json`
 *     blob and commits the whole tree in one atomic push (ADO push / GitHub Git
 *     Data API), then the binding records the real commit SHA returned by the
 *     service — that SHA is the no-vaporware receipt.
 *
 * Sovereign-cloud note: Azure DevOps Services has NO Government endpoint — every
 * customer (including federal) authenticates against `dev.azure.com`. GitHub has
 * no FedRAMP-High offering, so it is hidden in GCC-High / IL5.
 */

import { detectLoomCloud } from '@/lib/azure/cloud-endpoints';
import type { WorkspaceItem } from '@/lib/types/workspace';

const ADO_BASE = 'https://dev.azure.com';
const GH_BASE = 'https://api.github.com';
const ADO_API = '7.1';
/** All-zero object id — ADO's sentinel for "create this ref" (new branch). */
export const ADO_ZERO_OBJECT_ID = '0000000000000000000000000000000000000000';

export class GitIntegrationError extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status = 500) {
    super(message);
    this.name = 'GitIntegrationError';
    this.code = code;
    this.status = status;
  }
}

// ===========================================================================
// Shared serializer (pure — unit-testable)
// ===========================================================================

/** Normalize a repo folder: strip leading/trailing slashes, default when blank. */
export function normalizeFolder(folder: string | undefined | null): string {
  const f = (folder || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  return f || 'loom-workspace';
}

/**
 * Deterministic JSON serialization of a workspace item for Git. Stable key order
 * + 2-space indent so re-syncing an unchanged item produces a byte-identical blob
 * (no spurious commits). Private Cosmos plumbing is intentionally excluded.
 */
export function serializeItem(item: WorkspaceItem): string {
  const doc = {
    loomVersion: '1',
    id: item.id,
    workspaceId: item.workspaceId,
    itemType: item.itemType,
    displayName: item.displayName,
    description: item.description ?? null,
    folderId: item.folderId ?? null,
    state: item.state ?? {},
    createdBy: item.createdBy,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
  return JSON.stringify(doc, null, 2) + '\n';
}

/** Repo-relative path for an item blob: `{folder}/{itemType}/{id}.item.json`. */
export function itemFilePath(folder: string | undefined, item: WorkspaceItem): string {
  const base = normalizeFolder(folder);
  // Drop dots too (not just slashes) so a hostile itemType can never form a
  // `..` path-traversal segment — real item types never contain dots.
  const type = (item.itemType || 'item').replace(/[^A-Za-z0-9_-]/g, '-');
  return `${base}/${type}/${item.id}.item.json`;
}

/** Repo-relative path for the workspace manifest: `{folder}/.loom/workspace.json`. */
export function workspaceManifestPath(folder: string | undefined): string {
  return `${normalizeFolder(folder)}/.loom/workspace.json`;
}

export interface WorkspaceManifest {
  loomVersion: string;
  id: string;
  name: string;
  description?: string | null;
  tenantId?: string | null;
  syncedAt: string;
  itemCount: number;
}

export function serializeManifest(m: WorkspaceManifest): string {
  return JSON.stringify(m, null, 2) + '\n';
}

/** A file to write in a sync push. `path` is repo-relative (no leading slash). */
export interface SyncFile {
  path: string;
  content: string;
}

export interface GitCommitStatus {
  commitId: string;
  commitDate?: string;
  authorName?: string;
  comment?: string;
}

// ===========================================================================
// Azure DevOps
// ===========================================================================

/** ADO Basic-auth header value for a PAT (empty username + `:` + PAT). Pure. */
export function adoBasicAuth(pat: string): string {
  return 'Basic ' + Buffer.from(':' + (pat || ''), 'utf-8').toString('base64');
}

async function adoFetch(url: string, pat: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        authorization: adoBasicAuth(pat),
        'content-type': 'application/json',
        accept: 'application/json',
        ...(init?.headers || {}),
      },
      cache: 'no-store',
    });
  } catch (e: any) {
    throw new GitIntegrationError(`Azure DevOps unreachable: ${e?.message || e}`, 'ado_unreachable', 502);
  }
  return res;
}

async function adoJson<T>(res: Response, what: string): Promise<T> {
  if (res.status === 401 || res.status === 403) {
    throw new GitIntegrationError(
      `Azure DevOps rejected the PAT (${res.status}) for ${what}. Confirm the token has Code (Read & Write) scope and has not expired.`,
      'ado_auth',
      res.status,
    );
  }
  if (res.status === 404) {
    throw new GitIntegrationError(`Azure DevOps resource not found (404) for ${what}.`, 'ado_not_found', 404);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new GitIntegrationError(`Azure DevOps ${what} failed (${res.status}): ${body.slice(0, 300)}`, 'ado_error', res.status);
  }
  return (await res.json()) as T;
}

export interface AdoProject { id: string; name: string; description?: string; }
export interface AdoRepo { id: string; name: string; defaultBranch?: string; webUrl?: string; }
export interface AdoBranch { name: string; objectId: string; }

export async function adoListProjects(org: string, pat: string): Promise<AdoProject[]> {
  const res = await adoFetch(`${ADO_BASE}/${encodeURIComponent(org)}/_apis/projects?$top=500&api-version=${ADO_API}`, pat);
  const j = await adoJson<{ value: AdoProject[] }>(res, 'list projects');
  return (j.value || []).map((p) => ({ id: p.id, name: p.name, description: p.description }));
}

export async function adoListRepos(org: string, project: string, pat: string): Promise<AdoRepo[]> {
  const res = await adoFetch(
    `${ADO_BASE}/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories?api-version=${ADO_API}`,
    pat,
  );
  const j = await adoJson<{ value: any[] }>(res, 'list repositories');
  return (j.value || []).map((r) => ({
    id: r.id,
    name: r.name,
    defaultBranch: (r.defaultBranch || '').replace(/^refs\/heads\//, '') || undefined,
    webUrl: r.webUrl,
  }));
}

export async function adoListBranches(org: string, project: string, repoId: string, pat: string): Promise<AdoBranch[]> {
  const res = await adoFetch(
    `${ADO_BASE}/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repoId)}/refs?filter=heads/&api-version=${ADO_API}`,
    pat,
  );
  const j = await adoJson<{ value: { name: string; objectId: string }[] }>(res, 'list branches');
  return (j.value || []).map((b) => ({ name: b.name.replace(/^refs\/heads\//, ''), objectId: b.objectId }));
}

/**
 * Tip object-id of a branch, or ADO_ZERO_OBJECT_ID when the branch does not yet
 * exist (so the caller pushes with `oldObjectId: zero` to CREATE the branch).
 */
export async function adoGetBranchTip(org: string, project: string, repoId: string, branch: string, pat: string): Promise<string> {
  const res = await adoFetch(
    `${ADO_BASE}/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repoId)}/refs?filter=${encodeURIComponent('heads/' + branch)}&api-version=${ADO_API}`,
    pat,
  );
  const j = await adoJson<{ value: { name: string; objectId: string }[] }>(res, 'get branch tip');
  const exact = (j.value || []).find((r) => r.name === `refs/heads/${branch}`);
  return exact?.objectId || ADO_ZERO_OBJECT_ID;
}

/**
 * Set of repo-relative blob paths (no leading slash) that already exist under
 * `folder` on `branch`. Used to mark each change `edit` vs `add` in the push.
 * Missing folder (404) → empty set (first sync into a fresh directory).
 */
export async function adoExistingPaths(
  org: string, project: string, repoId: string, branch: string, folder: string, pat: string,
): Promise<Set<string>> {
  const scope = '/' + normalizeFolder(folder);
  const url =
    `${ADO_BASE}/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repoId)}` +
    `/items?scopePath=${encodeURIComponent(scope)}&recursionLevel=Full` +
    `&versionDescriptor.version=${encodeURIComponent(branch)}&versionDescriptor.versionType=branch&api-version=${ADO_API}`;
  const res = await adoFetch(url, pat);
  if (res.status === 404) return new Set();
  const j = await adoJson<{ value: { path: string; gitObjectType?: string; isFolder?: boolean }[] }>(res, 'list folder');
  const out = new Set<string>();
  for (const it of j.value || []) {
    if (it.isFolder || it.gitObjectType === 'tree') continue;
    out.add((it.path || '').replace(/^\/+/, ''));
  }
  return out;
}

export interface AdoPushArgs {
  org: string;
  project: string;
  repoId: string;
  branch: string;
  /** Tip object-id (use ADO_ZERO_OBJECT_ID to create the branch). */
  oldObjectId: string;
  files: SyncFile[];
  /** Repo-relative paths that already exist (mark `edit`); others are `add`. */
  existing: Set<string>;
  comment: string;
  pat: string;
}

/** Atomic multi-file commit (ADO push). Returns the new commit id. */
export async function adoPushFiles(args: AdoPushArgs): Promise<GitCommitStatus> {
  const changes = args.files.map((f) => {
    const rel = f.path.replace(/^\/+/, '');
    return {
      changeType: args.existing.has(rel) ? 'edit' : 'add',
      item: { path: '/' + rel },
      newContent: { content: f.content, contentType: 'rawtext' },
    };
  });
  const body = {
    refUpdates: [{ name: `refs/heads/${args.branch}`, oldObjectId: args.oldObjectId }],
    commits: [{ comment: args.comment, changes }],
  };
  const res = await adoFetch(
    `${ADO_BASE}/${encodeURIComponent(args.org)}/${encodeURIComponent(args.project)}/_apis/git/repositories/${encodeURIComponent(args.repoId)}/pushes?api-version=${ADO_API}`,
    args.pat,
    { method: 'POST', body: JSON.stringify(body) },
  );
  const j = await adoJson<{ commits: { commitId: string }[] }>(res, 'push commit');
  const commitId = j.commits?.[0]?.commitId;
  if (!commitId) throw new GitIntegrationError('Azure DevOps push returned no commit id.', 'ado_no_commit', 502);
  return { commitId, comment: args.comment };
}

/**
 * Create a new branch ref at an existing commit (Fabric "Branch out to another
 * workspace" — real Azure DevOps Git Data API). POSTs a ref-update with
 * `oldObjectId = zero` (create) and `newObjectId = fromObjectId` (the tip the
 * new branch points at). Throws a clean 409 when the branch already exists.
 */
export async function adoCreateBranch(
  org: string, project: string, repoId: string, newBranch: string, fromObjectId: string, pat: string,
): Promise<{ name: string; objectId: string }> {
  if (!fromObjectId || fromObjectId === ADO_ZERO_OBJECT_ID) {
    throw new GitIntegrationError(
      'The source branch has no commits to branch from. Sync the workspace to Git first, then branch out.',
      'ado_no_source_commit', 409,
    );
  }
  const body = [{ name: `refs/heads/${newBranch}`, oldObjectId: ADO_ZERO_OBJECT_ID, newObjectId: fromObjectId }];
  const res = await adoFetch(
    `${ADO_BASE}/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repoId)}/refs?api-version=${ADO_API}`,
    pat,
    { method: 'POST', body: JSON.stringify(body) },
  );
  const j = await adoJson<{ value: { success?: boolean; updateStatus?: string; customMessage?: string; name?: string; newObjectId?: string }[] }>(res, 'create branch');
  const r = j.value?.[0];
  if (!r || r.success === false) {
    const detail = r?.customMessage || r?.updateStatus || 'unknown';
    const already = /exist/i.test(detail);
    throw new GitIntegrationError(
      already ? `Branch "${newBranch}" already exists in the repository.` : `Azure DevOps refused the branch create: ${detail}.`,
      already ? 'branch_exists' : 'ado_branch_failed',
      already ? 409 : 502,
    );
  }
  return { name: (r.name || `refs/heads/${newBranch}`).replace(/^refs\/heads\//, ''), objectId: r.newObjectId || fromObjectId };
}

export async function adoLastCommit(org: string, project: string, repoId: string, branch: string, pat: string): Promise<GitCommitStatus | null> {
  const url =
    `${ADO_BASE}/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repoId)}` +
    `/commits?searchCriteria.itemVersion.version=${encodeURIComponent(branch)}&searchCriteria.itemVersion.versionType=branch&searchCriteria.$top=1&api-version=${ADO_API}`;
  const res = await adoFetch(url, pat);
  if (res.status === 404) return null;
  const j = await adoJson<{ value: any[] }>(res, 'last commit');
  const c = j.value?.[0];
  if (!c) return null;
  return { commitId: c.commitId, commitDate: c.author?.date || c.committer?.date, authorName: c.author?.name, comment: c.comment };
}

// ===========================================================================
// GitHub  (Commercial / GCC only — hidden in GCC-High / IL5)
// ===========================================================================

/**
 * Honest cloud gate for GitHub. GitHub has no FedRAMP-High / IL5 authorization,
 * so it is unavailable in GCC-High / DoD. Returns an error (caller throws / 503s)
 * in those clouds, `null` in Commercial / GCC where GitHub is reachable.
 */
export function githubCloudGate(): GitIntegrationError | null {
  const cloud = detectLoomCloud();
  if (cloud === 'GCC-High' || cloud === 'DoD') {
    return new GitIntegrationError(
      'GitHub is not available in GCC-High / IL5 deployments (no FedRAMP-High authorization). ' +
        'Use Azure DevOps — it operates on commercial endpoints and is available in every Loom cloud boundary.',
      'github_not_in_cloud',
      503,
    );
  }
  return null;
}

/** True when GitHub may be offered in the active cloud boundary. */
export function githubAvailable(): boolean {
  return githubCloudGate() === null;
}

/**
 * Resolve the GitHub REST API base for a host value. This treats GitHub
 * Enterprise Cloud **with data residency** (`<subdomain>.ghe.com`) as part of
 * the SAME GitHub provider — not a new one — exactly as Fabric does. All Git
 * Integration REST calls use identical paths on both hosts.
 *
 *   - empty / `github.com` / `api.github.com`  → `https://api.github.com`
 *   - a ghe.com tenant (any of: bare subdomain `octocorp`, `octocorp.ghe.com`,
 *     `https://octocorp.ghe.com`, or a full repo URL
 *     `https://octocorp.ghe.com/org/repo`) → `https://api.<subdomain>.ghe.com`
 *
 * The ghe.com data-residency REST host is `api.<subdomain>.ghe.com` (NOT the
 * GitHub-Enterprise-Server `/<host>/api/v3` shape) — confirmed via the GitHub
 * Enterprise Cloud data-residency quickstart. Scheme/path are stripped
 * defensively so a pasted URL or bare subdomain both resolve correctly.
 */
export function githubApiBase(host?: string): string {
  const raw = (host || '').trim();
  if (!raw) return GH_BASE;
  // Strip scheme and everything from the first slash (path), lowercase the host.
  const hostOnly = raw.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  if (!hostOnly || hostOnly === 'github.com' || hostOnly === 'api.github.com') return GH_BASE;
  // Derive the data-residency subdomain.
  let sub: string;
  if (hostOnly.endsWith('.ghe.com')) {
    sub = hostOnly.slice(0, -'.ghe.com'.length).replace(/^api\./, '');
  } else {
    sub = hostOnly; // a bare subdomain like "octocorp"
  }
  sub = sub.replace(/[^a-z0-9-]/g, '');
  if (!sub) return GH_BASE;
  return `https://api.${sub}.ghe.com`;
}

async function ghFetch(url: string, pat: string, init?: RequestInit): Promise<Response> {
  const gate = githubCloudGate();
  if (gate) throw gate;
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${pat}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'csa-loom-git-integration',
        ...(init?.headers || {}),
      },
      cache: 'no-store',
    });
  } catch (e: any) {
    throw new GitIntegrationError(`GitHub unreachable: ${e?.message || e}`, 'github_unreachable', 502);
  }
  return res;
}

async function ghJson<T>(res: Response, what: string): Promise<T> {
  if (res.status === 401 || res.status === 403) {
    throw new GitIntegrationError(
      `GitHub rejected the token (${res.status}) for ${what}. Confirm the PAT has \`repo\` scope and has not expired.`,
      'github_auth',
      res.status,
    );
  }
  if (res.status === 404) {
    throw new GitIntegrationError(`GitHub resource not found (404) for ${what}.`, 'github_not_found', 404);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new GitIntegrationError(`GitHub ${what} failed (${res.status}): ${body.slice(0, 300)}`, 'github_error', res.status);
  }
  return (await res.json()) as T;
}

export interface GhRepo { fullName: string; owner: string; name: string; defaultBranch?: string; htmlUrl?: string; }
export interface GhBranch { name: string; sha: string; }

/**
 * List repositories the token can write. When `ownerOrOrg` is blank we list the
 * authenticated user's repos; otherwise the org's repos. `base` selects the host
 * (github.com by default, or `api.<sub>.ghe.com` for an Enterprise Cloud tenant).
 */
export async function githubListRepos(ownerOrOrg: string, pat: string, base: string = GH_BASE): Promise<GhRepo[]> {
  const owner = (ownerOrOrg || '').trim();
  const url = owner
    ? `${base}/orgs/${encodeURIComponent(owner)}/repos?per_page=100&sort=full_name`
    : `${base}/user/repos?per_page=100&sort=full_name&affiliation=owner,collaborator,organization_member`;
  const res = await ghFetch(url, pat);
  const j = await ghJson<any[]>(res, 'list repositories');
  return (j || []).map((r) => ({
    fullName: r.full_name,
    owner: r.owner?.login,
    name: r.name,
    defaultBranch: r.default_branch,
    htmlUrl: r.html_url,
  }));
}

export async function githubListBranches(owner: string, repo: string, pat: string, base: string = GH_BASE): Promise<GhBranch[]> {
  const res = await ghFetch(`${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`, pat);
  const j = await ghJson<any[]>(res, 'list branches');
  return (j || []).map((b) => ({ name: b.name, sha: b.commit?.sha }));
}

/** Branch tip commit SHA, or null when the branch does not exist yet. */
export async function githubGetBranchSha(owner: string, repo: string, branch: string, pat: string, base: string = GH_BASE): Promise<string | null> {
  const res = await ghFetch(
    `${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/${encodeURIComponent('heads/' + branch)}`,
    pat,
  );
  if (res.status === 404) return null;
  const j = await ghJson<{ object?: { sha: string } }>(res, 'get branch ref');
  return j.object?.sha || null;
}

/**
 * Create a new branch ref at an existing commit (Fabric "Branch out to another
 * workspace" — real GitHub Git Data API `POST /git/refs`). Throws a clean 409
 * when the branch already exists (GitHub returns 422 "Reference already exists").
 */
export async function githubCreateBranch(
  owner: string, repo: string, newBranch: string, fromSha: string, pat: string, base: string = GH_BASE,
): Promise<{ name: string; sha: string }> {
  if (!fromSha) {
    throw new GitIntegrationError(
      'The source branch has no commits to branch from. Sync the workspace to Git first, then branch out.',
      'github_no_source_commit', 409,
    );
  }
  const res = await ghFetch(
    `${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`,
    pat,
    { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${newBranch}`, sha: fromSha }) },
  );
  if (res.status === 422) {
    const body = await res.text().catch(() => '');
    // 422 is "Reference already exists" (or an invalid ref name).
    const exists = /already exists/i.test(body);
    throw new GitIntegrationError(
      exists ? `Branch "${newBranch}" already exists in the repository.` : `GitHub refused the branch create (422): ${body.slice(0, 200)}`,
      exists ? 'branch_exists' : 'github_branch_failed',
      exists ? 409 : 422,
    );
  }
  const j = await ghJson<{ ref?: string; object?: { sha: string } }>(res, 'create branch');
  return { name: (j.ref || `refs/heads/${newBranch}`).replace(/^refs\/heads\//, ''), sha: j.object?.sha || fromSha };
}

export interface GhCommitArgs {
  owner: string;
  repo: string;
  branch: string;
  files: SyncFile[];
  message: string;
  pat: string;
  /** GitHub REST base — github.com by default, or `api.<sub>.ghe.com`. */
  base?: string;
}

/**
 * Atomic batch commit via the GitHub Git Data API: blob → tree → commit → ref.
 * Creates the branch when it does not exist (orphan tree, no parents). The tree
 * write handles add vs edit transparently, so no prior existence check is needed.
 * Returns the new commit SHA.
 */
export async function githubBatchCommit(args: GhCommitArgs): Promise<GitCommitStatus> {
  const { owner, repo, branch, pat } = args;
  const base = args.base || GH_BASE;
  const parentSha = await githubGetBranchSha(owner, repo, branch, pat, base);

  let baseTree: string | undefined;
  if (parentSha) {
    const commitRes = await ghFetch(`${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${parentSha}`, pat);
    const commit = await ghJson<{ tree?: { sha: string } }>(commitRes, 'read parent commit');
    baseTree = commit.tree?.sha;
  }

  // Create blobs.
  const treeItems: { path: string; mode: '100644'; type: 'blob'; sha: string }[] = [];
  for (const f of args.files) {
    const blobRes = await ghFetch(
      `${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs`,
      pat,
      { method: 'POST', body: JSON.stringify({ content: f.content, encoding: 'utf-8' }) },
    );
    const blob = await ghJson<{ sha: string }>(blobRes, 'create blob');
    treeItems.push({ path: f.path.replace(/^\/+/, ''), mode: '100644', type: 'blob', sha: blob.sha });
  }

  // Create tree.
  const treeRes = await ghFetch(
    `${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees`,
    pat,
    { method: 'POST', body: JSON.stringify(baseTree ? { base_tree: baseTree, tree: treeItems } : { tree: treeItems }) },
  );
  const tree = await ghJson<{ sha: string }>(treeRes, 'create tree');

  // Create commit.
  const commitRes = await ghFetch(
    `${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits`,
    pat,
    { method: 'POST', body: JSON.stringify({ message: args.message, tree: tree.sha, parents: parentSha ? [parentSha] : [] }) },
  );
  const commit = await ghJson<{ sha: string }>(commitRes, 'create commit');

  // Advance / create the ref.
  if (parentSha) {
    const patchRes = await ghFetch(
      `${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs/${encodeURIComponent('heads/' + branch)}`,
      pat,
      { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) },
    );
    await ghJson(patchRes, 'advance branch ref');
  } else {
    const postRes = await ghFetch(
      `${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`,
      pat,
      { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }) },
    );
    await ghJson(postRes, 'create branch ref');
  }

  return { commitId: commit.sha, comment: args.message };
}

export async function githubLastCommit(owner: string, repo: string, branch: string, pat: string, base: string = GH_BASE): Promise<GitCommitStatus | null> {
  const res = await ghFetch(
    `${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(branch)}`,
    pat,
  );
  if (res.status === 404 || res.status === 409) return null; // 409 = empty repo
  const j = await ghJson<any>(res, 'last commit');
  return { commitId: j.sha, commitDate: j.commit?.author?.date, authorName: j.commit?.author?.name, comment: j.commit?.message };
}
