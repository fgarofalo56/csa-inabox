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
  const code = yaml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

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
  const uses = code.match(/deployAppsEnabled=\$\{\{\s*steps\.reconcile\.outputs\.deploy_apps_enabled\s*\}\}/g) || [];
  if (uses.length < 2) {
    violations.push({
      line: 0,
      msg: `both the what-if and the provision step must pass deployAppsEnabled from steps.reconcile.outputs.deploy_apps_enabled (found ${uses.length}).`,
    });
  }
  return violations;
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
    `${APP_IMAGE_TAGS.length} key(s) in the resolver table.`,
  );
}
