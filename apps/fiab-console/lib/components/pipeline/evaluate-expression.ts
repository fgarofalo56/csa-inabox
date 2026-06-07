/**
 * Pre-run expression evaluator — the Loom one-for-one of the Azure Data
 * Factory / Synapse / Fabric "Evaluate expression" (F9) experience inside the
 * pipeline expression builder (see dynamic-content.tsx).
 *
 * Fabric's evaluator is PURELY client-side: it resolves the expression against
 * design-time values (parameters / variables / functions / system variables)
 * plus any sample values the user types in for run-time-only tokens (trigger
 * time, run id, activity outputs). Per the docs it "doesn't pull a run ID,
 * trigger instance ID, activity outputs, or any values that only exist during
 * a run. So, you'll have to manually provide these values."
 *   https://learn.microsoft.com/fabric/data-factory/evaluate-pipeline-expression
 *   https://learn.microsoft.com/azure/data-factory/control-flow-expression-language-functions
 *
 * Loom mirrors that client-side resolver here (no new dependency — a small
 * recursive-descent parser over the ADF expression grammar) AND adds an
 * optional enhancement: the /evaluate BFF route can fetch the LAST real run's
 * activity outputs from ADF to pre-fill the sample-value fields. The resolver
 * itself never calls a backend, exactly like Fabric.
 */

// ============================================================
// Public types
// ============================================================

export type SampleKind = 'activityOutput' | 'systemVar' | 'parameter' | 'variable';

export interface SampleInput {
  /** The literal token as it appears, e.g. "@activity('CopyData').output". */
  token: string;
  /** Stable state-map key, e.g. "activity__CopyData__output". */
  key: string;
  /** Human-readable label for the input field. */
  label: string;
  kind: SampleKind;
  /** The underlying name (activity / param / variable / system-var field). */
  name: string;
}

export interface EvalContext {
  /** @pipeline().parameters.X */
  parameters: Record<string, unknown>;
  /** @variables('X') */
  variables: Record<string, unknown>;
  /** @pipeline().RunId, .TriggerTime, etc. */
  systemVars: {
    RunId?: string;
    Pipeline?: string;
    DataFactory?: string;
    TriggerTime?: string;
    TriggerName?: string;
    TriggerId?: string;
    TriggerType?: string;
    GroupId?: string;
  };
  /** @activity('name').output */
  activityOutputs: Record<string, unknown>;
}

export interface EvalResult {
  value: unknown;
  /** Display string (JSON for objects, raw for scalars). */
  valueStr: string;
  error?: string;
  /** Tokens present in the expression that had no resolvable value. */
  unresolvedTokens: string[];
}

const SYSTEM_VAR_FIELDS = [
  'RunId', 'Pipeline', 'DataFactory', 'TriggerTime',
  'TriggerName', 'TriggerId', 'TriggerType', 'GroupId',
] as const;

// ============================================================
// Tokenizer
// ============================================================

type Tok =
  | { t: 'str'; v: string }
  | { t: 'num'; v: number }
  | { t: 'ident'; v: string }
  | { t: 'punct'; v: string };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    // String literal — ADF uses single quotes; '' escapes a quote. Accept " too.
    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      let str = '';
      while (i < n) {
        if (src[i] === quote) {
          if (src[i + 1] === quote) { str += quote; i += 2; continue; } // doubled escape
          i++; break;
        }
        str += src[i++];
      }
      toks.push({ t: 'str', v: str });
      continue;
    }
    // Number
    if (c >= '0' && c <= '9') {
      let num = '';
      while (i < n && /[0-9.]/.test(src[i])) num += src[i++];
      toks.push({ t: 'num', v: Number(num) });
      continue;
    }
    // Identifier
    if (/[A-Za-z_$]/.test(c)) {
      let id = '';
      while (i < n && /[A-Za-z0-9_$]/.test(src[i])) id += src[i++];
      toks.push({ t: 'ident', v: id });
      continue;
    }
    // Null-safe access ?.
    if (c === '?' && src[i + 1] === '.') { toks.push({ t: 'punct', v: '?.' }); i += 2; continue; }
    if ('().,[]'.includes(c)) { toks.push({ t: 'punct', v: c }); i++; continue; }
    throw new Error(`Unexpected character '${c}' at position ${i}`);
  }
  return toks;
}

// ============================================================
// Parser (recursive descent) — produces a tiny AST
// ============================================================

type Node =
  | { type: 'lit'; value: unknown }
  | { type: 'ident'; name: string }
  | { type: 'call'; name: string; args: Node[] }
  | { type: 'member'; obj: Node; prop: string; optional: boolean }
  | { type: 'index'; obj: Node; index: Node };

class Parser {
  private toks: Tok[];
  private pos = 0;
  constructor(toks: Tok[]) { this.toks = toks; }

  private peek(): Tok | undefined { return this.toks[this.pos]; }
  private next(): Tok | undefined { return this.toks[this.pos++]; }
  private expectPunct(v: string) {
    const t = this.next();
    if (!t || t.t !== 'punct' || t.v !== v) throw new Error(`Expected '${v}'`);
  }

  parse(): Node {
    const node = this.parsePostfix();
    if (this.pos < this.toks.length) throw new Error('Unexpected trailing tokens in expression');
    return node;
  }

  private parsePostfix(): Node {
    let node = this.parsePrimary();
    for (;;) {
      const t = this.peek();
      if (t && t.t === 'punct' && (t.v === '.' || t.v === '?.')) {
        this.next();
        const id = this.next();
        if (!id || id.t !== 'ident') throw new Error('Expected property name after "."');
        node = { type: 'member', obj: node, prop: id.v, optional: t.v === '?.' };
      } else if (t && t.t === 'punct' && t.v === '[') {
        this.next();
        const idx = this.parsePostfix();
        this.expectPunct(']');
        node = { type: 'index', obj: node, index: idx };
      } else break;
    }
    return node;
  }

  private parsePrimary(): Node {
    const t = this.next();
    if (!t) throw new Error('Unexpected end of expression');
    if (t.t === 'str') return { type: 'lit', value: t.v };
    if (t.t === 'num') return { type: 'lit', value: t.v };
    if (t.t === 'ident') {
      if (t.v === 'true') return { type: 'lit', value: true };
      if (t.v === 'false') return { type: 'lit', value: false };
      if (t.v === 'null') return { type: 'lit', value: null };
      const p = this.peek();
      if (p && p.t === 'punct' && p.v === '(') {
        this.next();
        const args = this.parseArgs();
        this.expectPunct(')');
        return { type: 'call', name: t.v, args };
      }
      return { type: 'ident', name: t.v };
    }
    if (t.t === 'punct' && t.v === '(') {
      const e = this.parsePostfix();
      this.expectPunct(')');
      return e;
    }
    throw new Error(`Unexpected token '${(t as any).v}'`);
  }

  private parseArgs(): Node[] {
    const args: Node[] = [];
    const p = this.peek();
    if (p && p.t === 'punct' && p.v === ')') return args;
    args.push(this.parsePostfix());
    for (;;) {
      const t = this.peek();
      if (t && t.t === 'punct' && t.v === ',') { this.next(); args.push(this.parsePostfix()); }
      else break;
    }
    return args;
  }
}

function parse(src: string): Node {
  return new Parser(tokenize(src)).parse();
}

// ============================================================
// Evaluator
// ============================================================

// Markers for the ADF "root accessors" whose member chains we resolve specially.
const ROOT = Symbol('loomRoot');
interface RootMarker { [ROOT]: 'pipeline' | 'pipelineParams' | 'activity' | 'trigger' | 'item'; name?: string; }
function isRoot(v: unknown): v is RootMarker {
  return typeof v === 'object' && v !== null && ROOT in (v as any);
}

const toNum = (v: unknown): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Cannot convert '${String(v)}' to a number`);
  return n;
};
const toStr = (v: unknown): string => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};
const asArray = (v: unknown): unknown[] => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return v.split('');
  throw new Error('Expected a collection');
};

function pad(n: number, w = 2): string { return String(n).padStart(w, '0'); }

/** Minimal .NET-style date formatter covering the common ADF tokens. */
function formatDate(d: Date, fmt?: string): string {
  if (!fmt || fmt.toLowerCase() === 'o') return d.toISOString();
  return fmt
    .replace(/yyyy/g, String(d.getUTCFullYear()))
    .replace(/MM/g, pad(d.getUTCMonth() + 1))
    .replace(/dd/g, pad(d.getUTCDate()))
    .replace(/HH/g, pad(d.getUTCHours()))
    .replace(/mm/g, pad(d.getUTCMinutes()))
    .replace(/ss/g, pad(d.getUTCSeconds()))
    .replace(/fff/g, pad(d.getUTCMilliseconds(), 3));
}
function parseDate(v: unknown): Date {
  const d = new Date(toStr(v));
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid timestamp '${toStr(v)}'`);
  return d;
}
const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const MIN_MS = 60000;
function unitMs(unit: string): number {
  switch (String(unit).toLowerCase()) {
    case 'day': return DAY_MS;
    case 'hour': return HOUR_MS;
    case 'minute': return MIN_MS;
    case 'second': return 1000;
    case 'week': return 7 * DAY_MS;
    case 'month': return 30 * DAY_MS;
    case 'year': return 365 * DAY_MS;
    default: throw new Error(`Unknown time unit '${unit}'`);
  }
}

type FnImpl = (a: unknown[]) => unknown;

const FUNCS: Record<string, FnImpl> = {
  // ---- String ----
  concat: (a) => a.map(toStr).join(''),
  substring: (a) => toStr(a[0]).substr(toNum(a[1]), a[2] == null ? undefined : toNum(a[2])),
  replace: (a) => toStr(a[0]).split(toStr(a[1])).join(toStr(a[2])),
  toLower: (a) => toStr(a[0]).toLowerCase(),
  toUpper: (a) => toStr(a[0]).toUpperCase(),
  trim: (a) => toStr(a[0]).trim(),
  split: (a) => toStr(a[0]).split(toStr(a[1])),
  indexOf: (a) => toStr(a[0]).indexOf(toStr(a[1])),
  lastIndexOf: (a) => toStr(a[0]).lastIndexOf(toStr(a[1])),
  startsWith: (a) => toStr(a[0]).startsWith(toStr(a[1])),
  endsWith: (a) => toStr(a[0]).endsWith(toStr(a[1])),
  guid: () => crypto.randomUUID ? crypto.randomUUID() : '00000000-0000-0000-0000-000000000000',
  length: (a) => (Array.isArray(a[0]) ? a[0].length : toStr(a[0]).length),
  // ---- Collection ----
  contains: (a) => {
    const c = a[0];
    if (Array.isArray(c)) return c.includes(a[1]);
    if (c && typeof c === 'object') return toStr(a[1]) in (c as object);
    return toStr(c).includes(toStr(a[1]));
  },
  empty: (a) => {
    const c = a[0];
    if (c == null) return true;
    if (Array.isArray(c) || typeof c === 'string') return c.length === 0;
    if (typeof c === 'object') return Object.keys(c).length === 0;
    return false;
  },
  first: (a) => asArray(a[0])[0],
  last: (a) => { const arr = asArray(a[0]); return arr[arr.length - 1]; },
  intersection: (a) => {
    const lists = a.map(asArray);
    return lists.reduce((acc, l) => acc.filter((x) => l.includes(x)));
  },
  union: (a) => Array.from(new Set(a.flatMap(asArray))),
  join: (a) => asArray(a[0]).map(toStr).join(toStr(a[1])),
  take: (a) => asArray(a[0]).slice(0, toNum(a[1])),
  skip: (a) => asArray(a[0]).slice(toNum(a[1])),
  // ---- Logical ----
  and: (a) => Boolean(a[0]) && Boolean(a[1]),
  or: (a) => Boolean(a[0]) || Boolean(a[1]),
  not: (a) => !a[0],
  equals: (a) => toStr(a[0]) === toStr(a[1]) || a[0] === a[1],
  greater: (a) => toNum(a[0]) > toNum(a[1]),
  greaterOrEquals: (a) => toNum(a[0]) >= toNum(a[1]),
  less: (a) => toNum(a[0]) < toNum(a[1]),
  lessOrEquals: (a) => toNum(a[0]) <= toNum(a[1]),
  if: (a) => (a[0] ? a[1] : a[2]),
  coalesce: (a) => a.find((x) => x != null) ?? null,
  // ---- Conversion ----
  json: (a) => (typeof a[0] === 'string' ? JSON.parse(a[0]) : a[0]),
  string: (a) => toStr(a[0]),
  int: (a) => Math.trunc(toNum(a[0])),
  float: (a) => toNum(a[0]),
  bool: (a) => (typeof a[0] === 'boolean' ? a[0] : String(a[0]).toLowerCase() === 'true'),
  array: (a) => (Array.isArray(a[0]) ? a[0] : [a[0]]),
  createArray: (a) => a.slice(),
  base64: (a) => (typeof btoa === 'function' ? btoa(toStr(a[0])) : Buffer.from(toStr(a[0])).toString('base64')),
  base64ToString: (a) => (typeof atob === 'function' ? atob(toStr(a[0])) : Buffer.from(toStr(a[0]), 'base64').toString()),
  encodeUriComponent: (a) => encodeURIComponent(toStr(a[0])),
  decimal: (a) => toNum(a[0]),
  xml: (a) => toStr(a[0]),
  // ---- Math ----
  add: (a) => toNum(a[0]) + toNum(a[1]),
  sub: (a) => toNum(a[0]) - toNum(a[1]),
  mul: (a) => toNum(a[0]) * toNum(a[1]),
  div: (a) => toNum(a[0]) / toNum(a[1]),
  mod: (a) => toNum(a[0]) % toNum(a[1]),
  min: (a) => Math.min(...a.flat().map(toNum)),
  max: (a) => Math.max(...a.flat().map(toNum)),
  range: (a) => { const start = toNum(a[0]); const count = toNum(a[1]); return Array.from({ length: count }, (_, i) => start + i); },
  rand: (a) => { const lo = toNum(a[0]); const hi = toNum(a[1]); return Math.floor(Math.random() * (hi - lo)) + lo; },
  // ---- Date ----
  utcnow: (a) => formatDate(new Date(), a[0] == null ? undefined : toStr(a[0])),
  addDays: (a) => formatDate(new Date(parseDate(a[0]).getTime() + toNum(a[1]) * DAY_MS), a[2] == null ? undefined : toStr(a[2])),
  addHours: (a) => formatDate(new Date(parseDate(a[0]).getTime() + toNum(a[1]) * HOUR_MS), a[2] == null ? undefined : toStr(a[2])),
  addMinutes: (a) => formatDate(new Date(parseDate(a[0]).getTime() + toNum(a[1]) * MIN_MS), a[2] == null ? undefined : toStr(a[2])),
  addSeconds: (a) => formatDate(new Date(parseDate(a[0]).getTime() + toNum(a[1]) * 1000), a[2] == null ? undefined : toStr(a[2])),
  formatDateTime: (a) => formatDate(parseDate(a[0]), a[1] == null ? undefined : toStr(a[1])),
  startOfDay: (a) => { const d = parseDate(a[0]); d.setUTCHours(0, 0, 0, 0); return formatDate(d, a[1] == null ? undefined : toStr(a[1])); },
  startOfHour: (a) => { const d = parseDate(a[0]); d.setUTCMinutes(0, 0, 0); return formatDate(d, a[1] == null ? undefined : toStr(a[1])); },
  startOfMonth: (a) => { const d = parseDate(a[0]); d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0); return formatDate(d, a[1] == null ? undefined : toStr(a[1])); },
  dayOfWeek: (a) => parseDate(a[0]).getUTCDay(),
  ticks: (a) => (parseDate(a[0]).getTime() + 62135596800000) * 10000,
  getPastTime: (a) => formatDate(new Date(Date.now() - toNum(a[0]) * unitMs(toStr(a[1]))), a[2] == null ? undefined : toStr(a[2])),
  getFutureTime: (a) => formatDate(new Date(Date.now() + toNum(a[0]) * unitMs(toStr(a[1]))), a[2] == null ? undefined : toStr(a[2])),
  convertTimeZone: (a) => formatDate(parseDate(a[0]), a[3] == null ? undefined : toStr(a[3])), // tz math out of scope — pass-through, honest
};

const ROOT_ACCESSORS = new Set(['pipeline', 'variables', 'activity', 'trigger', 'item']);

class Evaluator {
  constructor(private ctx: EvalContext, private unresolved: string[]) {}

  private flag(token: string) { if (!this.unresolved.includes(token)) this.unresolved.push(token); }

  eval(node: Node): unknown {
    switch (node.type) {
      case 'lit': return node.value;
      case 'ident': return undefined; // bare idents have no value in ADF
      case 'index': {
        const obj = this.eval(node.obj);
        const idx = this.eval(node.index);
        if (obj == null) return undefined;
        return (obj as any)[idx as any];
      }
      case 'member': return this.member(this.eval(node.obj), node.prop);
      case 'call': return this.call(node);
    }
  }

  private call(node: Extract<Node, { type: 'call' }>): unknown {
    const name = node.name;
    if (ROOT_ACCESSORS.has(name)) {
      switch (name) {
        case 'pipeline': return { [ROOT]: 'pipeline' } as RootMarker;
        case 'trigger': return { [ROOT]: 'trigger' } as RootMarker;
        case 'item': return { [ROOT]: 'item' } as RootMarker;
        case 'activity': return { [ROOT]: 'activity', name: toStr(this.eval(node.args[0])) } as RootMarker;
        case 'variables': {
          const vn = toStr(this.eval(node.args[0]));
          if (!(vn in this.ctx.variables)) { this.flag(`@variables('${vn}')`); return undefined; }
          return this.ctx.variables[vn];
        }
      }
    }
    const impl = FUNCS[name];
    if (!impl) throw new Error(`Unknown function '${name}'`);
    const args = node.args.map((a) => this.eval(a));
    return impl(args);
  }

  private member(obj: unknown, prop: string): unknown {
    if (isRoot(obj)) {
      const kind = obj[ROOT];
      if (kind === 'pipeline') {
        if (prop === 'parameters') return { [ROOT]: 'pipelineParams' } as RootMarker;
        const v = (this.ctx.systemVars as any)[prop];
        if (v == null) { this.flag(`@pipeline().${prop}`); return undefined; }
        return v;
      }
      if (kind === 'pipelineParams') {
        if (!(prop in this.ctx.parameters)) { this.flag(`@pipeline().parameters.${prop}`); return undefined; }
        return this.ctx.parameters[prop];
      }
      if (kind === 'activity') {
        if (prop === 'output') {
          const an = obj.name || '';
          if (!(an in this.ctx.activityOutputs)) { this.flag(`@activity('${an}').output`); return undefined; }
          return this.ctx.activityOutputs[an];
        }
        return undefined;
      }
      if (kind === 'trigger') {
        // trigger().startTime / .scheduledTime resolve from the sample TriggerTime.
        if (prop === 'startTime' || prop === 'scheduledTime') {
          const v = this.ctx.systemVars.TriggerTime;
          if (v == null) { this.flag(`@trigger().${prop}`); return undefined; }
          return v;
        }
        this.flag(`@trigger().${prop}`);
        return undefined;
      }
      if (kind === 'item') { this.flag(`@item().${prop}`); return undefined; }
    }
    if (obj == null) return undefined;
    return (obj as any)[prop];
  }
}

// ============================================================
// Top-level evaluate + interpolation handling
// ============================================================

/** Split a string into literal + @{…} expression segments (brace-balanced). */
function splitInterpolation(text: string): Array<{ lit: true; v: string } | { lit: false; v: string }> {
  const parts: Array<{ lit: true; v: string } | { lit: false; v: string }> = [];
  let i = 0;
  const n = text.length;
  let lit = '';
  while (i < n) {
    if (text[i] === '@' && text[i + 1] === '@') { lit += '@'; i += 2; continue; } // @@ → literal @
    if (text[i] === '@' && text[i + 1] === '{') {
      if (lit) { parts.push({ lit: true, v: lit }); lit = ''; }
      i += 2;
      let depth = 1;
      let expr = '';
      let inStr: string | null = null;
      while (i < n && depth > 0) {
        const c = text[i];
        if (inStr) {
          expr += c;
          if (c === inStr) { if (text[i + 1] === inStr) { expr += text[i + 1]; i += 2; continue; } inStr = null; }
          i++;
          continue;
        }
        if (c === "'" || c === '"') { inStr = c; expr += c; i++; continue; }
        if (c === '{') depth++;
        if (c === '}') { depth--; if (depth === 0) { i++; break; } }
        expr += c;
        i++;
      }
      parts.push({ lit: false, v: expr });
      continue;
    }
    lit += text[i++];
  }
  if (lit) parts.push({ lit: true, v: lit });
  return parts;
}

function display(v: unknown): string {
  if (v === undefined) return '(undefined)';
  if (v === null) return 'null';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return JSON.stringify(v, null, 2);
  return String(v);
}

/**
 * Evaluate an ADF/Synapse/Fabric pipeline expression against the supplied
 * design-time + sample context. Never calls a backend.
 */
export function evaluateExpression(expr: string, ctx: EvalContext): EvalResult {
  const unresolved: string[] = [];
  const ev = new Evaluator(ctx, unresolved);
  const trimmed = (expr ?? '').trim();
  try {
    let value: unknown;
    if (!trimmed) {
      value = '';
    } else if (trimmed.startsWith('@@')) {
      value = trimmed.slice(1); // escaped literal — drops one @
    } else if (trimmed.startsWith('@{') || expr.includes('@{')) {
      // String-interpolation form — may mix literal text with @{…} segments.
      const parts = splitInterpolation(expr);
      if (parts.length === 1 && !parts[0].lit) {
        // Single pure @{…} → return the raw typed value (matches preview).
        value = ev.eval(parse(parts[0].v));
      } else {
        value = parts.map((p) => (p.lit ? p.v : display(ev.eval(parse(p.v))))).join('');
      }
    } else if (trimmed.startsWith('@')) {
      value = ev.eval(parse(trimmed.slice(1)));
    } else {
      value = expr; // plain literal, no expression
    }
    return { value, valueStr: display(value), unresolvedTokens: unresolved };
  } catch (e: any) {
    return { value: undefined, valueStr: '', error: e?.message || String(e), unresolvedTokens: unresolved };
  }
}

// ============================================================
// Sample-input detection (which runtime tokens need a value)
// ============================================================

function walk(node: Node, visit: (n: Node) => void) {
  visit(node);
  switch (node.type) {
    case 'call': node.args.forEach((a) => walk(a, visit)); break;
    case 'member': walk(node.obj, visit); break;
    case 'index': walk(node.obj, visit); walk(node.index, visit); break;
  }
}

function collectAsts(expr: string): Node[] {
  const trimmed = (expr ?? '').trim();
  const asts: Node[] = [];
  const safeParse = (src: string) => { try { asts.push(parse(src)); } catch { /* ignore partial-typed exprs */ } };
  if (!trimmed) return asts;
  if (trimmed.startsWith('@@')) return asts;
  if (trimmed.startsWith('@{') || expr.includes('@{')) {
    for (const p of splitInterpolation(expr)) if (!p.lit) safeParse(p.v);
  } else if (trimmed.startsWith('@')) {
    safeParse(trimmed.slice(1));
  }
  return asts;
}

/** Detect run-time-only tokens (activity outputs, system vars, unknown
 *  params/vars) that the user must supply a sample value for. */
export function detectSampleInputs(
  expr: string,
  knownParams: string[],
  knownVars: string[],
): SampleInput[] {
  const out: SampleInput[] = [];
  const seen = new Set<string>();
  const push = (si: SampleInput) => { if (!seen.has(si.key)) { seen.add(si.key); out.push(si); } };
  const known = (arr: string[], v: string) => arr.some((x) => x.toLowerCase() === v.toLowerCase());

  for (const ast of collectAsts(expr)) {
    walk(ast, (n) => {
      // activity('X')  → activity output
      if (n.type === 'call' && n.name === 'activity' && n.args[0]?.type === 'lit') {
        const name = String((n.args[0] as any).value);
        push({
          token: `@activity('${name}').output`,
          key: `activity__${name}__output`,
          label: `Activity '${name}' output — paste JSON (e.g. {"rowsCopied":42})`,
          kind: 'activityOutput',
          name,
        });
      }
      // variables('X') → unknown variable
      if (n.type === 'call' && n.name === 'variables' && n.args[0]?.type === 'lit') {
        const name = String((n.args[0] as any).value);
        if (!known(knownVars, name)) {
          push({
            token: `@variables('${name}')`,
            key: `var__${name}`,
            label: `Variable '${name}' (not defined on this pipeline)`,
            kind: 'variable',
            name,
          });
        }
      }
      // pipeline().<field>  and  pipeline().parameters.<X>
      if (n.type === 'member' && n.obj.type === 'call' && n.obj.name === 'pipeline') {
        const field = n.prop;
        if (field !== 'parameters' && (SYSTEM_VAR_FIELDS as readonly string[]).includes(field)) {
          push({
            token: `@pipeline().${field}`,
            key: `sysvar__${field}`,
            label: `System variable · pipeline().${field}`,
            kind: 'systemVar',
            name: field,
          });
        }
      }
      if (
        n.type === 'member' &&
        n.obj.type === 'member' && n.obj.prop === 'parameters' &&
        n.obj.obj.type === 'call' && n.obj.obj.name === 'pipeline'
      ) {
        const name = n.prop;
        if (!known(knownParams, name)) {
          push({
            token: `@pipeline().parameters.${name}`,
            key: `param__${name}`,
            label: `Parameter '${name}' (not defined on this pipeline)`,
            kind: 'parameter',
            name,
          });
        }
      }
    });
  }
  return out;
}
