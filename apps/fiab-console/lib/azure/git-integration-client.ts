/**
 * Git integration client — real commit / pull / status against Azure DevOps
 * Repos (REST API 7.1) or GitHub (REST API v3). Mirrors Fabric's Git
 * integration: each workspace item is serialized to a canonical text form
 * (TMSL `model.bim` for semantic models, PBIR for reports, scorecard JSON,
 * `<itemType>.json` for everything else) under a Fabric-style item folder
 * `<directory>/<displayName>.<ItemType>/`, then pushed/pulled as real Git
 * commits.
 *
 * Auth: a workspace-scoped PAT lives in Key Vault at
 * `<LOOM_GIT_PAT_KV_PREFIX|loom-git-pat>-<workspaceId>` (written by the SCM
 * route via kv-secrets-client). It is NEVER stored in Cosmos or returned to
 * the browser — only the KV secret name (`patSecretRef`) is persisted.
 *
 * Sovereign clouds: Azure DevOps Services runs only on commercial Azure
 * (Microsoft Learn: "Azure DevOps Services isn't available in GCC; use
 * on-premises Azure DevOps or public Azure DevOps services"). For GCC-High /
 * IL5 / DoD, point `LOOM_ADO_HOST` at an on-prem Azure DevOps Server and
 * `LOOM_GITHUB_HOST` at a GitHub Enterprise Server `/api/v3` base. Commercial
 * and GCC leave both unset (dev.azure.com / api.github.com).
 *
 * No mocks, no placeholders — every function issues a real REST call.
 */

// Key Vault is imported lazily inside getPat() so this module's import graph
// stays free of @azure/identity — the pure serialization/parse/path helpers
// (and their tests) load without the credential chain.

/** Secret names must be 1-127 chars of [0-9a-zA-Z-] (mirrors kv-secrets-client). */
function sanitizeSecretName(raw: string): string {
  return (raw || '').replace(/[^0-9a-zA-Z-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 127) || 'loom-secret';
}

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export type GitProvider = 'github' | 'ado';

/** Persisted in Cosmos `workspace-git` (PK /workspaceId). */
export interface GitRepoConfig {
  id: string; // = workspaceId
  workspaceId: string;
  provider: GitProvider;
  repoHost: string; // dev.azure.com | github.com | on-prem host
  repoPath: string; // ADO: org/project/_git/repo  |  GH: owner/repo
  branch: string;
  directory?: string; // subdirectory root in repo, e.g. "fabric-items"
  patSecretRef?: string; // KV secret name holding the PAT
  status: 'connected';
  connectedBy: string;
  connectedAt: string;
  lastSyncedSha?: string;
}

/** Minimal item shape this client needs (subset of WorkspaceItem). */
export interface GitSerializableItem {
  id?: string;
  itemType: string;
  displayName: string;
  state?: { content?: unknown } & Record<string, unknown>;
}

export interface SerializedFile {
  /** Repo-relative path, e.g. fabric-items/Sales.SemanticModel/model.bim */
  repoPath: string;
  content: string;
}

export class GitIntegrationError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'GitIntegrationError';
    this.status = status;
    this.code = code;
  }
}

// ----------------------------------------------------------------------------
// Endpoint + auth resolution (sovereign-aware)
// ----------------------------------------------------------------------------

/** ADO REST API base. LOOM_ADO_HOST overrides for on-prem ADO Server. */
export function adoApiBase(repoHost: string): string {
  const ov = (process.env.LOOM_ADO_HOST || '').trim();
  if (ov) return ov.replace(/\/$/, '');
  return `https://${repoHost.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
}

/** GitHub REST API base. LOOM_GITHUB_HOST overrides for GitHub Enterprise. */
export function githubApiBase(): string {
  const ov = (process.env.LOOM_GITHUB_HOST || '').trim();
  if (ov) return ov.replace(/\/$/, '');
  return 'https://api.github.com';
}

/** ADO uses HTTP Basic with an empty username and the PAT as the password. */
export function adoAuthHeader(pat: string): string {
  return `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
}

/** GitHub uses a token credential. */
export function githubAuthHeader(pat: string): string {
  return `token ${pat}`;
}

/** Default KV secret name for a workspace PAT. */
export function patSecretName(workspaceId: string): string {
  const prefix = (process.env.LOOM_GIT_PAT_KV_PREFIX || 'loom-git-pat').trim() || 'loom-git-pat';
  return sanitizeSecretName(`${prefix}-${workspaceId}`);
}

/** Read the PAT for a config from Key Vault. Throws an honest gate if absent. */
export async function getPat(config: GitRepoConfig): Promise<string> {
  const ref = config.patSecretRef || patSecretName(config.workspaceId);
  let value = '';
  try {
    const { getKeyVaultSecretValue } = await import('./kv-secrets-client');
    value = await getKeyVaultSecretValue(ref);
  } catch (e: any) {
    const status = typeof e?.status === 'number' ? e.status : 502;
    if (status === 404) {
      throw new GitIntegrationError(
        'No PAT found in Key Vault for this workspace. Re-connect the repository in workspace Settings → Git integration and supply a PAT.',
        424,
        'no_pat',
      );
    }
    throw new GitIntegrationError(
      `Key Vault is not reachable for the git PAT (${e?.message || e}). Set LOOM_KEY_VAULT_URI and grant the Console identity the "Key Vault Secrets Officer" role.`,
      status === 403 ? 403 : 503,
      status === 403 ? 'kv_forbidden' : 'no_kv',
    );
  }
  if (!value) {
    throw new GitIntegrationError(
      'No PAT found in Key Vault for this workspace. Re-connect the repository in workspace Settings → Git integration and supply a PAT.',
      424,
      'no_pat',
    );
  }
  return value;
}

/** Honest gate: null/disconnected config → repo not bound. */
export function gitConfigGate(config: GitRepoConfig | null): { missing: string; detail: string } | null {
  if (!config || config.status !== 'connected' || !config.repoPath) {
    return {
      missing: 'no_repo_bound',
      detail: 'No repository connected. Connect one in workspace Settings → Git integration.',
    };
  }
  return null;
}

// ----------------------------------------------------------------------------
// Path parsing
// ----------------------------------------------------------------------------

export function parseAdoPath(repoPath: string): { org: string; project: string; repo: string } {
  const clean = repoPath.replace(/^\//, '').replace(/\/$/, '');
  const segs = clean.split('/').filter(Boolean);
  const gitIdx = segs.indexOf('_git');
  if (gitIdx > 0 && segs[gitIdx + 1]) {
    return {
      org: segs[0],
      project: segs.slice(1, gitIdx).join('/') || segs[0],
      repo: segs[gitIdx + 1],
    };
  }
  // Fallback: org/project/repo (last segment is the repo).
  if (segs.length >= 3) return { org: segs[0], project: segs[1], repo: segs[segs.length - 1] };
  if (segs.length === 2) return { org: segs[0], project: segs[0], repo: segs[1] };
  return { org: clean, project: clean, repo: clean };
}

export function parseGitHubPath(repoPath: string): { owner: string; repo: string } {
  const segs = repoPath.replace(/^\//, '').replace(/\/$/, '').replace(/\.git$/, '').split('/').filter(Boolean);
  return { owner: segs[0] || '', repo: segs[1] || '' };
}

// ----------------------------------------------------------------------------
// Serialization
// ----------------------------------------------------------------------------

/** itemType (kebab) → PascalCase folder suffix matching Fabric conventions. */
export function pascalItemType(itemType: string): string {
  return itemType
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
}

/** Item folder root in the repo for an item. */
export function itemFolder(item: GitSerializableItem, directoryRoot?: string): string {
  const dir = (directoryRoot || '').replace(/^\//, '').replace(/\/$/, '');
  const folder = `${item.displayName}.${pascalItemType(item.itemType)}`;
  return dir ? `${dir}/${folder}` : folder;
}

/**
 * Build TMSL (`model.bim`) from a SemanticModelContent-shaped object. Self
 * contained (no provisioner import) and an exact inverse of
 * `parseTmslToContent` for the carried fields, so Loom→repo→Loom round-trips.
 */
export function buildTmslFromContent(content: any, displayName: string): string {
  const tables = Array.isArray(content?.tables) ? content.tables : [];
  const measures = Array.isArray(content?.measures) ? content.measures : [];
  const relationships = Array.isArray(content?.relationships) ? content.relationships : [];
  return JSON.stringify(
    {
      name: displayName,
      compatibilityLevel: 1567,
      model: {
        culture: 'en-US',
        tables: tables.map((t: any) => ({
          name: t.name,
          columns: (t.columns || []).map((c: any) => ({
            name: c.name,
            dataType: c.dataType || 'string',
            sourceColumn: c.name,
          })),
          measures: measures
            .filter((m: any) => m.table === t.name)
            .map((m: any) => ({
              name: m.name,
              expression: m.expression,
              ...(m.formatString ? { formatString: m.formatString } : {}),
            })),
        })),
        relationships: relationships.map((r: any, i: number) => ({
          name: `rel${i}`,
          fromTable: String(r.from).split('.')[0],
          fromColumn: String(r.from).split('.')[1] || 'Id',
          toTable: String(r.to).split('.')[0],
          toColumn: String(r.to).split('.')[1] || 'Id',
          crossFilteringBehavior: 'oneDirection',
          ...(r.isActive === false ? { isActive: false } : {}),
        })),
      },
    },
    null,
    2,
  );
}

/** Reverse of buildTmslFromContent — TMSL `model.bim` → SemanticModelContent. */
export function parseTmslToContent(tmsl: string): { tables: any[]; measures: any[]; relationships: any[] } {
  const m = JSON.parse(tmsl);
  const model = m?.model || {};
  const tables = Array.isArray(model.tables) ? model.tables : [];
  const outTables = tables.map((t: any) => ({
    name: t.name,
    columns: (t.columns || []).map((c: any) => ({ name: c.name, dataType: c.dataType || 'string' })),
  }));
  const outMeasures: any[] = [];
  for (const t of tables) {
    for (const meas of t.measures || []) {
      outMeasures.push({
        name: meas.name,
        table: t.name,
        expression: meas.expression,
        ...(meas.formatString ? { formatString: meas.formatString } : {}),
      });
    }
  }
  const rels = Array.isArray(model.relationships) ? model.relationships : [];
  const outRels = rels.map((r: any) => ({
    from: `${r.fromTable}.${r.fromColumn}`,
    to: `${r.toTable}.${r.toColumn}`,
    ...(r.isActive === false ? { isActive: false } : {}),
  }));
  return { tables: outTables, measures: outMeasures, relationships: outRels };
}

/**
 * Serialize a Loom item to its canonical repo files (paths relative to repo
 * root). The content the editor stores is at item.state.content.
 */
export function serializeLoomItem(item: GitSerializableItem, directoryRoot?: string): SerializedFile[] {
  const folder = itemFolder(item, directoryRoot);
  const content = (item.state?.content ?? {}) as any;
  const pretty = (o: unknown) => JSON.stringify(o ?? {}, null, 2);

  switch (item.itemType) {
    case 'semantic-model':
      return [
        { repoPath: `${folder}/model.bim`, content: buildTmslFromContent(content, item.displayName) },
        { repoPath: `${folder}/definition.pbism`, content: pretty({ version: '4.0', settings: {} }) },
      ];
    case 'report':
      return [
        {
          repoPath: `${folder}/definition.pbir`,
          content: pretty({ version: '4.0', datasetReference: { byPath: { path: '../model.SemanticModel' } } }),
        },
        { repoPath: `${folder}/definition/report.json`, content: pretty(content) },
      ];
    case 'scorecard':
      return [{ repoPath: `${folder}/scorecard.json`, content: pretty(content) }];
    default:
      return [{ repoPath: `${folder}/${item.itemType}.json`, content: pretty(content) }];
  }
}

/**
 * Reverse of serializeLoomItem — repo files for one item → the state.content
 * to write back to Cosmos.
 */
export function deserializeLoomItem(itemType: string, files: SerializedFile[]): unknown {
  const bySuffix = (suffix: string) => files.find((f) => f.repoPath.endsWith(suffix));
  if (itemType === 'semantic-model') {
    const bim = bySuffix('model.bim');
    if (!bim) throw new GitIntegrationError('model.bim not found in repo for semantic model', 422, 'parse_failed');
    return parseTmslToContent(bim.content);
  }
  if (itemType === 'report') {
    const rep = bySuffix('definition/report.json') || bySuffix('report.json');
    if (!rep) throw new GitIntegrationError('report.json not found in repo for report', 422, 'parse_failed');
    return JSON.parse(rep.content);
  }
  if (itemType === 'scorecard') {
    const sc = bySuffix('scorecard.json');
    if (!sc) throw new GitIntegrationError('scorecard.json not found in repo', 422, 'parse_failed');
    return JSON.parse(sc.content);
  }
  const f = bySuffix(`${itemType}.json`) || files[0];
  if (!f) throw new GitIntegrationError(`${itemType}.json not found in repo`, 422, 'parse_failed');
  return JSON.parse(f.content);
}

// ----------------------------------------------------------------------------
// REST helpers
// ----------------------------------------------------------------------------

const EMPTY_OBJECT_ID = '0000000000000000000000000000000000000000';

async function jsonOrThrow(res: Response, ctx: string): Promise<any> {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw mapHttpError(res.status, `${ctx}: ${body.slice(0, 300)}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

function mapHttpError(status: number, message: string): GitIntegrationError {
  if (status === 401 || status === 403) {
    return new GitIntegrationError(
      `Git provider rejected the PAT (${status}). Re-connect the repository and supply a PAT with repo read/write (ADO: "Code (Read & Write)"; GitHub: "repo") scope. ${message}`,
      401,
      'git_auth',
    );
  }
  if (status === 409 || status === 412 || status === 422) {
    return new GitIntegrationError(
      `Remote branch moved since the last sync. Pull (Update) first, then commit. ${message}`,
      409,
      'git_conflict',
    );
  }
  if (status === 404) {
    return new GitIntegrationError(`Repository, branch, or path not found (404). ${message}`, 404, 'git_not_found');
  }
  return new GitIntegrationError(`Git provider error (${status}). ${message}`, status >= 500 ? 502 : status, 'git_error');
}

// ----------------------------------------------------------------------------
// HEAD SHA
// ----------------------------------------------------------------------------

/** Current HEAD commit SHA of the configured branch, or null if the branch does not exist. */
export async function getHeadSha(config: GitRepoConfig, pat: string): Promise<string | null> {
  if (config.provider === 'ado') {
    const { org, project, repo } = parseAdoPath(config.repoPath);
    const url = `${adoApiBase(config.repoHost)}/${org}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(
      repo,
    )}/refs?filter=${encodeURIComponent(`heads/${config.branch}`)}&api-version=7.1`;
    const res = await fetch(url, { headers: { authorization: adoAuthHeader(pat) }, cache: 'no-store' });
    const j = await jsonOrThrow(res, 'ADO get-ref');
    return j?.value?.[0]?.objectId ?? null;
  }
  const { owner, repo } = parseGitHubPath(config.repoPath);
  const url = `${githubApiBase()}/repos/${owner}/${repo}/git/ref/${encodeURIComponent(`heads/${config.branch}`)}`;
  const res = await fetch(url, {
    headers: { authorization: githubAuthHeader(pat), accept: 'application/vnd.github+json' },
    cache: 'no-store',
  });
  if (res.status === 404) return null;
  const j = await jsonOrThrow(res, 'GitHub get-ref');
  return j?.object?.sha ?? null;
}

// ----------------------------------------------------------------------------
// List + read repo files
// ----------------------------------------------------------------------------

/** All blob paths under config.directory at HEAD. */
export async function listRepoFiles(config: GitRepoConfig, pat: string): Promise<{ repoPath: string }[]> {
  const dir = (config.directory || '').replace(/^\//, '').replace(/\/$/, '');
  if (config.provider === 'ado') {
    const { org, project, repo } = parseAdoPath(config.repoPath);
    const scope = dir ? `/${dir}` : '/';
    const url =
      `${adoApiBase(config.repoHost)}/${org}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/items` +
      `?scopePath=${encodeURIComponent(scope)}&recursionLevel=Full` +
      `&versionDescriptor.versionType=Branch&versionDescriptor.version=${encodeURIComponent(config.branch)}&api-version=7.1`;
    const res = await fetch(url, { headers: { authorization: adoAuthHeader(pat) }, cache: 'no-store' });
    if (res.status === 404) return [];
    const j = await jsonOrThrow(res, 'ADO list-items');
    return (j?.value || [])
      .filter((it: any) => it && it.isFolder !== true && it.gitObjectType !== 'tree')
      .map((it: any) => ({ repoPath: String(it.path).replace(/^\//, '') }));
  }
  const head = await getHeadSha(config, pat);
  if (!head) return [];
  const { owner, repo } = parseGitHubPath(config.repoPath);
  const url = `${githubApiBase()}/repos/${owner}/${repo}/git/trees/${head}?recursive=1`;
  const res = await fetch(url, {
    headers: { authorization: githubAuthHeader(pat), accept: 'application/vnd.github+json' },
    cache: 'no-store',
  });
  const j = await jsonOrThrow(res, 'GitHub get-tree');
  return (j?.tree || [])
    .filter((t: any) => t.type === 'blob' && (!dir || String(t.path).startsWith(`${dir}/`) || String(t.path) === dir))
    .map((t: any) => ({ repoPath: String(t.path) }));
}

/** Fetch one file's content. Returns null if it does not exist on the branch. */
export async function getFileContent(config: GitRepoConfig, pat: string, filePath: string): Promise<string | null> {
  if (config.provider === 'ado') {
    const { org, project, repo } = parseAdoPath(config.repoPath);
    const url =
      `${adoApiBase(config.repoHost)}/${org}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/items` +
      `?path=${encodeURIComponent('/' + filePath.replace(/^\//, ''))}&includeContent=true` +
      `&versionDescriptor.versionType=Branch&versionDescriptor.version=${encodeURIComponent(config.branch)}&api-version=7.1`;
    const res = await fetch(url, {
      headers: { authorization: adoAuthHeader(pat), accept: 'application/json' },
      cache: 'no-store',
    });
    if (res.status === 404) return null;
    const j = await jsonOrThrow(res, 'ADO get-item');
    return typeof j?.content === 'string' ? j.content : null;
  }
  const { owner, repo } = parseGitHubPath(config.repoPath);
  const url = `${githubApiBase()}/repos/${owner}/${repo}/contents/${filePath
    .split('/')
    .map(encodeURIComponent)
    .join('/')}?ref=${encodeURIComponent(config.branch)}`;
  const res = await fetch(url, {
    headers: { authorization: githubAuthHeader(pat), accept: 'application/vnd.github+json' },
    cache: 'no-store',
  });
  if (res.status === 404) return null;
  const j = await jsonOrThrow(res, 'GitHub get-content');
  if (typeof j?.content !== 'string') return null;
  return Buffer.from(j.content, 'base64').toString('utf-8');
}

// ----------------------------------------------------------------------------
// Commit
// ----------------------------------------------------------------------------

export interface CommitResult {
  commitSha: string;
  url: string;
  at: string;
  files: number;
}

function webCommitUrl(config: GitRepoConfig, sha: string): string {
  return `https://${config.repoHost.replace(/^https?:\/\//, '').replace(/\/$/, '')}/${config.repoPath.replace(/^\//, '')}/commit/${sha}`;
}

/** Commit one or more item serializations to the branch as a single commit. */
export async function commitItems(
  config: GitRepoConfig,
  pat: string,
  items: GitSerializableItem[],
  message: string,
  author: { name: string; email: string },
): Promise<CommitResult> {
  const files: SerializedFile[] = [];
  for (const it of items) files.push(...serializeLoomItem(it, config.directory));
  if (files.length === 0) throw new GitIntegrationError('No files to commit', 400, 'empty_commit');

  if (config.provider === 'ado') {
    return commitItemsAdo(config, pat, files, message);
  }
  return commitItemsGitHub(config, pat, files, message, author);
}

async function commitItemsAdo(config: GitRepoConfig, pat: string, files: SerializedFile[], message: string): Promise<CommitResult> {
  const { org, project, repo } = parseAdoPath(config.repoPath);
  const head = await getHeadSha(config, pat);
  const existing = new Set((await listRepoFiles(config, pat)).map((f) => f.repoPath));
  const changes = files.map((f) => ({
    changeType: existing.has(f.repoPath) ? 'edit' : 'add',
    item: { path: `/${f.repoPath}` },
    newContent: { content: f.content, contentType: 'rawtext' },
  }));
  const body = {
    refUpdates: [{ name: `refs/heads/${config.branch}`, oldObjectId: head || EMPTY_OBJECT_ID }],
    commits: [{ comment: message, changes }],
  };
  const url = `${adoApiBase(config.repoHost)}/${org}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(
    repo,
  )}/pushes?api-version=7.1`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: adoAuthHeader(pat), 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const j = await jsonOrThrow(res, 'ADO push');
  const sha = j?.commits?.[0]?.commitId || '';
  return { commitSha: sha, url: webCommitUrl(config, sha), at: new Date().toISOString(), files: files.length };
}

async function commitItemsGitHub(
  config: GitRepoConfig,
  pat: string,
  files: SerializedFile[],
  message: string,
  author: { name: string; email: string },
): Promise<CommitResult> {
  const { owner, repo } = parseGitHubPath(config.repoPath);
  const base = githubApiBase();
  const h = { authorization: githubAuthHeader(pat), accept: 'application/vnd.github+json', 'content-type': 'application/json' };
  const head = await getHeadSha(config, pat);

  // base_tree from the head commit's tree, if the branch exists.
  let baseTree: string | undefined;
  if (head) {
    const cres = await fetch(`${base}/repos/${owner}/${repo}/git/commits/${head}`, { headers: h, cache: 'no-store' });
    const cj = await jsonOrThrow(cres, 'GitHub get-commit');
    baseTree = cj?.tree?.sha;
  }

  // Blobs.
  const tree: any[] = [];
  for (const f of files) {
    const bres = await fetch(`${base}/repos/${owner}/${repo}/git/blobs`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ content: f.content, encoding: 'utf-8' }),
      cache: 'no-store',
    });
    const bj = await jsonOrThrow(bres, 'GitHub create-blob');
    tree.push({ path: f.repoPath, mode: '100644', type: 'blob', sha: bj.sha });
  }

  // Tree.
  const tres = await fetch(`${base}/repos/${owner}/${repo}/git/trees`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ ...(baseTree ? { base_tree: baseTree } : {}), tree }),
    cache: 'no-store',
  });
  const tj = await jsonOrThrow(tres, 'GitHub create-tree');

  // Commit.
  const cmres = await fetch(`${base}/repos/${owner}/${repo}/git/commits`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({
      message,
      tree: tj.sha,
      parents: head ? [head] : [],
      author: { name: author.name, email: author.email, date: new Date().toISOString() },
    }),
    cache: 'no-store',
  });
  const cmj = await jsonOrThrow(cmres, 'GitHub create-commit');
  const newSha = cmj.sha;

  // Ref update (or create on first push to a new branch).
  if (head) {
    const rres = await fetch(`${base}/repos/${owner}/${repo}/git/refs/${encodeURIComponent(`heads/${config.branch}`)}`, {
      method: 'PATCH',
      headers: h,
      body: JSON.stringify({ sha: newSha, force: false }),
      cache: 'no-store',
    });
    await jsonOrThrow(rres, 'GitHub update-ref');
  } else {
    const rres = await fetch(`${base}/repos/${owner}/${repo}/git/refs`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ ref: `refs/heads/${config.branch}`, sha: newSha }),
      cache: 'no-store',
    });
    await jsonOrThrow(rres, 'GitHub create-ref');
  }
  return { commitSha: newSha, url: webCommitUrl(config, newSha), at: new Date().toISOString(), files: files.length };
}

// ----------------------------------------------------------------------------
// Status (diff local vs remote)
// ----------------------------------------------------------------------------

export type ItemChangeStatus = 'modified' | 'added' | 'removed';

export interface StatusEntry {
  itemId?: string;
  itemType: string;
  displayName: string;
  status: ItemChangeStatus;
}

export interface StatusResult {
  headSha: string | null;
  changed: StatusEntry[];
}

/** Compare local workspace items to the repo and report per-item status. */
export async function getStatus(config: GitRepoConfig, pat: string, items: GitSerializableItem[]): Promise<StatusResult> {
  const head = await getHeadSha(config, pat);
  const repoFiles = new Set((await listRepoFiles(config, pat)).map((f) => f.repoPath));
  const changed: StatusEntry[] = [];
  const localFolders = new Set<string>();

  for (const it of items) {
    const files = serializeLoomItem(it, config.directory);
    localFolders.add(itemFolder(it, config.directory));
    let anyPresent = false;
    let differs = false;
    for (const f of files) {
      if (!repoFiles.has(f.repoPath)) continue;
      anyPresent = true;
      const remote = await getFileContent(config, pat, f.repoPath);
      if (remote == null || remote !== f.content) differs = true;
    }
    if (!anyPresent) changed.push({ itemId: it.id, itemType: it.itemType, displayName: it.displayName, status: 'added' });
    else if (differs) changed.push({ itemId: it.id, itemType: it.itemType, displayName: it.displayName, status: 'modified' });
  }

  // Item folders in the repo with no matching local item → removed locally.
  const seenRemoteFolders = new Set<string>();
  const dir = (config.directory || '').replace(/^\//, '').replace(/\/$/, '');
  for (const p of repoFiles) {
    const rel = dir && p.startsWith(`${dir}/`) ? p.slice(dir.length + 1) : p;
    const folderName = rel.split('/')[0];
    if (!folderName || !folderName.includes('.')) continue;
    const fullFolder = dir ? `${dir}/${folderName}` : folderName;
    if (localFolders.has(fullFolder) || seenRemoteFolders.has(fullFolder)) continue;
    seenRemoteFolders.add(fullFolder);
    const dotIdx = folderName.lastIndexOf('.');
    const displayName = folderName.slice(0, dotIdx);
    const suffix = folderName.slice(dotIdx + 1);
    const itemType = suffix
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .toLowerCase();
    changed.push({ itemType, displayName, status: 'removed' });
  }

  return { headSha: head, changed };
}

// ----------------------------------------------------------------------------
// Pull (apply remote → local)
// ----------------------------------------------------------------------------

export interface PullEntry {
  cosmosItemId?: string;
  itemType: string;
  displayName: string;
  newContent: unknown;
}

export interface PullResult {
  headSha: string | null;
  items: PullEntry[];
  diff: { added: number; modified: number; removed: number };
}

/**
 * Read item files from the repo, deserialize, and return the changeset the BFF
 * route applies to Cosmos. Only items whose deserialized content differs from
 * the local content are returned (modified). Items present in the repo with no
 * matching local file are skipped (the caller owns creating new items).
 */
export async function pullItemFiles(config: GitRepoConfig, pat: string, items: GitSerializableItem[]): Promise<PullResult> {
  const head = await getHeadSha(config, pat);
  const out: PullEntry[] = [];
  let modified = 0;
  for (const it of items) {
    const files = serializeLoomItem(it, config.directory);
    const fetched: SerializedFile[] = [];
    for (const f of files) {
      const remote = await getFileContent(config, pat, f.repoPath);
      if (remote != null) fetched.push({ repoPath: f.repoPath, content: remote });
    }
    if (fetched.length === 0) continue; // not tracked in repo yet
    let newContent: unknown;
    try {
      newContent = deserializeLoomItem(it.itemType, fetched);
    } catch {
      continue; // unparseable remote file — leave local untouched
    }
    const localStr = JSON.stringify((it.state?.content ?? {}) as any);
    const remoteStr = JSON.stringify(newContent);
    if (localStr !== remoteStr) {
      modified++;
      out.push({ cosmosItemId: it.id, itemType: it.itemType, displayName: it.displayName, newContent });
    }
  }
  return { headSha: head, items: out, diff: { added: 0, modified, removed: 0 } };
}
