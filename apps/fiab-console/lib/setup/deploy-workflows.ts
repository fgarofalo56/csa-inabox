/**
 * The ONLY GitHub Actions workflow files the Setup Wizard may name.
 *
 * WHY THIS MODULE EXISTS (#2652, CodeQL js/request-forgery alert #368).
 *
 * `GET /api/setup/workflow-run-status?workflow=<file>` took the workflow file
 * straight from the query string and interpolated it into:
 *
 *     https://api.github.com/repos/<owner>/<repo>/actions/workflows/${workflowFile}/runs
 *
 * on a request carrying `Authorization: Bearer ${LOOM_GITHUB_ACTIONS_TOKEN}`.
 * `fetch` normalises `../` segments, so a caller could walk out of the
 * `/actions/workflows/` prefix to any path on api.github.com and have the
 * platform's GitHub token attached to it — e.g.
 *
 *     ?workflow=../../../../../../user/repos
 *
 * That turns any authenticated Loom session into arbitrary GitHub API reads as
 * the deployment token. This is the same defect class as #2683, #2691 and
 * #2607: a CREDENTIAL TRAVELLING TO A CALLER-CHOSEN ADDRESS.
 *
 * The dispatch route (`/api/setup/deploy`) never had the bug, because it picks
 * the file with a MAP LOOKUP on the boundary — an allow-list by construction.
 * That map is the natural source of truth, so it lives here and both routes use
 * it. Keeping two copies would let the status route drift back open the moment a
 * new boundary is added.
 */

/** Boundary → the deployment workflow that provisions it. */
export const DEPLOY_WORKFLOW_BY_BOUNDARY: Record<string, string> = {
  Commercial: 'deploy-fiab-commercial.yml',
  GCC: 'deploy-fiab-gcc.yml',
  'GCC-High': 'deploy-fiab-gcch.yml',
  IL5: 'deploy-fiab-gcch.yml',
};

/** Used when the caller's boundary is absent or unrecognised. */
export const DEFAULT_DEPLOY_WORKFLOW = 'deploy-fiab-commercial.yml';

/**
 * Every workflow file the wizard can legitimately dispatch OR poll.
 *
 * Derived from the map rather than written out again, so adding a boundary
 * cannot leave the status route rejecting a workflow the deploy route just
 * started.
 */
export const ALLOWED_DEPLOY_WORKFLOWS: ReadonlySet<string> = new Set([
  ...Object.values(DEPLOY_WORKFLOW_BY_BOUNDARY),
  DEFAULT_DEPLOY_WORKFLOW,
]);

/**
 * Resolve the workflow for a boundary. Unknown/absent → the Commercial default.
 */
export function deployWorkflowForBoundary(boundary?: string | null): string {
  return (boundary && DEPLOY_WORKFLOW_BY_BOUNDARY[boundary]) || DEFAULT_DEPLOY_WORKFLOW;
}

/**
 * Return `candidate` when it is an allowed workflow file, else `null`.
 *
 * A membership test against a fixed set — deliberately NOT a sanitiser. Stripping
 * `../` or rejecting a pattern invites the next encoding trick (`%2e%2e%2f`,
 * over-long UTF-8, a second decode pass upstream); an exact-match allow-list has
 * no such surface. It also fails CLOSED: an unrecognised value yields null and
 * the caller must refuse, rather than falling back to a default and quietly
 * polling the wrong workflow.
 */
export function resolveAllowedWorkflow(candidate: string | null | undefined): string | null {
  if (!candidate) return null;
  return ALLOWED_DEPLOY_WORKFLOWS.has(candidate) ? candidate : null;
}
