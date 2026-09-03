#!/usr/bin/env node
/**
 * #4298 — say so when a skipped roll has stranded the estate.
 *
 * `loom-roll-and-validate`'s gate job is guarded on the producer concluding
 * `success` or `failure`. Anything else — overwhelmingly `cancelled`, because
 * the image builder's concurrency group cancels an older in-flight run on the
 * next merge — skips EVERY job in the workflow. GitHub records
 * `conclusion: skipped` with `steps: []`, which is neither red nor green, and
 * the estate quietly stops moving.
 *
 * This runner is the annotation that was missing. It does the I/O and hands the
 * judgement to `decideStranded`, which is pure and separately tested, so the
 * distinction between "the merge train will self-heal" and "nothing is coming"
 * cannot drift into a shell conditional nobody can exercise.
 *
 * FAIL-CLOSED BY CONSTRUCTION. If the producer-run query fails, `producerRuns`
 * is passed as `null` — never `[]` — so an unreadable API becomes `unknown`
 * rather than "no build is coming". `2>/dev/null` on the query would have
 * converted a token problem into a confident false claim, which is the exact
 * shape deploy-integrity R7 exists to forbid and which this repo has already
 * paid for twice.
 *
 * A 'failure' SUCCESSOR IS READ, NOT ASSUMED (#4300 review). The producer is a
 * matrix, and the gate rolls a run that concluded 'failure' when its
 * loom-console job succeeded (#3260). So for every newer run that concluded
 * 'failure' — `runsNeedingConsoleLookup` names the set — this runner reads the
 * loom-console job conclusion(s) with the SAME query the gate's
 * `console_conclusions()` uses (loom-roll-and-validate.yml), and passes them in
 * as `console_conclusions`. A failed lookup is `null`, never `[]`, for the same
 * reason as above; the decision reports it as unknown naming the run.
 *
 * Env:
 *   GITHUB_REPOSITORY      owner/repo
 *   UPSTREAM_CONCLUSION    github.event.workflow_run.conclusion
 *   UPSTREAM_CREATED_AT    github.event.workflow_run.created_at
 *   UPSTREAM_HEAD_SHA      github.event.workflow_run.head_sha
 *   PRODUCER_WORKFLOW      defaults to build-fiab-images-acr-tasks.yml
 *   GH_TOKEN               for `gh api`
 *
 * Exit 0 when benign; exit 1 when stranded or unknown.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { decideStranded, runsNeedingConsoleLookup, shouldFail } from './stranded-roll-decision.mjs';

const repo = process.env.GITHUB_REPOSITORY || '';
const producer = process.env.PRODUCER_WORKFLOW || 'build-fiab-images-acr-tasks.yml';
const conclusion = process.env.UPSTREAM_CONCLUSION || '';
const createdAt = process.env.UPSTREAM_CREATED_AT || '';
const headSha = process.env.UPSTREAM_HEAD_SHA || '';

/** One `gh api --jq` call parsed as JSON, or null when it failed. The reason is
 *  kept and printed — a swallowed stderr is how "I could not reach the registry"
 *  once became "the tag does not exist". */
function ghApiJson(what, endpoint, jq) {
  try {
    const out = execFileSync(
      'gh',
      ['api', endpoint, '--jq', jq],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    const detail = (e && (e.stderr?.toString() || e.message)) || String(e);
    console.log(`::notice::Could not read ${what}: ${detail.slice(0, 400)}`);
    return null;
  }
}

/** Producer runs, or null when the query itself failed. NEVER [] for a failure. */
function readProducerRuns() {
  return ghApiJson(
    `${producer} runs`,
    `repos/${repo}/actions/workflows/${producer}/runs?per_page=50`,
    '[.workflow_runs[] | {id, status, conclusion, created_at, head_sha}]',
  );
}

/** The loom-console job conclusion(s) of one producer run — the gate's
 *  `console_conclusions()` query, verbatim — or null when the lookup failed. */
function readConsoleConclusions(runId) {
  return ghApiJson(
    `the jobs of producer run ${runId}`,
    `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`,
    '[.jobs[] | select(.name | test("loom-console")) | .conclusion]',
  );
}

const producerRuns = readProducerRuns();
for (const r of runsNeedingConsoleLookup({ upstreamCreatedAt: createdAt, producerRuns })) {
  r.console_conclusions = readConsoleConclusions(r.id);
  console.log(`producer run ${r.id} concluded 'failure'; loom-console conclusion(s): ${r.console_conclusions === null ? '(unreadable)' : JSON.stringify(r.console_conclusions)}`);
}

const verdict = decideStranded({
  upstreamConclusion: conclusion,
  upstreamCreatedAt: createdAt,
  producerRuns,
  producerWorkflow: producer,
});

const title = {
  benign: 'Roll skipped, and that is fine',
  stranded: 'ROLL STRANDED — the estate did not move and nothing is coming',
  unknown: 'Roll skipped, and whether the estate is stranded was NOT established',
}[verdict.verdict];

const lines = [
  `## ${title}`,
  '',
  `The image build for \`${headSha.slice(0, 12) || '(unknown sha)'}\` concluded **\`${conclusion || '(none)'}\`**,`,
  'so every job in this roll was skipped by the gate condition. That condition is correct —',
  'you must not roll an image that was never built — but a `skipped` run is neither red nor',
  'green, so this note exists to say what it means.',
  '',
  `**Verdict: \`${verdict.verdict}\`.** ${verdict.why}`,
];
if (verdict.carrier) {
  const c = verdict.carrier;
  const consoleNote = Array.isArray(c.console_conclusions) ? `, loom-console: \`${c.console_conclusions.join(',')}\`` : '';
  lines.push('', `Carrier run: [\`${c.id}\`](https://github.com/${repo}/actions/runs/${c.id}) (\`${c.status}\`/\`${c.conclusion || '-'}\`${consoleNote}).`);
}
if (verdict.remediation) {
  lines.push('', 'Remediation:', '', '```', verdict.remediation, '```');
}

console.log(lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) {
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  } catch (e) {
    console.log(`::notice::could not write the job summary: ${String(e).slice(0, 200)}`);
  }
}

if (shouldFail(verdict.verdict)) {
  console.log(`::error title=${title}::${verdict.why} ${verdict.remediation ? `Remediation: ${verdict.remediation.replace(/\n/g, ' ; ')}` : ''}`);
  process.exit(1);
}
console.log(`::notice title=${title}::${verdict.why}`);
