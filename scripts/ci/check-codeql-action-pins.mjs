#!/usr/bin/env node
/**
 * GUARDRAIL: every `github/codeql-action/*` in one workflow runs ONE release.
 *
 * WHY THIS EXISTS (2026-08-09)
 * ----------------------------
 * `init`, `autobuild` and `analyze` are three actions published from a single
 * repository, and the CodeQL bundle `init` unpacks is read back by the others.
 * Pin them to different commits and the run dies at Autobuild with:
 *
 *     Loaded a configuration file for version '4.37.6', but running version '4.35.3'
 *
 * Dependabot did exactly that: #3103 bumped ONLY `init` (4.35.3 -> 4.37.6) and
 * left autobuild/analyze behind, so every Analyze job failed.
 *
 * WHY IT IS NOT MERELY A RED CHECK
 * --------------------------------
 * A failed analysis still uploads a SARIF — one with 0 rules and 0 results —
 * and GitHub does NOT retire existing alerts from an upload like that. The
 * code-scanning list therefore FREEZES at the last real scan and keeps reading
 * as current while every merge since goes unscanned. codeql.yml's own
 * "Assert the analysis actually completed" step says this in as many words.
 * So the visible symptom (a non-required check is red) is much smaller than
 * the actual one (security scanning has silently stopped).
 *
 * THE RULE
 * --------
 * Within a single workflow file, every `github/codeql-action/<sub>@<ref>` must
 * use the SAME `<ref>`. Cross-file drift is allowed on purpose: `upload-sarif`
 * in trivy.yml / validate.yml is a standalone uploader with no bundle to share,
 * and forcing it to move in lockstep would be a false coupling.
 *
 * DELIBERATELY NOT CHECKED:
 *   - Whether the pinned ref is CURRENT. That is dependabot's job; this guard
 *     only cares that the set is CONSISTENT.
 *   - The trailing `# vX` comment. It is documentation, and a stale comment is
 *     a lint issue, not an outage. (They were all `# v3` while the pins were
 *     v4 — corrected in the same commit as this guard, but not enforced here.)
 *
 * ESCAPE HATCH: none. If two codeql-action steps in one workflow genuinely need
 * different releases, that is a bug report for upstream, not an allowlist.
 *
 * SELF-DEFENCE: refuses to pass vacuously — zero workflows, or zero
 * codeql-action references, FAILS rather than printing OK.
 *
 * Usage: node scripts/ci/check-codeql-action-pins.mjs [workflow-dir]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_DIR = '.github/workflows';
const WORKFLOW_DIR = process.argv[2] || DEFAULT_DIR;
const IS_DEFAULT = WORKFLOW_DIR === DEFAULT_DIR;

/** `uses: github/codeql-action/<sub>@<ref>`, with or without the sequence dash. */
const USES_CODEQL = /^\s*(?:-\s+)?uses:\s*github\/codeql-action\/([\w-]+)@(\S+)/;

const violations = [];
let examined = 0;
const files = readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f)).sort();

for (const file of files) {
  // PHYSICAL-LINES-OK: judges `uses: github/codeql-action/<sub>@<ref>` — a YAML
// key whose value is one token. A `uses:` line never continues with a backslash
// (#3420 names this guard specifically as the presence-only case).
  const lines = readFileSync(join(WORKFLOW_DIR, file), 'utf8').split(/\r?\n/);
  /** ref -> [{sub, line}] for this file */
  const byRef = new Map();
  lines.forEach((line, i) => {
    const m = line.match(USES_CODEQL);
    if (!m) return;
    examined++;
    const [, sub, ref] = m;
    if (!byRef.has(ref)) byRef.set(ref, []);
    byRef.get(ref).push({ sub, line: i + 1 });
  });

  if (byRef.size > 1) {
    violations.push({
      file,
      refs: [...byRef.entries()].map(([ref, uses]) => ({
        ref,
        uses: uses.map((u) => `${u.sub} (line ${u.line})`).join(', '),
      })),
    });
  }
}

if (violations.length > 0) {
  console.error(
    `\n[codeql-action-pins] ${violations.length} workflow(s) mix codeql-action releases:\n`,
  );
  for (const v of violations) {
    console.error(`  ${WORKFLOW_DIR}/${v.file}`);
    for (const r of v.refs) console.error(`      ${r.ref}\n        -> ${r.uses}`);
  }
  console.error(
    '\n  init/autobuild/analyze share one CodeQL bundle. Mixed pins fail at\n' +
      '  Autobuild with "Loaded a configuration file for version X, but running\n' +
      '  version Y" — and a failed analysis still uploads a 0-result SARIF that\n' +
      '  GitHub will NOT retire alerts from, so the code-scanning list freezes at\n' +
      '  the last real scan and reads as current while merges go unscanned.\n' +
      '\n  Fix: pin every codeql-action step in the file to the same commit.\n' +
      '  .github/dependabot.yml groups them so a bump moves all of them at once.\n',
  );
  process.exit(1);
}

if (IS_DEFAULT && (files.length === 0 || examined === 0)) {
  console.error(
    `[codeql-action-pins] REFUSING TO PASS: scanned ${files.length} workflow(s) and found ` +
      `${examined} codeql-action reference(s). This repo has several. The matcher has ` +
      'stopped matching — fix the scanner, do not ship a green check that measures nothing.',
  );
  process.exit(1);
}

console.log(
  `[codeql-action-pins] OK — ${files.length} workflows, ${examined} codeql-action use(s); consistent within every file.`,
);
