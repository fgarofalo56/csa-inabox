#!/usr/bin/env node
/**
 * check-bicepparam-env-reaches-deploy.mjs
 *
 * RULE. If a `.bicepparam` reads a value with `readEnvironmentVariable('X', …)`,
 * then every workflow step that DEPLOYS that param file must have `X` in scope.
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
 * SCOPE. Only `LOOM_*_TAG` reads are enforced, because those pin a container
 * IMAGE and getting one wrong silently changes what is running. Other
 * readEnvironmentVariable values (feature toggles, endpoints) fail loudly or are
 * genuinely optional; widening this rule to all of them would flag correct code
 * and get the rule muted.
 *
 * IN SCOPE means step `env:`, job `env:`, or workflow `env:` — a variable set at
 * any of those levels reaches the process.
 *
 * SELF-DEFENCE. Fails if it finds no param files, no env reads, or no deploying
 * steps — a matcher that has drifted off the code must not report a pass.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const PARAM_DIR = join(ROOT, 'platform', 'fiab', 'bicep', 'params');
const WF_DIR = join(ROOT, '.github', 'workflows');

/** LOOM_*_TAG values a param file reads from the environment. */
function tagReads(text) {
  const out = new Set();
  for (const m of text.matchAll(/readEnvironmentVariable\(\s*'(LOOM_[A-Z0-9_]*TAG)'/g)) out.add(m[1]);
  return out;
}

if (!existsSync(PARAM_DIR)) {
  console.error(`::error::bicepparam-env-reaches-deploy: ${PARAM_DIR} does not exist — the params moved. Refusing to pass.`);
  process.exit(1);
}

const params = new Map();
for (const f of readdirSync(PARAM_DIR)) {
  if (!f.endsWith('.bicepparam')) continue;
  const reads = tagReads(normalize(readFileSync(join(PARAM_DIR, f), 'utf8')));
  if (reads.size > 0) params.set(f, reads);
}

if (params.size === 0) {
  console.error(
    '::error::bicepparam-env-reaches-deploy: no .bicepparam reads a LOOM_*_TAG via readEnvironmentVariable. ' +
      'Several do, so the matcher has drifted. Refusing to report a pass on an empty population.',
  );
  process.exit(1);
}

/**
 * Split a workflow into steps WITHOUT a YAML parser: this file must not depend
 * on js-yaml being installed for a guard that runs before install in some lanes.
 * Steps are `      - name:` at a fixed indent in every workflow in this repo.
 */
function stepsOf(text) {
  const lines = text.split('\n');
  const starts = [];
  lines.forEach((l, i) => { if (/^ {6}- name:/.test(l)) starts.push(i); });
  return starts.map((s, i) => ({
    name: (lines[s].split('name:')[1] || '').trim(),
    body: lines.slice(s, i + 1 < starts.length ? starts[i + 1] : lines.length).join('\n'),
  }));
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
const stripYamlComments = (s) => s.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

/**
 * Normalise CRLF before ANY indent- or line-anchored matching.
 *
 * On a Windows checkout git hands these files back with `\r\n`, so a pattern
 * ending `env:\n` never matches and every step reads as having no `env:` block.
 * That made this guard report 32 violations on a tree that was correct — and,
 * worse, it had previously CANCELLED OUT a second bug: the old `globalEnvKeys`
 * regex used `\s`, which matches `\r`, so it kept finding keys the step matcher
 * had already lost. Two defects producing a plausible answer between them.
 *
 * CI runs Linux, so this only ever misfired locally — which is precisely where
 * a guard gets verified before it ships.
 */
// A function DECLARATION, not a const: this is called from the param-file loop
// above, and a `const` arrow would sit in the temporal dead zone there.
function normalize(s) {
  return s.replace(/\r\n/g, '\n');
}

/**
 * Env keys that reach EVERY step: the workflow-level `env:` (indent 0) and each
 * job-level `env:` (indent 4). Nothing else.
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
function globalEnvKeys(text) {
  const out = new Set();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)env:\s*$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    if (indent !== 0 && indent !== 4) continue; // step-level (8) does NOT reach siblings
    for (let j = i + 1; j < lines.length; j++) {
      const km = /^(\s+)([A-Za-z_][A-Za-z0-9_]*):/.exec(lines[j]);
      if (!km || km[1].length <= indent) break;
      out.add(km[2]);
    }
  }
  return out;
}

const violations = [];
let deployingSteps = 0;

for (const f of readdirSync(WF_DIR)) {
  if (!/\.ya?ml$/.test(f)) continue;
  const text = stripYamlComments(normalize(readFileSync(join(WF_DIR, f), 'utf8')));
  if (!/deployment\s+sub\s+create|deployment\s+group\s+create/.test(text)) continue;

  const globals = globalEnvKeys(text);
  for (const step of stepsOf(text)) {
    if (!/deployment\s+sub\s+create|deployment\s+group\s+create/.test(step.body)) continue;

    // Which param file does this step deploy?
    const used = [...params.keys()].filter((p) => step.body.includes(p));
    if (used.length === 0) continue;
    deployingSteps++;

    // Env keys declared on THIS step.
    // Literal spaces, not \s — \s also matches \r and \n, which is how the CRLF
    // bug above stayed invisible for as long as it did.
    const envBlock = /\n {8}env:\n((?: {10}\S[^\n]*\n)+)/.exec(step.body);
    const stepEnv = new Set();
    if (envBlock) for (const m of envBlock[1].matchAll(/^ {10}([A-Za-z_][A-Za-z0-9_]*):/gm)) stepEnv.add(m[1]);

    for (const p of used) {
      for (const v of params.get(p)) {
        if (stepEnv.has(v) || globals.has(v)) continue;
        violations.push({ file: `.github/workflows/${f}`, step: step.name.slice(0, 60), param: p, missing: v });
      }
    }
  }
}

if (deployingSteps === 0) {
  console.error(
    '::error::bicepparam-env-reaches-deploy: found ZERO workflow steps that deploy a tag-reading .bicepparam. ' +
      'Several exist, so the step or param matcher has drifted. Refusing to pass on an empty population.',
  );
  process.exit(1);
}

if (violations.length > 0) {
  console.error(
    `::error::bicepparam-env-reaches-deploy: ${violations.length} deploy step(s) do not set a LOOM_*_TAG their ` +
      '.bicepparam reads. readEnvironmentVariable() has a DEFAULT, so this does NOT fail — the deploy succeeds and ' +
      'silently writes the fallback tag onto live Container Apps, reverting any SHA-pinned roll with nothing in ' +
      'the log. See #3161.',
  );
  for (const v of violations) {
    console.error(`::error file=${v.file}::step '${v.step}' deploys ${v.param} but does not set ${v.missing}`);
  }
  process.exit(1);
}

console.log(
  `bicepparam-env-reaches-deploy OK — ${params.size} tag-reading param file(s), ${deployingSteps} deploying step(s); ` +
    'every LOOM_*_TAG a param file reads is in scope where it is deployed.',
);
