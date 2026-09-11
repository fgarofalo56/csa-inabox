#!/usr/bin/env node
/**
 * GUARDRAIL: the Copilot UAT scoring decision is TYPE-CHECKED  (#4432 / review F5)
 * ---------------------------------------------------------------------------
 * RULE: `e2e/_lib/copilot-verdict.ts`, the two UAT specs that apply it, and the
 *   four suites that pin it must compile.
 *
 * WHY IT EXISTS. `tsconfig.build.json` excludes `e2e/**`, `**\/__tests__/**` and
 * `*.test.ts`; vitest transpiles with esbuild and type-checks nothing. So the
 * headline "tsc --noEmit -p tsconfig.build.json → rc=0" receipt reads the routes
 * and the client and NONE of the files holding the decision. That is the same
 * gap #3963 found for the brain specs, and this is the same answer, narrowed to
 * this decision.
 *
 * It is not theoretical: on the commit that added it this check found THREE real
 * errors that no compiler in CI had ever read — a `NetworkFailure[]` assigned to
 * `string[]` (twice, newly introduced), and a Playwright `Response` passed to a
 * parameter typed `APIResponse` (pre-existing, TS2345).
 *
 * THREE CONTROLS, because a type-check is trivially made green-and-blind:
 *   1. POPULATION. `--listFilesOnly` first, and the run REFUSES below
 *      DECISION_FLOOR matched decision files. A tsconfig whose globs matched
 *      nothing compiles clean and exits 0 — indistinguishable from clean code.
 *   2. KNOWN-RED BY FILE, NEVER BY DIRECTORY. Two transitively-pulled modules
 *      import `mssql`, which ships no types. Named one by one, so a NEW error
 *      anywhere else is covered from the moment it lands.
 *   3. THE LIST MUST SHRINK. If a known-red file starts compiling clean, this
 *      FAILS telling you to delete its entry. An exemption that outlives its
 *      cause is a permanent hole, and chasing a guard's SILENCE is the only way
 *      that hole ever gets found.
 *
 * AND A FOURTH, on this script's OWN failure mode: if tsc exits non-zero having
 * produced no parseable diagnostic it did not RUN, and the triage would then
 * report every known-red file as newly clean. It refuses first.
 *
 * Run:  node scripts/ci/check-copilot-decision-types.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..', '..', 'apps', 'fiab-console');
const CONFIG = 'tsconfig.copilot-decision.json';

/** Files that MUST be in the program. Fewer than this and the glob broke. */
const DECISION_FLOOR = 7;
const DECISION_RE = /(copilot-verdict\.ts|copilot\.uat\.ts|help-copilot\.uat\.ts|copilot-uat-verdict\.test\.ts|copilot-studio-gate-code\.test\.ts|orchestrate-error-envelope-4432\.test\.ts|chat-gate-codes\.test\.ts)$/;

/**
 * Known-red, BY FILE. Both are the same pre-existing cause the brain-spec step
 * in fiab-console-ci.yml already records: `mssql` ships no type declarations,
 * so every consumer is TS7016. Neither is part of this decision; they arrive
 * transitively through the UAT spec's helpers.
 */
const KNOWN_RED = new Map([
  ['lib/azure/azure-sql-client.ts', "TS7016 — `mssql` ships no types (no @types/mssql); pulled in transitively, not by the decision files"],
  ['lib/azure/synapse-sql-client.ts', "TS7016 — same missing `mssql` types"],
]);

/**
 * The compiler's JS ENTRY, not the `.bin` shim.
 *
 * `node_modules/.bin/tsc` is a shell script on POSIX and a `.CMD` on Windows,
 * and `spawnSync(..., { shell: false })` cannot execute either on Windows — it
 * returns status 1 having run NOTHING, which is indistinguishable from "tsc ran
 * and found an error". Measured: the first version of this script reported
 * `tsc read 0 file(s)` for exactly that reason. Control 1 caught it, which is
 * the only reason it is a footnote rather than a false green. Invoking
 * `node <entry>` has no shim and no shell in the path.
 */
const TSC_ENTRY = path.join(APP_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
if (!fs.existsSync(TSC_ENTRY)) {
  console.error('[copilot-decision-types] typescript not installed — run the install first. NOT a verdict on the types.');
  process.exit(1);
}
const runTsc = (args) => spawnSync(process.execPath, [TSC_ENTRY, ...args], {
  cwd: APP_ROOT, encoding: 'utf8', shell: false, maxBuffer: 1 << 26,
});

// ── CONTROL 1: population ────────────────────────────────────────────────────
const listed = runTsc(['-p', CONFIG, '--listFilesOnly']);
const files = (listed.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const decisionFiles = files.filter((f) => DECISION_RE.test(f.replace(/\\/g, '/')));
console.log(`[copilot-decision-types] tsc read ${files.length} file(s); ${decisionFiles.length} of them are decision files.`);
if (decisionFiles.length < DECISION_FLOOR) {
  console.error(
    `[copilot-decision-types] FAIL — the tsconfig matched only ${decisionFiles.length} decision file(s), `
    + `below the floor of ${DECISION_FLOOR}. A type-check over a shrunken population is green and blind, `
    + 'so this refuses rather than reporting success.',
  );
  process.exit(1);
}

// ── The check itself. tsc's exit code is NOT the verdict — see CONTROL 2. ────
const run = runTsc(['--noEmit', '-p', CONFIG]);
const out = `${run.stdout || ''}${run.stderr || ''}`;
const DIAG_RE = /^(\S[^(]*)\((\d+),(\d+)\): error (TS\d+): (.*)$/gm;
const diags = [...out.matchAll(DIAG_RE)].map((m) => ({
  file: m[1].replace(/\\/g, '/'), line: Number(m[2]), code: m[4], msg: m[5],
}));

// ── CONTROL 4: did it actually run? ─────────────────────────────────────────
if (run.status !== 0 && diags.length === 0) {
  console.error(
    `[copilot-decision-types] FAIL — tsc exited ${run.status} without emitting a single parseable `
    + 'diagnostic, which means it did not type-check at all (bad config, OOM, or a crash). '
    + 'This is NOT a verdict on the types.\n' + out.slice(-1500),
  );
  process.exit(1);
}

const unexpected = diags.filter((d) => !KNOWN_RED.has(d.file));
const seen = new Set(diags.filter((d) => KNOWN_RED.has(d.file)).map((d) => d.file));

if (unexpected.length) {
  console.error(`[copilot-decision-types] FAIL — ${unexpected.length} error(s) outside the known-red list:`);
  for (const d of unexpected) console.error(`   ${d.file}(${d.line}): ${d.code} ${d.msg}`);
  process.exit(1);
}

// ── CONTROL 3: the list must shrink ─────────────────────────────────────────
const stale = [...KNOWN_RED.keys()].filter((f) => !seen.has(f));
if (stale.length) {
  console.error(
    '[copilot-decision-types] FAIL — these files are listed as known-red but now compile CLEAN. '
    + 'Delete their entries; an exemption that outlives its cause is a permanent hole:',
  );
  for (const f of stale) console.error(`   ${f}`);
  process.exit(1);
}

console.log(
  `[copilot-decision-types] OK — ${decisionFiles.length} decision file(s) type-check; `
  + `${seen.size} known-red file(s) still red for their recorded reason.`,
);
