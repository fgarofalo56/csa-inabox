/**
 * #2652 (js/request-forgery, alert #368) — the Setup Wizard's workflow name must
 * never be able to redirect a token-bearing request.
 *
 * `GET /api/setup/workflow-run-status?workflow=<file>` interpolated the raw query
 * value into:
 *
 *     https://api.github.com/repos/<owner>/<repo>/actions/workflows/${workflowFile}/runs
 *
 * on a request carrying `Authorization: Bearer ${LOOM_GITHUB_ACTIONS_TOKEN}`.
 * `fetch` normalises `../`, so any authenticated session could walk out of the
 * `/actions/workflows/` prefix and read arbitrary GitHub API paths AS THE
 * DEPLOYMENT TOKEN.
 *
 * These are ATTACK tests. Each traversal below reaches a different api.github.com
 * path when the allow-list is absent.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveAllowedWorkflow,
  deployWorkflowForBoundary,
  ALLOWED_DEPLOY_WORKFLOWS,
  DEPLOY_WORKFLOW_BY_BOUNDARY,
  DEFAULT_DEPLOY_WORKFLOW,
} from '../deploy-workflows';

/** What the route builds. Used to show a rejected value could not have escaped. */
const runUrl = (workflowFile: string) =>
  new URL(
    `https://api.github.com/repos/o/r/actions/workflows/${workflowFile}/runs?per_page=10`,
  ).toString();

describe('resolveAllowedWorkflow — attack cases', () => {
  it.each([
    ['../../../../../../user/repos', 'every repo the token can see'],
    ['../../../../../../user', 'the token owner identity'],
    ['..%2F..%2F..%2F..%2Fuser', 'percent-encoded traversal'],
    ['..\\..\\..\\..\\user', 'backslash traversal'],
    ['deploy-fiab-commercial.yml/../../../../user', 'valid prefix then escape'],
    ['deploy-fiab-commercial.yml ', 'trailing space'],
    ['DEPLOY-FIAB-COMMERCIAL.YML', 'case variation'],
    ['deploy-fiab-commercial.yaml', 'near-miss extension'],
    ['', 'empty'],
  ])('REFUSES %j (%s)', (candidate) => {
    expect(resolveAllowedWorkflow(candidate)).toBeNull();
  });

  it('REFUSES null/undefined without throwing', () => {
    expect(resolveAllowedWorkflow(null)).toBeNull();
    expect(resolveAllowedWorkflow(undefined)).toBeNull();
  });

  it('the traversal payload really would have escaped the workflows prefix', () => {
    // Establishes the vulnerability is real rather than theoretical: URL
    // normalisation collapses the `../` segments, so an unvalidated value does
    // NOT stay under /actions/workflows/.
    const escaped = runUrl('../../../../../../user/repos');
    expect(escaped).toBe('https://api.github.com/user/repos/runs?per_page=10');
    expect(escaped).not.toContain('/actions/workflows/');
  });

  it('allowed values stay under the workflows prefix', () => {
    for (const wf of ALLOWED_DEPLOY_WORKFLOWS) {
      expect(runUrl(wf)).toContain(`/actions/workflows/${wf}/runs`);
    }
  });
});

describe('resolveAllowedWorkflow — legitimate values', () => {
  it.each([...ALLOWED_DEPLOY_WORKFLOWS])('permits %s', (wf) => {
    expect(resolveAllowedWorkflow(wf)).toBe(wf);
  });
});

describe('the allow-list cannot drift from the dispatch map', () => {
  it('every workflow the deploy route can dispatch is pollable', () => {
    // The bug this prevents: adding a boundary to the map while the status route
    // keeps a stale hard-coded list, so the wizard dispatches a run it then
    // refuses to poll.
    for (const boundary of Object.keys(DEPLOY_WORKFLOW_BY_BOUNDARY)) {
      const wf = deployWorkflowForBoundary(boundary);
      expect(resolveAllowedWorkflow(wf), `boundary ${boundary}`).toBe(wf);
    }
  });

  it('the default is itself allowed', () => {
    expect(resolveAllowedWorkflow(DEFAULT_DEPLOY_WORKFLOW)).toBe(DEFAULT_DEPLOY_WORKFLOW);
  });

  it('an unknown boundary falls back to the default rather than undefined', () => {
    // `undefined` interpolated into the URL would produce a literal "undefined"
    // path segment and a confusing 404 instead of a deploy.
    expect(deployWorkflowForBoundary('Klingon')).toBe(DEFAULT_DEPLOY_WORKFLOW);
    expect(deployWorkflowForBoundary(undefined)).toBe(DEFAULT_DEPLOY_WORKFLOW);
    expect(deployWorkflowForBoundary(null)).toBe(DEFAULT_DEPLOY_WORKFLOW);
  });

  it('IL5 and GCC-High share the gcch workflow (documented behaviour, not a typo)', () => {
    expect(deployWorkflowForBoundary('IL5')).toBe(deployWorkflowForBoundary('GCC-High'));
  });
});
