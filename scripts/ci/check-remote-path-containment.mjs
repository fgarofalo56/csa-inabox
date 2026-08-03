/**
 * GUARDRAIL: remote-path-containment  (merge-blocker — CodeQL js/http-to-file-access)
 * ---------------------------------------------------------------------------
 * NO SHEBANG — DO NOT ADD ONE. This module exports its analysis so the self-test
 * (and, later, possibly a vitest spec) can import it, and vite-node evaluates an
 * out-of-root `.mjs` through `vm.Script`, which does NOT strip `#!` — a shebang
 * kills such a spec at COLLECTION with `SyntaxError: Invalid or unexpected
 * token`. That has already happened twice in this repo (_ratchet-count.mjs,
 * check-unity-audit-chokepoint.mjs). CI invokes it as `node scripts/ci/...`,
 * which needs no shebang.
 * ---------------------------------------------------------------------------
 * RULE
 *
 *   A value that arrived over the network must never become a filesystem path
 *   component without a containment check performed by the process that owns
 *   the filesystem.
 *
 * THE DEFECT THIS EXISTS FOR. `loom apps run-local` downloaded an app's build
 * context and wrote it out with:
 *
 *     for (const f of ctx.files) {          // ctx = await client.request(...)
 *       const p = join(dir, f.path);        // f.path came off the wire
 *       writeFileSync(p, f.content);
 *     }
 *
 * `path.join` resolves `..`, so a response carrying `../../victim.txt` wrote
 * OUTSIDE `dir`. Proven, not theorised: with the check reverted, the regression
 * suite's neighbouring file reads `PWNED` instead of `ORIGINAL`, and the first
 * mutation run left a literal `PWNED` file in the OS temp directory.
 *
 * WHY A GUARD AND NOT A COMMENT. The console's `assembleBuildContext()` already
 * sanitized these paths, and every escape vector tested against it is blocked —
 * so the CLI's missing check looked harmless right up until you notice the CLI
 * cannot observe that the peer sanitized anything. The API base URL is operator
 * supplied (`loom auth login --api-url …`). One server-side regression, one
 * typo'd host, one MITM, and every developer workstation that runs the command
 * writes wherever it is told. The next person to add a "download these files"
 * command will copy the neighbouring code, not the reasoning — so the reasoning
 * has to be a red build.
 *
 * WHAT IS CHECKED
 *
 *   A1  HELPER INTEGRITY (anti-inert). `containedJoin` still performs all three
 *       layers: a `..`-segment rejection, an absolute-path rejection, and the
 *       post-resolve `base + sep` containment comparison. Per #2729 a fix that
 *       is present but gutted is the worst outcome: it reads as protection and
 *       enforces nothing. A2 alone would happily pass against an empty helper.
 *   A2  ADOPTION. Every filesystem write whose path expression is tainted by a
 *       network read resolves through `containedJoin`.
 *   A3  NO RIVAL. Nobody hand-rolls a second containment helper, because two
 *       implementations means one of them is the stale one.
 *
 * ANTI-PATTERNS AVOIDED (per check-tid-boundary-chokepoint's three rewrites):
 * comments and string bodies are MASKED via the shared, self-tested
 * `maskCommentsAndStrings`, so a doc comment naming `containedJoin` cannot
 * satisfy A2; A1 brace-matches the function body rather than substring-testing
 * the file; taint is propagated INTO local functions through their call sites,
 * because the pre-fix defect and its fix live in different functions and a
 * per-function analysis would have reported "clean" either way.
 *
 * KNOWN LIMIT, stated rather than hidden: this is a textual taint pass, not a
 * type-aware one. It is deliberately conservative — it can MISS an exotic
 * laundering chain, it should not invent one. A miss is a future alert; a false
 * positive blocks unrelated PRs and gets the guard deleted.
 *
 * ## PROVEN TO FAIL. Each mutation was applied and the exit code recorded.
 * A guard nobody has tried to defeat is a comment.
 *
 *   M1  run-local writes `join(dir, f.path)` again (the original defect)  exit 1
 *   M2  containedJoin keeps its shape but loses the `..` rejection        exit 1
 *   M3  containedJoin loses the post-resolve containment comparison       exit 1
 *   M4  a NEW command downloads files and writes them with a raw join     exit 1
 *   M5  a second module re-implements containment                         exit 1
 *   M6  NEGATIVE CONTROL — a doc comment naming containedJoin             exit 0
 *   M7  NEGATIVE CONTROL — a write whose path is a CLI flag, not remote   exit 0
 *
 * Usage: node scripts/ci/check-remote-path-containment.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { maskCommentsAndStrings } from './check-unity-audit-chokepoint.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');

/** The module that owns containment. */
const HELPER_FILE = 'apps/loom-cli/src/safe-path.ts';
const HELPER = 'containedJoin';

/**
 * Every surface that can read from a network AND write to a local filesystem.
 * `apps/fiab-console/{app,lib}` has ZERO filesystem writes today — it is listed
 * so that the day someone adds one driven by a request value, this fails on
 * that PR instead of on a CodeQL run three weeks later.
 */
const ROOTS = [
  'apps/loom-cli/src',
  'apps/fiab-console/app',
  'apps/fiab-console/lib',
  'apps/fiab-mcp-bridge/src',
  'apps/copilot-maf/src',
  'apps/fiab-report-subscriptions/src',
  'scripts/ci',
  'scripts/csa-loom',
  'scripts/dev',
  'scripts/codemods',
];
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build', 'coverage', '__snapshots__']);
const EXTS = new Set(['.ts', '.tsx', '.mjs', '.js', '.cjs']);

/**
 * Sites where a network value legitimately reaches a path and the containment
 * lives elsewhere. Adding an entry is a security review: say why.
 * Empty today — the one real site uses the helper.
 */
const EXEMPT = new Map();

// ── source discovery ────────────────────────────────────────────────────────
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (EXTS.has(path.extname(e.name))) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const rel = (abs) => path.relative(REPO, abs).split(path.sep).join('/');

// ── expression helpers ──────────────────────────────────────────────────────

/** Text of the balanced argument list starting at the `(` at `open`. */
function argList(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return masked.slice(open + 1, i);
    }
  }
  return '';
}

/** First top-level argument of an argument-list text. */
function firstArg(args) {
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) return args.slice(0, i);
  }
  return args;
}

const IDENT = /[A-Za-z_$][\w$]*/g;
const hasWord = (text, word) => new RegExp(`\\b${word}\\b`).test(text);

// ── taint ───────────────────────────────────────────────────────────────────

/** `await client.request<T>(…)`, `await fetch(…)`, `await res.json()`, … */
const NET_CALL = String.raw`await\s+[\w.$]*\b(?:request|fetch|json|arrayBuffer|text|download|getJson|blob)\s*[(<]`;

/**
 * Analyze one masked source file.
 *
 * POSITION-SCOPED, deliberately. The first cut of this guard resolved each
 * identifier to the FIRST binding of that name anywhere in the file, and that
 * made it a gate that could be satisfied by accident: in apps.ts the arrow
 * parameter `p` of an unrelated one-line lambda collided with the `for (const p
 * of planned)` binding, so expanding `resolve(out)` in the `export` case
 * dragged `containedJoin` in from a different function and the site reported
 * "contained" when nothing contained it. Same shape as the defect this whole
 * guard exists for: it reported success while measuring nothing.
 *
 * So every identifier now resolves to the NEAREST PRECEDING binding of that
 * name, and taint is a property of the expanded expression (does it reach a
 * network call?) rather than of a file-wide name set.
 */
function analyze(masked) {
  // Every binding, with its source offset, so lookups can be positional.
  const bindings = [];
  for (const m of masked.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g)) {
    bindings.push({ name: m[1], init: m[2], pos: m.index });
  }
  for (const m of masked.matchAll(/for\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+([^)]+)\)/g)) {
    bindings.push({ name: m[1], init: m[2], pos: m.index });
  }
  bindings.sort((a, b) => a.pos - b.pos);

  const nearestInit = (name, pos) => {
    let best = null;
    for (const b of bindings) {
      if (b.pos >= pos) break;
      if (b.name === name) best = b;
    }
    return best ? best.init : null;
  };

  /** Replace identifiers with their nearest preceding initializer. */
  const expandAt = (text, pos, depth = 0, seen = new Set()) => {
    if (depth >= 4) return text;
    let out = text;
    for (const name of new Set(text.match(IDENT) || [])) {
      if (seen.has(name)) continue;
      const init = nearestInit(name, pos);
      if (init == null) continue;
      const next = new Set(seen);
      next.add(name);
      out = out.replace(new RegExp(`\\b${name}\\b`, 'g'), `(${expandAt(init, pos, depth + 1, next)})`);
    }
    return out;
  };

  // Local function declarations with their body ranges, so a sink can be
  // attributed to the function it sits in.
  const fns = [];
  for (const m of masked.matchAll(
    /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>(]*>)?\s*\(([^)]*)\)/g,
  )) {
    const params = m[2]
      .split(',')
      .map((p) => (p.trim().match(/^[A-Za-z_$][\w$]*/) || [''])[0])
      .filter(Boolean);
    const open = masked.indexOf('{', m.index + m[0].length);
    if (open < 0) continue;
    let depth = 0;
    let close = masked.length;
    for (let i = open; i < masked.length; i++) {
      if (masked[i] === '{') depth++;
      else if (masked[i] === '}') {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    fns.push({ name: m[1], params, start: open, end: close, taintedParams: new Set() });
  }

  const reachesNetwork = (text) => new RegExp(NET_CALL).test(text);

  // A tainted ARGUMENT at a call site taints the corresponding PARAMETER — the
  // pre-fix defect fetched in `runApps` and the fix writes in
  // `writeBuildContext`, so a purely intra-procedural pass would call both
  // clean and enforce nothing.
  for (const fn of fns) {
    if (!fn.params.length) continue;
    for (const m of masked.matchAll(new RegExp(String.raw`\b${fn.name}\s*\(`, 'g'))) {
      const callPos = m.index;
      if (callPos >= fn.start && callPos <= fn.end) continue; // recursion
      const args = argList(masked, callPos + m[0].length - 1);
      const parts = [];
      let depth = 0;
      let cur = '';
      for (const c of args) {
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') depth--;
        if (c === ',' && depth === 0) {
          parts.push(cur);
          cur = '';
          continue;
        }
        cur += c;
      }
      parts.push(cur);
      for (let i = 0; i < parts.length && i < fn.params.length; i++) {
        if (reachesNetwork(expandAt(parts[i], callPos))) fn.taintedParams.add(fn.params[i]);
      }
    }
  }

  const enclosing = (pos) => {
    let best = null;
    for (const fn of fns) {
      if (pos > fn.start && pos < fn.end && (!best || fn.start > best.start)) best = fn;
    }
    return best;
  };

  /** Is the expression at `pos` derived from a network read? */
  const isTaintedAt = (expr, pos) => {
    const full = expandAt(expr, pos);
    if (reachesNetwork(full)) return { tainted: true, full };
    const fn = enclosing(pos);
    if (fn) {
      for (const p of fn.taintedParams) if (hasWord(full, p)) return { tainted: true, full };
    }
    return { tainted: false, full };
  };

  return { isTaintedAt };
}

// ── sinks ───────────────────────────────────────────────────────────────────
const BARE_SINKS =
  'writeFileSync|appendFileSync|createWriteStream|mkdirSync|cpSync|copyFileSync|renameSync|rmSync|symlinkSync|truncateSync|writeFile|appendFile|outputFile|outputFileSync|ensureDirSync|ensureFileSync';
const QUALIFIED_SINKS =
  String.raw`(?:fs|fsp|fsPromises|promises)\s*\.\s*(?:mkdir|open|cp|rename|rm|unlink|writeFile|appendFile|copyFile|symlink|truncate)`;
const SINK_RE = new RegExp(String.raw`(?:\b(?:${BARE_SINKS})|${QUALIFIED_SINKS})\s*\(`, 'g');

/**
 * Find every filesystem write in `src` whose path is derived from a network
 * read. EXPORTED so `scripts/ci/__tests__/remote-path-containment.test.mjs`
 * can prove the guard is capable of failing without editing the real tree —
 * a guard whose only evidence is "it was green today" is the gate-that-cannot-
 * fail class this repo keeps rediscovering.
 *
 * @returns Array<{ line, sink, arg, contained }> — one entry per tainted sink.
 */
export function findRemotePathWrites(src) {
  const masked = maskCommentsAndStrings(src);
  const { isTaintedAt } = analyze(masked);
  const hits = [];
  const re = new RegExp(SINK_RE.source, 'g');
  for (const m of masked.matchAll(re)) {
    const open = m.index + m[0].length - 1;
    const arg = firstArg(argList(masked, open));
    const { tainted, full } = isTaintedAt(arg, m.index);
    if (!tainted) continue;
    hits.push({
      line: src.slice(0, m.index).split('\n').length,
      sink: m[0].replace(/\s*\($/, '').trim(),
      arg: arg.trim(),
      contained: hasWord(full, HELPER),
    });
  }
  return hits;
}

/** Assert the containment helper still has all three layers. EXPORTED for the self-test. */
export function checkHelperIntegrity(hsrc) {
  const problems = [];
  const hmask = maskCommentsAndStrings(hsrc);
  const decl = hmask.search(new RegExp(String.raw`export\s+function\s+${HELPER}\s*\(`));
  if (decl < 0) return [`${HELPER_FILE} no longer exports ${HELPER}().`];

  const open = hmask.indexOf('{', hmask.indexOf(')', decl));
  let depth = 0;
  let close = -1;
  for (let i = open; i < hmask.length; i++) {
    if (hmask[i] === '{') depth++;
    else if (hmask[i] === '}') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  const body = close > 0 ? hmask.slice(open, close) : hmask.slice(open);
  // The `..` and `/` rejections compare against string VALUES, which masking
  // blanks, so those two layers are tested against the unmasked body.
  const rawBody = close > 0 ? hsrc.slice(open, close) : hsrc.slice(open);

  // Each layer is asserted SEPARATELY. A helper that keeps its name, its
  // signature and two of its three checks is the #2729 "inert fix" shape:
  // it reads as protection and enforces less than it claims.
  if (!/===\s*['"`]\.\.['"`]|includes\s*\(\s*['"`]\.\.['"`]\s*\)/.test(rawBody)) {
    problems.push(`${HELPER_FILE}: ${HELPER}() no longer rejects ".." segments — containment is inert.`);
  }
  if (!/startsWith\s*\(\s*['"`]\//.test(rawBody)) {
    problems.push(`${HELPER_FILE}: ${HELPER}() no longer rejects absolute paths — containment is inert.`);
  }
  if (!/startsWith\s*\(\s*base\s*\+\s*sep\s*\)/.test(body)) {
    problems.push(
      `${HELPER_FILE}: ${HELPER}() no longer performs the post-resolve \`base + sep\` containment ` +
        'comparison — the syntactic checks alone are not the chokepoint.',
    );
  }
  return problems;
}

/** Rival containment helpers, so two implementations cannot drift apart. */
export function findRivalHelpers(src) {
  const masked = maskCommentsAndStrings(src);
  const m = masked.match(/(?:export\s+)?function\s+(containedJoin|safeJoin|securePathJoin|joinContained)\s*\(/);
  return m ? [m[1]] : [];
}

// ── main ────────────────────────────────────────────────────────────────────
function main() {
  const failures = [];
  const staleExempt = new Set(EXEMPT.keys());
  /** `--verbose` prints every network-derived write site and how it is contained. */
  const VERBOSE = process.argv.includes('--verbose');

  let scanned = 0;
  let sinkCount = 0;
  let taintedSinkCount = 0;

  // A2: adoption
  for (const root of ROOTS) {
    for (const abs of walk(path.join(REPO, root))) {
      const key = rel(abs);
      if (key === HELPER_FILE) continue;
      const src = fs.readFileSync(abs, 'utf8');
      const probe = new RegExp(SINK_RE.source, 'g');
      if (!probe.test(src)) continue;
      scanned++;
      sinkCount += (src.match(new RegExp(SINK_RE.source, 'g')) || []).length;

      for (const hit of findRemotePathWrites(src)) {
        taintedSinkCount++;
        if (hit.contained) {
          if (VERBOSE) console.log(`[remote-path-containment] ok   ${key}:${hit.line} ${hit.arg.slice(0, 40)} → ${HELPER}`);
          continue;
        }
        if (EXEMPT.has(key)) {
          staleExempt.delete(key);
          continue;
        }
        failures.push(
          `${key}:${hit.line} — ${hit.sink}() writes to a path built from a network response ` +
            `(\`${hit.arg.slice(0, 60)}\`) without ${HELPER}().`,
        );
      }
    }
  }

  // A1: helper integrity (anti-inert)
  const helperAbs = path.join(REPO, HELPER_FILE);
  if (!fs.existsSync(helperAbs)) {
    failures.push(`${HELPER_FILE} is missing — ${HELPER}() is the containment chokepoint.`);
  } else {
    failures.push(...checkHelperIntegrity(fs.readFileSync(helperAbs, 'utf8')));
  }

  // A3: no rival implementation
  for (const root of ROOTS) {
    for (const abs of walk(path.join(REPO, root))) {
      const key = rel(abs);
      if (key === HELPER_FILE) continue;
      for (const name of findRivalHelpers(fs.readFileSync(abs, 'utf8'))) {
        failures.push(`${key} defines a rival containment helper \`${name}\` — import ${HELPER} from ${HELPER_FILE} instead.`);
      }
    }
  }

  const tag = '[remote-path-containment]';
  console.log(`${tag} scanned ${scanned} file(s) with filesystem writes across ${ROOTS.length} roots`);
  console.log(`${tag} ${sinkCount} write site(s); ${taintedSinkCount} with a network-derived path`);

  for (const key of staleExempt) {
    console.warn(`${tag} WARNING: stale exemption for ${key} — it no longer violates. Remove it.`);
  }

  if (failures.length) {
    console.error(`\n${tag} FAIL — ${failures.length} violation(s):`);
    for (const f of failures) console.error(`   - ${f}`);
    console.error(
      `\n${tag} fix: build the path with ${HELPER}(baseDir, untrustedRelPath) from ${HELPER_FILE}. ` +
        'It refuses "..", absolute paths, Windows drives, NUL and backslashes, and then asserts the ' +
        'resolved path is still inside baseDir. Do not re-implement it.',
    );
    return 1;
  }
  console.log(`${tag} OK — every network-derived filesystem path is contained, and the helper is intact.`);
  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(main());
