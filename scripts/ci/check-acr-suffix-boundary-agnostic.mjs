#!/usr/bin/env node
/**
 * check-acr-suffix-boundary-agnostic.mjs
 *
 * RULE. If the REGISTRY NAME in a container-image reference comes from a
 * variable, the LOGIN-SERVER SUFFIX must come from a variable too.
 *
 *     ${ACR}.azurecr.io/${DST}          <-- VIOLATION (name varies, suffix does not)
 *     ${ACR}${ACR_SUFFIX}/${DST}        <-- ok       (both derived)
 *     acrloomdcmt6cqoezlgs.azurecr.us   <-- ok       (whole ref is a literal, so the
 *                                                     file is provably one-boundary)
 *
 * WHY THIS EXISTS (measured, 2026-08-10, gov-provision-dataplane-images run
 * 31454737765, boundary=gcc-high). scripts/ci/mirror-upstream-images.sh built its
 * digest read-back as `az acr manifest show-metadata "${ACR}.azurecr.io/${DST}"`.
 * The registry NAME was correct for Gov — it was passed in — but the suffix was
 * Commercial, and Azure Government registries are `.azurecr.us`. az refused:
 *
 *     ERROR: Provided registry suffix '.azurecr.io' does not match the configured
 *     az cli acr login server suffix '.azurecr.us'.
 *
 * All three upstream images MIRRORED SUCCESSFULLY. Only the verification failed —
 * so the step failed, the GCC-High data-plane image job failed, `loom-duckdb:v0.1`
 * never reached the Gov ACR, and `deploy-fiab-gcch` refused at its image preflight.
 * One hardcoded Commercial suffix, inside a step that had already done its work,
 * was enough to make the sovereign estate undeployable (.claude/rules/cloud-parity.md:
 * "a capability that works in Commercial and not in Gov is INCOMPLETE").
 *
 * WHY THE RULE IS SHAPED THIS WAY, and not "ban the literal '.azurecr.io'".
 * Banning the literal is keyed to the UNSAFE pattern, and this repo has already
 * been burned by that shape: adopting the safe fix deletes the token the rule
 * matches, so the guard goes quiet on exactly the files that were fixed, and it
 * screams about prose that merely NAMES the suffix (the error message in the
 * mirror script quotes '.azurecr.io' on purpose — that string is the whole point
 * of the message). Keying on the MISMATCH instead means:
 *   - single-boundary files (gov-console-roll.yml pins acrloomdcmt6cqoezlgs.azurecr.us,
 *     loom-roll-and-validate.yml pins acrloomk6mvh5sm6z7do) stay legal, because a
 *     fully-literal reference cannot be run against the wrong cloud by accident;
 *   - prose, comments and `${ACR:?e.g. foo.azurecr.io}` help text stay legal;
 *   - and the one shape that silently breaks a sovereign deploy is illegal.
 *
 * SELF-DEFENCE. A guard that passes because it found nothing to judge is worse
 * than no guard. This one fails if it scanned no files, and fails if it found no
 * ACR references AT ALL — either means the matcher has drifted off the code.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const ROOTS = ['scripts', '.github/workflows', 'platform'];
const EXTS = ['.sh', '.yml', '.yaml', '.mjs', '.js', '.ts', '.bicep', '.ps1'];
// Tests and fixtures deliberately contain both-cloud literals as DATA.
const SKIP_DIR = /(^|[\\/])(__tests__|__fixtures__|node_modules|\.next|dist)([\\/]|$)/;

const SUFFIXES = String.raw`azurecr\.io|azurecr\.us|azurecr\.cn`;
// A reference is `<registry><suffix>/<something>`. The trailing `/` is what
// separates a REFERENCE BEING BUILT from prose that merely names a suffix.
const SUFFIX_RE = new RegExp(String.raw`\.(${SUFFIXES})/`, 'g');
// Any interpolation: ${VAR}, ${{ ctx.x }}, $VAR, %VAR%.
const INTERPOLATED = /\$\{\{?[\s\S]*?\}\}?|\$[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z_][A-Za-z0-9_]*%/;
const SOLE_INTERPOLATION = /^(?:\$\{\{\s*(?:env|inputs|vars|matrix)\.([A-Za-z_][\w]*)\s*\}\}|\$\{([A-Za-z_][\w]*)\}|\$([A-Za-z_][\w]*))$/;

/**
 * Read the registry portion by scanning LEFT from the suffix.
 *
 * A naive `(\S*?)\.azurecr\.io/` is not enough: `${{ env.ACR_NAME }}` contains
 * SPACES, so the lazy match stopped at `}}` and the guard classified an
 * interpolated registry as a literal one — a false NEGATIVE on the exact shape
 * it exists to catch (loom-roll-and-validate.yml:253/527). Walk left instead,
 * stepping over a whole `${...}` / `${{ ... }}` when a closing brace is hit.
 */
function registryBefore(line, endIdx) {
  let i = endIdx;
  while (i > 0) {
    const c = line[i - 1];
    if (c === '}') {
      const open = line.lastIndexOf('${', i - 1);
      if (open === -1) break;
      i = open;
      continue;
    }
    if (/[\s"'`=,;:()[\]|&<>]/.test(c) || c === '/') break;
    i -= 1;
  }
  return line.slice(i, endIdx);
}

/** Literal assignments in the same file, so a pinned var counts as a literal. */
function literalPins(text) {
  const pins = new Map();
  for (const m of text.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*[:=]\s*["']?([A-Za-z0-9][\w.-]*)["']?\s*$/gm)) {
    if (!INTERPOLATED.test(m[2])) pins.set(m[1], m[2]);
  }
  return pins;
}

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    if (SKIP_DIR.test(p)) continue;
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (EXTS.some((x) => p.endsWith(x))) out.push(p);
  }
  return out;
}

/** Strip the comment tail so prose about a suffix is never judged as code. */
function stripComment(line, file) {
  if (file.endsWith('.sh') || file.endsWith('.yml') || file.endsWith('.yaml') || file.endsWith('.ps1')) {
    // A `#` inside quotes is not a comment; only treat a leading-whitespace `#`
    // (or one preceded by whitespace and outside quotes) as one. Conservative:
    // only strip when the line STARTS with the marker, so we never hide code.
    return /^\s*#/.test(line) ? '' : line;
  }
  return /^\s*(\/\/|\*|\/\*)/.test(line) ? '' : line;
}

const files = ROOTS.flatMap((r) => walk(join(ROOT, r)));
const violations = [];
let refsSeen = 0;
let compliantSeen = 0;

for (const file of files) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  if (!new RegExp(SUFFIXES).test(text) && !text.includes('ACR_SUFFIX')) continue;

  const rel = relative(ROOT, file).split(sep).join('/');
  const lines = text.split(/\r?\n/);
  const pins = literalPins(text);

  lines.forEach((raw, i) => {
    const line = stripComment(raw, rel);
    if (!line) return;

    // Count the compliant shape too, so "found nothing" cannot masquerade as clean.
    if (/\$\{?\w+\}?\$\{?\w*SUFFIX\w*\}?\//.test(line)) {
      compliantSeen++;
      refsSeen++;
    }

    SUFFIX_RE.lastIndex = 0;
    for (const m of line.matchAll(SUFFIX_RE)) {
      refsSeen++;
      const registry = registryBefore(line, m.index);
      if (!INTERPOLATED.test(registry)) continue; // fully literal ref => one-boundary, legal

      // A variable pinned to a literal in this same file is also one-boundary:
      // loom-roll-and-validate.yml sets `ACR_NAME: acrloomk6mvh5sm6z7do` at the
      // top, so `${{ env.ACR_NAME }}.azurecr.io/` cannot be aimed at Gov by
      // accident. gov-console-roll.yml is the sovereign counterpart and pins
      // `.azurecr.us`. Only an EXTERNALLY-supplied registry (a --acr argument, a
      // workflow input, a secret) can arrive from another cloud — that is the
      // shape that broke GCC-High.
      const sole = registry.match(SOLE_INTERPOLATION);
      const name = sole && (sole[1] || sole[2] || sole[3]);
      if (name && pins.has(name)) continue;

      violations.push({
        file: rel,
        line: i + 1,
        ref: `${registry}.${m[1]}/`,
        text: raw.trim().slice(0, 160),
      });
    }
  });
}

// --- self-defence -----------------------------------------------------------
if (files.length === 0) {
  console.error('::error::acr-suffix-boundary-agnostic: scanned ZERO files. The walker is broken — refusing to report a pass.');
  process.exit(1);
}
if (refsSeen === 0) {
  console.error(
    '::error::acr-suffix-boundary-agnostic: found ZERO container-registry references in ' +
      `${files.length} scanned files. This repo builds ACR references in the deploy path, so ` +
      'the matcher has drifted off the code. Refusing to report a pass on an empty population.',
  );
  process.exit(1);
}

if (violations.length > 0) {
  console.error(
    `::error::acr-suffix-boundary-agnostic: ${violations.length} reference(s) take the registry NAME ` +
      'from a variable but hardcode the login-server SUFFIX. That works in Commercial and fails in ' +
      'every sovereign boundary with "Provided registry suffix does not match the configured az cli ' +
      'acr login server suffix" — see scripts/ci/mirror-upstream-images.sh for the derivation to copy ' +
      "(az cloud show --query 'suffixes.acrLoginServerEndpoint').",
  );
  for (const v of violations) {
    console.error(`::error file=${v.file},line=${v.line}::${v.ref}  <-- registry varies, suffix does not | ${v.text}`);
  }
  process.exit(1);
}

console.log(
  `acr-suffix-boundary-agnostic OK — ${files.length} files scanned, ${refsSeen} registry reference(s) judged ` +
    `(${compliantSeen} derived-suffix), 0 variable-registry/literal-suffix mismatches.`,
);
