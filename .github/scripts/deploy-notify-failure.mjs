#!/usr/bin/env node
/**
 * deploy-notify-failure.mjs — a deploy failure notice that someone receives.
 *
 * WHY THIS EXISTS
 *
 *   Four deploy workflows notified failure like this:
 *
 *     github.rest.issues.createComment({
 *       issue_number: 279,
 *       body: `❌ deploy-fiab-commercial failed in run ${context.runId}. Check workflow logs.`
 *     })
 *
 *   Issue #279 is "CSA Loom — v1 build roadmap": state CLOSED, 289 comments.
 *   Every daily failure for 47+ days was appended to a closed roadmap issue
 *   nobody watches. That is the literal mechanism by which the breakage in
 *   deploy-integrity.md's opening incident stayed invisible.
 *
 *   Three defects in five lines:
 *     1. the target is a closed issue (nobody is notified);
 *     2. "Check workflow logs" is the generic, unclassified, unactionable
 *        message R6 forbids;
 *     3. the promise was neither awaited nor returned, so a REJECTED
 *        createComment would not have failed the step — the notifier could
 *        itself fail silently.
 *
 * WHAT THIS DOES INSTEAD
 *
 *   One DEDICATED, auto-titled, OPEN issue per failing workflow:
 *       "deploy: <workflow> is failing"
 *   Found by search → commented. Not found → created. The body is the
 *   CLASSIFIED failure from scripts/ci/deploy-retry.mjs's deploy-failure.json
 *   when one exists (class, what was established, the remediation), and an
 *   explicit "no classification was captured" statement when one does not —
 *   never an implied cause (R7).
 *
 *   Every API call is awaited and its status checked. A notifier that cannot
 *   notify exits non-zero.
 *
 * USAGE (from a workflow `if: failure()` step)
 *   GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
 *   node .github/scripts/deploy-notify-failure.mjs \
 *     --workflow deploy-fiab-commercial --failure-json deploy-failure.json
 *
 * Tests: node --test .github/scripts/__tests__/deploy-notify-failure.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The only label guaranteed to exist in this repo; creating one we do not have would fail the notify. */
export const FAILURE_LABEL = 'deploy-validation';

export function buildIssueTitle(workflow) {
  return `deploy: ${workflow} is failing`;
}

/**
 * The notice body. Says exactly what is known and, when nothing was captured,
 * says THAT rather than implying a cause (deploy-integrity.md R7).
 */
export function buildIssueBody({ workflow, runId, runUrl, sha, failure }) {
  const lines = [
    `**${workflow}** failed.`,
    '',
    `- run: ${runUrl ?? `(run ${runId})`}`,
    `- commit: \`${sha ?? 'unknown'}\``,
    '',
  ];

  if (!failure) {
    lines.push(
      '**No classification was captured for this failure.**',
      '',
      'The failing step did not run through `scripts/ci/deploy-retry.mjs`, so no ' +
        '`deploy-failure.json` was produced and nothing is asserted here about the cause. ' +
        'Wiring that step through the retry harness is the fix — see ' +
        '`scripts/ci/check-deploy-failure-handling.mjs` (C2).',
    );
  } else {
    lines.push(
      `**Classification: ${failure.class}**${failure.signalId ? ` (\`${failure.signalId}\`)` : ''}`,
      `- retryable: \`${failure.retryable === true}\``,
      `- attempts: ${failure.attempts?.length ?? 'unknown'}`,
      `- stopped because: ${failure.whyStopped ?? 'unknown'}`,
      '',
    );
    if (failure.class === 'unknown') {
      lines.push(
        'The output did not match any signal in the CSA Loom failure taxonomy, so **no cause is ' +
          'asserted**. This is a gap in `apps/fiab-console/lib/deploy/failure-taxonomy.json` — ' +
          'add the observed signal there.',
        '',
      );
    }
    if (failure.established?.length) {
      lines.push('**Established from the output:**', '');
      for (const e of failure.established) lines.push(`- \`${e.signal}\` — ${e.line}`);
      lines.push('');
    }
    if (failure.remediation) {
      lines.push(`**Remediation (${failure.remediationKind}):** ${failure.remediation}`, '');
    }
    if (failure.grantHint) lines.push('```', failure.grantHint, '```', '');
    if (failure.portalPath) lines.push(`Portal: ${failure.portalPath}`, '');
  }

  lines.push(
    '---',
    'Per `deploy-integrity.md` R1 a broken deploy path is P0 and preempts feature work. ' +
      'Close this issue only once the path has run GREEN — not on a merge (R2).',
  );
  return lines.join('\n');
}

/**
 * Find the open notice issue, or create it, then comment. `request` is the
 * injectable transport so this is testable without GitHub.
 *
 * Returns `{ issueNumber, created }`. Throws on any API failure — a notifier
 * that cannot notify must fail the step, not swallow.
 */
export async function notifyFailure({ repo, workflow, body, request }) {
  const title = buildIssueTitle(workflow);
  const [owner, name] = repo.split('/');

  const found = await request('GET', `/repos/${owner}/${name}/issues?state=open&labels=${FAILURE_LABEL}&per_page=100`);
  if (!Array.isArray(found)) {
    throw new Error(`issue search returned ${JSON.stringify(found)?.slice(0, 200)} — cannot tell whether a notice issue exists`);
  }
  const existing = found.find((i) => i.title === title && !i.pull_request);

  if (existing) {
    await request('POST', `/repos/${owner}/${name}/issues/${existing.number}/comments`, { body });
    return { issueNumber: existing.number, created: false };
  }

  const created = await request('POST', `/repos/${owner}/${name}/issues`, {
    title,
    body,
    labels: [FAILURE_LABEL],
  });
  if (!created?.number) throw new Error('issue creation returned no number — the notice was not filed');
  return { issueNumber: created.number, created: true };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function ghRequest(apiBase, token) {
  return async (method, url, body) => {
    const res = await fetch(`${apiBase}${url}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'csa-loom-deploy-notify',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub API ${method} ${url} → ${res.status}: ${text.slice(0, 300)}`);
    }
    return res.json();
  };
}

function arg(name, argv) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1];
}

async function main() {
  const argv = process.argv.slice(2);
  const workflow = arg('workflow', argv) ?? process.env.GITHUB_WORKFLOW;
  const failureJson = arg('failure-json', argv);
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;

  if (!workflow || !repo || !token) {
    process.stderr.write(
      'deploy-notify-failure: need --workflow, GITHUB_REPOSITORY and GH_TOKEN. Refusing to run — ' +
        'a notifier that quietly does nothing is worse than none.\n',
    );
    process.exit(2);
  }

  let failure = null;
  if (failureJson && fs.existsSync(failureJson)) {
    failure = JSON.parse(fs.readFileSync(failureJson, 'utf8'));
  }

  const serverUrl = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
  const body = buildIssueBody({
    workflow,
    runId: process.env.GITHUB_RUN_ID,
    runUrl: `${serverUrl}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`,
    sha: process.env.GITHUB_SHA,
    failure,
  });

  const apiBase = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const { issueNumber, created } = await notifyFailure({
    repo,
    workflow,
    body,
    request: ghRequest(apiBase, token),
  });
  process.stdout.write(
    `deploy-notify-failure: ${created ? 'opened' : 'updated'} #${issueNumber} for ${workflow}.\n`,
  );
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((e) => {
    process.stderr.write(`deploy-notify-failure: ${e.message}\n`);
    process.exit(1);
  });
}
