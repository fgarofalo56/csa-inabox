#!/usr/bin/env node
/**
 * check-bicepparam-env-reaches-deploy.mjs
 *
 * RULE. If a `.bicepparam` reads an image tag with `readEnvironmentVariable('X',
 * 'default')`, then every workflow step that RUNS a deployment with that param
 * file must have `X` in scope — by step `env:`, job `env:`, workflow `env:`, or
 * a `$GITHUB_ENV` write from an earlier step in the same job.
 *
 * WHY (#3161). `gcc-high.bicepparam` and `il5.bicepparam` both do:
 *
 *     unity: readEnvironmentVariable('LOOM_UNITY_TAG', 'v0.1')
 *     trino: readEnvironmentVariable('LOOM_TRINO_TAG', 'v0.1')
 *
 * and the step that ran `az deployment sub create` had NO `env:` block at all.
 * So every full Gov deploy silently fell back to the DEFAULT and wrote the
 * mutable `v0.1` onto `loom-unity`, `iceberg-catalog` (same image) and
 * `loom-trino` — reverting any SHA-pinned roll of those apps, with no error and
 * nothing in the log to say it had happened.
 *
 * That is the worst shape a deploy bug can take: it succeeds. Nothing fails,
 * the estate quietly goes back to a floating tag, and the next person to ask
 * "why is Gov running v0.1 again?" has no signal to follow.
 *
 * A DEFAULT MAKES IT SILENT. `readEnvironmentVariable('X', 'fallback')` cannot
 * fail — that is the point of the fallback, and it is also why nothing caught
 * this for the entire life of both lanes.
 *
 * ── WHAT THE FIRST VERSION OF THIS GUARD COULD NOT SEE (2026-08-13) ──────────
 *
 * The guard shipped with #3303 passed on a tree with THREE live blind spots,
 * each of which is the same shape as the bug it was written for — a deploy that
 * resolves image tags with nothing watching:
 *
 *   1. STEP-SCOPED PARAM ATTRIBUTION. It only considered a step "deploying" a
 *      param file if the step body LITERALLY contained the filename, and
 *      `continue`d otherwise. deploy-fiab-commercial.yml composes
 *      `--parameters …/commercial.bicepparam` into a variable in one step and
 *      runs `az deployment sub create` in another, so the single most important
 *      Commercial deploy step was SKIPPED — silently, and indistinguishably
 *      from "checked and fine". Attribution is now JOB-scoped: a step deploys
 *      whatever param file its job names, whichever step names it.
 *
 *   2. `azd provision`. The GCC-High and GCC lanes take an `azd provision`
 *      branch on every non-dlz-attach run. The verb list was `az deployment
 *      sub|group create` only, so an entire sovereign provisioning path was
 *      outside the rule.
 *
 *   3. `what-if`. `whatif-only` is the DEFAULT run mode of all four deploy
 *      lanes, so the what-if IS the artifact an operator reads before approving
 *      a full run. A what-if that resolves different image tags than the apply
 *      will use is a LYING PREVIEW: it shows image churn that will not happen,
 *      or hides churn that will. deploy-integrity.md R7 — an error (or a
 *      preview) must not assert something it did not establish.
 *
 * Each was found by asking what the guard reports when the answer is UNKNOWN,
 * rather than by reading what it reports when the answer is fine.
 *
 * SCOPE. Only `LOOM_*_TAG` reads are enforced, because those pin a container
 * IMAGE and getting one wrong silently changes what is running. Other
 * readEnvironmentVariable values (feature toggles, endpoints) fail loudly or are
 * genuinely optional; widening this rule to all of them would flag correct code
 * and get the rule muted.
 *
 * SELF-DEFENCE. Fails if it finds no param files, no env reads, no deploying
 * steps, or a tag-reading param file that no workflow deploys and that is not
 * declared below — a matcher that has drifted off the code must not report a
 * pass. The mutation controls live in
 * scripts/ci/__tests__/bicepparam-env-reaches-deploy.test.mjs.
 *
 * Run: node scripts/ci/check-bicepparam-env-reaches-deploy.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readLogicalLines } from './_logical-lines.mjs';
import { producerEnvWrites } from './_github-env-producers.mjs';

const ROOT = process.cwd();
const PARAM_DIR = join(ROOT, 'platform', 'fiab', 'bicep', 'params');
const WF_DIR = join(ROOT, '.github', 'workflows');

/**
 * Tag-reading param files that NO workflow deploys, and why that is true rather
 * than a matcher that has drifted.
 *
 * This is a DECLARATION, not a mute: a file listed here is still parsed, and a
 * file that acquires a deployer stops being reported. What it buys is that a
 * NEW param file with no deployer cannot appear silently — adding a name here
 * is a reviewable act in a diff, which is the difference between a ratchet and
 * an allowlist.
 */
export const NO_AUTOMATED_DEPLOYER = Object.freeze({
  'tenant-dmlz.bicepparam':
    'operator/manual only — no automated caller (same finding as the appimagetags-coverage guard). ' +
    'Its tags cannot be silently reverted by CI because CI never deploys it.',
});

/**
 * Every command that submits a template to ARM, and whether it CHANGES the
 * estate or only previews it. Both are in scope: a preview that resolves
 * different tags than the apply is a preview of a deployment that will not
 * happen.
 */
export const DEPLOY_VERBS = Object.freeze([
  { re: /az\s+deployment\s+(?:sub|group|mg|tenant)\s+create/, name: 'az deployment create', kind: 'apply' },
  { re: /az\s+stack\s+(?:sub|group|mg)\s+create/, name: 'az stack create', kind: 'apply' },
  { re: /azd\s+(?:provision|up)\b/, name: 'azd provision', kind: 'apply' },
  { re: /az\s+deployment\s+(?:sub|group|mg|tenant)\s+what-if/, name: 'az deployment what-if', kind: 'preview' },
  { re: /az\s+deployment\s+(?:sub|group|mg|tenant)\s+validate/, name: 'az deployment validate', kind: 'preview' },
]);

/**
 * Steps that run one of these EXPORT tag env vars into `$GITHUB_ENV` for every
 * later step in the job.
 *
 * THE TABLE LIVES IN `./_github-env-producers.mjs` (#3449) and is re-exported
 * here for the callers that already import it from this module. It moved
 * because check-workflow-unset-vars.mjs needs the SAME fact — "a Node script
 * assigned this name" — and had no way to know it: it detects only the literal
 * `echo "NAME=…" >> "$GITHUB_ENV"` shell form, so `adopt-image-tags.mjs`'s
 * seventeen writes read as unassigned and it refused a correct Gov lane. Two
 * guards asking one question get one table, or they drift.
 */
export { GITHUB_ENV_PRODUCERS } from './_github-env-producers.mjs';

/**
 * Normalise CRLF before ANY indent- or line-anchored matching.
 *
 * On a Windows checkout git hands these files back with `\r\n`, so a pattern
 * ending `env:\n` never matches and every step reads as having no `env:` block.
 * That made the first version of this guard report 32 violations on a tree that
 * was correct — and, worse, it had CANCELLED OUT a second bug: the old
 * `globalEnvKeys` regex used `\s`, which matches `\r`, so it kept finding keys
 * the step matcher had already lost. Two defects producing a plausible answer
 * between them.
 *
 * CI runs Linux, so this only ever misfired locally — which is precisely where
 * a guard gets verified before it ships.
 */
export function normalize(s) {
  return String(s).replace(/\r\n/g, '\n');
}

/**
 * Drop YAML comment lines.
 *
 * WHY THIS IS NOT COSMETIC. The first version of this guard flagged
 * loom-guardrails.yml itself — because the comment REGISTERING this very rule
 * quotes both `az deployment sub create` and `il5.bicepparam` while describing
 * the bug. A rule that matches its own documentation is a rule that fires on
 * whoever documents it, and the fix people reach for is deleting the comment.
 *
 * Only whole-line comments are stripped: a `#` inside a shell string is not a
 * comment, and treating it as one would hide real code from the scan.
 */
export function stripYamlComments(s) {
  return String(s).split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
}

/** envVar -> default, for every `LOOM_*_TAG` a param file reads. */
export function tagReads(text) {
  const out = new Map();
  const re = /readEnvironmentVariable\(\s*'(LOOM_[A-Z0-9_]*TAG)'\s*,\s*'([^']*)'/g;
  for (const m of normalize(text).matchAll(re)) out.set(m[1], m[2]);
  // A read with no default is still a read; record it with a null default.
  for (const m of normalize(text).matchAll(/readEnvironmentVariable\(\s*'(LOOM_[A-Z0-9_]*TAG)'\s*\)/g)) {
    if (!out.has(m[1])) out.set(m[1], null);
  }
  return out;
}

/**
 * Split a workflow into jobs WITHOUT a YAML parser: this file must not depend on
 * js-yaml being installed for a guard that runs before install in some lanes.
 * Job ids sit at indent 2 under `jobs:`; job keys at 4; steps at 6.
 */
export function jobsOf(text) {
  const lines = normalize(text).split('\n');
  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (jobsAt === -1) return [];
  const starts = [];
  for (let i = jobsAt + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break; // left the `jobs:` block entirely
    if (/^ {2}[A-Za-z_][A-Za-z0-9_-]*:\s*$/.test(lines[i])) starts.push(i);
  }
  return starts.map((s, i) => ({
    id: lines[s].trim().replace(/:$/, ''),
    body: lines.slice(s, i + 1 < starts.length ? starts[i + 1] : lines.length).join('\n'),
  }));
}

/** Steps are `      - name:` at a fixed indent in every workflow in this repo. */
export function stepsOf(text) {
  const lines = normalize(text).split('\n');
  const starts = [];
  lines.forEach((l, i) => { if (/^ {6}- name:/.test(l)) starts.push(i); });
  return starts.map((s, i) => ({
    name: (lines[s].split('name:')[1] || '').trim(),
    body: lines.slice(s, i + 1 < starts.length ? starts[i + 1] : lines.length).join('\n'),
  }));
}

/**
 * Env keys declared by an `env:` block at exactly `indent`.
 *
 * THE FIRST VERSION OF THIS FUNCTION MADE THE GUARD USELESS. It scanned
 * `^\s{2,10}([A-Z_]+):` — which matches keys inside ANY STEP's `env:` block too,
 * at indent 10. So a workflow passed as long as *some* step set the variable.
 *
 * That is exactly the #3161 shape: `LOOM_UNITY_TAG` WAS set — on the image
 * preflight step — while the step that actually deployed had no `env:` at all.
 * The guard would have looked at that file and reported OK. Caught by mutating
 * the fix away and getting ZERO errors: a guard that cannot fail on its own
 * motivating bug is worse than no guard, because it also tells you the class is
 * covered.
 */
export function envKeysAtIndent(text, indent) {
  const out = new Set();
  const lines = normalize(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)env:\s*$/.exec(lines[i]);
    if (!m || m[1].length !== indent) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const km = /^(\s+)([A-Za-z_][A-Za-z0-9_]*):/.exec(lines[j]);
      if (!km || km[1].length <= indent) break;
      out.add(km[2]);
    }
  }
  return out;
}

/**
 * Keys a step exports to every LATER step in its job.
 *
 * Two mechanisms, both real in this repo:
 *   - a literal `echo "NAME=…" >> "$GITHUB_ENV"`
 *   - a producer script whose exported keys are known (GITHUB_ENV_PRODUCERS)
 *
 * Literal spaces are used in the anchors, not `\s`: `\s` also matches `\r` and
 * `\n`, which is how the CRLF bug above stayed invisible for as long as it did.
 */
export function githubEnvExports(stepBody) {
  const out = new Set();
  const body = normalize(stepBody);
  for (const line of body.split('\n')) {
    if (!line.includes('GITHUB_ENV')) continue;
    for (const m of line.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=/g)) out.add(m[1]);
  }
  for (const k of producerEnvWrites(body)) out.add(k);
  return out;
}

/**
 * True when this step FORCES `deployAppsEnabled=false` on the command line.
 *
 * `appImageTags` is only ever dereferenced inside admin-plane/main.bicep's
 * `appDeployments` nested deployment, whose condition includes
 * `deployAppsEnabled`. A command-line `--parameters deployAppsEnabled=false`
 * beats the param file, so no Container App image reference is evaluated at all
 * and the tag env vars provably cannot change the outcome.
 *
 * bicep-whatif.yml and loom-drift-check.yml both do this on every what-if, by
 * design — the app plane rolls continuously and is deliberately outside their
 * drift verdict. Flagging them would demand sixteen env lines that change
 * nothing, which is how a rule earns a reputation for noise and gets muted.
 *
 * ONLY the literal `false` counts. `deployAppsEnabled=${{ inputs.something }}`
 * is UNKNOWN and stays in scope — an unread value must never be spent as a
 * reason to skip a check.
 */
export function forcesAppsDisabled(stepBody) {
  return /--parameters\s+deployAppsEnabled=false\b/.test(normalize(stepBody));
}

/**
 * The literal fallback each `LOOM_*_TAG` env line supplies, from lines shaped
 *
 *     LOOM_UNITY_TAG: ${{ vars.LOOM_UNITY_TAG || 'v0.1' }}
 *
 * WHY THIS IS A SEPARATE RULE FROM "IS IT IN SCOPE". Setting the variable is
 * necessary and not sufficient: the value has to be the one the param file
 * declares, or the env block becomes a SECOND, invisible source of truth for
 * the image tag.
 *
 * That is not hypothetical — it is what the #3161 fix itself did. #3303 added
 * sixteen `${{ vars.LOOM_X_TAG || 'v0.1' }}` lines to the IL5 deploy step, but
 * SIX of il5.bicepparam's defaults are not `v0.1`:
 *
 *     LOOM_CONSOLE_TAG      il5 declares 'v3.0'   the env line forced 'v0.1'
 *     LOOM_MCP_TAG          il5 declares 'v0.7'   the env line forced 'v0.1'
 *     LOOM_ORCHESTRATOR_TAG / ACTIVATOR / MIRRORING / DIRECTLAKE — same
 *
 * With the repo variables unset (their normal state) that silently repointed
 * six IL5 apps off the tags the param file declares — including loom-console,
 * whose `v3.0` gov-build-images.yml special-cases a build for precisely because
 * il5.bicepparam asks for it. Fixing an invisible override with a different
 * invisible override.
 */
export function envFallbacks(text) {
  const out = new Map();
  const re = /^\s*(LOOM_[A-Z0-9_]*TAG):\s*\$\{\{\s*vars\.\1\s*\|\|\s*'([^']*)'\s*\}\}/gm;
  for (const m of normalize(text).matchAll(re)) out.set(m[1], m[2]);
  return out;
}

/** Which deploy verbs a step runs. */
export function deployVerbsIn(stepBody) {
  return DEPLOY_VERBS.filter((v) => v.re.test(normalize(stepBody)));
}

/**
 * A line that only PRINTS text. It cannot deploy anything, so a param filename
 * inside one is a mention, never a use.
 *
 * This is the #2816 false positive the sibling guard
 * (check-deploy-paths-coverage.mjs) learned the hard way, reproduced here
 * exactly: gov-uc-purview-wire.yml refuses a run with
 *
 *     echo "::error::loom-unity:v0.1 is NOT in $ACR … that is the exact tag
 *           gcc-high/il5.bicepparam pull …"
 *
 * i.e. a step that deploys `loom-unity-app.bicep` and merely NAMES il5's param
 * file while explaining itself. Attributing il5's 16 tags to it produced 16
 * confident, wrong errors — and the fix a reader reaches for is deleting the
 * sentence that explains the refusal.
 */
export function isInertLine(line) {
  return /(^|\s)echo\s/.test(line) || /::(error|warning|notice)::/.test(line);
}

/**
 * Which param files a chunk of workflow YAML actually DEPLOYS.
 *
 * ARGUMENT POSITION, not mention. A filename counts only when it appears on a
 * line that hands it to a template command (`--parameters`, `--param-file`,
 * `-p`) or is the value of a `*PARAM*` key — loom-drift-check.yml sets
 * `PARAMS_FILE: gcc-high.bicepparam` at job level and deploys
 * `--parameters "platform/fiab/bicep/params/$PARAMS_FILE"`, which no
 * literal-in-the-step matcher can follow.
 */
export function paramFilesUsedIn(text, paramNames) {
  const used = new Set();
  // LOGICAL lines (#3420). This needs the ARGUMENT FLAG and the param FILENAME
  // on one command, and an `az deployment sub create` is always wrapped:
  //
  //     az deployment sub create \
  //       --template-file platform/fiab/bicep/main.bicep \
  //       --parameters \
  //         platform/fiab/bicep/params/gcc-high.bicepparam
  //
  // A physical-line read then finds no param file for the step — and finding
  // none does not report a violation, it SKIPS the workflow, so the question
  // "does the deploy set every env var this param file reads?" is never asked.
  // That is the #3161 shape this guard exists for: 16 image tags silently
  // defaulted because a read had a default and therefore could not fail.
  for (const { text: line } of readLogicalLines(normalize(text))) {
    if (isInertLine(line)) continue;
    const isArg = /--parameters\b|--param-file\b|(^|\s)-p\s/.test(line);
    const isParamKey = /^\s*[A-Za-z_]*[Pp][Aa][Rr][Aa][Mm][A-Za-z_]*:\s*\S/.test(line);
    if (!isArg && !isParamKey) continue;
    for (const p of paramNames) if (line.includes(p)) used.add(p);
  }
  return [...used];
}

/**
 * Analyse one workflow.
 *
 * @param {string} file      workflow filename (for messages)
 * @param {string} rawText   the workflow source
 * @param {Map<string, Map<string,string|null>>} params  param file -> (envVar -> default)
 * @returns {{violations: Array, deployingSteps: number, deployedParams: Set<string>}}
 */
export function analyzeWorkflow(file, rawText, params) {
  const text = stripYamlComments(normalize(rawText));
  const violations = [];
  const deployedParams = new Set();
  let deployingSteps = 0;

  const workflowEnv = envKeysAtIndent(text, 0);

  for (const job of jobsOf(text)) {
    // Attribution is JOB-scoped. deploy-fiab-commercial.yml names
    // commercial.bicepparam in the step that COMPOSES the argument list and
    // deploys in a later step; step-scoped attribution skipped it entirely.
    const jobParams = paramFilesUsedIn(job.body, [...params.keys()]);
    if (jobParams.length === 0) continue;

    const jobEnv = envKeysAtIndent(job.body, 4);
    const steps = stepsOf(job.body);
    const exportedSoFar = new Set();

    for (const step of steps) {
      const verbs = deployVerbsIn(step.body);
      if (verbs.length === 0) {
        for (const k of githubEnvExports(step.body)) exportedSoFar.add(k);
        continue;
      }

      // Prefer the param file named in THIS step; fall back to the job's.
      const stepParams = paramFilesUsedIn(step.body, jobParams);
      const used = stepParams.length > 0 ? stepParams : jobParams;

      // Attribution is recorded BEFORE the apps-disabled skip. A param file
      // whose only deployers are apps-disabled what-ifs still HAS a deployer —
      // collapsing that into "nothing deploys it" would trip the coverage
      // self-defence below with a false alarm, and would ask a reader to declare
      // a file as undeployed that is deployed twice a day.
      deployingSteps++;
      for (const p of used) deployedParams.add(p);

      if (forcesAppsDisabled(step.body)) {
        for (const k of githubEnvExports(step.body)) exportedSoFar.add(k);
        continue;
      }
      const stepEnv = envKeysAtIndent(step.body, 8);
      const fallbacks = new Map([
        ...envFallbacks(text).entries(),
        ...envFallbacks(job.body).entries(),
        ...envFallbacks(step.body).entries(),
      ]);
      for (const p of used) {
        for (const [v, dflt] of params.get(p)) {
          if (!(stepEnv.has(v) || jobEnv.has(v) || workflowEnv.has(v) || exportedSoFar.has(v))) {
            violations.push({
              file: `.github/workflows/${file}`,
              job: job.id,
              step: step.name.slice(0, 60),
              param: p,
              missing: v,
              fallback: dflt,
              rule: 'not-in-scope',
              kind: verbs.some((x) => x.kind === 'apply') ? 'apply' : 'preview',
              verb: verbs.map((x) => x.name).join(' + '),
            });
            continue;
          }
          // In scope — but does it carry the value the param file declares?
          const lit = fallbacks.get(v);
          if (lit !== undefined && dflt !== null && lit !== dflt) {
            violations.push({
              file: `.github/workflows/${file}`,
              job: job.id,
              step: step.name.slice(0, 60),
              param: p,
              missing: v,
              fallback: dflt,
              forced: lit,
              rule: 'fallback-mismatch',
              kind: verbs.some((x) => x.kind === 'apply') ? 'apply' : 'preview',
              verb: verbs.map((x) => x.name).join(' + '),
            });
          }
        }
      }
      for (const k of githubEnvExports(step.body)) exportedSoFar.add(k);
    }
  }

  return { violations, deployingSteps, deployedParams };
}

/** Read every tag-reading param file. Exported so the tests can reuse it. */
export function loadParams(dir = PARAM_DIR) {
  const params = new Map();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.bicepparam')) continue;
    const reads = tagReads(readFileSync(join(dir, f), 'utf8'));
    if (reads.size > 0) params.set(f, reads);
  }
  return params;
}

function main() {
  if (!existsSync(PARAM_DIR)) {
    console.error(`::error::bicepparam-env-reaches-deploy: ${PARAM_DIR} does not exist — the params moved. Refusing to pass.`);
    return 1;
  }

  const params = loadParams();
  if (params.size === 0) {
    console.error(
      '::error::bicepparam-env-reaches-deploy: no .bicepparam reads a LOOM_*_TAG via readEnvironmentVariable. ' +
        'Several do, so the matcher has drifted. Refusing to report a pass on an empty population.',
    );
    return 1;
  }

  const violations = [];
  const deployedParams = new Set();
  let deployingSteps = 0;

  for (const f of readdirSync(WF_DIR)) {
    if (!/\.ya?ml$/.test(f)) continue;
    const r = analyzeWorkflow(f, readFileSync(join(WF_DIR, f), 'utf8'), params);
    violations.push(...r.violations);
    deployingSteps += r.deployingSteps;
    for (const p of r.deployedParams) deployedParams.add(p);
  }

  if (deployingSteps === 0) {
    console.error(
      '::error::bicepparam-env-reaches-deploy: found ZERO workflow steps that deploy a tag-reading .bicepparam. ' +
        'Several exist, so the step or param matcher has drifted. Refusing to pass on an empty population.',
    );
    return 1;
  }

  // A param file nothing deploys is not automatically fine — it is UNKNOWN, and
  // the first version of this guard let it pass in silence. Declare it or fix it.
  //
  // Both checks below run and report even when the other has already failed:
  // `bash -e`-style short-circuiting is how a second finding gets hidden behind
  // the first, and a skipped check reads as a passed one.
  let failed = false;
  const undeployed = [...params.keys()].filter((p) => !deployedParams.has(p));
  const undeclared = undeployed.filter((p) => !(p in NO_AUTOMATED_DEPLOYER));
  for (const p of undeployed.filter((x) => x in NO_AUTOMATED_DEPLOYER)) {
    console.log(`bicepparam-env-reaches-deploy: ${p} has no automated deployer — ${NO_AUTOMATED_DEPLOYER[p]}`);
  }
  if (undeclared.length > 0) {
    failed = true;
    console.error(
      `::error::bicepparam-env-reaches-deploy: ${undeclared.length} tag-reading param file(s) are deployed by NO ` +
        'workflow step this guard can see: ' + undeclared.join(', ') + '. Either a deployer exists and the matcher ' +
        'cannot see it (a blind spot — fix the matcher), or none exists (declare it in NO_AUTOMATED_DEPLOYER with ' +
        'the reason). An unexplained zero is the same defect class as #3161.',
    );
  }

  if (violations.length > 0) {
    failed = true;
    const notInScope = violations.filter((v) => v.rule === 'not-in-scope');
    const mismatched = violations.filter((v) => v.rule === 'fallback-mismatch');
    if (notInScope.length > 0) {
      console.error(
        `::error::bicepparam-env-reaches-deploy: ${notInScope.length} deploy step(s) do not set a LOOM_*_TAG their ` +
          '.bicepparam reads. readEnvironmentVariable() has a DEFAULT, so this does NOT fail — the deploy succeeds and ' +
          'silently writes the fallback tag onto live Container Apps, reverting any SHA-pinned roll with nothing in ' +
          'the log. See #3161.',
      );
    }
    if (mismatched.length > 0) {
      console.error(
        `::error::bicepparam-env-reaches-deploy: ${mismatched.length} env line(s) OVERRIDE the tag their .bicepparam ` +
          'declares. Being in scope is not enough — an env fallback that differs from the param default is a second, ' +
          'invisible source of truth for which image the estate runs. Make the literal match the param file.',
      );
    }
    for (const v of violations) {
      const msg = v.rule === 'fallback-mismatch'
        ? `sets ${v.missing} to '${v.forced}' while ${v.param} declares '${v.fallback}' — with the repo variable ` +
          'unset (its normal state) this deploys a tag the param file never asked for'
        : v.kind === 'apply'
          ? `deploys ${v.param} without ${v.missing} — WRITES the fallback '${v.fallback}' onto the live app`
          : `deploys ${v.param} without ${v.missing} — PREVIEWS the fallback '${v.fallback}', so the what-if does ` +
            'not show what the apply will do';
      console.error(`::error file=${v.file}::job '${v.job}' step '${v.step}' (${v.verb}) ${msg}`);
    }
  }

  if (failed) return 1;

  console.log(
    `bicepparam-env-reaches-deploy OK — ${params.size} tag-reading param file(s), ${deployingSteps} deploying step(s) ` +
      `across ${deployedParams.size} deployed param file(s); every LOOM_*_TAG a param file reads is in scope where it ` +
      'is deployed (apply AND what-if).',
  );
  return 0;
}

// Only run when invoked directly, so the tests can import the pure functions.
if (process.argv[1] && process.argv[1].endsWith('check-bicepparam-env-reaches-deploy.mjs')) {
  process.exit(main());
}
