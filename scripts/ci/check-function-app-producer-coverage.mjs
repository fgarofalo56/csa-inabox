#!/usr/bin/env node
/**
 * GUARDRAIL: every Function App a workflow DEPLOYS must have a bicep PRODUCER.
 *
 * ── WHY THIS EXISTS (#3429) ────────────────────────────────────────────────
 *
 * `deploy-copilot-function.yml` deploys `func-csa-inabox-copilot-fg`, the
 * production chat backend for the docs site. It had failed EIGHT consecutive
 * runs (2026-07-02 .. 2026-08-14) and the lane had no recovery path, because
 * NOTHING IN THE TREE CREATED THAT APP. Measured 2026-08-17:
 *
 *     $ grep -rn "Microsoft.Web/sites@" --include=*.bicep . | grep -c existing
 *     1
 *
 * — one `existing` declaration among eighteen, and it was
 * `azure-functions/copilot-chat/deploy/main.bicep` naming this very app. A
 * CONSUMER with no producer. The app existed only because somebody once ran the
 * `az functionapp create` block in DEPLOYMENT.md by hand, so the only way to
 * recover it was for a human to run that block again from a workstation with
 * `az` write access.
 *
 * That is the `auto-bind-by-default.md` §5 shape ("infra prerequisites are
 * DEPLOYED, not requested") and the `deploy-integrity.md` R1 shape (a deploy
 * path that only a laptop can run is undeployable in practice). It is the
 * Function-App sibling of check-image-producer-coverage.mjs (#2619), which asks
 * the same question about container images, and it is written in the same shape
 * deliberately.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 *
 * For every Function App named as a DEPLOY TARGET by a workflow —
 *   • `uses: Azure/functions-action@…` with `app-name:`
 *   • `func azure functionapp publish <name>`
 *   • `az functionapp deploy … --name <name>` / `-n <name>`
 * — some `.bicep` in the tree must DECLARE that app, as a real resource and not
 * as `existing`.
 *
 * `existing` is the load-bearing distinction and a plain grep gets it wrong.
 * `resource x 'Microsoft.Web/sites@…' existing = {}` READS an app somebody else
 * made; only `resource x 'Microsoft.Web/sites@…' = {}` CREATES one. Counting the
 * first would have scored #3429 as covered on the exact file that proves it was
 * not.
 *
 * ── NAME RESOLUTION, AND WHY IT REFUSES TO GUESS ───────────────────────────
 *
 * Neither side of the comparison is reliably a literal:
 *
 *   workflow  `app-name: ${{ env.FUNCTION_APP_NAME }}`   -> resolve via env
 *             `func azure functionapp publish "$FUNC"`   -> resolve via the
 *                                                            shell assignment
 *   bicep     `name: functionAppName` -> a param default
 *             `var siteName = 'func-loom-posture-refresh-${uniqueString(…)}'`
 *                                     -> a LITERAL PREFIX, never a full name
 *
 * The posture Function App is deliberately a prefix on BOTH sides:
 * gov-provision-posture.yml discovers it with
 * `az functionapp list --query "[?starts_with(name,'func-loom-posture')]"`, and
 * posture-refresh/deploy/main.bicep builds it as
 * `'func-loom-posture-refresh-${uniqueString(resourceGroup().id)}'`. A guard that
 * only understood literals would have to skip both, and a skip is the blind spot
 * this whole file exists to close. So prefixes are matched as prefixes.
 *
 * Matching them is ONE-DIRECTIONAL, and the first version of this file got the
 * direction wrong. A declaration covers a target only when EVERY name it can
 * emit satisfies the target's selector — `decl.startsWith(target)`. The reverse,
 * `target.startsWith(decl)`, is merely NECESSARY, and treating it as sufficient
 * hands a generic producer credit for an app it can never create. It did exactly
 * that here: `deploy-planner/functions.bicep` emits `func-loom-<uniqueString>`
 * and "covered" BOTH posture lanes (Commercial and GCC-High/IL5) plus, under a
 * rename, the copilot app itself — so deleting the real producers scored GREEN.
 * See `matches()` for the measurement and cases M9/M10 for the pins.
 *
 * What it will NOT do is guess. A target it cannot resolve to a literal or a
 * prefix is a FAILURE, not a skip — including an EMPTY `app-name:`, which is
 * UNKNOWN and not "harmless". If a target is genuinely unresolvable it goes in
 * UNRESOLVABLE_TARGETS below WITH a reason, so the gap is named and counted
 * rather than invisible.
 *
 * ── CLOUD PARITY (cloud-parity.md) ─────────────────────────────────────────
 *
 * The scan is over EVERY file in .github/workflows — there is no Commercial
 * filter and no `gov-*` exclusion. Measured on this repo the population spans
 * both boundaries: deploy-copilot-function.yml and
 * csa-loom-post-deploy-bootstrap.yml (Commercial) and gov-provision-posture.yml
 * (GCC-High / IL5). A sovereign lane that deploys an app nobody's bicep creates
 * fails this guard identically to a Commercial one. That is the whole intent:
 * Gov is where a hand-run `az functionapp create` is LEAST likely to have
 * happened, because per csa_loom_gov_verify_via_actions nobody may run local
 * `az` against those boundaries at all.
 *
 * Usage:
 *   node scripts/ci/check-function-app-producer-coverage.mjs
 *   node scripts/ci/check-function-app-producer-coverage.mjs --self-test
 *
 * `--root <dir>` points the REAL analyzer at a fixture tree; it is how
 * --self-test drives it. It cannot hollow the check out — the population floors
 * fail on the empty trees a bogus root produces.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseWorkflow } from './_workflow-yaml.mjs';
import { readLogicalLines } from './_logical-lines.mjs';

const rootFlag = process.argv.indexOf('--root');
const ROOT = rootFlag >= 0 ? process.argv[rootFlag + 1] : process.cwd();
const SELF_TEST = process.argv.includes('--self-test');

/**
 * Deploy targets whose name this analyzer genuinely cannot resolve, each with
 * the reason it is tolerated. An entry is a LOAN, not a fix: it exists so the
 * gap is NAMED instead of silently skipped. Empty today — both shell-variable
 * targets in this repo resolve through their `starts_with(...)` discovery.
 * @type {Map<string,string>}
 */
const UNRESOLVABLE_TARGETS = new Map([]);

// ── file discovery ──────────────────────────────────────────────────────────

/**
 * Directories a producer may NOT live in.
 *
 * FOUND BY MUTATING THIS GUARD, not by reasoning: moving the copilot producer to
 * `temp/HELD.bicep` and re-running left the verdict GREEN, reporting
 * `func-csa-inabox-copilot-fg <- temp/HELD.bicep`. `temp/` is gitignored
 * (.gitignore:242), so that file is not in the repo, is not in any deploy, and
 * vanishes with the working tree — it is the opposite of a producer. A guard
 * that accepts one has been satisfied by a scratch file.
 *
 * `.claude` is excluded for a second reason: `.claude/worktrees/` holds FULL
 * copies of this repo, so a nested worktree would double-count every producer
 * and could cover a target the real tree does not.
 */
const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  '.claude',
  'temp',
  'tmp',
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
]);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (EXCLUDED_DIRS.has(e)) continue;
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const rel = (p) => relative(ROOT, p).split(sep).join('/');

// ── scalar hygiene ──────────────────────────────────────────────────────────

/**
 * Strip ONE layer of matched surrounding quotes.
 *
 * This is not cosmetic. A guard in this repo once reported that
 * `AZURE_LOCATION: "${{ inputs.region }}"` "seeds the deploy region with the
 * bare text \"\"" — it had stripped the expression and was judging the quote
 * characters. Unwrap before you judge a scalar, and never report the raw text
 * of a pattern as if it were the value.
 */
function unquote(s) {
  const t = String(s).trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

// A resolved target/producer name is one of:
//   { kind: 'literal', value }   an exact app name
//   { kind: 'prefix',  value }   a leading literal, the rest computed/discovered
//   { kind: 'unknown', detail }  could not be established — a FAILURE, not a skip
const literal = (value) => ({ kind: 'literal', value });
const prefix = (value) => ({ kind: 'prefix', value });
const unknown = (detail) => ({ kind: 'unknown', detail });

/** Leading literal chunk of a bicep string before its first `${` interpolation. */
function leadingLiteral(bicepString) {
  const i = bicepString.indexOf('${');
  return i < 0 ? null : bicepString.slice(0, i);
}

// ── workflow side: find + resolve deploy targets ────────────────────────────

const FUNCTIONS_ACTION = /^Azure\/functions-action@/i;
const PUBLISH_RE = /\bfunc\s+azure\s+functionapp\s+publish\s+(\S+)/;
const AZ_DEPLOY_RE = /\baz\s+functionapp\s+deploy\b[^\n]*?\s(?:--name|-n)\s+(\S+)/;
/** Cheap pre-filter; the same tokens the deep scan keys on, so they cannot drift apart. */
const DEPLOY_TOKENS = [/Azure\/functions-action/i, /func\s+azure\s+functionapp\s+publish/, /az\s+functionapp\s+deploy\b/];

/**
 * `X=$(az … --query "[?starts_with(name, 'PREFIX')] …")` — the discovery shape
 * both posture lanes use. Tolerant of the space after the comma (one lane has
 * it, the other does not) and of either quote style.
 */
const STARTS_WITH_RE = /starts_with\s*\(\s*name\s*,\s*['"]([^'"]+)['"]\s*\)/;

/** Resolve a `${{ env.X }}` / `$X` / `${X}` token against a workflow. */
function resolveToken(raw, envChain, wfText, seen = new Set()) {
  if (raw === undefined || raw === null) {
    return unknown('the key is absent');
  }
  const t = unquote(raw);
  if (t === '') {
    // "Empty value is UNKNOWN, not safe." An empty app-name deploys nowhere and
    // tells us nothing about what the lane targets.
    return unknown('the value is empty — that is UNKNOWN, not harmless');
  }
  if (seen.has(t)) return unknown(`resolution cycled on ${t}`);
  seen.add(t);

  const ghExpr = t.match(/^\$\{\{\s*([^}]+?)\s*\}\}$/);
  if (ghExpr) {
    const ref = ghExpr[1];
    const envRef = ref.match(/^env\.([A-Za-z_][A-Za-z0-9_-]*)$/);
    if (!envRef) {
      return unknown(`\`\${{ ${ref} }}\` is not an \`env.\` reference, so the name cannot be established statically`);
    }
    const key = envRef[1];
    for (const scope of envChain) {
      if (Object.prototype.hasOwnProperty.call(scope, key)) {
        return resolveToken(scope[key], envChain, wfText, seen);
      }
    }
    return unknown(`\`env.${key}\` is never assigned in this workflow`);
  }

  // Shell variable: $FOO or ${FOO} (quotes already stripped).
  const shellVar = t.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
  if (shellVar) {
    const name = shellVar[1];
    // Find the assignment(s) in the raw workflow text.
    const assigns = [];
    for (const { text } of readLogicalLines(wfText)) {
      const m = text.match(new RegExp(`(?:^|\\s|\\()${name}=(.+)$`));
      if (m) assigns.push(m[1]);
    }
    if (assigns.length === 0) {
      return unknown(`shell variable \`$${name}\` is never assigned in this workflow`);
    }
    for (const a of assigns) {
      const sw = a.match(STARTS_WITH_RE);
      if (sw) return prefix(sw[1]);
    }
    // A plain literal assignment (X=func-foo) is resolvable; anything else is not.
    const plain = assigns
      .map((a) => unquote(a))
      .find((a) => /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(a));
    if (plain) return literal(plain);
    return unknown(`shell variable \`$${name}\` is assigned from an expression this analyzer cannot resolve to a name or a \`starts_with(name,'…')\` prefix`);
  }

  if (t.includes('${{') || t.includes('$')) {
    return unknown(`\`${t}\` still contains an unresolved expression`);
  }
  return literal(t);
}

/** Merge an `env:` mapping node into a plain {key: value} object. */
function envObject(node) {
  const out = {};
  if (!node || typeof node !== 'object' || Array.isArray(node) || 'v' in node) return out;
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === 'object' && 'v' in v) out[k] = v.v;
  }
  return out;
}

function collectTargets(files) {
  const targets = [];
  let parsed = 0;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (!DEPLOY_TOKENS.some((re) => re.test(text))) continue;
    parsed++;

    let doc;
    try {
      doc = parseWorkflow(text);
    } catch (err) {
      // Unparseable is a FAILURE, not a skip — a half-read workflow hides
      // exactly the target we are here to find.
      targets.push({
        file: rel(file),
        line: 1,
        raw: '(whole file)',
        resolved: unknown(`the workflow could not be parsed: ${err.message}`),
      });
      continue;
    }

    const wfEnv = envObject(doc.env);
    const jobs = doc.jobs && typeof doc.jobs === 'object' && !('v' in doc.jobs) ? doc.jobs : {};
    for (const jobNode of Object.values(jobs)) {
      if (!jobNode || typeof jobNode !== 'object' || 'v' in jobNode) continue;
      const jobEnv = envObject(jobNode.env);
      const steps = Array.isArray(jobNode.steps) ? jobNode.steps : [];
      for (const step of steps) {
        if (!step || typeof step !== 'object' || 'v' in step) continue;
        const stepEnv = envObject(step.env);
        // Innermost first — a step-level env overrides the job's, which
        // overrides the workflow's. Getting that order backwards is how a
        // job-level override stayed invisible to a sibling guard.
        const chain = [stepEnv, jobEnv, wfEnv];

        const uses = step.uses && 'v' in step.uses ? step.uses.v : undefined;
        if (uses && FUNCTIONS_ACTION.test(unquote(uses))) {
          const withNode = step.with;
          const appNameNode =
            withNode && typeof withNode === 'object' && !('v' in withNode) ? withNode['app-name'] : undefined;
          const raw = appNameNode && 'v' in appNameNode ? appNameNode.v : undefined;
          targets.push({
            file: rel(file),
            line: appNameNode && 'line' in appNameNode ? appNameNode.line : step.uses.line,
            raw: raw === undefined ? '(app-name absent)' : String(raw),
            resolved: resolveToken(raw, chain, text),
          });
        }

        const runNode = step.run;
        const runText = runNode && 'v' in runNode ? String(runNode.v) : '';
        if (!runText) continue;
        for (const { line, text: logical } of readLogicalLines(runText)) {
          if (/^\s*#/.test(logical)) continue;
          for (const re of [PUBLISH_RE, AZ_DEPLOY_RE]) {
            const m = logical.match(re);
            if (!m) continue;
            targets.push({
              file: rel(file),
              line: (runNode.line || 1) + line,
              raw: m[1],
              resolved: resolveToken(m[1], chain, text),
            });
          }
        }
      }
    }
  }
  return { targets, workflowsWithDeploys: parsed };
}

// ── bicep side: find producers (and consumers, which are NOT producers) ─────

const SITE_DECL_RE = /^resource\s+([A-Za-z_]\w*)\s+'Microsoft\.Web\/sites@[^']+'\s*(existing\s*)?=/;

/** Resolve a bicep `name:` expression to a literal or a literal prefix. */
function resolveBicepName(expr, text) {
  const e = expr.trim();

  const quoted = e.match(/^'([^']*)'$/);
  if (quoted) {
    const v = quoted[1];
    if (!v.includes('${')) return literal(v);
    const lead = leadingLiteral(v);
    return lead ? prefix(lead) : unknown(`interpolated name \`${v}\` has no leading literal`);
  }

  const takeCall = e.match(/^take\(\s*'([^']*)'\s*,/);
  if (takeCall) {
    const v = takeCall[1];
    if (!v.includes('${')) return literal(v);
    const lead = leadingLiteral(v);
    return lead ? prefix(lead) : unknown(`interpolated name \`${v}\` has no leading literal`);
  }

  const ident = e.match(/^([A-Za-z_]\w*)$/);
  if (ident) {
    const name = ident[1];
    const paramDefault = text.match(new RegExp(`^param\\s+${name}\\s+string\\s*=\\s*(.+)$`, 'm'));
    if (paramDefault) return resolveBicepName(paramDefault[1], text);
    const varDef = text.match(new RegExp(`^var\\s+${name}\\s*=\\s*(.+)$`, 'm'));
    if (varDef) return resolveBicepName(varDef[1], text);
    return unknown(`\`${name}\` has no literal default in this file`);
  }

  if (e.includes('${')) {
    const lead = leadingLiteral(e.replace(/^'|'$/g, ''));
    if (lead && lead.length > 0 && !lead.includes("'")) return prefix(lead);
  }
  return unknown(`name expression \`${e}\` is not statically resolvable`);
}

function collectSites(files) {
  const producers = [];
  const consumers = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes("'Microsoft.Web/sites@")) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(SITE_DECL_RE);
      if (!m) continue;
      const isExisting = Boolean(m[2]);
      let nameExpr = null;
      for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
        const nm = lines[j].match(/^\s{2}name:\s*(.+?)\s*$/);
        if (nm) {
          nameExpr = nm[1];
          break;
        }
        if (/^\}/.test(lines[j])) break;
      }
      const entry = {
        file: rel(file),
        line: i + 1,
        resolved: nameExpr === null ? unknown('no `name:` found in the resource body') : resolveBicepName(nameExpr, text),
      };
      (isExisting ? consumers : producers).push(entry);
    }
  }
  return { producers, consumers };
}

// ── matching ────────────────────────────────────────────────────────────────

/**
 * Does `decl` (a bicep producer, or an `existing` consumer) DEMONSTRABLY name
 * the app that `target` deploys to?
 *
 * Coverage is proven in ONE direction only, and this function shipped with the
 * other one. `decl.startsWith(target)` says every name the declaration can emit
 * satisfies the target's selector — that is proof. `target.startsWith(decl)`
 * says only that the two share a leading substring — NECESSARY, never
 * SUFFICIENT — and accepting it credits a generic producer for an app it can
 * never create. That is a guess, in the one direction that produces silence,
 * from a file whose own header says it will not guess.
 *
 * MEASURED on this tree, not reasoned: platform/fiab/bicep/modules/deploy-planner/
 * functions.bicep builds `take('func-loom-${uniqueString(resourceGroup().id)}', 60)`
 * — prefix `func-loom-`, a different app entirely. Under the old rule:
 *
 *   • deleting azure-functions/posture-refresh/deploy/main.bicep left the verdict
 *     GREEN, both posture targets re-attributed to that module — and one of them
 *     is gov-provision-posture.yml (GCC-High / IL5), the boundary this guard's
 *     header names as the reason it exists (cloud-parity.md);
 *   • renaming the copilot target to a literal under that prefix and deleting its
 *     producer ALSO left it GREEN — #3429 itself scoring covered.
 *
 * So 2 of 3 real targets were unguarded and the third only by the accident that
 * no producer prefix happened to lead its name. Cases M9 and M10 pin both.
 */
function matches(target, decl) {
  if (target.kind === 'unknown' || decl.kind === 'unknown') return false;

  if (target.kind === 'literal') {
    // The lane deploys to exactly this name, so only a declaration that emits
    // exactly this name proves coverage. A `prefix` declaration's remainder is
    // computed at deploy time (uniqueString, a param, a suffix); it can never be
    // shown to equal a specific literal, however much of that literal it shares.
    return decl.kind === 'literal' && decl.value === target.value;
  }

  // target.kind === 'prefix': the lane deploys to whatever
  // `starts_with(name, target.value)` discovers. A declaration covers it when
  // EVERY name it can emit starts with that prefix — i.e. the declaration's own
  // literal (or literal prefix) EXTENDS the target's, never the reverse.
  return decl.value.startsWith(target.value);
}

// ── the analyzer ────────────────────────────────────────────────────────────

/** @returns {{failures: {title:string, detail:string}[], rows: string[]}} */
export function analyze(root) {
  const wfDir = join(root, '.github', 'workflows');
  const workflowFiles = existsSync(wfDir)
    ? walk(wfDir).filter((f) => /\.ya?ml$/.test(f))
    : [];
  const bicepFiles = walk(root).filter((f) => f.endsWith('.bicep'));

  const failures = [];
  const rows = [];

  // ── population floors. A guard that finds nothing to check has verified
  // nothing, and "clean" is the WRONG reading of a drifted matcher.
  if (workflowFiles.length === 0) {
    failures.push({
      title: 'no workflows scanned',
      detail: `.github/workflows under ${root} yielded zero files. The tree moved or the scan is pointed at the wrong directory.`,
    });
    return { failures, rows };
  }
  if (bicepFiles.length === 0) {
    failures.push({
      title: 'no bicep scanned',
      detail: `zero *.bicep files found under ${root}. The matcher has drifted from how this repo declares infrastructure.`,
    });
    return { failures, rows };
  }

  const { targets, workflowsWithDeploys } = collectTargets(workflowFiles);
  const { producers, consumers } = collectSites(bicepFiles);

  if (targets.length === 0) {
    failures.push({
      title: 'no Function App deploy target found',
      detail: `scanned ${workflowFiles.length} workflow(s) and found no \`Azure/functions-action\`, \`func azure functionapp publish\` or \`az functionapp deploy\`. This repo deploys Function Apps; zero targets means the matcher drifted, not that the repo is clean.`,
    });
    return { failures, rows };
  }
  if (producers.length === 0) {
    failures.push({
      title: 'no Function App producer found',
      detail: `scanned ${bicepFiles.length} bicep file(s) and found no non-\`existing\` \`Microsoft.Web/sites\` resource. Zero producers with ${targets.length} deploy target(s) is the #3429 estate: everything consumed, nothing created.`,
    });
    return { failures, rows };
  }

  rows.push(
    `${targets.length} deploy target(s) across ${workflowsWithDeploys} workflow(s); ${producers.length} bicep producer(s), ${consumers.length} \`existing\` consumer(s).`
  );

  for (const t of targets) {
    const key = `${t.file}:${t.raw}`;
    const allowed = UNRESOLVABLE_TARGETS.get(key);

    if (t.resolved.kind === 'unknown') {
      if (allowed) {
        rows.push(`  known-unresolvable  ${t.file}:${t.line}  ${t.raw}`);
        continue;
      }
      failures.push({
        title: `${t.file}:${t.line} — deploy target \`${t.raw}\` could not be resolved to an app name`,
        detail: `${t.resolved.detail}. An unresolved target is a FAILURE, not a skip: the analyzer cannot tell whether the app it deploys has a producer. Make the name resolvable, or add "${key}" to UNRESOLVABLE_TARGETS with the reason.`,
      });
      rows.push(`  UNRESOLVED          ${t.file}:${t.line}  ${t.raw}`);
      continue;
    }

    if (allowed) {
      failures.push({
        title: `${key} is in UNRESOLVABLE_TARGETS but now resolves to \`${t.resolved.value}\``,
        detail: 'Remove the entry. An allowlist that outlives its gap stops being a record and starts being noise.',
      });
    }

    const hit = producers.find((p) => matches(t.resolved, p.resolved));
    if (hit) {
      rows.push(`  ok                  ${t.file}:${t.line}  ${t.resolved.value} <- ${hit.file}:${hit.line}`);
      continue;
    }

    const consumedBy = consumers.filter((c) => matches(t.resolved, c.resolved));
    if (consumedBy.length > 0) {
      failures.push({
        title: `${t.file}:${t.line} — \`${t.resolved.value}\` is CONSUMED but never PRODUCED`,
        detail: `${consumedBy
          .map((c) => `${c.file}:${c.line}`)
          .join(', ')} declare(s) it \`existing\`, which READS an app somebody else made. No bicep CREATES it, so this lane can only ever deploy code onto a resource a human provisioned by hand — and cannot recover it when that resource is gone. This is the exact #3429 shape.`,
      });
      rows.push(`  CONSUMED-ONLY       ${t.file}:${t.line}  ${t.resolved.value}`);
      continue;
    }

    failures.push({
      title: `${t.file}:${t.line} — \`${t.resolved.value}\` has no bicep producer`,
      detail: `No *.bicep declares a non-\`existing\` Microsoft.Web/sites resolving to this name. Add one (platform/fiab/bicep/modules/copilot/copilot-chat-function.bicep is the template) so a from-scratch deploy can create it. auto-bind-by-default.md §5: infra prerequisites are DEPLOYED, not requested.`,
    });
    rows.push(`  NO-PRODUCER         ${t.file}:${t.line}  ${t.resolved.value}`);
  }

  return { failures, rows };
}

// ── self-test ───────────────────────────────────────────────────────────────

function fixture(dir, files) {
  for (const [p, body] of Object.entries(files)) {
    const full = join(dir, p);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body, 'utf8');
  }
}

const GOOD_WORKFLOW = `name: deploy good
on: push
env:
  FUNCTION_APP_NAME: func-good-app
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: Azure/functions-action@abc123 # v1
        with:
          app-name: \${{ env.FUNCTION_APP_NAME }}
`;

const GOOD_BICEP = `param functionAppName string = 'func-good-app'
resource site 'Microsoft.Web/sites@2024-04-01' = {
  name: functionAppName
  location: 'eastus'
}
`;

/** The posture shape: a `starts_with(...)` discovery target. */
const POSTURE_WORKFLOW = `name: posture
on: push
jobs:
  p:
    runs-on: ubuntu-latest
    steps:
      - run: |
          FUNC=$(az functionapp list -g "$RG" --query "[?starts_with(name,'func-loom-posture')].name | [0]" -o tsv)
          ( cd azure-functions/posture-refresh && func azure functionapp publish "$FUNC" --python )
`;

/** Its real producer: a literal prefix that EXTENDS the target's. Genuine cover. */
const POSTURE_BICEP = `var siteName = 'func-loom-posture-refresh-\${uniqueString(resourceGroup().id)}'
resource site 'Microsoft.Web/sites@2024-04-01' = {
  name: siteName
  location: 'eastus'
}
`;

/**
 * A DIFFERENT app whose literal prefix LEADS the posture target and the
 * `func-loom-copilot-fg` literal without ever being able to emit either. This is
 * platform/fiab/bicep/modules/deploy-planner/functions.bicep reduced — a Node
 * app built as `take('func-loom-${uniqueString(resourceGroup().id)}', 60)`.
 *
 * No fixture contained a SECOND, MORE GENERIC producer before, and that is
 * precisely why the self-test stayed 10/10 green while the real tree had two
 * unguarded targets. C3/M9/M10 exist to reproduce the shape the tree actually
 * has.
 */
const GENERIC_PREFIX_BICEP = `var siteName = take('func-loom-\${uniqueString(resourceGroup().id)}', 60)
resource site 'Microsoft.Web/sites@2024-04-01' = {
  name: siteName
  location: 'eastus'
}
`;

/** A lane deploying a LITERAL that the generic producer's prefix leads. */
const LITERAL_UNDER_GENERIC_WORKFLOW = `name: deploy literal under generic
on: push
jobs:
  d:
    runs-on: ubuntu-latest
    steps:
      - uses: Azure/functions-action@abc123
        with:
          app-name: func-loom-copilot-fg
`;

function selfTest() {
  const cases = [
    {
      // CONTROL. Must PASS. Without this, "everything fails" would read as a
      // working guard.
      name: 'control: literal target + literal producer',
      files: { '.github/workflows/good.yml': GOOD_WORKFLOW, 'infra/good.bicep': GOOD_BICEP },
      expectFail: false,
    },
    {
      // CONTROL. Must PASS. Proves prefix-on-both-sides (the posture shape) is
      // matched rather than skipped.
      name: 'control: starts_with discovery target + interpolated producer prefix',
      files: {
        '.github/workflows/good.yml': GOOD_WORKFLOW,
        'infra/good.bicep': GOOD_BICEP,
        '.github/workflows/posture.yml': POSTURE_WORKFLOW,
        'infra/posture.bicep': POSTURE_BICEP,
      },
      expectFail: false,
    },
    {
      // CONTROL. Must PASS. The real tree's shape: the correct producer AND a
      // more-generic one that merely LEADS the target's name, side by side.
      // Without this the M9/M10 pins below would also be satisfied by a matcher
      // that had simply become "always false" — this is what proves the fix
      // DISCRIMINATES rather than just rejects.
      name: 'control: a colliding generic producer does not mask the real one',
      files: {
        '.github/workflows/good.yml': GOOD_WORKFLOW,
        'infra/good.bicep': GOOD_BICEP,
        '.github/workflows/posture.yml': POSTURE_WORKFLOW,
        'infra/posture.bicep': POSTURE_BICEP,
        'infra/generic.bicep': GENERIC_PREFIX_BICEP,
      },
      expectFail: false,
    },
    {
      // ADDITIVE mutation — the good pair stays, a bad lane is ADDED alongside.
      // Replacing the only entry would trip the population floor and read as
      // proven; every blind spot found in sprint 1 came from exactly this shape.
      name: 'M1 additive: a second lane deploys an app with no producer',
      files: {
        '.github/workflows/good.yml': GOOD_WORKFLOW,
        'infra/good.bicep': GOOD_BICEP,
        '.github/workflows/orphan.yml': `name: deploy orphan
on: push
jobs:
  d:
    runs-on: ubuntu-latest
    steps:
      - uses: Azure/functions-action@abc123
        with:
          app-name: func-orphan-app
`,
      },
      expectFail: true,
      expectText: 'func-orphan-app',
    },
    {
      // The #3429 shape itself: declared, but `existing`.
      name: 'M2 additive: target exists in bicep only as `existing`',
      files: {
        '.github/workflows/good.yml': GOOD_WORKFLOW,
        'infra/good.bicep': GOOD_BICEP,
        '.github/workflows/copilot.yml': `name: deploy copilot
on: push
jobs:
  d:
    runs-on: ubuntu-latest
    steps:
      - uses: Azure/functions-action@abc123
        with:
          app-name: func-consumed-only
`,
        'infra/cosmos.bicep': `param functionAppName string = 'func-consumed-only'
resource functionApp 'Microsoft.Web/sites@2024-04-01' existing = {
  name: functionAppName
}
`,
      },
      expectFail: true,
      expectText: 'CONSUMED but never PRODUCED',
    },
    {
      // "Empty value is UNKNOWN, not safe."
      name: 'M3 additive: empty app-name must fail, not be skipped',
      files: {
        '.github/workflows/good.yml': GOOD_WORKFLOW,
        'infra/good.bicep': GOOD_BICEP,
        '.github/workflows/empty.yml': `name: deploy empty
on: push
jobs:
  d:
    runs-on: ubuntu-latest
    steps:
      - uses: Azure/functions-action@abc123
        with:
          app-name: ""
`,
      },
      expectFail: true,
      expectText: 'UNKNOWN, not harmless',
    },
    {
      name: 'M4 additive: an unresolvable expression must fail, not be skipped',
      files: {
        '.github/workflows/good.yml': GOOD_WORKFLOW,
        'infra/good.bicep': GOOD_BICEP,
        '.github/workflows/secret.yml': `name: deploy secret-named
on: push
jobs:
  d:
    runs-on: ubuntu-latest
    steps:
      - uses: Azure/functions-action@abc123
        with:
          app-name: \${{ secrets.APP_NAME }}
`,
      },
      expectFail: true,
      expectText: 'not an `env.` reference',
    },
    {
      // MISMATCH keying: the producer still exists, it just no longer names the
      // app the lane deploys. A guard keyed only to "is there a producer" goes
      // quiet here; this one must not.
      name: 'M5 replacement: producer renamed away from the deploy target',
      files: {
        '.github/workflows/good.yml': GOOD_WORKFLOW,
        'infra/good.bicep': GOOD_BICEP.replace("'func-good-app'", "'func-good-app-renamed'"),
      },
      expectFail: true,
      expectText: 'has no bicep producer',
    },
    {
      // Population floor.
      name: 'M6 population: workflows deploy, zero producers in the tree',
      files: {
        '.github/workflows/good.yml': GOOD_WORKFLOW,
        'infra/nothing.bicep': "param x string = 'y'\n",
      },
      expectFail: true,
      expectText: 'no Function App producer found',
    },
    {
      // A job-level env must override the workflow-level seed. Getting this
      // order backwards is how a sibling guard reported found=1/violations=0
      // while the defect sat in the override.
      name: 'M7 additive: job-level env override points at an unproduced app',
      files: {
        '.github/workflows/good.yml': GOOD_WORKFLOW,
        'infra/good.bicep': GOOD_BICEP,
        '.github/workflows/override.yml': `name: deploy override
on: push
env:
  FUNCTION_APP_NAME: func-good-app
jobs:
  d:
    runs-on: ubuntu-latest
    env:
      FUNCTION_APP_NAME: func-override-app
    steps:
      - uses: Azure/functions-action@abc123
        with:
          app-name: \${{ env.FUNCTION_APP_NAME }}
`,
      },
      expectFail: true,
      expectText: 'func-override-app',
    },
    {
      // Regression case for a defect this guard SHIPPED WITH and that only the
      // real-tree mutation exposed: with `temp/` walked, moving the producer to
      // temp/HELD.bicep kept the verdict GREEN. A gitignored scratch file is not
      // a producer.
      name: 'M8 relocation: a producer moved into gitignored temp/ must NOT count',
      files: {
        '.github/workflows/good.yml': GOOD_WORKFLOW,
        'temp/good.bicep': GOOD_BICEP,
        'infra/other.bicep': `resource other 'Microsoft.Web/sites@2024-04-01' = {
  name: 'func-something-else'
  location: 'eastus'
}
`,
      },
      expectFail: true,
      expectText: 'has no bicep producer',
    },
    {
      // REGRESSION PIN for the defect this guard SHIPPED WITH, direction 1:
      // a PREFIX target credited to a producer whose prefix is SHORTER than it.
      // `func-loom-` can only ever emit `func-loom-<uniqueString>`, which never
      // satisfies `starts_with(name,'func-loom-posture')` — yet the old
      // `target.value.startsWith(decl.value)` disjunct accepted it, and deleting
      // the real posture producer on the REAL TREE left the verdict GREEN for
      // BOTH posture lanes, one of which is gov-provision-posture.yml
      // (GCC-High / IL5). cloud-parity.md: the guard was blindest exactly where
      // its own header says it matters most.
      name: 'M9 collision: a prefix target must NOT be covered by a shorter, more generic producer prefix',
      files: {
        '.github/workflows/good.yml': GOOD_WORKFLOW,
        'infra/good.bicep': GOOD_BICEP,
        '.github/workflows/posture.yml': POSTURE_WORKFLOW,
        'infra/generic.bicep': GENERIC_PREFIX_BICEP,
      },
      expectFail: true,
      expectText: 'func-loom-posture',
    },
    {
      // REGRESSION PIN, direction 2: a LITERAL target credited to a prefix
      // producer merely because the literal starts with that prefix. A prefix
      // producer's remainder is computed at deploy time and can never be shown
      // to equal a specific literal. On the real tree this scored #3429 ITSELF
      // as covered — the copilot target renamed under `func-loom-`, its producer
      // deleted, exit 0. This is why the rework was not one line: the hole was
      // never confined to prefix targets.
      name: 'M10 collision: a literal target must NOT be covered by a prefix producer that merely leads it',
      files: {
        '.github/workflows/good.yml': GOOD_WORKFLOW,
        'infra/good.bicep': GOOD_BICEP,
        '.github/workflows/literal.yml': LITERAL_UNDER_GENERIC_WORKFLOW,
        'infra/generic.bicep': GENERIC_PREFIX_BICEP,
      },
      expectFail: true,
      expectText: 'func-loom-copilot-fg',
    },
  ];

  let bad = 0;
  const base = mkdtempSync(join(tmpdir(), 'fnprod-selftest-'));
  for (const c of cases) {
    const dir = join(base, c.name.replace(/[^a-z0-9]+/gi, '-'));
    mkdirSync(dir, { recursive: true });
    fixture(dir, c.files);
    const { failures } = analyze(dir);
    const failed = failures.length > 0;
    const blob = failures.map((f) => `${f.title} ${f.detail}`).join('\n');
    const textOk = !c.expectText || blob.includes(c.expectText);
    const ok = failed === c.expectFail && textOk;
    if (!ok) {
      bad++;
      console.error(`  [self-test] ${c.name}`);
      console.error(`      expected ${c.expectFail ? 'FAIL' : 'PASS'}${c.expectText ? ` containing "${c.expectText}"` : ''}, got ${failed ? 'FAIL' : 'PASS'}`);
      if (blob) console.error(`      findings: ${blob.slice(0, 400)}`);
    } else {
      console.log(`  [self-test] ok — ${c.name}`);
    }
  }
  rmSync(base, { recursive: true, force: true });

  if (bad > 0) {
    console.error(`\n[function-app-producer-coverage] SELF-TEST FAILED — ${bad} case(s). The analyzer cannot see the defects it exists to catch; do not trust its verdict on the real tree.`);
    process.exit(1);
  }
  console.log('[function-app-producer-coverage] self-test OK — every mutant detected, all controls pass.');
}

// ── entrypoint ──────────────────────────────────────────────────────────────

function main() {
  if (SELF_TEST) {
    selfTest();
    return;
  }
  const { failures, rows } = analyze(ROOT);
  console.log('[function-app-producer-coverage]');
  for (const r of rows) console.log(r);

  if (failures.length === 0) {
    console.log('\n[function-app-producer-coverage] OK — every deployed Function App has a bicep producer.');
    process.exit(0);
  }
  console.error(`\n[function-app-producer-coverage] FAIL — ${failures.length} problem(s).\n`);
  for (const f of failures) {
    console.error(`  ${f.title}`);
    console.error(`    ${f.detail}\n`);
  }
  console.error('  A Function App no bicep creates exists only because somebody ran `az functionapp');
  console.error('  create` by hand. When it is gone, the deploy lane has no recovery path — that is');
  console.error('  #3429, eight consecutive red runs on the production docs-site chat backend.\n');
  process.exit(1);
}

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) main();
