#!/usr/bin/env node
/**
 * _ratchet-count — the SHARED "count-a-forbidden-pattern" ratchet mechanic
 * (loom-next-level WS-R R3; consistency 5b / round-3 F6).
 * ---------------------------------------------------------------------------
 * One tested helper for every "baseline + shrink-only + `--update-baseline`"
 * guard so the mechanic exists ONCE instead of N copies. Consumers: R3
 * (check-route-toolkit), and later X1 (cloud-endpoint literals), I5
 * (credential adoption), R17 (client-fetch known-route), R19 (editor snapshot
 * trick, advisory), U11 (px-minmax grids), LIC0 (license inventory), R29
 * (parity-doc freshness).
 *
 * MODEL
 *   - A guard computes `current`: a map of stable keys → counts (keys are
 *     usually repo-relative file paths; counts are per-key violation counts).
 *   - The baseline file (JSON) freezes the grandfathered keys/counts, plus an
 *     ownership header (round-3 F6): who owns the ratchet, why it exists, and
 *     how to unblock (always the uniform `--update-baseline` escape hatch, run
 *     in the blocked PR with a one-line justification).
 *   - CHECK fails when any key's current count RISES above its baseline
 *     (net-new violations), and — when the guard opts into the touched-file
 *     ("boy-scout") rule — when a baselined key is modified by the PR's diff
 *     but not cleared.
 *   - `--update-baseline` regenerates the file from `current` (sorted). The
 *     ratchet is shrink-only in spirit: a regen that GROWS the total prints a
 *     loud warning so reviewers see the justification is required.
 *
 * API (all pure/synchronous; consumers stay tiny):
 *   loadBaseline(file)                      → { meta, entries }
 *   writeBaseline(file, meta, entries)      → void (sorted, stable)
 *   gitTouchedFiles({ cwd, baseRef })       → Set<repo-rel path> | null
 *   runRatchet({ name, baselineFile, meta, current, argv, touched })
 *                                           → exit code (0 pass / 1 fail)
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

/** Read a baseline JSON file → { meta:{owner,why,unblock}, entries:{key:n} }.
 *  A missing file yields empty entries (first run / bootstrap). */
export function loadBaseline(file) {
  if (!fs.existsSync(file)) return { meta: null, entries: {} };
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    meta: { owner: raw._owner ?? null, why: raw._why ?? null, unblock: raw._unblock ?? null },
    entries: raw.entries ?? {},
  };
}

/** Write the baseline (meta header first, entries sorted by key). */
export function writeBaseline(file, meta, entries) {
  const sorted = Object.keys(entries)
    .sort()
    .reduce((o, k) => {
      o[k] = entries[k];
      return o;
    }, {});
  const doc = {
    _owner: meta?.owner ?? 'unowned — set an owner',
    _why: meta?.why ?? 'ratchet baseline',
    _unblock:
      meta?.unblock ??
      'node <this guard> --update-baseline (run in the blocked PR with a one-line justification)',
    entries: sorted,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

/**
 * Repo-relative paths modified vs `baseRef` (default `origin/main`, override
 * via RATCHET_BASE_REF). Returns null when the diff cannot be computed (e.g.
 * shallow clone without the base ref) — callers SKIP the touched-file rule
 * with a note rather than failing spuriously.
 */
export function gitTouchedFiles({ cwd, baseRef } = {}) {
  const ref = baseRef ?? process.env.RATCHET_BASE_REF ?? 'origin/main';
  const dir = cwd ?? process.cwd();
  const run = (cmd) =>
    execSync(cmd, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  try {
    const committed = run(`git diff --name-only ${ref}...HEAD`);
    // union in uncommitted working-tree edits so local pre-commit runs see the
    // same result the CI run will after commit
    let working = [];
    try {
      working = run('git diff --name-only HEAD');
    } catch {
      /* fresh repo edge — committed diff is enough */
    }
    return new Set([...committed, ...working]);
  } catch {
    return null;
  }
}

const sum = (entries) => Object.values(entries).reduce((a, b) => a + b, 0);

/**
 * The shared check/regen driver. Returns the process exit code — the caller
 * does `process.exit(runRatchet({...}))`.
 *
 * @param {object} opts
 * @param {string} opts.name          log prefix, e.g. 'route-toolkit'
 * @param {string} opts.baselineFile  absolute path to the baseline JSON
 * @param {{owner:string,why:string,unblock:string}} opts.meta
 * @param {Record<string,number>} opts.current  measured keys → counts
 * @param {string[]} [opts.argv]      defaults to process.argv
 * @param {object} [opts.touched]     opt-in boy-scout rule:
 *        { files:Set<string>|null,   from gitTouchedFiles(); null = skip
 *          exempt:Map<string,string>, key → one-line reason
 *          message:(key)=>string }    the fix-it text shown on failure
 */
export function runRatchet({ name, baselineFile, meta, current, argv = process.argv, touched }) {
  const tag = `[${name}]`;
  const { meta: oldMeta, entries: baseline } = loadBaseline(baselineFile);

  if (argv.includes('--update-baseline')) {
    const oldTotal = sum(baseline);
    const newTotal = sum(current);
    writeBaseline(baselineFile, meta ?? oldMeta, current);
    console.log(
      `${tag} baseline updated: ${Object.keys(current).length} keys, ${newTotal} total (was ${sum(baseline)})`,
    );
    if (newTotal > oldTotal && Object.keys(baseline).length > 0) {
      console.warn(
        `${tag} WARNING: baseline GREW ${oldTotal} → ${newTotal}. This ratchet is shrink-only —` +
          ' a grow regen requires a one-line justification in the PR body.',
      );
    }
    return 0;
  }

  const baseTotal = sum(baseline);
  const curTotal = sum(current);
  console.log(`${tag} baseline: ${baseTotal} across ${Object.keys(baseline).length} keys`);
  console.log(`${tag} current:  ${curTotal} across ${Object.keys(current).length} keys`);

  let failed = false;

  // 1. per-key rise (net-new violations; subsumes the global-count rule)
  const regressions = [];
  for (const [key, n] of Object.entries(current)) {
    const allowed = baseline[key] ?? 0;
    if (n > allowed) regressions.push({ key, n, allowed });
  }
  if (regressions.length) {
    failed = true;
    console.error(`\n${tag} FAIL — new violations above the ratchet baseline:`);
    for (const r of regressions.sort((a, b) => a.key.localeCompare(b.key))) {
      console.error(`   - ${r.key}: ${r.n} (baseline ${r.allowed})`);
    }
  }

  // 2. optional touched-file (boy-scout) rule
  if (touched) {
    if (touched.files == null) {
      console.log(`${tag} note: base-ref diff unavailable — touched-file rule skipped this run.`);
    } else {
      const dirty = [];
      for (const key of Object.keys(baseline)) {
        if (!(key in current)) continue; // cleared — the ratchet's whole point
        if (!touched.files.has(key)) continue;
        if (touched.exempt?.has(key)) continue;
        dirty.push(key);
      }
      if (dirty.length) {
        failed = true;
        console.error(`\n${tag} FAIL — baselined files modified in this PR but not cleared (boy-scout rule):`);
        for (const key of dirty.sort()) {
          console.error(`   - ${key}`);
          if (touched.message) console.error(`     ${touched.message(key)}`);
        }
      }
    }
  }

  if (failed) {
    const unblock = (meta ?? oldMeta)?.unblock;
    if (unblock) console.error(`\n${tag} escape hatch: ${unblock}`);
    return 1;
  }
  console.log(`${tag} OK — no new violations; baseline holds.`);
  return 0;
}
