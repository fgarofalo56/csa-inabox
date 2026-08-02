#!/usr/bin/env node
/**
 * GUARDRAIL: no `az afd` / `az cdn` invocation in CI or automation may address an
 * endpoint by a name it did not DISCOVER. `--endpoint-name` must carry a shell
 * variable that traces back to an `az afd|az cdn ... list|show` (or to the
 * purge-target resolver) — never a literal, never a `${{ }}` expression.
 *
 * WHY THIS EXISTS (#2828). `loom-roll-and-validate.yml` purged Front Door after
 * every roll so the live-URL validation would not read a cached page. It had
 * never purged anything:
 *
 *     FD_PROFILE=$(az afd profile list -g "$RG" --query "[0].name" -o tsv)   # discovered
 *     az afd endpoint purge --profile-name "$FD_PROFILE" -g "$RG" \
 *       --endpoint-name ${{ env.APP_NAME }} --content-paths '/*' --no-wait \
 *       || true
 *
 * `env.APP_NAME` is `loom-console`; the deployed endpoint is
 * `loom-console-<deployment-suffix>`. Every call returned ResourceNotFound and
 * `|| true` threw the verdict away, inside a step that reported success.
 *
 * A `${{ }}` expression is worth calling out because it LOOKS dynamic. It is
 * substituted at workflow-parse time from a static `env:` block, so it is a
 * compile-time constant with interpolation syntax — which is exactly how this
 * one read as "already parameterised" to every reviewer who passed over it.
 *
 * WHAT THIS DOES NOT CLAIM. Two limits, stated rather than papered over:
 *
 *   1. Discovery is necessary, not sufficient. Replacing the literal with
 *      `--query "[0].name"` would satisfy this guard while keeping the same
 *      assumption one line over. Choosing WHICH discovered endpoint is the right
 *      one is scripts/ci/fd-resolve-purge-target.mjs's job, and its tests pin the
 *      anti-`[0]` behaviour.
 *   2. The trace is textual, not dataflow. A variable assigned in more than one
 *      place passes if ANY assignment reaches a discovery call, so a constant
 *      assignment that actually wins at runtime (because the discovering branch
 *      did not execute) would not be caught. Found while mutation-testing this
 *      guard, kept deliberately: the alternative is a shell interpreter, and the
 *      shape that caused #2828 — a name that appears nowhere in any `az` output —
 *      is caught either way.
 *
 * So this guard closes the narrower door: a name that never came from Azure at all.
 *
 * SCOPE: .github/workflows, .github/scripts, scripts/ — code that runs. Prose
 * under docs/ and examples/ is excluded; `az cdn ... --endpoint-name
 * data-contoso` in a Learn reference page is documentation, not an invocation,
 * and failing it would push toward less-documented code (the #2613 lesson).
 *
 * NOTE ON `az network private-endpoint`: also takes `--endpoint-name`, also
 * appears in this repo, and is a different resource type with none of this
 * failure mode. Only `az afd` / `az cdn` command lines are considered.
 *
 * ESCAPE HATCH: a genuinely operator-supplied endpoint name can carry
 *   # afd-endpoint-discovery-ok: <reason>
 * on the invocation line or the line above it.
 *
 * Usage: node scripts/ci/check-afd-endpoint-discovery.mjs
 * Tests: node --test scripts/ci/__tests__/afd-endpoint-discovery.test.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const SCAN_DIRS = ['.github/workflows', '.github/scripts', 'scripts'];
const SCAN_EXT = /\.(ya?ml|sh|bash|mjs|js|ts|ps1)$/;
/**
 * `__tests__` is excluded because THIS guard's own fixtures are, by design, a
 * catalogue of the exact shapes it must reject — scanning them would make the
 * guard permanently red at the one thing it is right about. Nothing under
 * `__tests__` runs `az` against a real estate, so the exclusion costs no
 * coverage. It is deliberately this narrow: no per-file allowlist, no
 * suppression baseline, so the only way to go green in shipping code is to
 * discover the name.
 */
const SCAN_SKIP_DIR = /(^|\/)__tests__$/;

const CDN_CMD = /\baz\s+(?:afd|cdn)\b/;
const ENDPOINT_ARG = /--endpoint-name(?:=|\s+)(\S+)/;
const ANNOTATION = /::(?:warning|notice|error|debug)::/;
const ALLOW_MARKER = /#\s*afd-endpoint-discovery-ok:/;
/** An `az ... list|show` — the only shapes that return a name Azure actually has. */
const DISCOVERY_RHS = /\baz\s+(?:afd|cdn)\b[^\n]*\b(?:list|show)\b/;
/** The purge-target resolver counts as discovery: it consumes `az afd ... list` output. */
const RESOLVER_RHS = /fd-resolve-purge-target/;

/**
 * Join backslash-continued lines so a multi-line `az` invocation is analysed as
 * one command. Returns `[{ text, line }]` where `line` is the 1-based line the
 * command STARTS on — the line a human needs to open.
 */
export function logicalLines(src) {
  const raw = String(src ?? '').split('\n');
  const out = [];
  let buf = null;
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i].replace(/\r$/, '');
    if (buf === null) buf = { text: line, line: i + 1 };
    else buf.text += ` ${line.trim()}`;
    if (/\\$/.test(buf.text.trimEnd())) {
      buf.text = buf.text.trimEnd().replace(/\\$/, '');
      continue;
    }
    out.push(buf);
    buf = null;
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * Is this logical line an actual command, rather than a comment or an emitted string?
 *
 * The rejections are the same idea in four dialects: text that NAMES a command is
 * not the command. `# …` / `// …` / ` * …` (JSDoc continuation) are comments —
 * counting them would push toward deleting the documentation that explains the
 * bug, which is the #2613 lesson. `echo` and `console.*` are output; `::warning::`
 * is a workflow annotation.
 */
export function isInvocation(text) {
  const t = text.trimStart();
  if (t.startsWith('#')) return false; // YAML / shell / PowerShell comment
  if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) return false; // JS comment
  if (ANNOTATION.test(text)) return false; // ::warning:: etc — output, not execution
  if (/\becho\b/.test(text)) return false; // echoed, not run
  if (/\bconsole\.(?:log|error|warn|info)\b/.test(text)) return false; // printed, not run
  return CDN_CMD.test(text);
}

/**
 * Classify the token passed to `--endpoint-name`.
 * @returns {'variable'|'expression'|'literal'} plus the variable name when known.
 */
export function classifyEndpointArg(token) {
  const bare = String(token ?? '').replace(/^["']|["']$/g, '');
  if (/\$\{\{/.test(bare)) return { kind: 'expression', name: null };
  const m = bare.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
  if (m) return { kind: 'variable', name: m[1] };
  if (/\$/.test(bare)) return { kind: 'variable', name: null }; // interpolated, unnameable
  return { kind: 'literal', name: null };
}

/**
 * Does `name` trace back to an `az afd|az cdn ... list|show` (or the resolver)
 * anywhere in `src`? Follows `X=...` and `for X in ...` assignments up to
 * `maxHops` levels, so the common
 *     EPS="$(az afd endpoint list ...)" ; for ep in $EPS ; ... --endpoint-name "$ep"
 * shape resolves. Unnameable (`name === null`) is treated as NOT derived: an
 * interpolated argument cannot be traced, and "cannot trace" is not "is fine".
 */
export function isDiscoveryDerived(src, name, maxHops = 5) {
  if (!name) return false;
  const text = String(src ?? '');
  const seen = new Set();
  let frontier = [name];

  for (let hop = 0; hop < maxHops && frontier.length; hop++) {
    const next = [];
    for (const v of frontier) {
      if (seen.has(v)) continue;
      seen.add(v);
      const assigns = [
        ...text.matchAll(new RegExp(`^\\s*(?:export\\s+)?${v}=([^\\n]*)`, 'gm')),
        ...text.matchAll(new RegExp(`\\bfor\\s+${v}\\s+in\\s+([^\\n;]*)`, 'g')),
      ].map((m) => m[1]);
      for (const rhs of assigns) {
        if (DISCOVERY_RHS.test(rhs) || RESOLVER_RHS.test(rhs)) return true;
        for (const ref of rhs.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)) next.push(ref[1]);
      }
    }
    frontier = next;
  }
  return false;
}

/** Every `az afd|az cdn ... --endpoint-name` invocation in `src`, classified. */
export function scanSource(src) {
  const findings = [];
  const lines = String(src ?? '').split('\n');
  for (const { text, line } of logicalLines(src)) {
    if (!isInvocation(text)) continue;
    const m = text.match(ENDPOINT_ARG);
    if (!m) continue;
    const prev = line >= 2 ? lines[line - 2] : '';
    const allowed = ALLOW_MARKER.test(text) || ALLOW_MARKER.test(prev);
    const { kind, name } = classifyEndpointArg(m[1]);
    const derived = kind === 'variable' && isDiscoveryDerived(src, name);
    findings.push({ line, token: m[1], kind, name, derived, allowed });
  }
  return findings;
}

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  if (SCAN_SKIP_DIR.test(dir.split(sep).join('/'))) return acc;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (SCAN_EXT.test(entry)) acc.push(p);
  }
  return acc;
}

function main() {
  const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)));
  const rows = [];
  const failures = [];

  for (const abs of files) {
    const rel = relative(ROOT, abs).split(sep).join('/');
    let src;
    try {
      src = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (!CDN_CMD.test(src)) continue;
    for (const f of scanSource(src)) {
      const ok = f.allowed || (f.kind === 'variable' && f.derived);
      const status = f.allowed
        ? 'allowlisted'
        : f.kind === 'expression'
          ? 'EXPRESSION'
          : f.kind === 'literal'
            ? 'LITERAL'
            : f.derived
              ? 'ok'
              : 'UNTRACED';
      rows.push({ rel, line: f.line, token: f.token, status });
      if (!ok) failures.push({ rel, line: f.line, token: f.token, status, name: f.name });
    }
  }

  if (rows.length === 0) {
    console.error('[afd-endpoint-discovery] FAIL — found no `az afd|az cdn ... --endpoint-name` invocation to check.');
    console.error(`  Scanned: ${SCAN_DIRS.join(', ')}. Either the calls moved out of these directories, or this`);
    console.error('  guard has gone blind. A gate that silently finds nothing to check is the failure mode it');
    console.error('  exists to prevent (#2828 was hidden by exactly that shape). If AFD/CDN automation was');
    console.error('  intentionally removed, delete this guard and its loom-guardrails.yml lane in the same PR.');
    process.exit(1);
  }

  console.log(`[afd-endpoint-discovery] ${rows.length} az afd|az cdn --endpoint-name invocation(s):`);
  for (const r of rows) {
    console.log(`  ${r.status.padEnd(12)} ${`${r.rel}:${r.line}`.padEnd(58)} ${r.token}`);
  }

  if (failures.length === 0) {
    console.log('[afd-endpoint-discovery] OK — every endpoint name comes from a discovery call.');
    process.exit(0);
  }

  console.error(`\n[afd-endpoint-discovery] FAIL — ${failures.length} invocation(s) address a CDN endpoint by a name that was never discovered.\n`);
  for (const f of failures) {
    console.error(`  ${f.rel}:${f.line}  --endpoint-name ${f.token}`);
    if (f.status === 'EXPRESSION') {
      console.error('    a ${{ }} expression is substituted at workflow-parse time — a constant wearing');
      console.error('    interpolation syntax. That is precisely the #2828 shape.');
    } else if (f.status === 'LITERAL') {
      console.error('    hardcoded name. Front Door endpoints carry a per-deployment suffix; this will');
      console.error('    ResourceNotFound in every estate but the one it was typed for.');
    } else {
      console.error(`    "$${f.name ?? '?'}" does not trace back to an \`az afd|az cdn ... list|show\`;`);
      console.error('    a variable holding a constant is still a constant.');
    }
  }
  console.error('\n  Fix: resolve the endpoint from Azure, and pick the one that BACKS THE URL you are acting on');
  console.error('  (hostName, or a custom domain routed to it) — not `--query "[0].name"`, which is the same');
  console.error('  assumption one line over. scripts/ci/fd-resolve-purge-target.mjs does this and is unit-tested;');
  console.error('  the "Purge Front Door" step in .github/workflows/loom-roll-and-validate.yml is the template.');
  console.error('  Genuinely operator-supplied names: add `# afd-endpoint-discovery-ok: <reason>`.\n');
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
