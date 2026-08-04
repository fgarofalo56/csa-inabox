/**
 * PURE clone-URL construction for `CSA Loom: Clone workspace repo` (W9) — no
 * `vscode` import, so the provider→URL mapping is unit-testable in isolation.
 *
 * The bound repo's coordinates come from the REAL `/api/git-integration/status`
 * route (`repo.provider` + `repo.repoPath`, shapes defined in `git-model.ts`).
 * The command hands the resulting HTTPS URL to VS Code's built-in `git.clone`
 * command, which performs the clone AND the auth using the user's OWN Git
 * credentials (the GitHub/ADO auth providers) — the extension never shells out
 * to `git` and never handles a credential (security-review requirement: no
 * `child_process` of user-supplied strings).
 *
 * Provider path shapes (matching the Console git client):
 *   • github : `owner/repo`               → https://github.com/owner/repo.git
 *   • ado    : `org/project/_git/repo`     → https://dev.azure.com/org/project/_git/repo
 *              (`org/project/repo` is also accepted and normalised to `_git`)
 */

import { trimSlashes } from '../util/trim';

/** Outcome of building a clone URL — a usable URL or an honest reason it can't. */
export type CloneUrlResult = { url: string } | { error: string };

/** Build the HTTPS clone URL for a bound repo, or explain why it can't be built. */
export function buildCloneUrl(provider: string, repoPath: string): CloneUrlResult {
  const p = (provider || '').toLowerCase().trim();
  const path = trimSlashes((repoPath || '').trim());
  if (!path) return { error: 'The workspace has no repository path configured.' };

  if (p === 'github' || p === 'gh') {
    const segs = path.replace(/\.git$/i, '').split('/').filter(Boolean);
    if (segs.length !== 2) {
      return { error: `Unexpected GitHub repo path "${repoPath}" (expected owner/repo).` };
    }
    return { url: `https://github.com/${segs[0]}/${segs[1]}.git` };
  }

  if (p === 'ado' || p === 'azure-devops' || p === 'azuredevops') {
    if (/\/_git\//.test(path)) {
      return { url: `https://dev.azure.com/${path}` };
    }
    const segs = path.split('/').filter(Boolean);
    if (segs.length === 3) {
      const [org, project, repo] = segs;
      return { url: `https://dev.azure.com/${org}/${project}/_git/${repo}` };
    }
    return { error: `Unexpected Azure DevOps repo path "${repoPath}" (expected org/project/_git/repo).` };
  }

  return { error: `Clone is not supported for provider "${provider}" from VS Code yet — open the repo in the Console.` };
}
