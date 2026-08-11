#!/usr/bin/env node
/**
 * GUARDRAIL: every `actions/github-script` body must COMPILE the way the action
 * compiles it.
 *
 * WHY THIS EXISTS (2026-08-09, loom-synthetic-monitor)
 * ---------------------------------------------------
 * `loom-synthetic-monitor.yml` opened its alert step with:
 *
 *     const exec = `${{ steps.run.outputs.execution }}` || '<unknown>';
 *
 * `exec` is one of the values actions/github-script INJECTS. The action does
 * roughly:
 *
 *     new AsyncFunction('require', '__original_require__', 'github', 'context',
 *                       'core', 'exec', 'glob', 'io', 'fetch', script)
 *
 * so the script body is a function whose PARAMETERS carry those names, and a
 * `const` of the same name is a redeclaration — `SyntaxError: Identifier 'exec'
 * has already been declared`. The function never gets built, so the body never
 * runs; not one statement of it.
 *
 * That step was the synthetic monitor's designated durable alert — "the dedup
 * GitHub issue below is the durable signal", per the file's own header. It
 * threw on every invocation. Measured when this guard was written: the six
 * live user journeys had been failing continuously since 2026-08-07T08:15Z
 * (83 of the last 100 runs red) and the number of synthetic-monitor issues
 * EVER filed was ZERO. The detector worked perfectly; the part that tells a
 * human was dead on arrival, and being dead is what kept it quiet.
 *
 * A plain `node --check` does NOT catch this: at the top level of a script,
 * `const exec = 1` is perfectly legal. The redeclaration only exists inside the
 * function wrapper. So this guard reproduces the wrapper rather than
 * approximating it — the "run the real dependency, compare byte-for-byte"
 * lesson, applied to a compile step.
 *
 * WHAT IT CHECKS
 * --------------
 * For every step with `uses: actions/github-script@*` and an inline `script:`
 * block: build `new AsyncFunction(...INJECTED, body)` and report any
 * SyntaxError with the file, step name and line.
 *
 * `${{ ... }}` expressions are substituted before the JS ever parses, so they
 * are replaced here with a benign literal (`0`). That keeps the check about
 * JS syntax and not about expression values — `${{ x }}` inside a template
 * literal, a string, or a bare expression position all remain valid.
 *
 * DELIBERATELY NOT CHECKED — and why:
 *   - Runtime behaviour. This is a COMPILE check; a body that parses can still
 *     throw. Compilation is the failure mode that produced a silent alert.
 *   - `script:` supplied via an expression / file reference rather than an
 *     inline block. There is nothing to parse.
 *   - Non-github-script `run:` blocks. Shell has its own guards in this dir.
 *
 * ESCAPE HATCH: none, by design. A body that cannot compile has no honest
 * reason to ship; rename the local, do not suppress the finding.
 *
 * SELF-DEFENCE: refuses to pass vacuously. If it finds no workflows, or zero
 * github-script blocks, it FAILS rather than printing OK — a scanner that has
 * silently stopped matching is the same defect it exists to catch (the
 * 2026-07-28 "gates that measure nothing" class).
 *
 * Usage: node scripts/ci/check-github-script-syntax.mjs [workflow-dir]
 *   The optional directory argument exists for the self-test in
 *   scripts/ci/__tests__/github-script-syntax.test.mjs; CI passes nothing.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_DIR = '.github/workflows';
const WORKFLOW_DIR = process.argv[2] || DEFAULT_DIR;
const IS_DEFAULT = WORKFLOW_DIR === DEFAULT_DIR;

/**
 * The values actions/github-script injects, in the action's own order.
 * Source: actions/github-script v7 `src/main.ts` — the object passed to
 * `callAsyncFunction`, whose keys become the AsyncFunction parameter list.
 * Keep this list in sync when the pinned major changes; a name MISSING here
 * only costs a missed finding, a name wrongly ADDED would be a false positive,
 * so it is intentionally the documented set and nothing inferred.
 */
const INJECTED = [
  'require',
  '__original_require__',
  'github',
  'context',
  'core',
  'exec',
  'glob',
  'io',
  'fetch',
];

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

/** A step begins at a YAML sequence item inside a `steps:` list. */
const STEP_START = /^(\s*)-\s+(name|uses|run|id|if|with|env|shell|continue-on-error):/;
/**
 * Matches BOTH step spellings: a `uses:` on its own line, and the very common
 * `- uses: actions/github-script@v7` where the key shares the sequence-dash
 * line. Anchoring on `^\s*uses:` alone silently skipped every step of the
 * second kind — 2 of this repo's 20 blocks — which is the same
 * blind-to-a-variant failure this directory's other guards have hit before.
 */
const USES_GITHUB_SCRIPT = /^\s*(-\s+)?uses:\s*actions\/github-script@/;

/** Slice the lines belonging to one step, starting at `start`. */
function stepBody(lines, start) {
  const indent = lines[start].match(/^(\s*)/)[1].length;
  for (let j = start + 1; j < lines.length; j++) {
    const line = lines[j];
    if (line.trim() === '') continue;
    const ind = line.match(/^(\s*)/)[1].length;
    if (ind === indent && /^\s*-\s+\S/.test(line)) return lines.slice(start, j);
    if (ind < indent) return lines.slice(start, j);
  }
  return lines.slice(start);
}

/**
 * The inline `script: |` block within a step body, dedented, plus the offset of
 * its first content line relative to the step start. Returns null when the step
 * has no inline block scalar for `script:`.
 */
function scriptBlock(body) {
  const idx = body.findIndex((l) => /^\s*script:\s*[|>][-+]?\d*\s*(#.*)?$/.test(l));
  if (idx < 0) return null;
  const indent = body[idx].match(/^(\s*)/)[1].length;
  const out = [];
  let blockIndent = null;
  for (let k = idx + 1; k < body.length; k++) {
    const line = body[k];
    if (line.trim() === '') { out.push(''); continue; }
    const ind = line.match(/^(\s*)/)[1].length;
    if (ind <= indent) break;
    if (blockIndent === null) blockIndent = ind;
    out.push(line.slice(Math.min(blockIndent, ind)));
  }
  while (out.length && out.at(-1) === '') out.pop();
  return { text: out.join('\n'), offset: idx + 1 };
}

/**
 * Replace `${{ ... }}` with a benign literal. GitHub substitutes these before
 * the JS is parsed, so leaving them in would report syntax errors the action
 * never sees. `0` is valid in every position an expression can occupy here.
 */
const stripExpressions = (src) => src.replace(/\$\{\{[\s\S]*?\}\}/g, '0');

const violations = [];
let examined = 0;
const files = readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f)).sort();

for (const file of files) {
  const lines = readFileSync(join(WORKFLOW_DIR, file), 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!STEP_START.test(lines[i])) continue;
    const body = stepBody(lines, i);
    const stepStart = i;
    i += body.length - 1;

    if (!body.some((l) => USES_GITHUB_SCRIPT.test(l))) continue;
    const block = scriptBlock(body);
    if (!block) continue;
    examined++;

    const name = (body.find((l) => /^\s*-?\s*name:/.test(l)) || '')
      .replace(/^\s*-?\s*name:\s*/, '').trim() || '(unnamed step)';

    try {
      // Compile exactly as the action does. Never invoked — compilation is the
      // whole check.
      new AsyncFunction(...INJECTED, stripExpressions(block.text));
    } catch (err) {
      violations.push({
        file,
        line: stepStart + block.offset + 1,
        name,
        why: `${err.name}: ${err.message}`,
      });
    }
  }
}

if (violations.length > 0) {
  console.error(
    `\n[github-script-syntax] ${violations.length} github-script block(s) do not compile:\n`,
  );
  for (const v of violations) {
    console.error(`  ${WORKFLOW_DIR}/${v.file}:${v.line}  ${v.name}`);
    console.error(`      ${v.why}`);
  }
  console.error(
    '\n  actions/github-script turns each `script:` body into an async function\n' +
      `  whose parameters are: ${INJECTED.join(', ')}.\n` +
      '  Declaring a const/let/var/function of one of those names is a redeclaration,\n' +
      '  and the SyntaxError kills the step before its first line runs.\n' +
      '\n  That is not a loud failure. loom-synthetic-monitor\'s alert step threw this\n' +
      '  on every invocation while the six live journeys were down — 83 red runs and\n' +
      '  ZERO issues ever filed, because the part that files them never compiled.\n' +
      '\n  Fix: rename the local (`exec` -> `execName`). Do not suppress.\n',
  );
  process.exit(1);
}

// A scanner that matches nothing is not a passing check — it is a broken one.
if (IS_DEFAULT && (files.length === 0 || examined === 0)) {
  console.error(
    `[github-script-syntax] REFUSING TO PASS: scanned ${files.length} workflow(s) and found ` +
      `${examined} inline github-script block(s). This repo has many. The parser has ` +
      'stopped matching (YAML shape change?) — fix the scanner, do not ship a green ' +
      'check that measures nothing.',
  );
  process.exit(1);
}

console.log(
  `[github-script-syntax] OK — ${files.length} workflows, ${examined} inline github-script block(s); every one compiles.`,
);
