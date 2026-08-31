#!/usr/bin/env node
/**
 * check-msal-resolver-before-deploy.mjs
 *
 * RULE. A workflow that renders a bicep params file reading
 * `LOOM_MSAL_CLIENT_ID` from the environment must RESOLVE that value first.
 *
 * WHY. Every `platform/fiab/bicep/params/*.bicepparam` carries:
 *
 *     param loomMsalClientId = readEnvironmentVariable('LOOM_MSAL_CLIENT_ID', '')
 *
 * An Entra app registration is a Microsoft Graph object ARM cannot create, so it
 * is minted once by the post-deploy bootstrap and only RE-READ by later deploys.
 * With that env var unset the template renders an EMPTY client id — and a
 * declarative ACA template DROPS every env var it does not declare. That blanks
 * `LOOM_MSAL_CLIENT_ID` (sign-in dark) and empties `LOOM_UNITY_CLIENT_ID` /
 * `LOOM_UNITY_AUDIENCE` with it, which seals the Iceberg REST catalog behind the
 * `.invalid` sentinel audience no tenant can mint — up, enforcing, rejecting
 * every caller (iceberg-catalog-aca.bicep, `svc-loom-unity-authz`).
 *
 * `scripts/csa-loom/resolve-msal-client-id.sh` exists for exactly this and its
 * docblock says so. Three of the four console lanes called it; `deploy-fiab-gcc`
 * did not (#4224). That was latent rather than live only because GCC is
 * `disabled_manually` with zero credentials (#4071) — it would have fired on the
 * first run after re-enablement.
 *
 * KEYED TO THE MISMATCH, not to the helper's presence: a workflow that RENDERS a
 * params file without a preceding resolver invocation. Keying it to "does the
 * repo reference the resolver" would go quiet the moment one lane adopted it,
 * which is the shape that let this survive in one lane while three others were
 * fixed (`guard_keyed_to_the_unsafe_pattern`).
 *
 * ORDER MATTERS, so this compares line numbers. A resolver that runs AFTER the
 * render is not a fix — the template has already been rendered from an empty
 * value.
 *
 * ── WHAT THE FIRST DRAFT OF THIS FILE GOT WRONG, kept because the correction is
 * the load-bearing part ────────────────────────────────────────────────────────
 *
 * v1 flagged FOUR workflows and every one was a false positive. Measured:
 *
 *   bicep-whatif.yml              `what-if` — READ-ONLY, mutates nothing
 *   loom-drift-check.yml          `what-if` — READ-ONLY
 *   deploy-fiab-il5.yml           `what-if` at 524; the APPLY at 805 is correctly
 *                                 preceded by the resolver at 636
 *   gov-provision-runner-images   the match is inside an echoed error STRING:
 *                                   echo "::error::Run phase 1 (az deployment
 *                                   sub create … ) first"
 *
 * Two distinct errors, and both are ones this repo has written guards to prevent:
 *
 *   1. CONFLATING PREVIEW WITH MUTATION. `what-if` renders the same template but
 *      changes nothing. An empty client id there produces a misleading DIFF (the
 *      preview shows the env var being removed), which is worth knowing and is
 *      NOT a deploy defect. Only `sub create` can take sign-in dark, so only
 *      `sub create` blocks. What-if renders are reported as a notice.
 *   2. READING PROSE AS CODE. Excluding `#`-led lines is not enough: a command
 *      name inside an `echo "…"` is prose too. A guard with a 4/4 false-positive
 *      rate gets muted, and a muted guard is worth less than no guard — which is
 *      precisely how the gcc gap survived while three sibling lanes were fixed.
 *
 * SELF-DEFENCE. Fails on an empty workflow population and on zero params files
 * carrying the pattern — either means the matcher drifted off the code.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readLogicalLines } from './_logical-lines.mjs';

const ROOT = process.cwd();
const ENV_VAR = 'LOOM_MSAL_CLIENT_ID';
const RESOLVER = 'resolve-msal-client-id.sh';

function tracked(...patterns) {
  try {
    return execFileSync('git', ['ls-files', '--', ...patterns], {
      encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    }).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch (e) {
    console.error(
      `::error::msal-resolver-before-deploy: could not ask git for tracked files (${(e.message || '').slice(0, 160)}). ` +
        'Refusing to fall back to a filesystem walk.',
    );
    process.exit(1);
  }
}

// Which params files actually carry the pattern? If none do, this rule has no
// subject and saying "pass" would be saying nothing.
const paramFiles = tracked('platform/fiab/bicep/params/*.bicepparam')
  .filter((p) => {
    try {
      return new RegExp(`readEnvironmentVariable\\(\\s*'${ENV_VAR}'`).test(readFileSync(join(ROOT, p), 'utf8'));
    } catch { return false; }
  });

if (paramFiles.length === 0) {
  console.error(
    `::error::msal-resolver-before-deploy: ZERO params files read ${ENV_VAR} from the environment. ` +
      'Every shipped params file does in any healthy tree, so zero means this matcher has drifted off the code. ' +
      'Refusing to report a pass on an empty population.',
  );
  process.exit(1);
}
const paramNames = new Set(paramFiles.map((p) => p.split('/').pop()));

const workflows = tracked('.github/workflows/*.yml', '.github/workflows/*.yaml');
if (workflows.length === 0) {
  console.error('::error::msal-resolver-before-deploy: scanned ZERO workflows. Refusing to report a pass.');
  process.exit(1);
}

const violations = [];
const notices = [];
let renderers = 0;

/**
 * True when the command name at `at` is PROSE rather than an invocation.
 *
 * SCOPED TO THE TEXT BEFORE THE MATCH, not to the whole line, and on a FOLDED
 * line that distinction bites. A real invocation frequently carries its own
 * fallback message on a continuation:
 *
 *     az deployment sub create … \
 *       || echo "::error::the apply failed"
 *
 * which folds to one logical line containing both. An anywhere-on-the-line test
 * for `echo` discards that REAL call site — the exact inversion
 * check-guard-logical-lines warns about when a guard adopts folding.
 */
function isProse(text, at) {
  const before = text.slice(0, at);
  return /\b(echo|printf)\b/.test(before) || /::(error|warning|notice)::/.test(before);
}

for (const rel of workflows) {
  let logical;
  try {
    logical = readLogicalLines(readFileSync(join(ROOT, rel), 'utf8'));
  } catch { continue; }

  // FOLD FIRST, THEN judge. A `run: |` block is shell, and a backslash
  // continuation can put `az deployment sub create` and its params file on
  // different physical lines — a physical-line matcher sees neither whole.
  // Comment lines are dropped after folding: `#`-led is a comment in YAML and
  // in shell alike.
  const code = logical
    .map(({ line, text }) => ({ line, text }))
    .filter(({ text }) => !text.trim().startsWith('#'));

  const wholeCode = code.map((c) => c.text).join('\n');
  if (![...paramNames].some((n) => wholeCode.includes(n))) continue;

  const find = (re) => code
    .filter(({ text }) => {
      const m = re.exec(text);
      return m && !isProse(text, m.index);
    })
    .map((c) => c.line);

  // The BLOCKING subject is the mutation. `what-if` renders the same template
  // and changes nothing, so it cannot take sign-in dark.
  const applies = find(/az\s+deployment\s+sub\s+create/);
  const whatIfs = find(/az\s+deployment\s+sub\s+what-if/);
  if (applies.length === 0 && whatIfs.length === 0) continue;
  renderers++;

  const resolves = code.filter(({ text }) => text.includes(RESOLVER)).map((c) => c.line);
  const firstResolve = resolves.length ? Math.min(...resolves) : Infinity;

  if (applies.length > 0) {
    const firstApply = Math.min(...applies);
    if (resolves.length === 0) {
      violations.push({ file: rel, line: firstApply, why: `runs \`az deployment sub create\` against a params file reading ${ENV_VAR} and never invokes ${RESOLVER}` });
    } else if (firstResolve > firstApply) {
      violations.push({ file: rel, line: firstApply, why: `invokes ${RESOLVER} at line ${firstResolve}, AFTER the apply at line ${firstApply} — the template is already rendered from an empty value` });
    }
  }

  // A what-if rendered from an empty value previews the env var being REMOVED.
  // Misleading, not destructive — reported, never merge-blocking.
  if (whatIfs.length > 0 && firstResolve > Math.min(...whatIfs)) {
    notices.push({ file: rel, line: Math.min(...whatIfs) });
  }
}

if (renderers === 0) {
  console.error(
    '::error::msal-resolver-before-deploy: found ZERO workflows that render a params file carrying the pattern. ' +
      'The console deploy lanes all do, so zero means this matcher has drifted. Refusing to report a pass.',
  );
  process.exit(1);
}

for (const n of notices) {
  console.log(
    `::notice file=${n.file},line=${n.line}::what-if renders a params file reading ${ENV_VAR} before it is resolved. ` +
      'Read-only, so this is not a deploy defect — but the preview will show the env var being REMOVED, which is a ' +
      'misleading artifact for anyone approving a run from it.',
  );
}

if (violations.length > 0) {
  console.error(
    `::error::msal-resolver-before-deploy: ${violations.length} workflow(s) APPLY a bicep params file that reads ` +
      `${ENV_VAR} without resolving it first. The template then renders an EMPTY client id, and a declarative ACA ` +
      'template drops every env var it does not declare — taking sign-in dark and sealing the Iceberg catalog behind ' +
      'the `.invalid` sentinel audience (#4224). Fix: run ' +
      `\`bash scripts/csa-loom/resolve-msal-client-id.sh --rg "rg-csa-loom-admin-$AZURE_LOCATION"\` before the apply.`,
  );
  for (const v of violations) console.error(`::error file=${v.file},line=${v.line}::${v.why}`);
  process.exit(1);
}

console.log(
  `msal-resolver-before-deploy OK — ${workflows.length} workflow(s) scanned, ${paramFiles.length} params file(s) ` +
    `read ${ENV_VAR}, ${renderers} render one, every APPLY resolves first` +
    (notices.length ? `; ${notices.length} what-if-only notice(s) above.` : '.'),
);
