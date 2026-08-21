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
 * CANCELLED IS NOT FAILED (#3368)
 *
 *   On 2026-08-13 this script filed #3356 — "full-app-deploy-commercial is
 *   failing", P0-shaped, citing R1 — from run 31710130307, whose conclusion is
 *   `cancelled`. The operator had cancelled it themselves to deconflict a
 *   duplicate ACR-lease holder; the deploy path was never broken. The caller's
 *   predicate was `needs.<job>.result != 'success'` inside an `if: always()`
 *   job, and `!= 'success'` is true for `cancelled` and for `skipped`.
 *
 *   Fixing that one `if:` would leave the class open, so the refusal lives
 *   HERE, at the chokepoint every caller goes through: `--result` is REQUIRED,
 *   and unless it classifies as a GENUINE failure this script logs and files
 *   NOTHING. A caller whose `if:` regresses can no longer manufacture a P0,
 *   and a new caller that forgets `--result` fails loudly (exit 2) instead of
 *   filing blind. Classification is shared with every other consumer in
 *   scripts/ci/run-outcome.mjs — one table, not N predicates.
 *
 * REDACTION LIVES AT THE POSTER BOUNDARY, NOT AT EACH FIELD (#3829)
 *
 *   This repository is PUBLIC, and this script is the widest-audience publisher
 *   in the deploy lane: what it writes lands in an issue title and body
 *   permanently, edit history included. A push publishes.
 *
 *   deploy-retry.mjs redacted `leaf.message` and `evidence.line` at their
 *   composition sites and missed `whyStopped` — which `decideRetryForLeaves`
 *   builds by embedding a leaf's `resourceName`, and for a
 *   `flexibleServers/administrators` leaf that name IS `<server>/<objectId>`.
 *   So a raw Entra object id reached issue #3817's auto-posted body.
 *
 *   Adding `redact()` to that one field would fix the INSTANCE and leave the
 *   CLASS: every future field added to this body would have to remember on its
 *   own, and the evidence of this repo is that one eventually will not.
 *
 *   So the redaction is applied at the POSTER — the last statement before the
 *   payload leaves the process — in notifyFailure(), over the TITLE and the BODY
 *   together. The first cut of this fix put it at the end of buildIssueBody()
 *   instead, which is one level ABOVE the boundary and left two holes: the title
 *   was never covered (it is derived from the workflow name), and `body` is a
 *   parameter, so any caller handing notifyFailure() a hand-built string posted
 *   it verbatim. Both were measured leaking before this was moved.
 *
 *   redact() is idempotent (`<guid>` and `<redacted>` contain nothing it
 *   matches), so buildIssueBody()'s own call and the per-site calls upstream in
 *   deploy-retry.mjs remain correct and are kept as defence in depth.
 *
 *   Round 3 closed the two residuals that boundary did not cover. The API is not
 *   the only surface this process publishes to: main() printed `${workflow}`
 *   RAW into a `::notice::` annotation and into stdout, and both are public in
 *   this repo's Actions logs — measured, a `--workflow` carrying a GUID emitted
 *   it verbatim on the not-filed path. And redact() returns '' for a non-string,
 *   so applying it bare to the `body` PARAMETER had converted a malformed body
 *   from "the API rejects it and the step fails" into "an EMPTY P0 notice is
 *   filed and the run exits 0" — a regression this fix itself introduced,
 *   against notifyFailure()'s own stated contract below. Both are pinned by
 *   tests that go red when reverted.
 *
 *   Round 4 finished the job round 3 started HALF way. Round 3 redacted the
 *   `workflow` INTERPOLATION and left `result` — its immediate neighbour on the
 *   very same `::notice::` statement — raw, and `result` reaches that line twice:
 *   once directly and once embedded in `decision.why` by shouldFile(). Measured
 *   at round-3 head:
 *
 *     --result 11111111-2222-3333-4444-555555555555
 *     ::notice::… ("11111111-2222-3333-4444-555555555555") … (observed result:
 *     "11111111-2222-3333-4444-555555555555", category: unknown)
 *
 *   Redacting one interpolation and leaving the one beside it raw IS the
 *   field-by-field defect this whole change exists to delete. So there is no
 *   per-variable redaction left in this file: formatStdout() below is the single
 *   boundary every byte of stdout crosses, exactly as formatAnnotation() is for
 *   scripts/ci/deploy-retry.mjs, and the raw values are interpolated freely
 *   because nothing downstream of the boundary can publish them unredacted.
 *
 * USAGE (from a workflow `if: failure()` step)
 *   GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
 *   node .github/scripts/deploy-notify-failure.mjs \
 *     --workflow deploy-fiab-commercial --result "${{ job.status }}" \
 *     --failure-json deploy-failure.json
 *
 * Tests: node --test .github/scripts/__tests__/deploy-notify-failure.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyOutcome } from '../../scripts/ci/run-outcome.mjs';
import { redact } from '../../scripts/ci/_azure-redact.mjs';

/** The only label guaranteed to exist in this repo; creating one we do not have would fail the notify. */
export const FAILURE_LABEL = 'deploy-validation';

export function buildIssueTitle(workflow) {
  return `deploy: ${workflow} is failing`;
}

/**
 * The notice body. Says exactly what is known and, when nothing was captured,
 * says THAT rather than implying a cause (deploy-integrity.md R7).
 *
 * THE REDACTION BOUNDARY (#3829). Every line assembled below passes through
 * redact() exactly once, at the return. Nothing that reaches a PUBLIC issue
 * body may carry a subscription/tenant id, a full ARM resource id, or a bare
 * GUID — and that property is enforced HERE, for the whole body, rather than
 * field by field where the next addition would have to remember.
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
  // THE BOUNDARY. One call, covering every line above and every line a future
  // change adds (#3829). Do not move this to the individual pushes.
  return redact(lines.join('\n'));
}

/**
 * Find the open notice issue, or create it, then comment. `request` is the
 * injectable transport so this is testable without GitHub.
 *
 * THE POSTER BOUNDARY (#3829 round 2). redact() is applied HERE — the last
 * statement before the payload leaves the process — over BOTH the title and the
 * body, for three reasons the buildIssueBody() call site could not cover:
 *
 *   1. The TITLE was never redacted at all. It is derived from `--workflow` /
 *      GITHUB_WORKFLOW, and a workflow name containing a GUID would have put one
 *      in a public issue title, permanently, in the issue LIST.
 *   2. `body` is a parameter, not necessarily buildIssueBody()'s return. Any
 *      caller — present or future — that hands this function a hand-built string
 *      posted it verbatim.
 *   3. The SEARCH is matched on the redacted title, so the notice issue is found
 *      by the same string it was created under. Redacting only at creation would
 *      open a duplicate issue on every subsequent run.
 *
 * redact() is idempotent, so buildIssueBody()'s own call remains correct and is
 * kept as defence in depth.
 *
 * STRING() BEFORE REDACT(), AND FOR A NARROWER REASON THAN ROUND 3 CLAIMED.
 * redact() returns '' for a non-string, so applying it BARE to `body` turns a
 * malformed body into an EMPTY P0 notice filed with exit 0 — the swallow the
 * paragraph below forbids. `body` is a PARAMETER — reason 2 above — so the shape
 * is reachable by any future caller rather than hypothetical.
 *
 * Round 3 justified this with "before this redaction existed a non-string
 * reached the API and threw, and the step failed as it should have". That is
 * true for a plain OBJECT — `{"body":{"msg":"…"}}` is not a valid create-issue
 * payload — but it is FALSE for `undefined` and `null`, and the correction
 * matters because those are the likelier accidents. Measured on the wire:
 *
 *   body: {msg:'…'}  ->  {"title":…,"body":{"msg":"…"},"labels":[…]}   rejected
 *   body: undefined  ->  {"title":…,"labels":[…]}                      ACCEPTED
 *   body: null       ->  {"title":…,"body":null,"labels":[…]}          ACCEPTED
 *
 * JSON.stringify DROPS an undefined-valued key, so an `undefined` body was never
 * a malformed request at all: it already filed a bodiless P0 notice and exited
 * 0, before and after the redaction. (The wire payloads above are measured; the
 * accept/reject column is the GitHub API's documented handling of them, not
 * something this repo has probed.) So String() is not restoring a pre-existing
 * failure for those two — it is the thing that makes them visible for the first
 * time, by posting `undefined` instead of nothing at all. A bad body degrades to
 * a visibly-wrong notice instead of a silently-empty one, a message object with
 * a real toString() survives intact, and the redaction still runs over whatever
 * the stringification produced.
 *
 * Returns `{ issueNumber, created }`. Throws on any API failure — a notifier
 * that cannot notify must fail the step, not swallow.
 */
export async function notifyFailure({ repo, workflow, body, request }) {
  const title = redact(buildIssueTitle(workflow));
  const safeBody = redact(String(body));
  const [owner, name] = repo.split('/');

  const found = await request('GET', `/repos/${owner}/${name}/issues?state=open&labels=${FAILURE_LABEL}&per_page=100`);
  if (!Array.isArray(found)) {
    throw new Error(`issue search returned ${JSON.stringify(found)?.slice(0, 200)} — cannot tell whether a notice issue exists`);
  }
  const existing = found.find((i) => i.title === title && !i.pull_request);

  if (existing) {
    await request('POST', `/repos/${owner}/${name}/issues/${existing.number}/comments`, { body: safeBody });
    return { issueNumber: existing.number, created: false };
  }

  const created = await request('POST', `/repos/${owner}/${name}/issues`, {
    title,
    body: safeBody,
    labels: [FAILURE_LABEL],
  });
  if (!created?.number) throw new Error('issue creation returned no number — the notice was not filed');
  return { issueNumber: created.number, created: true };
}

/**
 * Should this outcome be FILED as a deploy-failure P0, or merely logged?
 *
 * PURE, and the single decision point for #3368. Returns the classification
 * alongside the verdict so the caller can print a message that is TRUE for the
 * state it actually observed (deploy-integrity.md R7) instead of asserting a
 * failure it never established.
 *
 * @param {string|null|undefined} result a GitHub job `result` / run `conclusion`
 * @returns {{file: boolean, category: string, why: string}}
 */
export function shouldFile(result) {
  const c = classifyOutcome(result);
  if (c.genuineFailure) {
    return { file: true, category: c.category, why: `the run ${c.label}` };
  }
  if (c.category === 'success') {
    return {
      file: false,
      category: c.category,
      why: 'the run SUCCEEDED — there is nothing to file. The caller\'s `if:` condition is wrong.',
    };
  }
  return {
    file: false,
    category: c.category,
    why:
      `the run ${c.label}. A cancellation, a skip or an unfinished run is NOT evidence that the deploy ` +
      'path is broken, and filing it as a P0 costs exactly what a real P0 costs (#3368). Logged, not filed.',
  };
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

/** Present at all? Distinct from `arg()`, because an EMPTY value is meaningful. */
function hasArg(name, argv) {
  return argv.indexOf(`--${name}`) !== -1;
}

/**
 * THE STDOUT BOUNDARY (#3829 round 4). Every byte this process writes to stdout
 * passes through here and is redacted ONCE.
 *
 * NOT per-variable, deliberately, and this is the second time that lesson has
 * been paid for in this file. Round 3 redacted `${workflow}` on the not-filed
 * `::notice::` line and left `${result}` — the next interpolation on the SAME
 * statement — raw; `result` also reaches that line a second time inside
 * `decision.why`, which shouldFile() builds by embedding the observed value. A
 * reviewer measured `--result <guid>` emitting the id verbatim, twice, into a
 * public Actions log. Per-field redaction fails the same way every time: the
 * field that is added next does not know it has to opt in.
 *
 * So callers below interpolate RAW values and never call redact() themselves.
 * The only way to publish to stdout from this file is through emit(), and the
 * only way through emit() is through here. Exported and PURE so a test can
 * mutate it to a pass-through and see the suite go red — an end-to-end
 * assertion alone could not tell this boundary from redact()'s other callers
 * (csa_loom_mutation_that_does_not_move_the_verdict).
 *
 * String() first, for the reason formatAnnotation() does it: redact() returns ''
 * for a non-string, and a log line that silently vanished would be a worse
 * failure than the one it was reporting.
 *
 * @param {unknown} text
 * @returns {string} the exact bytes written to stdout
 */
export function formatStdout(text) {
  return redact(String(text));
}

function emit(text) {
  process.stdout.write(formatStdout(text));
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

  // THE RUN LOG IS A PUBLISHED SURFACE TOO (#3829 round 3/4). notifyFailure()
  // covers what reaches the GitHub API; it does not cover what this function
  // PRINTS, and this repo's Actions logs are public. Both stdout writes below go
  // through emit() → formatStdout(), the single boundary — so `workflow`,
  // `result`, `decision.why` and anything a future line adds are redacted by
  // construction rather than one remembered call at a time. Round 3 redacted
  // `workflow` here per-variable and left `result` raw on the same statement;
  // that per-variable local is gone.

  // #3368 — the outcome must be SUPPLIED, not assumed. An invocation with no
  // --result cannot tell a failure from a cancellation, and this script's whole
  // job is to assert one of them. Missing is a hard usage error rather than a
  // default, because a default is how six callers get it right and the seventh
  // silently does not.
  if (!hasArg('result', argv)) {
    process.stderr.write(
      'deploy-notify-failure: --result is REQUIRED (pass "${{ job.status }}" or the specific ' +
        'needs.<job>.result that failed). Without it this script cannot tell a genuine failure from a ' +
        'cancellation, and it filed a false P0 that way once already (#3356 / #3368). Refusing to file.\n',
    );
    process.exit(2);
  }

  const result = arg('result', argv) ?? '';
  const decision = shouldFile(result);
  if (!decision.file) {
    // NOT an error: this is the designed outcome for a cancelled run. Exit 0 so
    // a cancellation does not itself turn a run red, but say plainly what was
    // observed and what was therefore not done.
    emit(
      `::notice::deploy-notify-failure: no issue filed for ${workflow} — ${decision.why} ` +
        `(observed result: "${result || '<empty>'}", category: ${decision.category})\n`,
    );
    return;
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
  emit(`deploy-notify-failure: ${created ? 'opened' : 'updated'} #${issueNumber} for ${workflow}.\n`);
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((e) => {
    // stderr is a published surface in this repo's Actions logs too, and this
    // handler sits OUTSIDE the four surfaces #3829 enumerated. No live carrier
    // is known — a probe of the most plausible one (a fetch failure) showed V8
    // truncates the message too short to carry an id — but "no carrier today" is
    // the argument that was wrong twice already in this file. Redact anyway.
    process.stderr.write(redact(`deploy-notify-failure: ${e.message}\n`));
    process.exit(1);
  });
}
