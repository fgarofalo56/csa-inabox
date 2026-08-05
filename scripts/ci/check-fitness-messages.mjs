#!/usr/bin/env node
/**
 * GUARDRAIL: every adoption fitness check must record WHAT IT OBSERVED, and a
 * check that could not observe must never assert non-existence. (merge-blocker)
 *
 * WHY THIS EXISTS (deploy-integrity R7)
 * -------------------------------------
 * On 2026-08-05 a roll reported "the tag does not exist" when the truth was "I
 * could not reach the registry" — a `2>/dev/null` had turned a permission denial
 * into an empty string and the empty string into a false claim. That message
 * sent two separate investigations down the wrong path.
 *
 * Adoption validation is the same hazard at ten times the surface area: twenty
 * services, each with SKU / region / network / RBAC / family checks, every one
 * of which can fail to READ its input. Telling an operator their storage account
 * has no hierarchical namespace, when the truth is that the scan lacked Reader,
 * sends them to replace a resource that was fine.
 *
 * TWO RULES
 * ---------
 * 1. Every FitnessCheck literal carries `established` — the field, the value and
 *    the source the verdict was derived from. A check's `what` may only assert
 *    something that field supports.
 * 2. A check whose verdict is 'unknown' must NOT claim non-existence. "Loom
 *    could not read X" is allowed; "X does not exist" is not.
 *
 * Mutation-proven by scripts/ci/__tests__/fitness-messages.test.mjs.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
export const FITNESS_PATH = 'apps/fiab-console/lib/deploy/fitness.ts';

/** Phrases that assert a fact about the world, not about what the code read. */
const NON_EXISTENCE_CLAIMS = [
  'does not exist',
  'not found',
  'no such',
  'is missing',
];

const MIN_CHECKS = 35;

/**
 * Extract every object literal that is a FitnessCheck.
 *
 * Anchored on each `verdict:` occurrence and walked BACKWARDS to the opening
 * brace of its innermost enclosing object, then forwards to the matching close.
 * A naive forward scan from every `{` grabs the enclosing ARROW-FUNCTION BODY
 * instead — it contains `verdict:` and `what:` too — and then skips past all the
 * real literals inside it. That undercounted 45 checks as 11 while still
 * reporting a plausible-looking number, which is precisely the shape of a guard
 * that measures less than it claims.
 */
export function extractCheckLiterals(source) {
  const seen = new Set();
  const out = [];
  const isStringDelim = (c) => c === "'" || c === '"' || c === '`';

  for (const m of source.matchAll(/\bverdict:/g)) {
    // Walk backwards to the innermost enclosing '{'.
    let depth = 0;
    let open = -1;
    for (let k = m.index - 1; k >= 0; k--) {
      const c = source[k];
      if (c === '}') depth++;
      else if (c === '{') {
        if (depth === 0) { open = k; break; }
        depth--;
      }
    }
    if (open < 0 || seen.has(open)) continue;

    // Walk forwards to its matching '}', string-aware.
    let d = 0, close = -1, inStr = null;
    for (let k = open; k < source.length; k++) {
      const c = source[k];
      if (inStr) {
        if (c === '\\') { k++; continue; }
        if (c === inStr) inStr = null;
        continue;
      }
      if (isStringDelim(c)) { inStr = c; continue; }
      if (c === '{') d++;
      else if (c === '}') { d--; if (d === 0) { close = k; break; } }
    }
    if (close < 0) continue;

    const text = source.slice(open, close + 1);
    // A VALUE literal, not the `interface FitnessCheck` declaration (whose
    // members are `what: string;` / `verdict: CheckVerdict;`).
    if (!/\bwhat:/.test(text)) continue;
    if (/\bwhat:\s*string;/.test(text)) continue;

    seen.add(open);
    out.push({ index: open, text });
  }
  return out.sort((a, b) => a.index - b.index);
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

export function runChecks(source) {
  const problems = [];
  const literals = extractCheckLiterals(source);

  if (literals.length < MIN_CHECKS) {
    problems.push(
      `only ${literals.length} fitness-check literals were found but at least ${MIN_CHECKS} are ` +
        `expected. Either checks were deleted, or the extractor stopped matching — and an extractor ` +
        `that matches nothing is a guard that measures nothing.`,
    );
  }

  for (const { index, text } of literals) {
    const line = lineOf(source, index);

    // RULE 1 — the observation is mandatory.
    if (!/\bestablished:/.test(text)) {
      const id = /\bid:\s*[`'"]([^`'"]*)/.exec(text)?.[1] ?? '(unnamed)';
      problems.push(
        `${FITNESS_PATH}:${line} — check '${id}' has no \`established\`. Without it the message ` +
          `asserts something the code never recorded observing.`,
      );
    }

    // RULE 2 — an unknown verdict must not assert non-existence.
    const verdict = /\bverdict:\s*'([a-z-]+)'/.exec(text)?.[1];
    const dynamicVerdict = /\bverdict:\s*[^'\n]/.test(text.split('\n').find((l) => /\bverdict:/.test(l)) ?? '');
    if (verdict === 'unknown' || (dynamicVerdict && /'unknown'/.test(text))) {
      const whatLine = text.split('\n').find((l) => /\bwhat:/.test(l)) ?? '';
      for (const claim of NON_EXISTENCE_CLAIMS) {
        if (whatLine.toLowerCase().includes(claim)) {
          problems.push(
            `${FITNESS_PATH}:${line} — a check that may resolve to 'unknown' says "${claim}" in its ` +
              `\`what\`. "I could not read it" and "it is not there" are different facts and must not ` +
              `collapse (deploy-integrity R7).`,
          );
        }
      }
    }
  }

  // The blocking gate must treat 'unknown' as blocking, not as a pass.
  if (!/verdict === 'unusable' \|\| r\.fitness\.verdict === 'unknown'/.test(source)) {
    problems.push(
      `${FITNESS_PATH} — assertPlanIsDeployable must block on BOTH 'unusable' and 'unknown'. ` +
        `Deploying against a resource Loom could not verify is how a half-built estate happens.`,
    );
  }

  return { problems, literalCount: literals.length };
}

export function loadSource() {
  const p = resolve(REPO, FITNESS_PATH);
  if (!existsSync(p)) throw new Error(`missing required file: ${FITNESS_PATH}`);
  return readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}

function main() {
  let result;
  try {
    result = runChecks(loadSource());
  } catch (err) {
    console.error(`[fitness-messages] FAILED to run: ${err.message}`);
    process.exit(1);
  }
  if (result.problems.length > 0) {
    console.error(`[fitness-messages] ${result.problems.length} problem(s):\n`);
    for (const p of result.problems) console.error(`  ✗ ${p}\n`);
    process.exit(1);
  }
  console.log(
    `[fitness-messages] ok — ${result.literalCount} checks, every one records what it observed.`,
  );
}

if (process.argv[1]?.endsWith('check-fitness-messages.mjs')) main();
