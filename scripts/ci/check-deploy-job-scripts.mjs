#!/usr/bin/env node
/**
 * GUARDRAIL: the `az containerapp job create` a `deploy-*-job.sh` performs must be
 * ABLE TO SUCCEED on a fresh estate, and its failure must be VISIBLE.
 *
 * WHY THIS EXISTS (#2816 residual). check-deploy-script-reachability.mjs proved the
 * five deploy scripts are now invocable from CI. It says nothing about whether the
 * command they invoke works. Three defects survived that check:
 *
 *  1. deploy-loom-verify-job.sh emitted `- { name: SESSION_SECRET, secretRef: session-secret }`
 *     while its YAML declared NO `configuration.secrets:` block. ARM rejects a
 *     deployment whose env var references an unknown secret
 *     (learn.microsoft.com/azure/container-apps/troubleshoot-deployment-errors —
 *     "Deployment error referencing unknown secret / Define the secret before you
 *     deploy"). The `az containerapp job secret set` that supplies the value runs
 *     AFTER the create and can never be reached. The IDENTICAL omission in the
 *     loom-uat sibling was found live and fixed in #1545: "the job YAML referenced
 *     secretRef: session-secret but never DEFINED it -> create failed -> the
 *     || job update also failed (job does not exist)". loom-verify — the job whose
 *     entire purpose is validating deploys — kept the broken shape from #1533.
 *
 *  2. That create was written `... -o none 2>/dev/null || az containerapp job update ...`,
 *     so the real error was discarded and the operator saw only the fallback's
 *     "job does not exist". Swallowing the stderr of the mutating call is what made
 *     defect 1 invisible for two months; it is the same shape as every other
 *     "control that runs, measures nothing, and reports success" in this repo.
 *
 *  3. deploy-lineage-extractor-job.sh and deploy-secret-expiry-job.sh created their
 *     job with no `--container-name`. The CLI then names the container after the JOB
 *     (containerapp_job_decorator: `container_def["name"] = container_name or job_name`),
 *     diverging from the bicep module AND from each script's own documented
 *     diagnostic query (`ContainerName_s == 'extractor'` / `'secret-expiry'`), which
 *     would silently return zero rows.
 *
 * THE RULES, per scripts/csa-loom/deploy-*-job.sh:
 *   A. every `secretRef: X` in a job payload is DECLARED before it is used — by a
 *      YAML `secrets:` block, by `--secrets X=...` on the create itself, or by an
 *      `az containerapp job secret set` that runs EARLIER IN THE SCRIPT. The order
 *      is the whole rule: deploy-copilot-evaluator-job.sh sets the secret and THEN
 *      adds the referencing env var (correct); the broken shape referenced it in the
 *      create and set the value afterwards, where it can never be reached.
 *   B. no mutating `az containerapp job create|update` discards its stderr.
 *      A read-only `az containerapp job show` probe may (its failure is the
 *      answer, not an error) — so this does not ban `2>/dev/null` outright.
 *   C. a flag-based (non-`--yaml`) `az containerapp job create` passes
 *      `--container-name`, because the container name is a contract with bicep and
 *      with the log queries the runbooks tell operators to run.
 *
 * Usage: node scripts/ci/check-deploy-job-scripts.mjs
 * Self-tests: node --test scripts/ci/__tests__/deploy-job-scripts.test.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPT_DIR = 'scripts/csa-loom';

/**
 * Join backslash-continued shell lines into logical commands, so a multi-line
 * `az containerapp job create ... \` is analysed as ONE command. Without this a
 * `--container-name` on its own line would look like a separate statement.
 *
 * Returns [{ text, line }] where `line` is the 1-based line the command starts on.
 */
export function logicalLines(src) {
  const raw = src.split('\n').map((l) => l.replace(/\r$/, ''));
  const out = [];
  let buf = null;
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    if (buf === null) buf = { text: '', line: i + 1 };
    const continued = /\\$/.test(line);
    buf.text += (buf.text ? ' ' : '') + (continued ? line.slice(0, -1) : line).trim();
    if (!continued) {
      out.push(buf);
      buf = null;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** Is this logical line shell-commented out? */
const isComment = (text) => /^\s*#/.test(text);

/** Strip a trailing `# ...` comment so a commented flag cannot satisfy a rule. */
const stripTrailingComment = (text) => text.replace(/\s+#(?![{(]).*$/, '');

/**
 * Secret names DECLARED in a YAML `secrets:` block.
 *
 * Indentation-scoped on purpose: `- name:` is also how containers and env vars are
 * written, so a container named `session-secret` must not be mistaken for a secret.
 */
export function declaredYamlSecrets(src) {
  const lines = src.split('\n').map((l) => l.replace(/\r$/, ''));
  const names = new Set();
  let blockIndent = null;
  for (const line of lines) {
    if (blockIndent === null) {
      const open = /^(\s*)secrets:\s*$/.exec(line);
      if (open) blockIndent = open[1].length;
      continue;
    }
    if (!line.trim() || /^\s*#/.test(line)) continue; // blank / comment: neither name nor dedent
    const indent = /^(\s*)/.exec(line)[1].length;
    if (indent <= blockIndent) {
      blockIndent = null;
      const open = /^(\s*)secrets:\s*$/.exec(line);
      if (open) blockIndent = open[1].length;
      continue;
    }
    const m = /^\s*-?\s*name:\s*["']?([A-Za-z0-9][A-Za-z0-9._-]*)["']?\s*$/.exec(line);
    if (m) names.add(m[1]);
  }
  return names;
}

/** Secret names declared by `--secrets a=... b=...` on a `job create` command. */
export function declaredCreateFlagSecrets(src) {
  const names = new Set();
  for (const { text } of logicalLines(src)) {
    if (isComment(text)) continue;
    if (!/\baz\s+containerapp\s+job\s+create\b/.test(text)) continue;
    for (const name of secretsFlagNames(stripTrailingComment(text))) names.add(name);
  }
  return names;
}

/**
 * Secret names set by a standalone `az containerapp job secret set`, WITH the line
 * they are set on.
 *
 * The line number is load-bearing. `secret set` is a SEPARATE request from the
 * create/update that references the secret, so it only helps if it runs FIRST.
 * deploy-copilot-evaluator-job.sh does it in the correct order — `secret set`, then
 * `job update --set-env-vars X=secretref:...` — and must pass. The pre-#2816
 * deploy-loom-verify-job.sh did the opposite: it referenced the secret in the CREATE
 * payload and set the value afterwards, so the create ARM-rejected and the `secret
 * set` was never reached. Both shapes contain the same two commands; only the order
 * distinguishes working from broken, so the check has to model the order.
 */
export function secretSetDeclarations(src) {
  const decls = [];
  for (const { text, line } of logicalLines(src)) {
    if (isComment(text)) continue;
    if (!/\baz\s+containerapp\s+job\s+secret\s+set\b/.test(text)) continue;
    for (const name of secretsFlagNames(stripTrailingComment(text))) decls.push({ name, line });
  }
  return decls;
}

/** Parse `--secrets name=value [name2=value2 ...]` out of one logical command. */
function secretsFlagNames(cmd) {
  const names = [];
  const m = /--secrets\s+(.+)$/.exec(cmd);
  if (!m) return names;
  for (const tok of m[1].split(/\s+/)) {
    const kv = /^["']?([A-Za-z0-9][A-Za-z0-9._-]*)=/.exec(tok);
    if (!kv) break; // first non `name=value` token ends the --secrets list
    names.push(kv[1]);
  }
  return names;
}

/** Every `secretRef: X` / `secretref:X` reference, with its line number. */
export function secretRefs(src) {
  const refs = [];
  const lines = src.split('\n').map((l) => l.replace(/\r$/, ''));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#/.test(line)) continue;
    for (const m of line.matchAll(/secretRef:\s*["']?([A-Za-z0-9][A-Za-z0-9._-]*)/g)) {
      refs.push({ name: m[1], line: i + 1 });
    }
    for (const m of line.matchAll(/=secretref:([A-Za-z0-9][A-Za-z0-9._-]*)/gi)) {
      refs.push({ name: m[1], line: i + 1 });
    }
  }
  return refs;
}

/** Analyse one script's source. Exported so the self-tests can drive it on fixtures. */
export function analyze(src) {
  const violations = [];
  // Payload-scoped declarations (YAML `secrets:` block / `job create --secrets`) are
  // part of the SAME atomic request as the reference, so their position in the file
  // is irrelevant. `secret set` declarations are a separate, earlier request — they
  // only count if they run before the reference.
  const payloadDeclared = new Set([...declaredYamlSecrets(src), ...declaredCreateFlagSecrets(src)]);
  const preSet = secretSetDeclarations(src);
  const refs = secretRefs(src);
  const seen = new Set();
  for (const ref of refs) {
    if (payloadDeclared.has(ref.name)) continue;
    if (preSet.some((d) => d.name === ref.name && d.line < ref.line)) continue;
    if (seen.has(ref.name)) continue;
    seen.add(ref.name);
    const late = preSet.find((d) => d.name === ref.name);
    violations.push({
      rule: 'undeclared-secretref',
      line: ref.line,
      detail: late
        ? `env var references secret '${ref.name}', but the only \`az containerapp job secret set\` ` +
          `for it is at line ${late.line} — AFTER this reference. ARM rejects the referencing request ` +
          '("deployment error referencing unknown secret"), so that later line is never reached. ' +
          'Either declare the secret in the payload, or move the `secret set` above the reference ' +
          '(deploy-copilot-evaluator-job.sh does the latter).'
        : `env var references secret '${ref.name}', which is never declared. ARM rejects the request ` +
          '("deployment error referencing unknown secret"). Declare it in the payload — a YAML ' +
          '`secrets:` block with a placeholder is fine (deploy-loom-uat-job.sh, #1545).',
    });
  }

  let creates = 0;
  let updates = 0;
  for (const { text, line } of logicalLines(src)) {
    if (isComment(text)) continue;
    const cmd = stripTrailingComment(text);
    const isCreate = /\baz\s+containerapp\s+job\s+create\b/.test(cmd);
    const isUpdate = /\baz\s+containerapp\s+job\s+update\b/.test(cmd);
    if (isCreate) creates++;
    if (isUpdate) updates++;
    if (!isCreate && !isUpdate) continue;

    if (/2>\s*\/dev\/null|2>&-/.test(cmd)) {
      violations.push({
        rule: 'swallowed-stderr',
        line,
        detail:
          `\`az containerapp job ${isCreate ? 'create' : 'update'}\` discards its stderr. ` +
          'That is the mutating call — if it fails you need the reason. Branch on an explicit ' +
          '`az containerapp job show` probe instead of `create 2>/dev/null || update`.',
      });
    }

    if (isCreate && !/--yaml\b/.test(cmd) && !/--container-name\b/.test(cmd)) {
      violations.push({
        rule: 'missing-container-name',
        line,
        detail:
          'flag-based `az containerapp job create` without `--container-name`. The CLI then ' +
          'names the container after the job, diverging from the bicep module and from the ' +
          'documented `ContainerName_s == ...` log query, which would silently return zero rows.',
      });
    }
  }

  return { violations, stats: { secretRefs: refs.length, declaredSecrets: payloadDeclared.size + preSet.length, creates, updates } };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function main() {
  const root = process.cwd();
  const dir = join(root, SCRIPT_DIR);
  const scripts = existsSync(dir)
    ? readdirSync(dir).filter((f) => /^deploy-.*-job\.sh$/.test(f)).sort()
    : [];

  if (scripts.length === 0) {
    console.error(`[deploy-job-scripts] FAIL — no deploy-*-job.sh found under ${SCRIPT_DIR}.`);
    console.error('  A guard that silently finds nothing to check is the failure mode it exists to prevent.');
    process.exit(1);
  }

  const failures = [];
  let totalCreates = 0;
  console.log(`[deploy-job-scripts] ${scripts.length} deploy-*-job.sh script(s):`);
  for (const script of scripts) {
    const rel = `${SCRIPT_DIR}/${script}`;
    const { violations, stats } = analyze(readFileSync(join(dir, script), 'utf8'));
    totalCreates += stats.creates;
    const status = violations.length === 0 ? 'ok        ' : 'VIOLATION ';
    console.log(
      `  ${status} ${script.padEnd(34)} ` +
        `create=${stats.creates} update=${stats.updates} secretRef=${stats.secretRefs} declared=${stats.declaredSecrets}`,
    );
    for (const v of violations) failures.push({ rel, ...v });
  }

  // Anti-vacuous-pass: if the scanner found no `job create` in ANY script, it is
  // not reading what it claims to read and every "ok" above is meaningless.
  if (totalCreates === 0) {
    console.error('\n[deploy-job-scripts] FAIL — parsed 0 `az containerapp job create` commands across all scripts.');
    console.error('  Either the scripts stopped creating jobs or this parser is broken. Refusing to pass vacuously.');
    process.exit(1);
  }

  if (failures.length === 0) {
    console.log('[deploy-job-scripts] OK — every job create declares its secrets, surfaces its errors, and names its container.');
    process.exit(0);
  }

  console.error(`\n[deploy-job-scripts] FAIL — ${failures.length} violation(s).\n`);
  for (const f of failures) {
    console.error(`  ${f.rel}:${f.line}  [${f.rule}]`);
    console.error(`    ${f.detail}`);
  }
  console.error('');
  process.exit(1);
}

const invokedDirectly =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('check-deploy-job-scripts.mjs');
if (invokedDirectly) main();
