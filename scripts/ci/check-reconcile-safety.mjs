#!/usr/bin/env node
/**
 * check-reconcile-safety.mjs — the SCHEDULED reconcile of
 * deploy-fiab-commercial.yml must be non-destructive.
 *
 * WHY THIS EXISTS (refs #2775)
 * ---------------------------
 * #2881 fixed the topology guard that had refused every scheduled run of the
 * only workflow able to apply Console configuration to the live estate. It
 * verified the guard. It did not walk the rest of the path, and the rest of the
 * path had three ways to destroy or duplicate production the first time it got
 * that far:
 *
 *   TEARDOWN  the `Teardown` step ran on `github.event_name == 'schedule'`, and
 *             .github/scripts/fiab-teardown.sh deletes RG_NAME plus EVERY other
 *             `rg-csa-loom-*` resource group in the subscription.
 *   REGION    `AZURE_LOCATION: ${{ inputs.region || 'eastus2' }}` — a schedule
 *             has no inputs, so it aimed at eastus2 while the estate is in
 *             centralus: a second estate, not a reconcile.
 *   IMAGES    `appImageTags.console` defaults to 'v0.1' and commercial.bicepparam
 *             never set it, while production runs a commit-SHA tag. So the flag
 *             that has to be true for Console env to apply at all would have
 *             rewritten the Console image to a tag that does not exist.
 *
 * Each was fixed in the workflow. Each fix is a line of YAML or bicep that a
 * later edit can undo in seconds and that no test would otherwise notice. This
 * file is what notices.
 *
 * THE INVARIANTS
 *
 *   I1  No step that can DELETE infrastructure may run on a `schedule`. Every
 *       destructive step must carry the literal `github.event_name != 'schedule'`
 *       in its `if:`. A literal is demanded rather than an evaluation of the
 *       GitHub expression on purpose: the previous condition was *already*
 *       subtle enough that three reviewers read it as safe.
 *
 *   I2  No `appImageTags` key may drive TWO different image repositories. When
 *       it does, pinning it to one repo's running tag necessarily rewrites the
 *       other's, so the immutability invariant becomes unsatisfiable. This was
 *       live: `imageTag: appImageTags.console` was passed to dbt-runner.bicep,
 *       which builds `loom-dbt-runner:${imageTag}`, and the two ran at different
 *       tags in production.
 *
 *   I3  Every key the bicep READS is known to reconcile-policy.mjs, with the
 *       same repository the bicep derives. The pin table cannot drift from what
 *       ARM would actually do.
 *
 *   I4  `commercial.bicepparam` names every key the bicep reads non-optionally,
 *       and EVERY value is a `readEnvironmentVariable(<the env var
 *       reconcile-policy.mjs exports>, …)`. A literal tag here is the whole bug
 *       coming back: it would be applied over whatever is running.
 *
 *   I5  The workflow actually invokes the resolver, before the steps that
 *       deploy, and the az commands consume ITS `deploy_apps_enabled` rather
 *       than the upstream one.
 *
 *   I6  Every `AZURE_LOCATION` entry in an `env:` mapping resolves to the
 *       OPERATOR'S INPUT or to the resolver's measured output — never to a
 *       literal. This is the REGION defect above, and until now nothing in this
 *       file watched the line that carries it: reintroducing
 *       `${{ inputs.region || 'eastus2' }}` left all 47 tests of
 *       __tests__/reconcile-policy.test.mjs green and this script exiting 0
 *       (measured 2026-08-11).
 *
 *       A sibling guard, check-deploy-input-safety.mjs S3, does match that ONE
 *       spelling — `/\|\|\s*'[a-z0-9]+'/` against the FIRST `AZURE_LOCATION:`
 *       line in the file. Measured against it, five other spellings of the same
 *       defect walk straight through, and so does deleting the line:
 *
 *         || "eastus2"   (double quotes)                     NOT CAUGHT
 *         || 'EastUS2'   (mixed case — `az` accepts it)      NOT CAUGHT
 *         AZURE_LOCATION: eastus2   (bare scalar)            NOT CAUGHT
 *         inputs.region == '' && 'eastus2' || inputs.region  NOT CAUGHT
 *         the line deleted / restructured (no floor at all)  NOT CAUGHT
 *
 *       I6 is therefore keyed to the MISMATCH — "this seed has a producer that
 *       is neither the input nor the resolver" — and never to the string
 *       'eastus2'. A future default of 'westus2' fails identically, and the
 *       safe form keeps the rule matching instead of silencing it.
 *
 * FAILING CLOSED. Every discovery step has a floor. A regex that stops matching
 * would otherwise report "0 violations" and read as a pass — the exact shape
 * this repo keeps finding inside its own guards. Finding FEWER image reads,
 * bicepparam keys or destructive steps than the floor is an error, not silence.
 *
 * Usage: node scripts/ci/check-reconcile-safety.mjs
 * Tests: node --test scripts/ci/__tests__/reconcile-policy.test.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stepBody, runBlock } from './check-ui-verify-step-teeth.mjs';
import { APP_IMAGE_TAGS, APP_IMAGE_TAG_BY_KEY } from './reconcile-policy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');

export const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'deploy-fiab-commercial.yml');
export const ADMIN_PLANE = path.join(REPO_ROOT, 'platform', 'fiab', 'bicep', 'modules', 'admin-plane', 'main.bicep');
export const COMMERCIAL_PARAM = path.join(REPO_ROOT, 'platform', 'fiab', 'bicep', 'params', 'commercial.bicepparam');

/**
 * A `run:` body that can delete infrastructure.
 *
 * `fiab-teardown.sh` is the one that mattered; `az group delete` and
 * `az deployment ... delete` are here so a future step that inlines the same
 * destruction cannot slip past by not being named "teardown".
 */
export const DESTRUCTIVE_RUN = /fiab-teardown\.sh|az\s+group\s+delete|az\s+containerapp\s+delete|az\s+deployment\s+\w+\s+delete/;

/** The literal every destructive step must carry. */
export const SCHEDULE_EXCLUSION = "github.event_name != 'schedule'";

/**
 * Discovery floors. Below these, the parser — not the repo — is what changed.
 * Lower one only deliberately, in the same commit that removes the thing.
 */
export const FLOORS = Object.freeze({
  destructiveSteps: 1,   // the Teardown step
  imageReads: 16,        // appImageTags.* reads in admin-plane/main.bicep
  paramKeys: 10,         // keys admin-plane reads NON-optionally (17 are declared)
  regionSeeds: 1,        // AZURE_LOCATION entries in an `env:` mapping (I6)
});

const stripLineComments = (src) =>
  src.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');

const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

// ---------------------------------------------------------------------------
// I1 — destructive steps
// ---------------------------------------------------------------------------

/** The `if:` text of a step, including a folded `if: |` block. */
export function ifText(body) {
  const i = body.findIndex((l) => /^\s*-?\s*if:/.test(l));
  if (i < 0) return '';
  const first = body[i];
  const indent = first.match(/^(\s*)/)[1].length;
  const out = [first.replace(/^\s*-?\s*if:\s*/, '')];
  for (let j = i + 1; j < body.length; j++) {
    if (body[j].trim() === '') continue;
    if (body[j].match(/^(\s*)/)[1].length <= indent) break;
    out.push(body[j]);
  }
  return out.join('\n');
}

const STEP_START = /^(\s*)-\s+(name|uses|run|id|if|with|env|shell|continue-on-error):/;

/**
 * The EXECUTABLE part of a step's `run:` block.
 *
 * Three things in a step mention a command without running it, and all three
 * are stripped here — the first draft of this file flagged a step whose only
 * crime was printing the teardown command in a `::warning::` for the operator:
 *
 *   - `#` comments  — prose.
 *   - quoted strings — `echo "… bash .github/scripts/fiab-teardown.sh"` is
 *     documentation. A real invocation is unquoted. Stripping the QUOTES rather
 *     than skipping `echo` lines keeps the rule general: any command mentioned
 *     inside a string literal is a mention, and any command outside one is a
 *     command.
 *   - `name:` / `if:` — a step called "Teardown" is not thereby destructive;
 *     only `runBlock` is considered.
 *
 * If this over-strips, FLOORS.destructiveSteps turns the resulting silence into
 * a failure rather than a pass.
 */
export function executableRun(body) {
  return runBlock(body)
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''"))
    .join('\n');
}

/** Every step in a workflow, with its name, `if:` text and executable `run:`. */
export function parseWorkflowSteps(yaml) {
  const lines = yaml.split(/\r?\n/);
  const steps = [];
  for (let i = 0; i < lines.length; i++) {
    if (!STEP_START.test(lines[i])) continue;
    const body = stepBody(lines, i);
    const startLine = i + 1;
    i += body.length - 1;
    const name = (body.find((l) => /^\s*-?\s*name:/.test(l)) || '')
      .replace(/^\s*-?\s*name:\s*/, '').trim().replace(/^['"]|['"]$/g, '') || '(unnamed)';
    steps.push({ name, startLine, body, run: executableRun(body), if: ifText(body) });
  }
  return steps;
}

export function checkDestructiveSteps(yaml) {
  const steps = parseWorkflowSteps(yaml);
  const destructive = steps.filter((s) => DESTRUCTIVE_RUN.test(s.run));
  const violations = destructive
    .filter((s) => !s.if.includes(SCHEDULE_EXCLUSION))
    .map((s) => ({
      line: s.startLine,
      msg:
        `step "${s.name}" can DELETE infrastructure but its \`if:\` does not contain ` +
        `\`${SCHEDULE_EXCLUSION}\`. A scheduled reconcile that reaches it deletes the estate ` +
        'it was scheduled to reconcile (fiab-teardown.sh removes every rg-csa-loom-* RG in the sub).',
    }));
  return { found: destructive.length, violations };
}

// ---------------------------------------------------------------------------
// I2 / I3 — appImageTags key -> image repository, derived from the bicep
// ---------------------------------------------------------------------------

/** `…/loom-console:${appImageTags.console}` / `${appImageTags.?duckdb ?? 'v0.1'}` */
const DIRECT_IMAGE = /([A-Za-z0-9][A-Za-z0-9._-]*):\$\{appImageTags\.\??([A-Za-z0-9_]+)/;
/** `imageTag: appImageTags.maf` — the repo lives in the module being called. */
const MODULE_IMAGE_TAG = /^\s*imageTag:\s*appImageTags\.(\??)([A-Za-z0-9_]+)/;
/** `module foo '../integration/dbt-runner.bicep' = …` */
const MODULE_DECL = /^module\s+\w+\s+'([^']+)'/;
/** `image: '${acrLoginServer}/loom-dbt-runner:${imageTag}'` inside that module. */
const MODULE_IMAGE = /([A-Za-z0-9][A-Za-z0-9._-]*):\$\{imageTag\}/;
/** Optional access — `appImageTags.?duckdb` — means the key may be absent. */
const OPTIONAL_READ = /appImageTags\.\?([A-Za-z0-9_]+)/;

/**
 * Every `appImageTags` key the admin-plane template reads, with the image
 * repository it ends up naming and whether the read is optional.
 *
 * @returns {Array<{key:string, repo:string|null, optional:boolean, line:number, via:string}>}
 */
export function deriveImageReads(bicepPath) {
  const src = read(bicepPath);
  const lines = src.split('\n');
  const dir = path.dirname(bicepPath);
  const reads = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\/\//.test(line)) continue;          // a comment is prose
    if (!line.includes('appImageTags.')) continue;

    const optional = OPTIONAL_READ.test(line);

    const direct = DIRECT_IMAGE.exec(line);
    if (direct) {
      reads.push({ key: direct[2], repo: direct[1], optional, line: i + 1, via: 'inline image' });
      continue;
    }

    const asParam = MODULE_IMAGE_TAG.exec(line);
    if (asParam) {
      // Walk back to the `module <name> '<path>'` this params block belongs to.
      let modPath = null;
      for (let j = i; j >= 0 && j > i - 400; j--) {
        const m = MODULE_DECL.exec(lines[j]);
        if (m) { modPath = m[1]; break; }
      }
      let repo = null;
      if (modPath) {
        const abs = path.resolve(dir, modPath);
        if (existsSync(abs)) {
          const inner = read(abs).split('\n').find((l) => !/^\s*\/\//.test(l) && MODULE_IMAGE.test(l));
          if (inner) repo = MODULE_IMAGE.exec(inner)[1];
        }
      }
      reads.push({ key: asParam[2], repo, optional, line: i + 1, via: `module ${modPath || '(unresolved)'}` });
    }
  }
  return reads;
}

export function checkImageKeyFanout(reads) {
  const violations = [];
  const byKey = new Map();
  for (const r of reads) {
    if (!r.repo) {
      violations.push({
        line: r.line,
        msg: `appImageTags.${r.key} is passed to ${r.via}, but no \`image: '…:\${imageTag}'\` could be found there, so the repository it names is UNKNOWN. The immutability pin cannot be proved for it.`,
      });
      continue;
    }
    const set = byKey.get(r.key) || new Set();
    set.add(r.repo);
    byKey.set(r.key, set);
  }
  for (const [key, repos] of byKey) {
    if (repos.size > 1) {
      violations.push({
        line: reads.find((r) => r.key === key)?.line ?? 0,
        msg:
          `appImageTags.${key} drives ${repos.size} DIFFERENT image repositories (${[...repos].join(', ')}). ` +
          'One key cannot preserve two running tags: pinning it to either rewrites the other. ' +
          'Give the second repository its own key (read it optionally so no param bag needs updating).',
      });
    }
  }
  return { violations, byKey };
}

export function checkPolicyTableCoverage(byKey) {
  const violations = [];
  for (const [key, repos] of byKey) {
    const entry = APP_IMAGE_TAG_BY_KEY[key];
    if (!entry) {
      violations.push({
        line: 0,
        msg: `admin-plane/main.bicep reads appImageTags.${key}, but reconcile-policy.mjs APP_IMAGE_TAGS has no entry for it — a scheduled reconcile would deploy it at the bicep default instead of the running tag.`,
      });
      continue;
    }
    const repo = [...repos][0];
    if (repos.size === 1 && entry.repo !== repo) {
      violations.push({
        line: 0,
        msg: `APP_IMAGE_TAGS says ${key} -> "${entry.repo}", but the bicep builds "${repo}". The running container would never be matched, so the key would silently fall back to the default tag.`,
      });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// I4 — commercial.bicepparam
// ---------------------------------------------------------------------------

/** The `param appImageTags = { … }` block, as key -> raw value text. */
export function parseParamImageTags(paramPath) {
  const src = stripLineComments(read(paramPath));
  const start = src.indexOf('param appImageTags');
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return null;
  const body = src.slice(open + 1, end);
  const out = {};
  for (const line of body.split('\n')) {
    const m = /^\s*([A-Za-z0-9_]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const READ_ENV = /^readEnvironmentVariable\(\s*'([A-Z0-9_]+)'\s*,/;

export function checkParamFile(paramPath, reads) {
  const violations = [];
  const tags = parseParamImageTags(paramPath);
  if (!tags) {
    return {
      count: 0,
      violations: [{
        line: 0,
        msg: `${path.relative(REPO_ROOT, paramPath)} declares no \`param appImageTags = { … }\`, so appImageTags falls back to main.bicep's default of v0.1 for every app. An apps-enabled deploy would rewrite every running image to a tag that does not exist.`,
      }],
    };
  }

  // Every key read NON-optionally must be present, or template evaluation
  // aborts with "property '<key>' doesn't exist".
  const requiredKeys = [...new Set(reads.filter((r) => !r.optional).map((r) => r.key))];
  for (const key of requiredKeys) {
    if (!(key in tags)) {
      violations.push({
        line: 0,
        msg: `appImageTags.${key} is read NON-optionally by admin-plane/main.bicep but is missing from ${path.basename(paramPath)}. The whole nested deployment fails template evaluation.`,
      });
    }
  }

  for (const [key, value] of Object.entries(tags)) {
    const m = READ_ENV.exec(value);
    if (!m) {
      violations.push({
        line: 0,
        msg: `appImageTags.${key} in ${path.basename(paramPath)} is the literal \`${value}\`, not a readEnvironmentVariable(...). A literal is applied over whatever is running — that is exactly the image rewrite this file exists to prevent.`,
      });
      continue;
    }
    const entry = APP_IMAGE_TAG_BY_KEY[key];
    if (!entry) {
      violations.push({
        line: 0,
        msg: `${path.basename(paramPath)} pins appImageTags.${key}, which reconcile-policy.mjs does not know about — nothing would ever export its env var, so it silently stays at its default.`,
      });
      continue;
    }
    if (m[1] !== entry.envVar) {
      violations.push({
        line: 0,
        msg: `appImageTags.${key} reads env "${m[1]}" but reconcile-resolve.mjs exports "${entry.envVar}". The exported tag would never be picked up and the default would apply instead.`,
      });
    }
  }
  return { count: Object.keys(tags).length, violations };
}

// ---------------------------------------------------------------------------
// I5 — the workflow wires the resolver in
// ---------------------------------------------------------------------------

export function checkWorkflowWiring(yaml) {
  const violations = [];
  const steps = parseWorkflowSteps(yaml);
  // The step's YAML+shell with COMMENT LINES REMOVED. Not `s.run` (it blanks
  // quoted strings, and `echo "deploy_args_file=…"` is one) and not the raw
  // body (a step absorbs the comment block introducing the NEXT step, so a
  // marker MENTIONED in prose matches ahead of the step that implements it).
  const raw = (s) => s.body.filter((l) => !/^\s*#/.test(l)).join('\n');

  const resolverIdx = steps.findIndex((s) => /node scripts\/ci\/reconcile-resolve\.mjs/.test(s.run));
  if (resolverIdx < 0) {
    violations.push({ line: 0, msg: 'no step runs `node scripts/ci/reconcile-resolve.mjs`, so nothing pins appImageTags to the running images or derives the estate region.' });
    return violations;
  }
  const deployIdx = steps.findIndex((s) => /az deployment sub (create|what-if)/.test(s.run));
  if (deployIdx >= 0 && deployIdx < resolverIdx) {
    violations.push({ line: steps[deployIdx].startLine, msg: 'a step runs `az deployment sub …` BEFORE reconcile-resolve.mjs, so it deploys with unpinned image tags.' });
  }

  // The az invocations must consume the RESOLVER's verdict, not the upstream
  // trigger-policy one — the upstream value is deliberately the safe 'false'
  // and is only ever upgraded by the resolver.
  //
  // The SHAPE this checks changed with #3022. The what-if and the apply used to
  // restate the whole argument list, so the assertion was "the string
  // `deployAppsEnabled=${{ steps.reconcile.outputs.deploy_apps_enabled }}`
  // appears at least twice". They now expand ONE composed argument file — which
  // is the stronger property, because there is no second copy to disagree — so
  // the assertion becomes: exactly one step composes the arguments, it takes
  // deployAppsEnabled from the RESOLVER, and both commands expand that file.
  const composeSteps = steps.filter((s) => raw(s).includes('deploy_args_file='));
  if (composeSteps.length !== 1) {
    violations.push({
      line: 0,
      msg:
        `expected exactly ONE step to compose the deployment arguments (emitting \`deploy_args_file=\`), ` +
        `found ${composeSteps.length}. With more than one, the what-if and the apply can once again be ` +
        'given different values for deployAppsEnabled — the flag that decides whether every running ' +
        'image is rewritten.',
    });
  } else {
    const compose = raw(composeSteps[0]);
    if (!/DEPLOY_APPS_ENABLED:\s*\$\{\{\s*steps\.reconcile\.outputs\.deploy_apps_enabled\s*\}\}/.test(compose)) {
      violations.push({
        line: composeSteps[0].startLine,
        msg:
          'the argument-composition step does not take DEPLOY_APPS_ENABLED from ' +
          '`steps.reconcile.outputs.deploy_apps_enabled`. The upstream trigger-policy value is the safe ' +
          "'false' base and is only ever upgraded once every running image has been pinned; using it " +
          'directly would deploy the bicep default (v0.1) over a running estate.',
      });
    }
    if (!/--parameters\s+"deployAppsEnabled=\$DEPLOY_APPS_ENABLED"/.test(compose)) {
      violations.push({
        line: composeSteps[0].startLine,
        msg: 'the argument-composition step does not emit `--parameters "deployAppsEnabled=$DEPLOY_APPS_ENABLED"`, so the resolver\'s verdict never reaches ARM.',
      });
    }
    for (const [label, re] of [['what-if', /az deployment sub what-if/], ['apply', /az deployment sub create/]]) {
      const i = steps.findIndex((s) => re.test(s.run));
      if (i < 0) {
        violations.push({ line: 0, msg: `DISCOVERY FLOOR: no step runs the ${label} command; this check would otherwise pass by seeing nothing.` });
        continue;
      }
      if (!raw(steps[i]).includes('"${DEPLOY_ARGS[@]}"')) {
        violations.push({
          line: steps[i].startLine,
          msg: `the ${label} step does not expand the composed argument list, so its deployAppsEnabled is not the resolver's.`,
        });
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// I6 — the AZURE_LOCATION seed in `env:` (refs #3029)
// ---------------------------------------------------------------------------

/** The env var whose value IS the identity of the estate being deployed to. */
export const REGION_SEED_ENV = 'AZURE_LOCATION';

/**
 * The only producers a region seed may name.
 *
 * `inputs.region` is the operator's explicit choice (the input is
 * `required: true`, held by check-deploy-input-safety.mjs S3).
 * `steps.<id>.outputs.region` is reconcile-resolve.mjs's MEASURED verdict.
 * Everything else — a literal, another env var, a `format(...)` — is a value
 * nobody chose and nobody measured, which is exactly what #3029 was.
 */
export const ALLOWED_REGION_PRODUCERS = Object.freeze([
  /^inputs\.region$/,
  /^github\.event\.inputs\.region$/,
  /^steps\.[A-Za-z0-9_-]+\.outputs\.region$/,
]);

const indentOf = (line) => line.match(/^[ \t]*/)[0].length;

/** `run: |`, `script: >-`, `creds: |` … — the body is text, never YAML. */
const BLOCK_SCALAR = /^[ \t]*(?:-[ \t]+)?[A-Za-z0-9_.-]+:[ \t]*[|>][-+]?\d*[ \t]*(?:#.*)?$/;
/** An `env:` mapping opener, at workflow, job or step level. */
const ENV_OPENER = /^[ \t]*(-[ \t]+)?env:[ \t]*(?:#.*)?$/;
/** One `NAME: value` entry inside it. */
const ENV_ENTRY = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*):(?:[ \t]+(.*))?$/;

/**
 * Strip a YAML trailing `#` comment without touching a `#` that is inside a
 * `${{ … }}` expression or a quoted string.
 */
export function stripValueComment(value) {
  let out = '';
  let quote = null;
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    if (!quote && value.startsWith('${{', i)) { depth++; out += '${{'; i += 2; continue; }
    if (!quote && depth > 0 && value.startsWith('}}', i)) { depth--; out += '}}'; i += 1; continue; }
    const c = value[i];
    if (quote) { if (c === quote) quote = null; out += c; continue; }
    if (c === "'" || c === '"') { quote = c; out += c; continue; }
    if (c === '#' && depth === 0 && (i === 0 || /[ \t]/.test(value[i - 1]))) break;
    out += c;
  }
  return out.trim();
}

/**
 * Every `NAME: value` in every `env:` mapping of a workflow.
 *
 * Deliberately NOT `yaml.split('\n').find(/^\s*AZURE_LOCATION:/)`: that shape
 * sees only the first occurrence, cannot tell an `env:` entry from a line of
 * shell inside `run: |`, and returns '' — which reads as clean — the moment the
 * YAML is restructured. Block-scalar bodies are skipped for the same reason.
 *
 * @returns {Array<{name:string, value:string, line:number}>}
 */
export function envAssignments(yaml) {
  const lines = yaml.split('\n');
  const out = [];

  /** Advance past the body of a block scalar whose key sits at `keyIndent`. */
  const skipBlock = (from, keyIndent) => {
    let j = from;
    while (j < lines.length && (lines[j].trim() === '' || indentOf(lines[j]) > keyIndent)) j++;
    return j;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || /^[ \t]*#/.test(line)) continue;

    if (BLOCK_SCALAR.test(line)) {
      i = skipBlock(i + 1, indentOf(line) + (/^[ \t]*-[ \t]+/.test(line) ? 2 : 0)) - 1;
      continue;
    }

    const opener = ENV_OPENER.exec(line);
    if (!opener) continue;

    const keyIndent = indentOf(line) + (opener[1] ? opener[1].length : 0);
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === '') continue;
      if (indentOf(l) <= keyIndent) break;
      if (/^[ \t]*#/.test(l)) continue;
      const entry = ENV_ENTRY.exec(l);
      if (!entry) continue;
      const raw = (entry[2] ?? '').trim();
      if (/^[|>][-+]?\d*$/.test(raw)) { j = skipBlock(j + 1, indentOf(l)) - 1; continue; }
      out.push({ name: entry[1], value: raw, line: j + 1 });
    }
    i = j - 1;
  }
  return out;
}

/**
 * Split an env value into the string LITERALS and the context REFERENCES it is
 * built from, plus any text sitting outside a `${{ … }}` expression.
 *
 * `${{ inputs.region || 'eastus2' }}` -> refs ['inputs.region'], literals ['eastus2']
 * `eastus2`                           -> outside 'eastus2'
 */
export function regionSeedTerms(rawValue) {
  const value = stripValueComment(rawValue);
  const exprs = [...value.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]);
  const outside = value.replace(/\$\{\{[\s\S]*?\}\}/g, '').trim();
  const literals = [];
  const refs = [];
  for (const expr of exprs) {
    // GitHub expression strings are single-quoted with '' as the escape; the
    // double-quoted form is invalid in an expression but IS valid YAML around
    // one, and either way a quoted region is a hardcoded region.
    for (const m of expr.matchAll(/'((?:[^']|'')*)'|"([^"]*)"/g)) literals.push(m[1] ?? m[2] ?? '');
    const bare = expr.replace(/'(?:[^']|'')*'|"[^"]*"/g, ' ');
    for (const m of bare.matchAll(/[A-Za-z_][A-Za-z0-9_.-]*/g)) {
      if (/^(true|false|null|and|or|not)$/i.test(m[0])) continue;
      refs.push(m[0]);
    }
  }
  return { value, exprs, literals, refs, outside };
}

/**
 * I6. Every AZURE_LOCATION seed resolves to the input or the resolver alone.
 *
 * The DISCOVERY FLOOR is returned as a violation rather than left to the
 * caller: a check whose population can silently become empty is the failure
 * mode this whole file exists to prevent, and a floor a caller can forget to
 * apply is one `run()` refactor away from being forgotten.
 */
export function checkRegionSeed(yaml) {
  const seeds = envAssignments(yaml).filter((a) => a.name === REGION_SEED_ENV);
  const violations = [];

  if (seeds.length < FLOORS.regionSeeds) {
    violations.push({
      line: 0,
      msg:
        `DISCOVERY FLOOR: found ${seeds.length} \`${REGION_SEED_ENV}\` entr(y/ies) in an \`env:\` mapping of ` +
        `deploy-fiab-commercial.yml, expected >= ${FLOORS.regionSeeds}. Either the seed was removed (lower ` +
        'FLOORS.regionSeeds in the same commit) or envAssignments() stopped matching the YAML, in which ' +
        'case this check is measuring nothing and a reintroduced region default would read as clean.',
    });
    return { found: seeds.length, violations };
  }

  const allowed = ALLOWED_REGION_PRODUCERS.map((re) => re.source.replace(/^\^|\$$/g, '').replace(/\\/g, ''));
  const why =
    'The region IS the identity of the estate — rg-csa-loom-admin-<region>, vnet-csa-loom-hub-<region> and ' +
    'uami-loom-console-<region> are all derived from it — so a value nobody chose and nobody measured does not ' +
    'fail the deploy, it succeeds against a DIFFERENT, empty estate (#3029). A schedule carries no inputs and a ' +
    'dispatch may leave the field blank, which is precisely when a seed like this decides. reconcile-resolve.mjs ' +
    'does later write the MEASURED region into $GITHUB_ENV, so a seed here is latent rather than immediately ' +
    'live: that is defence in depth, not a licence to put the default back.';

  for (const seed of seeds) {
    if (seed.value === '') continue;   // nothing seeded at all — the resolver decides. Safe.

    const { value, literals, refs, outside } = regionSeedTerms(seed.value);

    if (outside) {
      violations.push({
        line: seed.line,
        msg:
          `\`${REGION_SEED_ENV}: ${value}\` seeds the deploy region with the bare text "${outside}" rather than ` +
          `an expression over ${allowed.join(' / ')}. ${why}`,
      });
    }
    for (const literal of literals) {
      // `|| ''` collapses to the same "nothing seeded" state as an empty value,
      // so it is not a hardcoded region. Any NON-empty literal is.
      if (literal === '') continue;
      violations.push({
        line: seed.line,
        msg:
          `\`${REGION_SEED_ENV}: ${value}\` contains the hardcoded literal '${literal}'. ${why} ` +
          `Seed it from the input alone: \`${REGION_SEED_ENV}: \${{ inputs.region }}\`.`,
      });
    }
    for (const ref of refs) {
      if (ALLOWED_REGION_PRODUCERS.some((re) => re.test(ref))) continue;
      violations.push({
        line: seed.line,
        msg:
          `\`${REGION_SEED_ENV}: ${value}\` takes the deploy region from \`${ref}\`, which is neither the ` +
          `operator's input nor the resolver's measured output (allowed: ${allowed.join(' / ')}). ${why}`,
      });
    }
  }
  return { found: seeds.length, violations };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export function run() {
  const problems = [];
  const note = (file, v) => problems.push(`${path.relative(REPO_ROOT, file)}${v.line ? `:${v.line}` : ''}  ${v.msg}`);

  const yaml = read(WORKFLOW);

  // I1
  const destructive = checkDestructiveSteps(yaml);
  if (destructive.found < FLOORS.destructiveSteps) {
    problems.push(
      `DISCOVERY FLOOR: found ${destructive.found} destructive step(s) in deploy-fiab-commercial.yml, expected >= ${FLOORS.destructiveSteps}. ` +
      'Either the teardown step was removed (lower FLOORS.destructiveSteps in the same commit) or DESTRUCTIVE_RUN stopped matching and this check is now measuring nothing.',
    );
  }
  for (const v of destructive.violations) note(WORKFLOW, v);

  // I2 / I3
  const reads = deriveImageReads(ADMIN_PLANE);
  if (reads.length < FLOORS.imageReads) {
    problems.push(
      `DISCOVERY FLOOR: found ${reads.length} appImageTags read(s) in admin-plane/main.bicep, expected >= ${FLOORS.imageReads}. ` +
      'The regexes stopped matching; this check would otherwise pass by seeing nothing.',
    );
  }
  const fanout = checkImageKeyFanout(reads);
  for (const v of fanout.violations) note(ADMIN_PLANE, v);
  for (const v of checkPolicyTableCoverage(fanout.byKey)) note(ADMIN_PLANE, v);

  // I4
  const param = checkParamFile(COMMERCIAL_PARAM, reads);
  if (param.count && param.count < FLOORS.paramKeys) {
    problems.push(
      `DISCOVERY FLOOR: commercial.bicepparam declares ${param.count} appImageTags key(s), expected >= ${FLOORS.paramKeys}.`,
    );
  }
  for (const v of param.violations) note(COMMERCIAL_PARAM, v);

  // I5
  for (const v of checkWorkflowWiring(yaml)) note(WORKFLOW, v);

  // I6 — carries its own discovery floor (see checkRegionSeed).
  for (const v of checkRegionSeed(yaml).violations) note(WORKFLOW, v);

  return problems;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const problems = run();
  if (problems.length) {
    console.error('[reconcile-safety] FAIL — a scheduled reconcile could destroy, duplicate, or re-image the estate:\n');
    for (const p of problems) console.error(`  ${p}`);
    console.error(`\n${problems.length} violation(s). See the header of scripts/ci/check-reconcile-safety.mjs.`);
    process.exit(1);
  }
  const reads = deriveImageReads(ADMIN_PLANE);
  const tags = parseParamImageTags(COMMERCIAL_PARAM) || {};
  console.log(
    `[reconcile-safety] OK — ${checkDestructiveSteps(read(WORKFLOW)).found} destructive step(s) excluded from the schedule; ` +
    `${reads.length} appImageTags read(s) across ${new Set(reads.map((r) => r.key)).size} key(s), each naming one repository; ` +
    `${Object.keys(tags).length} key(s) pinned via readEnvironmentVariable in commercial.bicepparam; ` +
    `${APP_IMAGE_TAGS.length} key(s) in the resolver table; ` +
    `${checkRegionSeed(read(WORKFLOW)).found} ${REGION_SEED_ENV} seed(s), each resolving to the input or the resolver.`,
  );
}
