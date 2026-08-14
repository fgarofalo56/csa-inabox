#!/usr/bin/env node
/**
 * GUARDRAIL: a workflow `env:` value must not contain shell substitution.
 *
 * WHY THIS EXISTS (#3137, deploy-integrity.md R1/R7)
 * --------------------------------------------------
 * Both sovereign deploy lanes carried this on their smoke-test step:
 *
 *     - name: Smoke test (Gov-specific)
 *       run: bash .github/scripts/fiab-smoke-test.sh
 *       env:
 *         CONSOLE_URL: $(azd env get-values | grep CONSOLE_URL | cut -d= -f2)
 *
 * A workflow `env:` value is a LITERAL. GitHub Actions evaluates `${{ }}`
 * expressions while the workflow is processed — "the value of the GITHUB_REF
 * variable can be read during workflow processing using the ${{ github.ref }}
 * context property" (docs.github.com, Variables) — and hands everything else to
 * the runner verbatim. `$( … )` is shell syntax, and nothing in that path is a
 * shell. So the step received the TEXT `$(azd env get-values | …)` as its
 * console URL.
 *
 * That is worse than an empty value in a specific, measured way: the smoke
 * script guards with `${CONSOLE_URL:?CONSOLE_URL must be set}`, and the TEXT is
 * non-empty, so the guard passed and every probe curled a nonsense address. A
 * step that runs and cannot pass — the same class the smoke script's own header
 * documents ("It could not pass. Nobody saw it…").
 *
 * It had never fired because `deploy-fiab-gcch` had never got past `Provision`
 * (#3137, #3217, #3221, #3232, #3236, #3390) and `deploy-fiab-gcc` is
 * disabled_manually (#3345). A latent defect on the step immediately AFTER the
 * one everyone was fixing.
 *
 * WHY actionlint DOES NOT CATCH IT (verified, not assumed)
 * -------------------------------------------------------
 * actionlint validates workflow SYNTAX and pipes `run:` bodies through
 * shellcheck. An `env:` value is a valid YAML string whatever it contains, and
 * it is never a `run:` body, so no shellcheck rule is applied to it. Run against
 * the pre-fix file, actionlint reports nothing about that line. The repo's
 * check-workflow-unset-vars.mjs is also blind here for the opposite reason: it
 * asks whether a name is ASSIGNED, and `CONSOLE_URL` *is* assigned — with
 * garbage.
 *
 * THE RULE
 * --------
 * A value under any `env:` mapping (workflow, job, or step) must not contain
 * `$( … )` or a backtick substitution. Use one of:
 *
 *   - `${{ steps.<id>.outputs.<name> }}` — compute it in an earlier step and
 *     write it to `$GITHUB_OUTPUT` (this is what deploy-fiab-commercial.yml has
 *     always done for CONSOLE_URL, and what the sovereign lanes now do);
 *   - `$GITHUB_ENV` from an earlier step;
 *   - compute it inside the `run:` body, where a shell actually runs.
 *
 * NOT A VIOLATION — `${VAR}` / `$VAR` in an `env:` value. Those are ALSO not
 * expanded by Actions, but they are frequently intentional (a literal template
 * consumed by the step, e.g. a `--query` string or a format spec) and flagging
 * them would be a false-positive machine. Command substitution has no such
 * benign reading: its only purpose is to run a command, and it never will.
 *
 * SELF-DEFENCE: this guard's population is ZERO once #3137 is fixed, so "no
 * findings" would be indistinguishable from "the matcher stopped matching".
 * `--self-test` drives the analyser over the verbatim #3137 defect and FAILS if
 * it is not reported; the check run also refuses to pass if it scanned no
 * workflows or found no `env:` mappings at all.
 *
 * ESCAPE HATCH: a value that genuinely must contain that text (documenting the
 * syntax, a payload for a downstream shell) may carry
 *   # env-substitution-ok: <reason>
 * on the line above it.
 *
 * MODES
 *   node scripts/ci/check-workflow-env-substitution.mjs              # CHECK
 *   node scripts/ci/check-workflow-env-substitution.mjs --self-test  # prove it can fail
 * Tests: node --test scripts/ci/__tests__/workflow-env-substitution.test.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_DIR = '.github/workflows';

/** `$(` … `)` or a backtick pair. Both are command substitution in POSIX sh. */
const COMMAND_SUBSTITUTION = /\$\([^)]*\)|`[^`]+`/;

const ALLOW_MARKER = /#\s*env-substitution-ok\s*:/;

/**
 * Scan one workflow's text for `env:` mapping values containing command
 * substitution.
 *
 * Deliberately line-based rather than YAML-parsed: the finding must carry a
 * LINE NUMBER a reviewer can open, and a YAML load discards them. The tradeoff
 * is that only single-line `KEY: value` entries under an `env:` mapping are
 * considered — a block scalar under `env:` is not valid for a mapping VALUE in
 * the shapes this repo uses, and a multi-line value that ran a command would
 * still not be executed, so the narrow matcher closes the shape that occurred.
 *
 * @returns {{line:number, key:string, value:string}[]}
 */
export function findEnvSubstitutions(source) {
  const lines = source.split(/\r?\n/);
  const findings = [];
  // Indent of the `env:` mapping we are currently inside, or null.
  let envIndent = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;

    const indent = line.match(/^(\s*)/)[1].length;

    if (envIndent !== null && indent <= envIndent) envIndent = null;

    // `env:` with nothing after it opens a mapping. `env: {}` / `env: ${{ … }}`
    // do not.
    const envOpen = line.match(/^(\s*)-?\s*env:\s*$/);
    if (envOpen) {
      envIndent = line.indexOf('env:');
      continue;
    }

    if (envIndent === null) continue;
    if (indent <= envIndent) continue;

    const entry = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!entry) continue;

    const [, key, rawValue] = entry;
    // Strip a trailing `# comment` only when it is clearly not inside the value.
    const value = rawValue.trim();
    if (!COMMAND_SUBSTITUTION.test(value)) continue;

    const prev = i > 0 ? lines[i - 1] : '';
    if (ALLOW_MARKER.test(prev) || ALLOW_MARKER.test(line)) continue;

    findings.push({ line: i + 1, key, value });
  }

  return findings;
}

/** The verbatim #3137 defect, used by --self-test. */
export const SELF_TEST_FIXTURE = `
name: self-test
on: workflow_dispatch
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Smoke test (Gov-specific)
        run: bash .github/scripts/fiab-smoke-test.sh
        env:
          CONSOLE_URL: $(azd env get-values | grep CONSOLE_URL | cut -d= -f2)
          BOUNDARY: GCC-High
`;

/** A control: the CORRECT shape must NOT be reported. */
export const SELF_TEST_CONTROL = `
name: self-test-control
on: workflow_dispatch
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Smoke test (Gov-specific)
        run: bash .github/scripts/fiab-smoke-test.sh
        env:
          CONSOLE_URL: \${{ steps.provision.outputs.console_url }}
          BOUNDARY: GCC-High
`;

function selfTest() {
  const hits = findEnvSubstitutions(SELF_TEST_FIXTURE);
  const control = findEnvSubstitutions(SELF_TEST_CONTROL);
  const problems = [];
  if (!hits.some((h) => h.key === 'CONSOLE_URL')) {
    problems.push('the #3137 defect (CONSOLE_URL: $(azd env get-values …)) was NOT reported');
  }
  if (hits.some((h) => h.key === 'BOUNDARY')) {
    problems.push('a plain literal (BOUNDARY: GCC-High) was reported — false positive');
  }
  if (control.length !== 0) {
    problems.push(`the CORRECT \${{ steps.*.outputs.* }} shape was reported (${control.length} finding(s)) — false positive`);
  }
  if (problems.length > 0) {
    console.error('[workflow-env-substitution] SELF-TEST FAILED:');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('\n  The analyser no longer detects the defect it exists for. Fix the matcher.');
    process.exit(1);
  }
  console.log('[workflow-env-substitution] self-test OK — detects the #3137 defect, and does not flag the correct shape or a plain literal.');
}

function check(dir) {
  if (!existsSync(dir)) {
    console.error(`[workflow-env-substitution] REFUSING TO PASS: ${dir} does not exist.`);
    process.exit(1);
  }
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  const violations = [];
  let envMappings = 0;

  for (const file of files) {
    const src = readFileSync(join(dir, file), 'utf8');
    envMappings += (src.match(/^\s*-?\s*env:\s*$/gm) || []).length;
    for (const hit of findEnvSubstitutions(src)) violations.push({ file, ...hit });
  }

  if (violations.length > 0) {
    console.error(`\n[workflow-env-substitution] ${violations.length} \`env:\` value(s) contain shell substitution that will NEVER run:\n`);
    for (const v of violations) {
      console.error(`  ${dir}/${v.file}:${v.line}  ${v.key}`);
      console.error(`      ${v.value}`);
    }
    console.error(
      '\n  A workflow `env:` value is a LITERAL. Actions substitutes `${{ }}` during workflow\n' +
        '  processing and passes the rest through verbatim; nothing in that path is a shell, so\n' +
        '  `$( … )` reaches the step as TEXT. On #3137 that text became the smoke test\'s console\n' +
        '  URL — non-empty, so the script\'s `${CONSOLE_URL:?}` guard passed and every probe\n' +
        '  curled a nonsense address.\n' +
        '\n  Compute it in an earlier step and pass `${{ steps.<id>.outputs.<name> }}`, write\n' +
        '  `$GITHUB_ENV`, or move the command into the `run:` body where a shell actually runs.\n' +
        '  If the text is genuinely wanted, mark it: `# env-substitution-ok: <reason>`.\n',
    );
    process.exit(1);
  }

  if (files.length === 0 || envMappings === 0) {
    console.error(
      `[workflow-env-substitution] REFUSING TO PASS: scanned ${files.length} workflow(s) and found ` +
        `${envMappings} \`env:\` mapping(s). This repo has hundreds. The matcher has stopped matching — ` +
        'fix the scanner, do not ship a green check that measures nothing.',
    );
    process.exit(1);
  }

  console.log(
    `[workflow-env-substitution] OK — ${files.length} workflows, ${envMappings} \`env:\` mapping(s); ` +
      'no value carries shell substitution.',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--self-test')) selfTest();
  else check(process.argv[2] || DEFAULT_DIR);
}
