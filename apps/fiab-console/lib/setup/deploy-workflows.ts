/**
 * deploy-workflows — the ONE list of GitHub Actions workflow files the Setup
 * Wizard may dispatch and poll, keyed by cloud boundary.
 *
 * Extracted so the DISPATCH side (`POST /api/setup/deploy`) and the POLL side
 * (`GET /api/setup/workflow-run-status`) read the same trusted set. The poll
 * route previously interpolated its `?workflow=` query param straight into
 * `https://api.github.com/repos/{owner}/{repo}/actions/workflows/{file}/runs`,
 * so `?workflow=../../../..` normalised into a DIFFERENT GitHub REST endpoint —
 * i.e. any authenticated Loom user could aim `LOOM_GITHUB_ACTIONS_TOKEN` (a PAT
 * that can dispatch deployment workflows) at arbitrary GitHub API paths.
 *
 * A wizard client never sends anything but one of these values: the deploy
 * response hands the workflow file back and the wizard echoes it. Validating
 * against this map is therefore zero-regression and closes the injection
 * structurally — the request selects a constant, it never supplies a path.
 */

/** Boundary → the deploy workflow that provisions it. */
export const DEPLOY_WORKFLOW_BY_BOUNDARY: Record<string, string> = {
  Commercial: 'deploy-fiab-commercial.yml',
  GCC: 'deploy-fiab-gcc.yml',
  'GCC-High': 'deploy-fiab-gcch.yml',
  IL5: 'deploy-fiab-gcch.yml',
};

/** The workflow used when a boundary is missing/unknown. */
export const DEFAULT_DEPLOY_WORKFLOW = 'deploy-fiab-commercial.yml';

/** Every workflow file the wizard is allowed to dispatch or poll. */
export const DISPATCHABLE_WORKFLOWS: readonly string[] = Array.from(
  new Set([...Object.values(DEPLOY_WORKFLOW_BY_BOUNDARY), DEFAULT_DEPLOY_WORKFLOW]),
);

/** The workflow file for a boundary (falls back to the Commercial deploy). */
export function deployWorkflowFor(boundary: string | undefined | null): string {
  return DEPLOY_WORKFLOW_BY_BOUNDARY[String(boundary || '')] || DEFAULT_DEPLOY_WORKFLOW;
}

/**
 * Return the workflow file EXACTLY as this module declares it, or null when the
 * caller asked for anything else. The returned string is the constant from
 * {@link DISPATCHABLE_WORKFLOWS}, never the caller's bytes, so no separator,
 * traversal segment or encoding trick can reach the GitHub API URL.
 */
export function assertDispatchableWorkflow(requested: string | undefined | null): string | null {
  const want = String(requested || '').trim();
  if (!want) return null;
  return DISPATCHABLE_WORKFLOWS.find((w) => w === want) ?? null;
}
