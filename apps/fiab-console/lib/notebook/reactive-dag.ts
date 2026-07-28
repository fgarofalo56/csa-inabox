/**
 * N19a — reactive notebook dependency DAG (pure, dependency-free).
 *
 * Static analysis of a Loom notebook's CODE cells that answers the two
 * questions a reactive runtime (Marimo / Observable semantics) needs:
 *
 *   1. Which cells does cell X depend on?  (its `uses` resolved to definers)
 *   2. When X changes, which cells go stale? (the transitive downstream set,
 *      returned in a runnable topological order)
 *
 * Model (matches Marimo's, not Jupyter's):
 *   • A cell DEFINES the module-level names it binds — assignments, augmented
 *     assignments, tuple/starred unpacking, `for` targets, `with … as`,
 *     `def` / `class`, imports, and walrus (`:=`) bindings.
 *   • A cell USES every free identifier it references that it does not itself
 *     define.
 *   • An edge definer → user exists for EVERY definer of a used name,
 *     regardless of notebook order — a reactive notebook executes in
 *     dependency order, not top-to-bottom. That makes cycles real, so they are
 *     detected (Kahn residue) and surfaced instead of being run.
 *   • Two cells defining the SAME name is ambiguous (Marimo rejects it); we
 *     keep both edges and report the collision so the UI can warn.
 *
 * Scope limits (documented, never silently wrong):
 *   • Only INDENT-0 statements bind module-level names, so function locals and
 *     loop bodies do not leak into the graph.
 *   • Only Python-family cells (`python` / `pyspark`) are analyzed. SQL / Scala
 *     / R / T-SQL / C# cells are opaque nodes: no defs, no uses, so they are
 *     never falsely invalidated and never falsely trusted.
 *   • Attribute/subscript mutation (`df.cache()`, `d['k'] = 1`) counts the base
 *     name as a USE, not a def — the same conservative call Marimo makes.
 *
 * No I/O, no React, no network: importable from both the editor and tests.
 */

import type { NotebookCell, NotebookCellLang } from '@/lib/types/notebook-cell';

/** Languages whose source this module can statically analyze. */
const ANALYZABLE_LANGS: readonly NotebookCellLang[] = ['python', 'pyspark'];

export function isAnalyzableLang(lang: NotebookCellLang | undefined): boolean {
  return ANALYZABLE_LANGS.includes((lang || 'pyspark') as NotebookCellLang);
}

/** Python keywords + soft keywords — never a variable reference. */
const PY_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break',
  'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally',
  'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
  'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
  'match', 'case', 'self', 'cls',
]);

/**
 * Builtins + notebook-runtime globals that are always present, so referencing
 * them is not a dependency on another cell. `spark` / `sc` / `dbutils` /
 * `display` are injected by the Loom Spark + Databricks session preambles;
 * `loom_lakehouses` by the auto-mount preamble (lakehouse-mount-preamble.ts).
 */
const AMBIENT_NAMES = new Set([
  'abs', 'all', 'any', 'bool', 'bytes', 'callable', 'chr', 'dict', 'dir',
  'divmod', 'enumerate', 'eval', 'exec', 'filter', 'float', 'format',
  'frozenset', 'getattr', 'hasattr', 'hash', 'help', 'hex', 'id', 'input',
  'int', 'isinstance', 'issubclass', 'iter', 'len', 'list', 'map', 'max',
  'min', 'next', 'object', 'oct', 'open', 'ord', 'pow', 'print', 'range',
  'repr', 'reversed', 'round', 'set', 'setattr', 'slice', 'sorted', 'str',
  'sum', 'super', 'tuple', 'type', 'vars', 'zip', 'Exception', 'ValueError',
  'TypeError', 'KeyError', 'IndexError', 'RuntimeError', 'NotImplementedError',
  'StopIteration', 'AttributeError', 'ImportError', 'OSError', 'ZeroDivisionError',
  // Loom / Spark session globals injected by the run preambles.
  'spark', 'sc', 'sqlContext', 'dbutils', 'display', 'displayHTML',
  'loom_lakehouses', 'loom_semantic_link', 'mssparkutils', 'notebookutils',
]);

/** Per-cell static analysis result. */
export interface CellAnalysis {
  cellId: string;
  /** Module-level names this cell binds. */
  defs: string[];
  /** Free names this cell references and does not itself bind. */
  uses: string[];
  /** False when the cell's language is not statically analyzable (opaque node). */
  analyzed: boolean;
}

/** One dependency edge: `from` defines name(s) `via` that `to` references. */
export interface DagEdge {
  from: string;
  to: string;
  via: string[];
}

/** A name bound by more than one cell — ambiguous in reactive semantics. */
export interface DefinitionCollision {
  name: string;
  cellIds: string[];
}

/** The full dependency graph over a notebook's code cells. */
export interface NotebookDag {
  /** Code-cell ids in notebook (document) order — the tie-break for topo sort. */
  order: string[];
  analyses: Record<string, CellAnalysis>;
  edges: DagEdge[];
  /** cellId → cells that depend on it (its direct downstream). */
  dependents: Record<string, string[]>;
  /** cellId → cells it depends on (its direct upstream). */
  dependencies: Record<string, string[]>;
  /** Strongly-connected residue after Kahn — every cell caught in a cycle. */
  cycles: string[][];
  collisions: DefinitionCollision[];
}

// ---------------------------------------------------------------------------
// Source scrubbing
// ---------------------------------------------------------------------------

/**
 * Blank out comments and string literals so identifiers inside them are never
 * mistaken for references. Replaces their CONTENT with spaces (keeping line
 * structure + offsets intact) rather than deleting, so indentation-based
 * top-level detection stays correct.
 */
export function stripCommentsAndStrings(source: string): string {
  const out: string[] = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    // Comment → blank to end of line.
    if (ch === '#') {
      while (i < n && source[i] !== '\n') { out.push(' '); i++; }
      continue;
    }
    if (ch === '"' || ch === "'") {
      const triple = source.slice(i, i + 3);
      const quote = triple === '"""' || triple === "'''" ? triple : ch;
      out.push(' '.repeat(quote.length));
      i += quote.length;
      while (i < n) {
        if (source[i] === '\\') {
          out.push(source[i] === '\n' ? '\n' : ' ');
          out.push(i + 1 < n && source[i + 1] === '\n' ? '\n' : ' ');
          i += 2;
          continue;
        }
        if (source.startsWith(quote, i)) { out.push(' '.repeat(quote.length)); i += quote.length; break; }
        out.push(source[i] === '\n' ? '\n' : ' ');
        i++;
      }
      continue;
    }
    out.push(ch);
    i++;
  }
  return out.join('');
}

/** Split `a, (b, c), *rest` into the bare names it binds. */
function namesInTarget(target: string): string[] {
  const names: string[] = [];
  for (const raw of target.split(',')) {
    const t0 = raw.trim();
    // Attribute / subscript targets bind nothing new — `d['k'] = 1` mutates
    // `d`, `obj.attr = 2` mutates `obj`; neither creates a module binding.
    if (/[.[]/.test(t0.replace(/^\s*\*+/, '').split(':')[0])) continue;
    const t = t0.replace(/[()[\]]/g, ' ').replace(/^\s*\*+/, '').trim();
    if (!t) continue;
    // `name: Type` annotated target.
    const bare = t.split(':')[0].trim();
    if (/^[A-Za-z_]\w*$/.test(bare) && !PY_KEYWORDS.has(bare)) names.push(bare);
  }
  return names;
}

/**
 * Left-hand side of a plain assignment, or null when the statement is not one.
 * Scans for the first `=` at bracket depth 0 that is not part of `==`, `!=`,
 * `<=`, `>=`, `:=` or an augmented assignment, then validates that the target
 * looks like a binding target (names, commas, stars, brackets, annotations).
 */
function assignmentTarget(body: string): string | null {
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === '=' && depth === 0) {
      if (body[i + 1] === '=') return null;              // ==
      const prev = body[i - 1];
      if (prev && '=!<>+-*/%&|^@:'.includes(prev)) return null; // != <= >= += := …
      const target = body.slice(0, i).trim();
      if (!target || /\b(lambda|if|return|yield|assert|del|import|for|while)\b/.test(target)) return null;
      if (!/^[A-Za-z_0-9\s,.*()[\]'":]+$/.test(target)) return null;
      return target;
    }
  }
  return null;
}

const IDENT_RE = /[A-Za-z_]\w*/g;

/** Every identifier in `text` that is not preceded by a `.` (attribute access). */
function referencedIdents(text: string): string[] {
  const found: string[] = [];
  let m: RegExpExecArray | null;
  IDENT_RE.lastIndex = 0;
  while ((m = IDENT_RE.exec(text)) !== null) {
    const start = m.index;
    // Skip attribute names (`obj.attr`) and keyword-argument names (`f(x=1)`).
    let j = start - 1;
    while (j >= 0 && (text[j] === ' ' || text[j] === '\t')) j--;
    if (j >= 0 && text[j] === '.') continue;
    let k = start + m[0].length;
    while (k < text.length && (text[k] === ' ' || text[k] === '\t')) k++;
    if (text[k] === '=' && text[k + 1] !== '=' && text[k - 1] !== '!' && text[k - 1] !== '<' && text[k - 1] !== '>') {
      // Could be a kwarg (inside parens) or an assignment target; both are
      // handled by the statement scanner, so don't double-count as a use.
      const before = text.slice(Math.max(0, start - 200), start);
      const opens = (before.match(/\(/g) || []).length - (before.match(/\)/g) || []).length;
      if (opens > 0) continue;
    }
    found.push(m[0]);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Cell analysis
// ---------------------------------------------------------------------------

const IMPORT_RE = /^import\s+(.+)$/;
const FROM_IMPORT_RE = /^from\s+[.\w]+\s+import\s+(.+)$/;
const DEF_RE = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/;
const CLASS_RE = /^class\s+([A-Za-z_]\w*)/;
const FOR_RE = /^(?:async\s+)?for\s+(.+?)\s+in\s/;
const WITH_AS_RE = /\bas\s+([A-Za-z_]\w*)/g;
const AUG_ASSIGN_RE = /^([A-Za-z_][\w.[\]'"]*)\s*(?:\+|-|\*|\/|\/\/|%|@|&|\||\^|>>|<<|\*\*)=/;
const WALRUS_RE = /([A-Za-z_]\w*)\s*:=/g;
const GLOBAL_RE = /^(?:global|nonlocal)\s+(.+)$/;

/** Names bound by an `import` / `from … import` clause list. */
function importBindings(clause: string): string[] {
  const names: string[] = [];
  for (const part of clause.replace(/[()]/g, ' ').split(',')) {
    const p = part.trim();
    if (!p || p === '*') continue;
    const asMatch = /\s+as\s+([A-Za-z_]\w*)$/.exec(p);
    if (asMatch) { names.push(asMatch[1]); continue; }
    // `import a.b.c` binds `a`; `from m import x` binds `x`.
    const head = p.split('.')[0].trim();
    if (/^[A-Za-z_]\w*$/.test(head)) names.push(head);
  }
  return names;
}

/**
 * Analyze one cell's source. Returns the module-level names it binds (`defs`)
 * and the free names it references (`uses`, excluding its own defs, keywords
 * and the ambient runtime globals).
 */
export function analyzeSource(source: string, lang?: NotebookCellLang): { defs: string[]; uses: string[] } {
  if (!isAnalyzableLang(lang)) return { defs: [], uses: [] };
  const clean = stripCommentsAndStrings(source || '');
  /** Module-level (indent-0) bindings — what OTHER cells can consume. */
  const defs = new Set<string>();
  /** Every name bound anywhere in the cell, including function/loop locals. */
  const bound = new Set<string>();
  /** Names read before they are rebound in this cell (augmented assignment). */
  const forcedUses = new Set<string>();
  const lines = clean.split('\n');

  for (const line of lines) {
    // A magic line (`%%pyspark`, `%pip install …`) binds nothing.
    if (/^\s*%/.test(line)) continue;
    const indent = line.length - line.replace(/^[ \t]*/, '').length;
    const body = line.trim();
    if (!body) continue;
    const topLevel = indent === 0;
    const bind = (names: string[]) => {
      for (const nm of names) { bound.add(nm); if (topLevel) defs.add(nm); }
    };

    // Walrus bindings leak to the enclosing scope; count them at any indent.
    let w: RegExpExecArray | null;
    WALRUS_RE.lastIndex = 0;
    while ((w = WALRUS_RE.exec(body)) !== null) { bound.add(w[1]); if (topLevel) defs.add(w[1]); }

    // `global x` / `nonlocal x` inside a function declares a module binding.
    const g = GLOBAL_RE.exec(body);
    if (g) { for (const nm of namesInTarget(g[1])) { bound.add(nm); defs.add(nm); } continue; }

    const fi = FROM_IMPORT_RE.exec(body);
    if (fi) { bind(importBindings(fi[1])); continue; }
    const im = IMPORT_RE.exec(body);
    if (im) { bind(importBindings(im[1])); continue; }
    const df = DEF_RE.exec(body);
    if (df) { bind([df[1]]); continue; }
    const cl = CLASS_RE.exec(body);
    if (cl) { bind([cl[1]]); continue; }
    const fo = FOR_RE.exec(body);
    if (fo) { bind(namesInTarget(fo[1])); continue; }
    if (/^(?:async\s+)?with\s/.test(body) || /^except\s/.test(body)) {
      const asNames: string[] = [];
      let a: RegExpExecArray | null;
      WITH_AS_RE.lastIndex = 0;
      while ((a = WITH_AS_RE.exec(body)) !== null) asNames.push(a[1]);
      bind(asNames);
      continue;
    }
    const aug = AUG_ASSIGN_RE.exec(body);
    if (aug) {
      const names = namesInTarget(aug[1]);
      // `x += 1` READS x before rebinding it — a genuine upstream dependency.
      for (const nm of names) forcedUses.add(nm);
      bind(names);
      continue;
    }
    const target = assignmentTarget(body);
    if (target) { bind(namesInTarget(target)); continue; }
  }

  const uses = new Set<string>(forcedUses);
  for (const ident of referencedIdents(clean)) {
    if (PY_KEYWORDS.has(ident) || AMBIENT_NAMES.has(ident)) continue;
    if (bound.has(ident)) continue;
    uses.add(ident);
  }
  for (const kw of PY_KEYWORDS) uses.delete(kw);
  return { defs: [...defs].sort(), uses: [...uses].sort() };
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

/** Build the dependency graph over a notebook's CODE cells. */
export function buildNotebookDag(cells: NotebookCell[]): NotebookDag {
  const codeCells = (cells || []).filter((c) => c && c.type === 'code');
  const order = codeCells.map((c) => c.id);
  const analyses: Record<string, CellAnalysis> = {};
  const definers = new Map<string, string[]>();

  for (const c of codeCells) {
    const analyzed = isAnalyzableLang(c.lang);
    const { defs, uses } = analyzeSource(c.source || '', c.lang);
    analyses[c.id] = { cellId: c.id, defs, uses, analyzed };
    for (const d of defs) {
      const list = definers.get(d);
      if (list) list.push(c.id); else definers.set(d, [c.id]);
    }
  }

  const edgeKey = new Map<string, DagEdge>();
  for (const c of codeCells) {
    for (const u of analyses[c.id].uses) {
      const from = definers.get(u);
      if (!from) continue;
      for (const f of from) {
        if (f === c.id) continue;
        const key = `${f}::${c.id}`;
        const existing = edgeKey.get(key);
        if (existing) { if (!existing.via.includes(u)) existing.via.push(u); }
        else edgeKey.set(key, { from: f, to: c.id, via: [u] });
      }
    }
  }
  const edges = [...edgeKey.values()];

  const dependents: Record<string, string[]> = {};
  const dependencies: Record<string, string[]> = {};
  for (const id of order) { dependents[id] = []; dependencies[id] = []; }
  for (const e of edges) {
    dependents[e.from].push(e.to);
    dependencies[e.to].push(e.from);
  }

  const collisions: DefinitionCollision[] = [];
  for (const [name, ids] of definers) {
    if (ids.length > 1) collisions.push({ name, cellIds: [...ids] });
  }
  collisions.sort((a, b) => a.name.localeCompare(b.name));

  return {
    order,
    analyses,
    edges,
    dependents,
    dependencies,
    cycles: findCycles(order, dependents),
    collisions,
  };
}

/**
 * Cells left un-emitted by Kahn's algorithm are exactly the cells on (or
 * downstream of) a cycle. Grouped into connected components so the UI can name
 * each cycle separately.
 */
function findCycles(order: string[], dependents: Record<string, string[]>): string[][] {
  const indeg = new Map<string, number>(order.map((id) => [id, 0]));
  for (const id of order) for (const to of dependents[id] || []) indeg.set(to, (indeg.get(to) || 0) + 1);
  const queue = order.filter((id) => (indeg.get(id) || 0) === 0);
  const emitted = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (emitted.has(id)) continue;
    emitted.add(id);
    for (const to of dependents[id] || []) {
      const d = (indeg.get(to) || 0) - 1;
      indeg.set(to, d);
      if (d === 0) queue.push(to);
    }
  }
  const stuck = order.filter((id) => !emitted.has(id));
  if (stuck.length === 0) return [];
  // Group the residue into weakly-connected components.
  const stuckSet = new Set(stuck);
  const adj = new Map<string, Set<string>>(stuck.map((id) => [id, new Set<string>()]));
  for (const id of stuck) {
    for (const to of dependents[id] || []) {
      if (!stuckSet.has(to)) continue;
      adj.get(id)!.add(to);
      adj.get(to)!.add(id);
    }
  }
  const seen = new Set<string>();
  const groups: string[][] = [];
  for (const id of stuck) {
    if (seen.has(id)) continue;
    const comp: string[] = [];
    const stack = [id];
    seen.add(id);
    while (stack.length) {
      const cur = stack.pop()!;
      comp.push(cur);
      for (const nb of adj.get(cur) || []) if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
    }
    groups.push(comp.sort((a, b) => order.indexOf(a) - order.indexOf(b)));
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Invalidation math
// ---------------------------------------------------------------------------

/**
 * Transitive downstream closure of `seeds` — every cell whose result is
 * invalidated when the seed cells change. Excludes the seeds themselves and
 * anything trapped in a cycle (a cycle can't be reactively ordered).
 * Returned in TOPOLOGICAL order (document order as the tie-break), i.e. a
 * directly runnable sequence.
 */
export function downstreamOf(dag: NotebookDag, seeds: string[]): string[] {
  const seedSet = new Set(seeds.filter((id) => dag.order.includes(id)));
  const hit = new Set<string>();
  const stack = [...seedSet];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const to of dag.dependents[cur] || []) {
      if (hit.has(to) || seedSet.has(to)) continue;
      hit.add(to);
      stack.push(to);
    }
  }
  const cycled = new Set(dag.cycles.flat());
  return topoSort(dag, [...hit].filter((id) => !cycled.has(id)));
}

/**
 * Topological order of `subset` (default: the whole notebook), tie-broken by
 * document order so a dependency-free notebook runs exactly top-to-bottom.
 * Cells inside a cycle are appended last, in document order, so the caller can
 * still show them (they are never auto-run — see `downstreamOf`).
 */
export function topoSort(dag: NotebookDag, subset?: string[]): string[] {
  const scope = new Set(subset ?? dag.order);
  const indeg = new Map<string, number>();
  for (const id of dag.order) if (scope.has(id)) indeg.set(id, 0);
  for (const e of dag.edges) {
    if (scope.has(e.from) && scope.has(e.to)) indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
  }
  const ready = dag.order.filter((id) => scope.has(id) && (indeg.get(id) || 0) === 0);
  const out: string[] = [];
  const emitted = new Set<string>();
  while (ready.length) {
    // Always take the document-earliest ready cell — deterministic order.
    ready.sort((a, b) => dag.order.indexOf(a) - dag.order.indexOf(b));
    const id = ready.shift()!;
    if (emitted.has(id)) continue;
    emitted.add(id);
    out.push(id);
    for (const to of dag.dependents[id] || []) {
      if (!scope.has(to) || emitted.has(to)) continue;
      const d = (indeg.get(to) || 0) - 1;
      indeg.set(to, d);
      if (d === 0) ready.push(to);
    }
  }
  for (const id of dag.order) if (scope.has(id) && !emitted.has(id)) out.push(id);
  return out;
}

/**
 * The stale set after editing `changedIds`: the changed cells themselves plus
 * their transitive downstream, merged with any `alreadyStale` cells that are
 * still present in the notebook. Returned in topological order.
 */
export function staleAfterEdit(
  dag: NotebookDag,
  changedIds: string[],
  alreadyStale: Iterable<string> = [],
): string[] {
  const present = new Set(dag.order);
  const acc = new Set<string>();
  for (const id of alreadyStale) if (present.has(id)) acc.add(id);
  for (const id of changedIds) if (present.has(id)) acc.add(id);
  for (const id of downstreamOf(dag, changedIds)) acc.add(id);
  return topoSort(dag, [...acc]);
}

/**
 * The reactive run plan after a cell finishes: its downstream closure minus
 * anything the caller has excluded (e.g. cells the user pinned or that are
 * already running), in dependency order.
 */
export function reactiveRunPlan(
  dag: NotebookDag,
  ranCellId: string,
  exclude: Iterable<string> = [],
): string[] {
  const skip = new Set(exclude);
  return downstreamOf(dag, [ranCellId]).filter((id) => !skip.has(id));
}

/** Human-readable one-line summary of a cell's edges, for the UI + tooltips. */
export function describeCellDeps(dag: NotebookDag, cellId: string): string {
  const ups = dag.dependencies[cellId] || [];
  const downs = dag.dependents[cellId] || [];
  const names = (from: string) =>
    (dag.edges.find((e) => e.from === from && e.to === cellId)?.via || []).join(', ');
  if (ups.length === 0 && downs.length === 0) return 'No detected dependencies — this cell runs standalone.';
  const parts: string[] = [];
  if (ups.length) parts.push(`depends on ${ups.length} cell${ups.length === 1 ? '' : 's'} (${ups.map(names).filter(Boolean).join('; ')})`);
  if (downs.length) parts.push(`${downs.length} cell${downs.length === 1 ? '' : 's'} depend on it`);
  return parts.join(' · ');
}
