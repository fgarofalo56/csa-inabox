#!/usr/bin/env node
/**
 * MUTATION HARNESS for scripts/ci/__tests__/file-size-ratchet.test.mjs.
 *
 *   node scripts/ci/__tests__/file-size-ratchet.mutations.mjs
 *
 * Not named `*.test.mjs` on purpose: it REWRITES `check-file-size.mjs` while it
 * runs, so it must not be swept up by `node --test scripts/ci/__tests__/*.test.mjs`
 * in the guardrails job or by check-node-test-suites.mjs's discovery walk. It
 * restores the file in a `finally`, and re-asserts the restore at the end.
 *
 * WHY IT IS COMMITTED. A mutation result quoted in a PR body is a claim; a
 * mutation result a reviewer can re-run is evidence. Every arm below carries the
 * MECHANISM — what the mutant breaks about the guard, and which assertion is
 * supposed to notice — because a green run is otherwise ambiguous between "the
 * test is blind" and "the mutant was too weak to change behaviour".
 *
 * TWO TRAPS THIS HARNESS IS BUILT AGAINST:
 *
 *   1. A NEEDLE THAT MATCHES ZERO TIMES mutates nothing and reports GREEN — the
 *      suite is then credited for surviving a mutation that never happened. On a
 *      Windows checkout of this repo the working tree is CRLF while the blob is
 *      LF, so any multi-line `\n` needle silently matches nothing. Every needle
 *      here is a RegExp, every `\n` in one is `\r?\n`, and each is asserted to
 *      match EXACTLY ONCE before it is applied.
 *   2. A SHARED ORACLE. The suite imports `nextCeiling` from the module under
 *      test and uses it as the oracle for the CLI arm, so mutating `nextCeiling`
 *      moves the oracle with the subject and that arm goes blind. That is why
 *      arms 1-4 assert `nextCeiling` against LITERALS, and why this harness
 *      mutates the helper (`loosen-helper`) and the call site (`loosen-callsite`)
 *      SEPARATELY rather than trusting one to stand for the other.
 *
 * The CONTROL arm mutates a string no assertion reads and must stay GREEN. Its
 * job is to show that the REDs below are caused by the semantics and not merely
 * by the file having been rewritten.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(HERE, '..', 'check-file-size.mjs');
const SUITE = path.join(HERE, 'file-size-ratchet.test.mjs');
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

/**
 * @type {{name:string, expect:'RED'|'GREEN', mechanism:string, kills:string,
 *         needle:RegExp, replace:string}[]}
 */
const MUTANTS = [
  {
    name: 'loosen-helper',
    expect: 'RED',
    mechanism:
      'nextCeiling forgets the recorded ceiling — the verbatim 2026-09-10 defect. Every exact-LOC ' +
      'pin is handed +38..+94 LOC back on the next paste.',
    kills:
      'arms 1-4, which assert nextCeiling against LITERALS. The CLI arm CANNOT kill this one: its ' +
      'oracle is nextCeiling itself, so the oracle mutates with the subject.',
    needle: /return Math\.max\(n, Math\.min\(prevMax, ceilTo100\(n\)\)\);/,
    replace: 'return ceilTo100(n);',
  },
  {
    name: 'loosen-callsite',
    expect: 'RED',
    mechanism:
      'nextCeiling stays correct and exported, but planBaseline stops calling it. An exported helper ' +
      'is presence, not reachability — this is the shape arms 1-4 are structurally blind to.',
    kills: 'the CLI arm ("emits exactly nextCeiling(recorded, LOC)"), over the real 66-entry population.',
    needle: /const max = nextCeiling\(prev\?\.max, n\);/,
    replace: 'const max = ceilTo100(n);',
  },
  {
    name: 'drop-existing-entries',
    expect: 'RED',
    mechanism:
      'planBaseline emits only files above the warn line — the second half of the 2026-09-10 defect. ' +
      'The 8 entries at or below 1500 vanish, and a dropped entry is unratcheted to 1500 (apim-editors ' +
      'goes 100 -> released).',
    kills: 'the "drops no existing allowlist entry" arm. No ceiling comparison can see it: a dropped key has none.',
    needle: /\r?\n\s*\.\.\.Object\.keys\(allowlist\),/,
    replace: '',
  },
  {
    name: 'clamp-away-the-rise',
    expect: 'RED',
    mechanism:
      "the re-reviewer's mutant. planBaseline can tighten but never rise, so the FAIL text's own " +
      'remediation is DEAD: run --update-baseline on a grown file, paste the output, and CI is still ' +
      'red with no explanation. On the clean tree it is behaviourally IDENTICAL to the correct code, ' +
      'so no arm over the real population can distinguish it.',
    kills:
      'the FIXTURE rise arm, which drives planBaseline with a synthetic counts map where one pinned ' +
      'file sits ONE line over its ceiling. That population cannot exist in a green tree, which is ' +
      'why the fixture seam had to be opened.',
    needle: /const max = nextCeiling\(prev\?\.max, n\);/,
    replace: 'const max = prev === undefined ? ceilTo100(n) : Math.min(prev.max, ceilTo100(n));',
  },
  {
    name: 'unstamped-rise',
    expect: 'RED',
    mechanism:
      'a rise is emitted carrying the OLD entry\'s justification verbatim — the 2026-09-11 finding. ' +
      'The tool then auto-generates an allowlist entry whose narrative argues a number it no longer ' +
      'holds ("ZERO HEADROOM IS THE POINT ... 2620 under 2620 now" sitting above max: 2621).',
    kills: 'the FIXTURE stamp arm (reason must start with TODO(bump): and name the 2620->2621 rise).',
    needle: /prev && max > prev\.max\r?\n/,
    replace: 'false\n',
  },
  {
    name: 'toothless-marker',
    expect: 'RED',
    mechanism:
      'unarguedBumps() never finds a marker, so the stamp is decoration: paste a raised ceiling and ' +
      'the guard goes green anyway.',
    kills: 'the FIXTURE stamp arm AND the process arm (the injected entry stops failing the guard).',
    needle: /\.filter\(\(\[, entry\]\) => typeof entry\?\.reason === 'string' && entry\.reason\.startsWith\(BUMP_MARKER\)\)/,
    replace: '.filter(() => false)',
  },
  {
    name: 'marker-present-but-unreachable',
    expect: 'RED',
    mechanism:
      'unarguedBumps() is exported and CORRECT, but main() computes it and throws the result away. ' +
      'Every helper-level assertion still passes. This is the exact "a control can be present and ' +
      'unreachable" shape, and only a run of the guard AS A PROCESS can see it.',
    kills: 'the process arm ("the guard FAILS on an allowlist entry still carrying the stamp").',
    needle: /failures\.push\(\{ file, kind: 'unargued-bump', limit: ALLOWLIST\[file\]\.max \}\);/,
    replace: 'void file;',
  },
  {
    name: 'launder-the-marker',
    expect: 'RED',
    mechanism:
      'a NON-rising entry has its marker stripped on the way out, so a bump launders green in two ' +
      'passes: grow, paste (red), re-run --update-baseline, paste again (green, unargued). The ' +
      'narrow way around FAIL rule 4 that does not touch rule 4 at all.',
    kills: 'the "a second --update-baseline does NOT launder the stamp away" arm.',
    needle: /\r?\n(\s*): carried;/,
    replace: '\n$1: reasonWithoutBumpMarker(carried);',
  },
  {
    name: 'CONTROL-reword-a-log-line',
    expect: 'GREEN',
    mechanism:
      'rewords the OK line, which no assertion reads. Nothing about the ratchet changes.',
    kills: 'nothing — and it must not, or every RED above would be explained by "the file was edited".',
    needle: /no ratchet regressions, no backstop breaches\./,
    replace: 'no ratchet regressions and no backstop breaches.',
  },
];

/** Run the suite under whatever `check-file-size.mjs` currently says. */
function runSuite() {
  let stdout = '';
  let code = 0;
  try {
    stdout = execFileSync(
      process.execPath,
      ['--test', '--test-reporter=tap', SUITE],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (e) {
    code = e.status ?? -1;
    stdout = e.stdout ?? '';
  }
  const num = (label) => {
    const m = stdout.match(new RegExp(`^# ${label} (\\d+)$`, 'm'));
    return m ? Number(m[1]) : NaN;
  };
  const failed = [...stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1].trim());
  return { code, pass: num('pass'), fail: num('fail'), tests: num('tests'), failed };
}

const original = readFileSync(GUARD, 'utf8');
const results = [];

try {
  const baseline = runSuite();
  results.push({ name: '(unmutated baseline)', expect: 'GREEN', ...baseline });

  for (const m of MUTANTS) {
    const hits = original.match(new RegExp(m.needle.source, m.needle.flags.includes('g') ? m.needle.flags : `${m.needle.flags}g`)) ?? [];
    if (hits.length !== 1) {
      results.push({
        name: m.name, expect: m.expect, code: NaN, pass: NaN, fail: NaN, tests: NaN,
        failed: [`NEEDLE MATCHED ${hits.length} TIMES — NOT APPLIED. A zero-match needle would have ` +
          'reported this arm GREEN over a mutation that never happened.'],
      });
      continue;
    }
    writeFileSync(GUARD, original.replace(m.needle, m.replace), 'utf8');
    results.push({ name: m.name, expect: m.expect, ...runSuite() });
    writeFileSync(GUARD, original, 'utf8');
  }
} finally {
  writeFileSync(GUARD, original, 'utf8');
}

if (readFileSync(GUARD, 'utf8') !== original) {
  console.error('[mutations] FATAL: check-file-size.mjs was NOT restored. Fix it before committing.');
  process.exit(2);
}

let bad = 0;
console.log('');
for (const r of results) {
  const verdict = r.fail > 0 || r.code !== 0 ? 'RED' : 'GREEN';
  const ok = verdict === r.expect && Number.isFinite(r.pass);
  if (!ok) bad++;
  console.log(
    `${ok ? 'as expected' : 'UNEXPECTED '}  ${r.expect.padEnd(5)}  ${String(r.name).padEnd(32)}  ` +
      `RC=${r.code}  tests ${r.tests} · pass ${r.pass} · fail ${r.fail}`,
  );
  for (const f of r.failed) console.log(`                                                    ↳ ${f}`);
}
console.log('');
if (bad) {
  console.error(`[mutations] ${bad} arm(s) did not behave as documented. A surviving mutant is a blind test.`);
  process.exit(1);
}
console.log(`[mutations] ${results.length - 1} mutants, all as documented (${MUTANTS.filter((m) => m.expect === 'RED').length} killed, 1 control green).`);
