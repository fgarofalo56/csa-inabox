/**
 * #3513 — install-time remediation gates must resolve to the gate registry (G2).
 *
 * THE DEFECT: `.claude/rules/ux-baseline.md` G2 requires every unavoidable gate
 * to (a) carry an inline Fix-it, (b) be registered in the central gate registry
 * so Copilot can discover + resolve it, and (c) appear on the Admin gate page.
 * `lib/gates/registry` already delivers all three for any gate that can be NAMED
 * — `HonestGate` renders a real "Fix it" button + `GateFixitDialog`, and
 * `/admin/gates` lists every gate with its owning surfaces.
 *
 * But `RemediationGate` (the envelope every provisioner returns) had only
 * `{reason, remediation, link}`. There was NO field naming the gate, so all 114
 * `status:'remediation'` sites in this tree resolved to NOTHING: no registry
 * row, no Fix-it, invisible to Copilot. Identical defect class to the UC
 * system-tables error codes fixed by `svc-databricks-system-tables` in #2624.
 *
 * These tests pin the LINK, not a spelling: they scan the real provisioner
 * sources, so a new `gateId` typo'd or pointed at a deleted gate fails here.
 *
 * MUTATION PROOF (break the subject, watch the named spec go red, restore):
 *   a) Change any `gateId: 'svc-adx'` to `gateId: 'svc-adxx'` in kql-db.ts
 *      -> RED: "every gateId used in a provisioner resolves to a real registry gate"
 *   b) Delete `gateId: 'svc-eventhubs'` from eventstream.ts
 *      -> RED: "eventstream's Event Hubs gate names svc-eventhubs"
 *   c) Remove the `gateId?: string` field from RemediationGate in types.ts
 *      -> RED (type error at build; and) "RemediationGate exposes a gateId link"
 *   d) Point `svc-purview-uc`'s fixit at a kind with no resolver, or empty its
 *      requiredSettings -> RED: "every linked gate can actually be fixed"
 *   e) Add a `required('LOOM_MADE_UP')` to any predicate a provisioner gates on
 *      -> RED: "every env var a gate predicate demands is writable through its Fix-it"
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getGate, GATES } from '@/lib/gates/registry';
import { trimEdges } from '@/lib/util/trim';

const APP_ROOT = process.cwd();
const PROVISIONER_DIR = join(APP_ROOT, 'lib/install/provisioners');

/** Every `gateId: '<id>'` literal in the production provisioner sources. */
function collectGateIdUsages(): Array<{ file: string; gateId: string }> {
  const out: Array<{ file: string; gateId: string }> = [];
  for (const file of readdirSync(PROVISIONER_DIR)) {
    if (!file.endsWith('.ts')) continue;
    const src = readFileSync(join(PROVISIONER_DIR, file), 'utf8');
    for (const m of src.matchAll(/gateId:\s*'([^']+)'/g)) {
      out.push({ file, gateId: m[1] });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// DERIVING X — the env vars a provisioner's gate predicate ACTUALLY demands.
//
// Everything below reads the PROVISIONER SOURCE and the predicate that source
// calls. There is deliberately NO table of "gate -> env var" here: a guard that
// compares the registry against a restatement of the registry is green even
// when the gate is completely disjoint from the predicate it claims to govern,
// which is the exact shape this file used to have.
//
// The chain, followed mechanically:
//   `gateId: 'x'`  ->  the enclosing `if (...)` / `catch` that returns it
//                  ->  the predicate that condition evaluates (local fn, an
//                      imported *ConfigGate(), a thrown *ConfigGateError, or a
//                      bare `process.env.LOOM_*` read)
//                  ->  the env keys that predicate NAMES as missing.
//
// Honest gates in this tree all name their own missing key — `{missing: 'K'}`,
// `missing.push('K (or J)')`, `throw new XError([...])`, `required('K')`. That
// name is exactly what the Fix-it has to be able to write, so it is the right
// thing to derive rather than the thing to hand-copy.
// ─────────────────────────────────────────────────────────────────────────────

const LOOM_KEY = /LOOM_[A-Z0-9_]+/g;
const CALL_ID = /\b([a-z_$][A-Za-z0-9_$]*)\s*\(/g;
const NOT_A_CALL = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await']);

const srcCache = new Map<string, string | null>();

/** Blank comments out IN PLACE, so every offset and line number still lines up. */
function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));
}

function readSource(path: string): string | null {
  if (!srcCache.has(path)) {
    srcCache.set(path, existsSync(path) ? stripComments(readFileSync(path, 'utf8')) : null);
  }
  return srcCache.get(path)!;
}

function loomKeys(text: string): string[] {
  return [...new Set(text.match(LOOM_KEY) || [])];
}

function resolveModule(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join(APP_ROOT, spec.slice(2));
  else if (spec.startsWith('.')) base = join(dirname(fromFile), spec);
  else return null;
  for (const cand of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

/** Source of the brace block that opens at/after `fromIdx`. */
function blockAt(src: string, fromIdx: number): string {
  const open = src.indexOf('{', fromIdx);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

/**
 * Body of the function whose signature starts at `sigStart`.
 *
 * NOT simply "the next `{`": `function adfConfigGate(): { missing: string } |
 * null {` opens a RETURN-TYPE literal first, and taking that as the body is how
 * this derivation silently saw nothing at all for eight of the sixteen gate
 * sites. Skip the parameter list, then skip any `{…}` that a `:` `|` `&` `<`
 * `,` introduces (a type), and take the first brace that is genuinely code.
 */
function functionBody(src: string, sigStart: number): string {
  let i = src.indexOf('(', sigStart);
  if (i < 0) return '';
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) {
      i++;
      break;
    }
  }
  for (; i < src.length; i++) {
    if (src[i] !== '{') continue;
    const prev = src.slice(0, i).trimEnd().slice(-1);
    if (![':', '|', '&', '<', ','].includes(prev)) return blockAt(src, i);
    i = skipBalanced(src, i) - 1;
  }
  return '';
}

/** Index just past the `{…}` group that opens at `open`. */
function skipBalanced(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return i + 1;
  }
  return src.length;
}

type Def = { body: string; kind: 'fn' | 'var' | 'class'; src: string; path: string };

function findDef(src: string, path: string, name: string): Def | null {
  const esc = name.replace(/[$]/g, '\\$&');
  const fn = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${esc}\\s*[(<]`).exec(src);
  if (fn) return { body: functionBody(src, fn.index), kind: 'fn', src, path };
  const cls = new RegExp(`(?:export\\s+)?class\\s+${esc}\\b`).exec(src);
  if (cls) return { body: blockAt(src, cls.index), kind: 'class', src, path };
  const v = new RegExp(`(?:export\\s+)?(?:const|let|var)\\s+${esc}\\s*[:=]`).exec(src);
  if (v) {
    const rest = src.slice(v.index);
    const nl = rest.indexOf('\n');
    const head = rest.slice(0, nl < 0 ? rest.length : nl);
    return { body: /[{]|=>/.test(head) ? blockAt(src, v.index) : head, kind: 'var', src, path };
  }
  return null;
}

/** Resolve a symbol to its definition, following a named import if needed. */
function lookup(name: string, src: string, path: string): Def | null {
  const local = findDef(src, path, name);
  if (local) return local;
  for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const names = m[1].split(',').map((n) => n.trim().split(/\s+as\s+/).pop()!.trim());
    if (!names.includes(name)) continue;
    const target = resolveModule(m[2], path);
    if (!target) return null;
    const tsrc = readSource(target);
    return tsrc === null ? null : findDef(tsrc, target, name);
  }
  return null;
}

/**
 * The env keys a predicate body DECLARES as missing, grouped by gate-exit.
 *
 * One group == one alternative set: `'LOOM_A (or LOOM_B)'` and
 * `missing: [A, B]` both mean "setting any ONE of these satisfies me", so the
 * Fix-it only has to cover one member. Separate exits (`required(A)` then
 * `required(B)`, or a `for (const k of [A,B,C])` that returns on the FIRST
 * unset key) are separate groups, because each is independently fatal.
 */
function demandGroups(body: string, src: string, path: string, depth: number): string[][] {
  if (depth < 0) return [];
  const groups: string[][] = [];

  const loops = [...body.matchAll(/for\s*\(\s*const\s+(\w+)\s+of\s*\[([^\]]*)\]/g)].map((m) => ({
    name: m[1],
    keys: loomKeys(m[2]),
  }));

  const exits: string[] = [];
  for (const m of body.matchAll(/missing:\s*(\[[^\]]*\]|[^,}\n]+)/g)) exits.push(m[1]);
  for (const m of body.matchAll(/missing\.push\(([^;]*?)\)\s*;/g)) exits.push(m[1]);

  for (const raw of exits) {
    const keys = loomKeys(raw);
    if (keys.length) {
      groups.push(keys);
      continue;
    }
    const id = trimEdges(raw.trim(), ';,)');
    const loop = loops.find((l) => l.name === id);
    if (loop) {
      for (const k of loop.keys) groups.push([k]);
      continue;
    }
    groups.push(...followValue(id, body, src, path, depth - 1));
  }

  // `required('LOOM_X')` — a throw-if-unset accessor names its own key, and
  // each call is independently fatal.
  for (const m of body.matchAll(/\brequired\(\s*['"](LOOM_[A-Z0-9_]+)['"]/g)) groups.push([m[1]]);

  // A predicate that declares no `missing` still gates on the keys it READ
  // (`const e = process.env.A; if (e) return …; const f = process.env.B; …`).
  // It only fails when EVERY one of them is absent, so they are one
  // alternative group — the lenient reading, which never invents a violation.
  if (!groups.length) {
    const read = loomKeys(body);
    if (read.length) groups.push(read);
  }

  return groups;
}

/** Follow `x` / `x.missing` back to the assignment that produced it. */
function followValue(expr: string, body: string, src: string, path: string, depth: number): string[][] {
  if (depth < 0) return [];
  const base = expr.split('.')[0].trim();
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(base)) return [];
  const re = new RegExp(`(?:const|let|var)\\s+${base}\\s*(?::[^=\\n]+)?=\\s*([^;\\n]+)`, 'g');
  const hits = [...body.matchAll(re)];
  if (!hits.length) return [];
  const rhs = hits[hits.length - 1][1];
  const out: string[][] = [];
  const direct = loomKeys(rhs);
  if (direct.length) out.push(direct);
  out.push(...callGroups(rhs, src, path, depth));
  return out;
}

/** Every function called in `expr`, resolved, and what IT declares missing. */
function callGroups(expr: string, src: string, path: string, depth: number): string[][] {
  if (depth < 0) return [];
  const out: string[][] = [];
  for (const m of expr.matchAll(CALL_ID)) {
    if (NOT_A_CALL.has(m[1])) continue;
    const def = lookup(m[1], src, path);
    if (!def || def.kind === 'class') continue;
    out.push(...demandGroups(def.body, def.src, def.path, depth - 1));
  }
  return out;
}

/** `throw new <Error>(…)` sites reachable from the code the `try` block ran. */
function classThrowGroups(cls: string, tryBody: string, src: string, path: string, depth: number): string[][] {
  if (depth < 0) return [];
  const out: string[][] = [];
  for (const m of tryBody.matchAll(CALL_ID)) {
    if (NOT_A_CALL.has(m[1])) continue;
    const def = lookup(m[1], src, path);
    if (!def || def.kind === 'class') continue;
    const throws = [...def.body.matchAll(new RegExp(`throw\\s+new\\s+${cls}\\(([\\s\\S]*?)\\)\\s*;`, 'g'))];
    for (const t of throws) {
      const keys = loomKeys(t[1]);
      if (keys.length) out.push(keys);
      else out.push(...followValue(t[1].trim(), def.body, def.src, def.path, depth - 1));
    }
    if (!throws.length) out.push(...classThrowGroups(cls, def.body, def.src, def.path, depth - 1));
  }
  return out;
}

/** The `if (…)` / `catch (…)` heads enclosing an index, innermost first. */
function guardChain(src: string, idx: number): Array<{ kind: 'if' | 'catch'; text: string; brace: number }> {
  const chain: Array<{ kind: 'if' | 'catch'; text: string; brace: number }> = [];
  let depth = 0;
  for (let i = idx; i >= 0; i--) {
    const c = src[i];
    if (c === '}') depth++;
    else if (c === '{') {
      if (depth > 0) {
        depth--;
        continue;
      }
      const head = headBefore(src, i);
      if (/\bif\s*\(/.test(head)) chain.push({ kind: 'if', text: head, brace: i });
      else if (/\bcatch\s*\(/.test(head)) chain.push({ kind: 'catch', text: head, brace: i });
    }
  }
  return chain;
}

/** The condition text before a block-opening brace, joined across lines. */
function headBefore(src: string, brace: number): string {
  let start = src.lastIndexOf('\n', brace) + 1;
  let text = src.slice(start, brace);
  for (let i = 0; i < 20 && start > 0; i++) {
    const opens = (text.match(/\(/g) || []).length;
    const closes = (text.match(/\)/g) || []).length;
    if (closes <= opens) break;
    start = src.lastIndexOf('\n', start - 2) + 1;
    text = src.slice(start, brace);
  }
  return text;
}

/** Body of the `try` block whose `catch` opens at `catchBrace`. */
function tryBodyBefore(src: string, catchBrace: number): string {
  const close = src.lastIndexOf('}', catchBrace);
  if (close < 0) return '';
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (src[i] === '}') depth++;
    else if (src[i] === '{' && --depth === 0) return src.slice(i, close + 1);
  }
  return '';
}

type Site = { file: string; line: number; gateId: string; guard: string; groups: string[][] };

/** Derive, for every `gateId:` site, the env-var groups its predicate demands. */
function deriveSites(): Site[] {
  const sites: Site[] = [];
  for (const file of readdirSync(PROVISIONER_DIR)) {
    if (!file.endsWith('.ts')) continue;
    const path = join(PROVISIONER_DIR, file);
    const src = readSource(path)!;
    for (const m of src.matchAll(/gateId:\s*'([^']+)'/g)) {
      const line = src.slice(0, m.index).split('\n').length;
      const chain = guardChain(src, m.index!);
      if (!chain.length) {
        sites.push({ file, line, gateId: m[1], guard: '(no enclosing if/catch)', groups: [] });
        continue;
      }
      const guard = chain[0];
      const groups: string[][] = [];

      if (guard.kind === 'catch') {
        // The `try` block THREW the gate: its callees are the predicate.
        const tryBody = tryBodyBefore(src, guard.brace);
        groups.push(...callGroups(tryBody, src, path, 3));
      } else {
        const cond = guard.text.slice(guard.text.search(/\bif\s*\(/));
        const direct = loomKeys(cond);
        if (direct.length) groups.push(direct);

        const inst = /instanceof\s+([A-Za-z0-9_$]+)/.exec(cond);
        if (inst) {
          // `catch (e) { if (e instanceof XConfigGateError) …` — the predicate
          // is whatever the enclosing `try` ran that threw X.
          const c = chain.find((g) => g.kind === 'catch');
          const tryBody = c ? tryBodyBefore(src, c.brace) : '';
          groups.push(...classThrowGroups(inst[1], tryBody, src, path, 3));
        } else {
          groups.push(...callGroups(cond, src, path, 3));
          // Bare identifiers in the condition (`if (gate)`, `if (!adlsAccount)`)
          // resolve through the nearest preceding assignment.
          for (const id of cond.matchAll(/(?<![.\w'"])([a-z_$][A-Za-z0-9_$]*)\b(?!\s*\()/g)) {
            if (['if', 'in', 'instanceof', 'typeof', 'length', 'e', 'const', 'let'].includes(id[1])) continue;
            groups.push(...followValue(id[1], src.slice(0, guard.brace), src, path, 3));
          }
        }
      }

      // A predicate that names nothing still gates on the keys it READ: the
      // gate fires only when every one of them is absent, so they are one
      // alternative group.
      const seen = new Set<string>();
      const merged = groups.filter((g) => {
        if (!g.length) return false;
        const key = [...g].sort().join('|');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      sites.push({ file, line, gateId: m[1], guard: guard.text.trim().slice(0, 120), groups: merged });
    }
  }
  return sites;
}

/** Y — every env var `/api/admin/gates/[id]/resolve` will accept for a gate. */
function writableSettings(gateId: string): Set<string> {
  const gate = getGate(gateId);
  const out = new Set<string>();
  for (const s of gate?.requiredSettings || []) {
    out.add(s.envVar);
    for (const a of s.aliasOf || []) out.add(a);
  }
  return out;
}

describe('#3513 — provisioner remediation gates link to the registry', () => {
  it('RemediationGate exposes a gateId link to the registry', () => {
    const types = readFileSync(join(PROVISIONER_DIR, 'types.ts'), 'utf8');
    // The field must exist on the interface every provisioner returns —
    // without it no install gate can ever reach HonestGate's Fix-it.
    expect(types).toMatch(/export interface RemediationGate\b/);
    expect(types).toMatch(/\bgateId\?:\s*string/);
  });

  it('at least one provisioner actually uses the link (the field is not dead)', () => {
    // Guards the vacuous-pass shape: a gateId field nobody populates would make
    // every "resolves to a real gate" assertion below trivially true.
    expect(collectGateIdUsages().length).toBeGreaterThanOrEqual(15);
  });

  it('every gateId used in a provisioner resolves to a real registry gate', () => {
    const unresolved = collectGateIdUsages()
      .filter((u) => !getGate(u.gateId))
      .map((u) => `${u.file} -> '${u.gateId}'`);
    expect(unresolved, `unknown gate ids: ${unresolved.join(', ')}`).toEqual([]);
  });

  it('every linked gate can actually be fixed (a Fix-it that cannot fix is worse than none)', () => {
    for (const { file, gateId } of collectGateIdUsages()) {
      const gate = getGate(gateId)!;
      expect(gate.fixit, `${file}: gate ${gateId} has no fixit`).toBeTruthy();
      expect(gate.fixit.kind, `${file}: gate ${gateId} has no fixit kind`).toBeTruthy();
      // A gate whose Fix-it is an env/resource picker MUST name the settings the
      // dialog writes, or the button opens on an empty form.
      if (gate.fixit.kind === 'env-picker' || gate.fixit.kind === 'resource-picker') {
        expect(
          gate.requiredSettings.length,
          `${file}: gate ${gateId} has a ${gate.fixit.kind} Fix-it but no settings to set`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('every linked gate is discoverable on /admin/gates as firing during app install', () => {
    // (c) of G2: the Admin gate page renders `g.surfaces` and searches them, so
    // a gate that fires at install must SAY so or the operator cannot find it.
    const linked = [...new Set(collectGateIdUsages().map((u) => u.gateId))];
    const missingInstallSurface = linked.filter((id) => {
      const gate = getGate(id)!;
      return !gate.surfaces.some((sf) => sf.path.includes('/api/apps/') && sf.path.includes('install'));
    });
    expect(
      missingInstallSurface,
      `gates linked from a provisioner but not listing the install surface: ${missingInstallSurface.join(', ')}`,
    ).toEqual([]);
  });

  // ── the specific links, so a silent DELETION of one is caught ──────────────
  const EXPECTED: Array<[file: string, gateId: string, why: string]> = [
    ['ai-search.ts', 'svc-aisearch', 'LOOM_AI_SEARCH_SERVICE'],
    ['adf-pipeline.ts', 'svc-adf', 'LOOM_ADF_FACTORY / LOOM_ADF_RG'],
    ['databricks-job.ts', 'svc-databricks', 'LOOM_DATABRICKS_HOSTNAME'],
    ['eventstream.ts', 'svc-eventhubs', 'LOOM_EVENTHUB_NAMESPACE'],
    ['kql-db.ts', 'svc-adx', 'LOOM_KUSTO_CLUSTER_URI'],
    ['kql-dashboard.ts', 'svc-adx', 'LOOM_KUSTO_CLUSTER_URI'],
    ['workspace-monitor.ts', 'svc-adx', 'LOOM_KUSTO_CLUSTER_URI'],
    ['logic-app.ts', 'svc-logic-apps', 'Logic Apps ARM coordinates'],
    ['mirrored-database.ts', 'svc-adf', 'LOOM_ADF_FACTORY / LOOM_ADF_RG'],
    ['mirrored-database.ts', 'svc-adls', 'LOOM_ADLS_ACCOUNT'],
    ['ml-model.ts', 'svc-databricks', 'LOOM_DATABRICKS_HOSTNAME'],
    ['synapse-pipeline.ts', 'svc-synapse', 'LOOM_SYNAPSE_WORKSPACE'],
    ['warehouse.ts', 'svc-synapse', 'LOOM_SYNAPSE_WORKSPACE + dedicated pool'],
    ['activator.ts', 'svc-monitor-alerts', 'LOOM_LOG_ANALYTICS_RESOURCE_ID'],
    ['data-product.ts', 'svc-purview-uc', 'LOOM_PURVIEW_UC_ENDPOINT'],
  ];

  it.each(EXPECTED)('%s links its config gate to %s (%s)', (file, gateId) => {
    const usages = collectGateIdUsages().filter((u) => u.file === file);
    expect(
      usages.map((u) => u.gateId),
      `${file} no longer names ${gateId}`,
    ).toContain(gateId);
  });

  it('the derivation actually reaches each gate predicate (it must watch its subject)', () => {
    // This spec is only worth anything if X comes from the PROVISIONER, not
    // from a table in this file. A site whose predicate we cannot follow is
    // reported as unwatched rather than silently passing.
    const sites = deriveSites();
    expect(sites.length, 'no gateId sites found — the scanner is broken').toBeGreaterThanOrEqual(15);
    const blind = sites
      .filter((s) => s.groups.length === 0)
      .map((s) => `${s.file}:${s.line} (${s.gateId}) guard: ${s.guard}`);
    expect(blind, `gate sites whose predicate could not be resolved:\n  ${blind.join('\n  ')}`).toEqual([]);
  });

  it('every env var a gate predicate demands is writable through its Fix-it', () => {
    // R7 — assert the mapping we ESTABLISHED, not one we restated. X is read
    // out of the provisioner's own predicate (see deriveSites); Y is the hard
    // whitelist `/api/admin/gates/[id]/resolve` enforces — it 400s any key
    // outside `requiredSettings ∪ aliasOf`. So a key the predicate demands but
    // the gate does not govern is literally UNWRITABLE through the Fix-it: the
    // button provably cannot unblock the install it is offered for.
    const violations: string[] = [];
    for (const site of deriveSites()) {
      const writable = writableSettings(site.gateId);
      for (const group of site.groups) {
        if (group.some((k) => writable.has(k))) continue;
        violations.push(
          `${site.file}:${site.line} gate '${site.gateId}' — predicate demands ` +
            `${group.join(' or ')}, but its Fix-it can only write ` +
            `[${[...writable].join(', ') || '(nothing)'}]`,
        );
      }
    }
    expect(violations, `Fix-it cannot set what the predicate demands:\n  ${violations.join('\n  ')}`).toEqual([]);
  });

  it('gate ids are still unique in the registry (no duplicate claim)', () => {
    const ids = GATES.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
