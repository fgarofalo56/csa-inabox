#!/usr/bin/env node
/**
 * GUARDRAIL: no Gov-reachable `az acr build` may run on the WEDGED ACR agent
 * pool, and a pool build may never be silent.
 *
 * WHY THIS EXISTS (#2706). The Gov console build took 4h25m and 3h29m on two
 * consecutive runs while Commercial built the same commit in ~15min. It was not
 * throughput, not the ACR SKU, not the base-image pulls and not the supply-chain
 * gates — the per-step timings put 100% of the gap in ONE step, and the cause was
 * a single stuck Azure resource: the `loombuild` agent pool on the Gov registry
 * went into a Failed provisioning state with its backing queue stuck in "being
 * deleted" (409). Builds submitted to it are ACCEPTED, never execute, and
 * `az acr build` EXITS 0 having pushed nothing.
 *
 *   loombuild  (wedged queue)   queued=3 / queued=4   -> ~60min, exit 0, NO image
 *   loombuild2 (healthy)        queued=0  x8 runs     -> 17-23min, image pushed
 *   Commercial loombuild        -                     -> ~15min, image pushed
 *
 * Recreating the wedged pool does NOT work (it 409s — run 30565655935). A FRESH
 * NAME is the reliable move, which is why the fix is a name and why a guard is
 * needed to keep every call site on it.
 *
 * ── WHY A GUARD AND NOT JUST THE FIX ───────────────────────────────────────
 * This is the guard-adoption gap, twice over. The fix first lived only in a
 * DISPATCH FORM FIELD — eight green Gov rolls all got there by a human typing
 * `loombuild2`, while the committed default stayed `loombuild`. #2938 then moved
 * the committed default for `gov-console-roll.yml` and `gov-build-images.yml`
 * and MISSED the other two Gov-reachable call sites:
 *
 *   console-bluegreen-roll.yml       cloud: [commercial, gov]  --agent-pool loombuild --no-logs
 *   build-fiab-images-acr-tasks.yml  boundary: [GCC-High, IL5] --agent-pool loombuild
 *
 * The first is the documented blue-green SUCCESSOR to the in-place roll, i.e.
 * the safer roll path was the one still aimed at the dead queue. Both would have
 * reproduced the 60-minute silent no-op on their next Gov dispatch. A correct
 * fix that only some siblings adopt is how this repo keeps re-learning the same
 * incident, so the invariant is enforced here instead of remembered.
 *
 * ── THE RULES ──────────────────────────────────────────────────────────────
 * For every workflow that runs `az acr build` AND can target Azure Government:
 *   R1. it must not name the known-wedged pool `loombuild` on an executable line;
 *   R2. an `az acr build` that runs ON A POOL must not pass `--no-logs`.
 *
 * R2 is the half that made this expensive. With `--no-logs` a stalled build and
 * a slow build are INDISTINGUISHABLE from Actions — there is no output at all —
 * which is why a dead queue burned most of a day before anyone could learn
 * anything. Default-agent builds are deliberately NOT covered: they are a
 * different execution path that cannot inherit a wedged pool queue, and eight
 * Gov workflows use `--no-logs` there today. Narrowing R2 to pool builds is what
 * makes it a real discriminator rather than a broad style rule.
 *
 * ── WHAT THIS DELIBERATELY DOES *NOT* COUNT ────────────────────────────────
 * A MENTION IS NOT A USE. `loombuild` legitimately appears all over these files
 * as PROSE — in comments recording the incident, in `description:` text for the
 * override input, and inside `::error::` remediation strings that name it as the
 * thing to avoid. Counting those would make the guard fail on the very files
 * that carry the fix, and the obvious "fix" would be deleting the explanation.
 * Only executable lines are judged. Commercial-only workflows are out of scope:
 * the Commercial `loombuild` pool is healthy and proven, and the wedge is a
 * property of one queue on one registry, not of the name.
 *
 * Usage: node scripts/ci/check-acr-agent-pool.mjs [--root <dir>]
 *
 * `--root` exists ONLY so scripts/ci/__tests__/acr-agent-pool.test.mjs can aim
 * the real checker at fixture trees built from the ACTUAL pre-fix files and
 * prove it goes red for the right reasons. CI never passes it, and it cannot
 * hollow the check out: the self-check below fails if the scan finds no
 * Gov-reachable builder at all, which is what a bogus root produces.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const rootFlag = process.argv.indexOf('--root');
const ROOT = rootFlag >= 0 ? process.argv[rootFlag + 1] : process.cwd();
const WORKFLOW_DIR = '.github/workflows';

/** The pool whose backing queue is stuck "being deleted" on the Gov registry. */
const WEDGED_POOL = 'loombuild';
/** Exact token: must match `loombuild` but NOT `loombuild2` / `loombuild3`. */
const WEDGED_POOL_RE = /(?<![A-Za-z0-9_])loombuild(?![A-Za-z0-9_])/;

/** A workflow reaching any of these can target Azure Government. */
const GOV_REACHABLE = /(AzureUSGovernment|usgovvirginia|AZURE_GOV_)/;

/** Workflow-command markers. A line carrying one of these is OUTPUT, not code. */
const ANNOTATION = /::(?:warning|notice|error|debug)::/;

/**
 * Lines that are PROSE rather than executable shell/YAML:
 *   - `#` comments (YAML and embedded bash)
 *   - `description:` — the dispatch-input help text, which names the wedged pool
 *     precisely so an operator understands the override
 *   - `echo`, and any ::annotation:: string
 */
function isProse(line) {
  const t = line.trim();
  if (t.startsWith('#')) return true;
  if (ANNOTATION.test(line)) return true;
  if (/^-?\s*description:/.test(t)) return true;
  if (/^echo\s/.test(t)) return true;
  return false;
}

/**
 * Join `\`-continued shell lines so a multi-line `az acr build ... \` invocation
 * is judged as ONE command. Without this, `--agent-pool` on line 1 and
 * `--no-logs` on line 3 look like unrelated facts, and R2 could never fire on
 * the real formatting these workflows use.
 */
function joinContinuations(lines) {
  const out = [];
  let buf = null;
  let startLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (isProse(raw)) {
      if (buf !== null) { out.push({ text: buf, line: startLine }); buf = null; }
      continue;
    }
    const trimmed = raw.trim();
    const continues = trimmed.endsWith('\\');
    const body = continues ? trimmed.slice(0, -1) : trimmed;
    if (buf === null) { buf = body; startLine = i + 1; } else { buf += ' ' + body; }
    if (!continues) { out.push({ text: buf, line: startLine }); buf = null; }
  }
  if (buf !== null) out.push({ text: buf, line: startLine });
  return out;
}

const wfDir = join(ROOT, WORKFLOW_DIR);
if (!existsSync(wfDir)) {
  console.error(`[acr-agent-pool] FAIL — ${WORKFLOW_DIR} does not exist under ${ROOT}.`);
  process.exit(1);
}

const failures = [];
const rows = [];
let govBuilders = 0;

for (const file of readdirSync(wfDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')).sort()) {
  const src = readFileSync(join(wfDir, file), 'utf8');
  if (!/az\s+acr\s+build/.test(src)) continue;

  const lines = src.split(/\r?\n/);
  const code = lines.filter((l) => !isProse(l)).join('\n');
  if (!GOV_REACHABLE.test(code)) {
    rows.push({ file, status: 'commercial-only', detail: 'not Gov-reachable — the wedge is a property of one queue on the Gov registry' });
    continue;
  }
  govBuilders++;

  const commands = joinContinuations(lines);

  // ── R1: the wedged pool must not be named on an executable line ────────────
  const wedged = [];
  for (const { text, line } of commands) {
    if (!WEDGED_POOL_RE.test(text)) continue;
    // Only pool-shaped usage counts: `--agent-pool loombuild`, `agentpool ... -n
    // loombuild`, or an assignment feeding one (POOL="loombuild").
    if (/--agent-pool|agentpool|POOL/i.test(text)) wedged.push({ text: text.slice(0, 160), line });
  }
  for (const w of wedged) {
    failures.push({
      file, rule: 'R1-wedged-pool', line: w.line,
      detail: `names the wedged pool '${WEDGED_POOL}' on an executable line: ${w.text}`,
    });
  }

  // ── R2: a POOL build must not be silent ───────────────────────────────────
  const silentPoolBuilds = commands.filter(
    ({ text }) => /az\s+acr\s+build/.test(text) && /--agent-pool|POOL_ARGS/.test(text) && /--no-logs/.test(text),
  );
  for (const s of silentPoolBuilds) {
    failures.push({
      file, rule: 'R2-silent-pool-build', line: s.line,
      detail: `runs \`az acr build\` on an agent pool with --no-logs: ${s.text.slice(0, 160)}`,
    });
  }

  const bad = wedged.length + silentPoolBuilds.length;
  rows.push({ file, status: bad ? 'FAIL' : 'ok', detail: bad ? `${bad} problem(s)` : 'gov-reachable pool usage is clean' });
}

// Self-check: a scan that finds no Gov-reachable image builder is measuring
// nothing (a bad --root, a moved workflow dir, a regex that stopped matching).
// Report that as a FAILURE rather than a green "0 problems".
if (govBuilders === 0) {
  console.error('[acr-agent-pool] FAIL — found ZERO Gov-reachable `az acr build` workflows.');
  console.error('  This repo has several. A scan that matches nothing cannot fail for the right');
  console.error('  reason, so it is reported as broken rather than passing vacuously.');
  process.exit(1);
}

console.log(`[acr-agent-pool] ${rows.length} image-building workflow(s), ${govBuilders} Gov-reachable:`);
for (const r of rows) console.log(`  ${r.status.padEnd(16)} ${r.file.padEnd(38)} ${r.detail}`);

if (failures.length === 0) {
  console.log('\n[acr-agent-pool] OK — no Gov-reachable build targets the wedged pool, and no pool build is silent.');
  process.exit(0);
}

console.error(`\n[acr-agent-pool] FAIL — ${failures.length} problem(s).\n`);
for (const f of failures) {
  console.error(`  ${f.file}:${f.line}  [${f.rule}]`);
  console.error(`    ${f.detail}`);
}
console.error(`\n  R1 — the '${WEDGED_POOL}' pool on the Gov ACR has a backing queue stuck in "being`);
console.error('  deleted" (409). Builds submitted to it are accepted, never execute, and');
console.error('  `az acr build` EXITS 0 having pushed NOTHING after ~60min. Recreating it 409s');
console.error('  too — use a FRESH NAME. `loombuild2` is proven by 8+ consecutive green Gov');
console.error('  rolls at 17-23min each; if it ever wedges the same way, move to loombuild3.');
console.error('\n  R2 — `--no-logs` on a POOL build makes a stall indistinguishable from a slow');
console.error('  build, which is how a dead queue burned 4h25m before anyone could learn');
console.error('  anything. Drop it; default-agent builds are out of scope and may keep it.');
console.error('\n  Prose is not judged: comments, `description:` text and ::error:: strings may');
console.error('  name the wedged pool freely — that is the record of why this guard exists.\n');
process.exit(1);
