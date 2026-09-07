#!/usr/bin/env node
/**
 * estate-pause-declared.mjs — publish ONLY the declaration half of the estate
 * pause verdict, for callers that have no Azure credential and no cluster to
 * observe. (refs #4233)
 *
 * ── WHY THIS EXISTS SEPARATELY FROM THE ADX PREFLIGHT ───────────────────────
 *
 * `ensure-adx-cluster-running.mjs` publishes `estate_paused`, and that output is
 * the CONJUNCTION of two facts: the boundary is DECLARED paused in
 * scripts/ci/estate-pause-declaration.json, and its cluster was OBSERVED
 * stopped. Reading the second fact costs an Azure Government login, an ARM read,
 * and a job that has already been through the `gcc-high-deploy` approval gate.
 *
 * `deploy-fiab-gcch`'s image phase (`build-gov-images`) runs BEFORE any of that.
 * It is a separate job, it has no approval environment, and it MUTATES the
 * sovereign estate: gov-provision-streaming-migrate.yml acquires the ACR
 * firewall lease (`publicNetworkAccess=Enabled` on the GCC-High registry) and
 * `az acr build`s loom-migrate + loom-risingwave into it. Measured on the
 * declared-paused schedule, runs 34138038567 (2026-09-07) and 33111419147
 * (2026-08-27): job = success, step `Build both images on the Gov ACR` =
 * success, step `Release the ACR firewall lease (always)` = success. The
 * firewall was opened on an estate the same run declares it will not measure.
 *
 * So that job needs a verdict it can compute with NO Azure at all. The
 * declaration alone is exactly that: `classifyPauseDeclaration` is a pure
 * function of a checked-in JSON file and a date.
 *
 * ── THE PREDICATE IS DELIBERATELY BROADER THAN `estate_paused` ──────────────
 *
 * declared            ⊇  declared AND observed-stopped
 *
 * The one divergent case is DECLARED-but-Running: this script says `true` and
 * the ADX preflight says `false`, so the image phase stands down while the
 * deploy proceeds. That is the SAFE direction and it is not silent:
 *
 *   - The deploy's own `Image preflight — Gov ACR must already hold every
 *     referenced tag` still runs in that case and REFUSES if a referenced tag is
 *     absent, so a missing manifest fails closed with a named remediation rather
 *     than as a MANIFEST_UNKNOWN inside a Container App PUT.
 *   - Skipping a rebuild does not remove a manifest. `v0.1` keeps whatever
 *     content was last pushed; the estate is left as-is, which is what a
 *     declaration of pause asks for.
 *   - The register's own resume instruction is "resume the estate, then delete
 *     the entry". An operator validating a resumed estate has already removed
 *     the declaration, so they never reach the divergent case.
 *
 * ── NEVER THROWS, AND ALWAYS WRITES A VALUE ────────────────────────────────
 *
 * Same asymmetry as the classifier it wraps: SUPPRESSING needs positive
 * evidence, so every uncertain outcome resolves to `false` — the pre-register
 * behaviour, where the image phase runs. A missing register, an unreadable file,
 * unparseable JSON, a boundary that is not named, an expired `reviewBy`: all
 * `declared_paused=false`, each with a printed reason, because a declaration
 * that is silently ignored is worse than no declaration (deploy-integrity R7).
 *
 * Both values are always written, so the output is a MEASUREMENT and not a
 * presence check — a step that writes the key only when it is `true` cannot be
 * told apart from a step that failed to write at all.
 *
 * Usage:
 *   node scripts/ci/estate-pause-declared.mjs --boundary GCC-High [--today YYYY-MM-DD]
 */
import { readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyPauseDeclaration, PAUSE_DECLARATION_PATH } from './_estate-pause-declaration.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * PURE. Parse `--key value` pairs. Unknown keys are ignored rather than fatal:
 * this script's whole contract is that it cannot fail the job it runs in.
 *
 * @param {string[]} argv
 * @returns {Record<string,string>}
 */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const m = /^--([\w-]+)$/.exec(argv[i]);
    if (m && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      out[m[1]] = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

/**
 * Read + parse the register. Returns `{register, readError}` and NEVER throws.
 * `null` is not an error: the ordinary case is that no estate is paused and the
 * file does not exist.
 *
 * @param {string} file absolute path to the register
 * @returns {{register: object|null, readError: string|null}}
 */
export function loadRegister(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    // ENOENT is the no-estate-paused case and is not worth a warning; anything
    // else is an UNKNOWN the caller must see, because it means a declaration
    // that exists may not have been read.
    if (err && err.code === 'ENOENT') return { register: null, readError: null };
    return { register: null, readError: `${file} could not be read (${err?.code ?? err?.message})` };
  }
  try {
    return { register: JSON.parse(raw), readError: null };
  } catch (err) {
    return { register: null, readError: `${file} is not parseable JSON (${err?.message})` };
  }
}

/**
 * PURE. The whole verdict, with no filesystem and no process access, so the
 * tests can drive every branch.
 *
 * @param {object} p
 * @param {object|null} p.register
 * @param {string|null} p.readError
 * @param {string|null|undefined} p.boundary
 * @param {string} p.today ISO date
 * @returns {{declared: boolean, lines: string[]}}
 */
export function decide({ register, readError, boundary, today }) {
  const lines = [];
  if (readError) {
    lines.push(`::warning::[pause-declaration] ${readError} — NOT treating any estate as declared paused.`);
  }
  const verdict = classifyPauseDeclaration({ register, boundary, today });
  lines.push(`[pause-declaration] boundary='${boundary ?? ''}' today=${today} declared=${verdict.declared}`);
  lines.push(`[pause-declaration] ${verdict.reason}`);
  return { declared: verdict.declared === true, lines };
}

function main() {
  let declared = false;
  let lines = [];
  try {
    const args = parseArgs(process.argv.slice(2));
    const today = args.today || new Date().toISOString().slice(0, 10);
    const file = path.join(REPO_ROOT, PAUSE_DECLARATION_PATH);
    const { register, readError } = loadRegister(file);
    ({ declared, lines } = decide({ register, readError, boundary: args.boundary, today }));
  } catch (err) {
    // Belt-and-braces. There is no known path here, and if one is ever found it
    // must not fail the job or — worse — suppress the image phase on an
    // unestablished verdict.
    declared = false;
    lines = [
      `::warning::[pause-declaration] the declaration could not be evaluated (${err?.message}) — ` +
        'NOT treating the estate as declared paused, so the image phase runs exactly as it did before.',
    ];
  }
  for (const l of lines) console.log(l);
  const out = `declared_paused=${declared ? 'true' : 'false'}\n`;
  console.log(`[pause-declaration] ${out.trim()}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, out);
}

// Only run when invoked directly, so the tests can import the pure parts.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
