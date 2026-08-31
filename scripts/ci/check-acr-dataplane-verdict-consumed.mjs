#!/usr/bin/env node
/**
 * check-acr-dataplane-verdict-consumed.mjs
 *
 * RULE. A workflow that runs `acr-dataplane-ready.sh` must CONSUME its verdict —
 * by branching on the exit status, or by going through
 * `scripts/ci/acr-dataplane-gate.sh`, which classifies it. Discarding the status
 * with `|| echo …` / `|| true` is the violation.
 *
 * WHY (#4079). The probe returns THREE distinguishable verdicts:
 *
 *   0  answered on N consecutive samples — ready
 *   1  never sustained N consecutive answers (propagation — retryable)
 *   2  never got an HTTP response at all (an UNKNOWN, NOT a refusal)
 *
 * and every Azure Government caller collapsed all of them into one sentence:
 *
 *   bash …/acr-dataplane-ready.sh --acr "$ACR" --timeout-seconds 180 \
 *     || echo "::warning::ACR data plane not confirmed reachable; …"
 *
 * Measured on main, 2026-08-31, over the 17 real call sites:
 *
 *   Gov:         branch=0   swallow=12
 *   Commercial:  branch=3   swallow=2
 *
 * #4067 hardened the probe so a single anonymous 401 is no longer treated as an
 * observation. In Gov that changed the LOG and nothing about BEHAVIOUR: the
 * probe correctly refused to declare READY, the caller discarded the refusal,
 * and the step proceeded into the very data-plane call the probe existed to
 * protect. Commercial got the protection; the sovereign boundaries got a warning
 * line (`cloud-parity.md`), and #4067 read as more protective than it was.
 *
 * KEYED TO THE UNSAFE PATTERN — a bare probe invocation whose status is thrown
 * away — never to "does this repo reference the gate". Adopting the gate REMOVES
 * the `acr-dataplane-ready.sh` token from the call site, so a presence-keyed rule
 * would go quiet on exactly the files it had just fixed
 * (`guard_keyed_to_the_unsafe_pattern`).
 *
 * NOT FLAGGED, deliberately:
 *   · `acr-dataplane-gate.sh` itself and its self-test — they ARE the adoption;
 *   · the guardrails lane's self-test invocations, which run the probe's own
 *     test harness rather than probing a registry;
 *   · a call site that branches (`if ! bash …`), which is the pre-existing
 *     Commercial shape and is already correct.
 *
 * FOLDED LINES. Read through readLogicalLines: `bash …ready.sh --acr X \` +
 * `  || echo "…"` is one logical command, and a physical-line matcher sees the
 * invocation without its `||` and calls it clean — the #3420 class this repo has
 * been bitten by twice.
 *
 * SELF-DEFENCE. Fails on an empty workflow population and on zero probe
 * references anywhere — either means the matcher drifted off the code.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readLogicalLines } from './_logical-lines.mjs';

const ROOT = process.cwd();
const PROBE = 'acr-dataplane-ready.sh';
const GATE = 'acr-dataplane-gate.sh';

const EXEMPT = new Set([
  'scripts/ci/acr-dataplane-ready.sh',
  'scripts/ci/acr-dataplane-gate.sh',
  'scripts/ci/test-acr-dataplane-ready.sh',
  'scripts/ci/test-acr-dataplane-gate.sh',
  'scripts/ci/check-acr-dataplane-verdict-consumed.mjs',
]);

function tracked(...patterns) {
  try {
    return execFileSync('git', ['ls-files', '--', ...patterns], {
      encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    }).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch (e) {
    console.error(
      `::error::acr-dataplane-verdict: could not ask git for tracked files (${(e.message || '').slice(0, 160)}). ` +
        'Refusing to fall back to a filesystem walk.',
    );
    process.exit(1);
  }
}

const workflows = tracked('.github/workflows/*.yml', '.github/workflows/*.yaml');
if (workflows.length === 0) {
  console.error('::error::acr-dataplane-verdict: scanned ZERO workflows. Refusing to report a pass.');
  process.exit(1);
}

const violations = [];
let probeRefs = 0;
let gateRefs = 0;

for (const rel of workflows) {
  if (EXEMPT.has(rel)) continue;
  let logical;
  try {
    logical = readLogicalLines(readFileSync(join(ROOT, rel), 'utf8'));
  } catch { continue; }

  for (const { line, text } of logical) {
    if (text.trim().startsWith('#')) continue;
    if (text.includes(GATE)) gateRefs++;
    const at = text.indexOf(PROBE);
    if (at < 0) continue;
    // A mention inside an echoed message is prose, not an invocation. Scoped to
    // the text BEFORE the match: on a folded line a real invocation carries its
    // own fallback message after it.
    const before = text.slice(0, at);
    if (/\b(echo|printf)\b/.test(before) || /::(error|warning|notice)::/.test(before)) continue;
    // The probe's own self-test harness is not a registry probe.
    if (/test-acr-dataplane/.test(text)) continue;
    probeRefs++;

    const branches = /\bif\s+!?\s*bash\b/.test(text) || /\bif\s+!/.test(before);
    const discards = /\|\|\s*(echo|true|:|printf)/.test(text);
    if (discards && !branches) {
      violations.push({ file: rel, line, text: text.trim().slice(0, 150) });
    }
  }
}

if (probeRefs === 0 && gateRefs === 0) {
  console.error(
    `::error::acr-dataplane-verdict: found ZERO references to ${PROBE} or ${GATE} across ` +
      `${workflows.length} tracked workflow(s). Every image producer and roll path probes the ACR data plane, ` +
      'so zero means this matcher has drifted off the code. Refusing to report a pass on an empty population.',
  );
  process.exit(1);
}

if (violations.length > 0) {
  console.error(
    `::error::acr-dataplane-verdict: ${violations.length} call site(s) run ${PROBE} and DISCARD its exit status. ` +
      'The probe distinguishes "never sustained" (propagation, retryable) from "no HTTP response at all" (an ' +
      'UNKNOWN, not a refusal); `|| echo` collapses both into one sentence and proceeds into the data-plane call ' +
      'the probe existed to protect (#4079 — Gov had 12 of these while Commercial branched). Fix: ' +
      `bash scripts/ci/${GATE} --acr "$ACR" --timeout-seconds 180 [--on-unconfirmed fail]`,
  );
  for (const v of violations) console.error(`::error file=${v.file},line=${v.line}::${v.text}`);
  process.exit(1);
}

console.log(
  `acr-dataplane-verdict OK — ${workflows.length} workflow(s) scanned, ${gateRefs} call site(s) go through ${GATE}, ` +
    `${probeRefs} direct ${PROBE} invocation(s) all branch on the verdict, 0 discard it.`,
);
