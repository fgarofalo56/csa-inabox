/**
 * PURE core for Git / ALM integration (no `vscode` import) — the types + the
 * honest-gate mapping behind the Phase 5 Git commands (W9/W10), unit-testable in
 * isolation against the real route contracts.
 *
 * Backed by the Console's REAL workspace-scoped Git routes (Azure-native ADO /
 * GitHub, never a Fabric git surface):
 *   GET  /api/git-integration/status?workspaceId=…   (repo + changed items)
 *   POST /api/git-integration/commit                  (commit selected items)
 *   POST /api/git-integration/pull                    (pull → apply to items)
 *   POST /api/git-integration/resolve                 (per-item local|remote)
 *
 * When no repo is bound (or no PAT / no Key Vault), those routes answer 424 with
 * `{ gated:true, missing }` — an honest gate (`no-vaporware.md` G2) the command
 * turns into a named remediation + a Fix-it that opens the Console binding page,
 * NEVER a fabricated status.
 */

/** How a workspace item differs from the bound repo. */
export type GitChangeStatus = 'modified' | 'added' | 'removed';

/** One changed item in a status response (`StatusEntry` in the git client). */
export interface GitStatusEntry {
  itemId?: string;
  itemType: string;
  displayName: string;
  status: GitChangeStatus;
}

/** `GET …/status` success body. */
export interface GitStatusResponse {
  ok: true;
  workspaceId: string;
  repo: { provider: string; repoPath: string; branch: string };
  headSha: string | null;
  lastSyncedSha: string | null;
  changed: GitStatusEntry[];
}

/** `POST …/commit` success body. */
export interface GitCommitResponse {
  ok: true;
  commitSha: string;
  url: string;
  at: string;
  files: number;
  committed: Array<{ id: string; displayName: string; itemType: string }>;
}

/** `POST …/pull` success body. */
export interface GitPullResponse {
  ok: true;
  headSha: string | null;
  applied: number;
  diff?: unknown;
  items: Array<{ id: string; displayName: string; itemType: string }>;
}

/** `POST …/resolve` success body (shape depends on the resolution). */
export interface GitResolveResponse {
  ok: true;
  resolution: 'local' | 'remote';
  commitSha?: string;
  url?: string;
  at?: string;
  applied?: number;
  headSha?: string | null;
}

/**
 * The distinct honest-gate reasons the routes return as `missing` on a 424 (or a
 * downstream KV 503). Kept as a union so a Fix-it can branch on it.
 */
export type GitGateReason = 'no_repo_bound' | 'no_pat' | 'kv_forbidden' | 'no_kv' | (string & {});

/** A codicon id for a change status (status quick-pick + labels). */
export function changeIcon(status: GitChangeStatus): string {
  switch (status) {
    case 'added':
      return 'diff-added';
    case 'removed':
      return 'diff-removed';
    default:
      return 'diff-modified';
  }
}

/** Count changed items by status (for the status summary line). */
export function summarizeChanges(changed: GitStatusEntry[]): {
  added: number;
  modified: number;
  removed: number;
  total: number;
} {
  const out = { added: 0, modified: 0, removed: 0, total: changed.length };
  for (const c of changed) {
    if (c.status === 'added') out.added++;
    else if (c.status === 'removed') out.removed++;
    else out.modified++;
  }
  return out;
}

/**
 * A human, actionable message for an honest git gate — names the exact
 * remediation (`no-vaporware.md` G2). `detail` is the route's own explanation.
 */
export function describeGitGate(missing: GitGateReason, detail?: string): string {
  const base = (() => {
    switch (missing) {
      case 'no_repo_bound':
        return 'No Git repository is connected to this workspace. Connect an Azure DevOps or GitHub repo in the Console (Workspace → Settings → Git integration).';
      case 'no_pat':
        return 'No Git access token is stored for this workspace. Add the repo PAT in the Console workspace Git settings.';
      case 'kv_forbidden':
        return "The Console's identity cannot read the Git PAT from Key Vault. Grant it the Key Vault Secrets User role, then retry.";
      case 'no_kv':
        return 'No Key Vault is configured to hold the Git PAT for this deployment. Provision it (DLZ Key Vault bicep module), then connect the repo.';
      default:
        return 'Git integration is not fully configured for this workspace.';
    }
  })();
  return detail && detail.trim() && detail.trim() !== base ? `${base} (${detail.trim()})` : base;
}

/** True when a route body is an honest git gate rather than a hard error. */
export function isGitGateBody(body: unknown): body is { gated: true; missing: GitGateReason; detail?: string } {
  return (
    !!body &&
    typeof body === 'object' &&
    (body as { gated?: unknown }).gated === true &&
    typeof (body as { missing?: unknown }).missing === 'string'
  );
}
