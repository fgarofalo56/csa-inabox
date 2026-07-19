/**
 * Fusion Sheet (Foundry-parity row 3.4) — the spreadsheet formula engine core.
 *
 * A sheet is a map of A1-addressed cells (`{ A1: "10", B1: "=A1*2" }`). This
 * module evaluates every formula cell with dependency-ordered recursion, cycle
 * detection, and Excel-style error values. It is a PURE function (no I/O) so it
 * is fully unit-testable; the editor renders the grid + calls evaluateSheet.
 *
 * Supported: numbers, strings, cell refs (A1), ranges (A1:B3), unary minus,
 * `+ - * / ^`, comparisons (`= <> < > <= >=`), and functions SUM/AVG/MIN/MAX/
 * COUNT/IF/ROUND/ABS/CONCAT. Errors: #REF! #DIV/0! #VALUE! #CYCLE! #NAME? #ERROR!.
 */

export type CellError = '#REF!' | '#DIV/0!' | '#VALUE!' | '#CYCLE!' | '#NAME?' | '#ERROR!';
const ERRORS: readonly string[] = ['#REF!', '#DIV/0!', '#VALUE!', '#CYCLE!', '#NAME?', '#ERROR!'];
export type CellValue = number | string | boolean | CellError;
export interface EvaluatedCell { value: CellValue; isError: boolean }

// ── A1 addressing ───────────────────────────────────────────────────────────

const CELL_RE = /^([A-Z]+)([1-9][0-9]*)$/;
export function isCellRef(s: string): boolean { return CELL_RE.test(s); }
export function colToIndex(col: string): number {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
export function indexToCol(idx: number): string {
  let s = ''; let n = idx + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
function parseRef(ref: string): { col: number; row: number } | null {
  const m = CELL_RE.exec(ref);
  if (!m) return null;
  return { col: colToIndex(m[1]), row: parseInt(m[2], 10) - 1 };
}
/** Expand an A1:B3 range into its member cell refs (row-major). */
export function expandRange(a: string, b: string): string[] | null {
  const pa = parseRef(a); const pb = parseRef(b);
  if (!pa || !pb) return null;
  const out: string[] = [];
  const [c0, c1] = [Math.min(pa.col, pb.col), Math.max(pa.col, pb.col)];
  const [r0, r1] = [Math.min(pa.row, pb.row), Math.max(pa.row, pb.row)];
  if ((c1 - c0 + 1) * (r1 - r0 + 1) > 100000) return null; // sanity cap
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.push(`${indexToCol(c)}${r + 1}`);
  return out;
}

// ── Tokenizer ───────────────────────────────────────────────────────────────

type Tok = { t: 'num' | 'str' | 'ident' | 'op' | 'lp' | 'rp' | 'comma' | 'colon'; v: string };
function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '(') { toks.push({ t: 'lp', v: c }); i++; continue; }
    if (c === ')') { toks.push({ t: 'rp', v: c }); i++; continue; }
    if (c === ',') { toks.push({ t: 'comma', v: c }); i++; continue; }
    if (c === ':') { toks.push({ t: 'colon', v: c }); i++; continue; }
    if (c === '"') {
      let s = ''; i++;
      while (i < src.length && src[i] !== '"') { if (src[i] === '\\' && i + 1 < src.length) { s += src[i + 1]; i += 2; } else { s += src[i++]; } }
      i++; toks.push({ t: 'str', v: s }); continue;
    }
    if (/[0-9.]/.test(c)) { let n = ''; while (i < src.length && /[0-9.]/.test(src[i])) n += src[i++]; toks.push({ t: 'num', v: n }); continue; }
    if (/[A-Za-z_]/.test(c)) { let id = ''; while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) id += src[i++]; toks.push({ t: 'ident', v: id }); continue; }
    // multi-char operators
    const two = src.slice(i, i + 2);
    if (['<=', '>=', '<>'].includes(two)) { toks.push({ t: 'op', v: two }); i += 2; continue; }
    if ('+-*/^=<>'.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }
    throw new Error('#ERROR!');
  }
  return toks;
}

// ── Parser → AST ────────────────────────────────────────────────────────────

type Node =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'ref'; v: string }
  | { k: 'range'; a: string; b: string }
  | { k: 'unary'; op: string; e: Node }
  | { k: 'bin'; op: string; l: Node; r: Node }
  | { k: 'call'; name: string; args: Node[] };

class Parser {
  private p = 0;
  constructor(private toks: Tok[]) {}
  private peek(): Tok | undefined { return this.toks[this.p]; }
  private next(): Tok | undefined { return this.toks[this.p++]; }
  parse(): Node { const n = this.compare(); if (this.p !== this.toks.length) throw new Error('#ERROR!'); return n; }
  private compare(): Node {
    let l = this.add();
    const t = this.peek();
    if (t?.t === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(t.v)) { this.next(); l = { k: 'bin', op: t.v, l, r: this.add() }; }
    return l;
  }
  private add(): Node { let l = this.mul(); let t = this.peek(); while (t?.t === 'op' && (t.v === '+' || t.v === '-')) { this.next(); l = { k: 'bin', op: t.v, l, r: this.mul() }; t = this.peek(); } return l; }
  private mul(): Node { let l = this.pow(); let t = this.peek(); while (t?.t === 'op' && (t.v === '*' || t.v === '/')) { this.next(); l = { k: 'bin', op: t.v, l, r: this.pow() }; t = this.peek(); } return l; }
  private pow(): Node { const l = this.unary(); const t = this.peek(); if (t?.t === 'op' && t.v === '^') { this.next(); return { k: 'bin', op: '^', l, r: this.pow() }; } return l; }
  private unary(): Node { const t = this.peek(); if (t?.t === 'op' && t.v === '-') { this.next(); return { k: 'unary', op: '-', e: this.unary() }; } return this.primary(); }
  private primary(): Node {
    const t = this.next();
    if (!t) throw new Error('#ERROR!');
    if (t.t === 'num') return { k: 'num', v: parseFloat(t.v) };
    if (t.t === 'str') return { k: 'str', v: t.v };
    if (t.t === 'lp') { const e = this.compare(); if (this.next()?.t !== 'rp') throw new Error('#ERROR!'); return e; }
    if (t.t === 'ident') {
      const nx = this.peek();
      if (nx?.t === 'lp') { // function call
        this.next(); const args: Node[] = [];
        if (this.peek()?.t !== 'rp') { args.push(this.rangeOrExpr()); while (this.peek()?.t === 'comma') { this.next(); args.push(this.rangeOrExpr()); } }
        if (this.next()?.t !== 'rp') throw new Error('#ERROR!');
        return { k: 'call', name: t.v.toUpperCase(), args };
      }
      if (isCellRef(t.v.toUpperCase())) return { k: 'ref', v: t.v.toUpperCase() };
      if (t.v.toUpperCase() === 'TRUE') return { k: 'num', v: 1 };
      if (t.v.toUpperCase() === 'FALSE') return { k: 'num', v: 0 };
      throw new Error('#NAME?');
    }
    throw new Error('#ERROR!');
  }
  private rangeOrExpr(): Node {
    // A1:B3 range only appears as a bare ref pair; otherwise a normal expression.
    const t = this.peek();
    if (t?.t === 'ident' && isCellRef(t.v.toUpperCase()) && this.toks[this.p + 1]?.t === 'colon') {
      const a = this.next()!.v.toUpperCase(); this.next(); const b = this.next();
      if (!b || b.t !== 'ident' || !isCellRef(b.v.toUpperCase())) throw new Error('#REF!');
      return { k: 'range', a, b: b.v.toUpperCase() };
    }
    return this.compare();
  }
}

// ── Evaluator ───────────────────────────────────────────────────────────────

function num(v: CellValue): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') { if (v === '') return 0; const n = Number(v); if (!Number.isFinite(n)) throw new Error('#VALUE!'); return n; }
  throw new Error('#VALUE!');
}

/**
 * Evaluate every cell in the sheet. Formula cells (raw starts with '=') are
 * computed by recursively resolving dependencies; a ref caught mid-resolution
 * is a cycle (#CYCLE!). Literal cells pass through (number-coerced when numeric).
 */
export function evaluateSheet(cells: Record<string, string>): Record<string, EvaluatedCell> {
  const out: Record<string, EvaluatedCell> = {};
  const memo = new Map<string, CellValue>();
  const visiting = new Set<string>();

  const resolve = (ref: string): CellValue => {
    if (memo.has(ref)) return memo.get(ref)!;
    if (visiting.has(ref)) throw new Error('#CYCLE!');
    const raw = cells[ref];
    if (raw === undefined || raw === '') { memo.set(ref, 0); return 0; }
    if (!raw.startsWith('=')) {
      const n = Number(raw);
      const v: CellValue = raw !== '' && Number.isFinite(n) ? n : raw;
      memo.set(ref, v); return v;
    }
    visiting.add(ref);
    let v: CellValue;
    try { v = evalNode(new Parser(tokenize(raw.slice(1))).parse()); }
    catch (e) { const msg = e instanceof Error ? e.message : '#ERROR!'; v = (ERRORS.includes(msg) ? msg : '#ERROR!') as CellError; }
    visiting.delete(ref);
    memo.set(ref, v); return v;
  };

  const evalNode = (n: Node): CellValue => {
    switch (n.k) {
      case 'num': return n.v;
      case 'str': return n.v;
      case 'ref': return resolve(n.v);
      case 'range': throw new Error('#VALUE!'); // a range is only valid inside a function
      case 'unary': return -num(evalNode(n.e));
      case 'bin': {
        if (['=', '<>', '<', '>', '<=', '>='].includes(n.op)) {
          const l = evalNode(n.l); const r = evalNode(n.r);
          const cmp = compare(l, r);
          switch (n.op) { case '=': return cmp === 0; case '<>': return cmp !== 0; case '<': return cmp < 0; case '>': return cmp > 0; case '<=': return cmp <= 0; default: return cmp >= 0; }
        }
        const a = num(evalNode(n.l)); const b = num(evalNode(n.r));
        switch (n.op) { case '+': return a + b; case '-': return a - b; case '*': return a * b; case '/': if (b === 0) throw new Error('#DIV/0!'); return a / b; case '^': return Math.pow(a, b); default: throw new Error('#ERROR!'); }
      }
      case 'call': return callFn(n.name, n.args);
    }
  };

  const argValues = (args: Node[]): CellValue[] => {
    const vals: CellValue[] = [];
    for (const a of args) {
      if (a.k === 'range') { const refs = expandRange(a.a, a.b); if (!refs) throw new Error('#REF!'); for (const r of refs) vals.push(resolve(r)); }
      else vals.push(evalNode(a));
    }
    return vals;
  };

  const callFn = (name: string, args: Node[]): CellValue => {
    if (name === 'IF') { if (args.length < 2) throw new Error('#VALUE!'); const cond = evalNode(args[0]); const truthy = typeof cond === 'boolean' ? cond : num(cond) !== 0; return truthy ? evalNode(args[1]) : (args[2] ? evalNode(args[2]) : false); }
    if (name === 'CONCAT') return argValues(args).map((v) => (typeof v === 'string' ? v : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v))).join('');
    const vals = argValues(args);
    switch (name) {
      case 'SUM': return vals.reduce<number>((s, v) => s + num(v), 0);
      case 'AVG': case 'AVERAGE': { const ns = vals.map(num); return ns.length ? ns.reduce((s, v) => s + v, 0) / ns.length : 0; }
      case 'MIN': return vals.length ? Math.min(...vals.map(num)) : 0;
      case 'MAX': return vals.length ? Math.max(...vals.map(num)) : 0;
      case 'COUNT': return vals.filter((v) => typeof v === 'number' || (typeof v === 'string' && v !== '' && Number.isFinite(Number(v)))).length;
      case 'ROUND': { const x = num(vals[0]); const d = vals[1] !== undefined ? num(vals[1]) : 0; const f = Math.pow(10, d); return Math.round(x * f) / f; }
      case 'ABS': return Math.abs(num(vals[0]));
      default: throw new Error('#NAME?');
    }
  };

  for (const ref of Object.keys(cells)) {
    const v = resolve(ref);
    out[ref] = { value: v, isError: typeof v === 'string' && ERRORS.includes(v) };
  }
  return out;
}

function compare(l: CellValue, r: CellValue): number {
  if (typeof l === 'number' && typeof r === 'number') return l < r ? -1 : l > r ? 1 : 0;
  const ls = String(l); const rs = String(r);
  return ls < rs ? -1 : ls > rs ? 1 : 0;
}
